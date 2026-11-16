"""Windows companion that repairs ShopBase sync cookies after local validation."""
import ctypes
import json
import os
import sys
import time
from ctypes import wintypes
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright

try:
    from sync_shopbase_cookie import PROFILE, LOGIN_URL, CATALOG_URL, cookie_from_context, read_credentials, verify_session
except ImportError:
    from tools.sync_shopbase_cookie import PROFILE, LOGIN_URL, CATALOG_URL, cookie_from_context, read_credentials, verify_session

APP_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "AARO-ShopBase-Sync"
CONFIG = APP_DIR / "auto-sync.dat"
POLL_SECONDS = 60


class DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


_crypt32 = ctypes.windll.crypt32
_kernel32 = ctypes.windll.kernel32
_crypt32.CryptProtectData.argtypes = [ctypes.POINTER(DataBlob), wintypes.LPCWSTR, ctypes.POINTER(DataBlob), wintypes.LPVOID, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(DataBlob)]
_crypt32.CryptProtectData.restype = wintypes.BOOL
_crypt32.CryptUnprotectData.argtypes = [ctypes.POINTER(DataBlob), ctypes.POINTER(wintypes.LPWSTR), ctypes.POINTER(DataBlob), wintypes.LPVOID, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(DataBlob)]
_crypt32.CryptUnprotectData.restype = wintypes.BOOL
_kernel32.LocalFree.argtypes = [wintypes.HLOCAL]
_kernel32.LocalFree.restype = wintypes.HLOCAL


def _blob(data: bytes):
    buffer = ctypes.create_string_buffer(data)
    return DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))), buffer


def protect(data: bytes) -> bytes:
    source, keepalive = _blob(data)
    target = DataBlob()
    if not _crypt32.CryptProtectData(ctypes.byref(source), "AARO ShopBase Agent", None, None, None, 0, ctypes.byref(target)):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(target.pbData, target.cbData)
    finally:
        _kernel32.LocalFree(target.pbData)


def unprotect(data: bytes) -> bytes:
    source, keepalive = _blob(data)
    target = DataBlob()
    if not _crypt32.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 0, ctypes.byref(target)):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(target.pbData, target.cbData)
    finally:
        _kernel32.LocalFree(target.pbData)


def pair():
    if os.name != "nt":
        raise RuntimeError("The automatic companion currently requires Windows.")
    api = input("Paste the API address shown in Admin → Product sync: ").strip().rstrip("/")
    if not api.startswith("https://") and "localhost" not in api and "127.0.0.1" not in api:
        raise RuntimeError("Use the secure https:// API address from the admin panel.")
    pairing = input("Paste the one-time pairing code from Admin → Product sync: ").strip()
    if not pairing:
        raise RuntimeError("The pairing code is required.")
    response = requests.get(api + "/api/sync-agent/poll", headers={"Authorization": "Bearer " + pairing}, timeout=15)
    if response.status_code != 200:
        raise RuntimeError("Pairing code was not accepted. Create a new pairing code in Product sync.")
    APP_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG.write_bytes(protect(json.dumps({"api": api, "token": pairing}).encode("utf-8")))
    print("This PC is securely paired. The pairing code is encrypted for your Windows account.")
    print("Install the background checker to run automatically whenever you sign in? (Y/n)")
    if input("> ").strip().lower() not in ("n", "no"):
        install_startup()


def install_startup():
    script = Path(__file__).resolve()
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    python = pythonw if pythonw.exists() else Path(sys.executable)
    startup = Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    startup.mkdir(parents=True, exist_ok=True)
    startup_script = startup / "AARO ShopBase Auto Sync.vbs"
    command = '"' + str(python) + '" "' + str(script) + '" --run'
    vbs = 'Set shell = CreateObject("WScript.Shell")\r\nshell.Run "' + command.replace('"', '""') + '", 0, False\r\n'
    startup_script.write_text(vbs, encoding="utf-8-sig")
    print("Installed. The cookie checker will run in the background after you sign in to Windows.")


def load_config():
    if os.name != "nt" or not CONFIG.exists():
        raise RuntimeError("This PC is not paired yet. Run Pair-ShopBase-Auto-Sync.bat first.")
    return json.loads(unprotect(CONFIG.read_bytes()).decode("utf-8"))


def ensure_browser():
    """Return a locally verified cookie, using saved credentials without exposing them."""
    PROFILE.mkdir(parents=True, exist_ok=True)
    username, password = read_credentials()
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(str(PROFILE), headless=False)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(1200)
            password_field = page.locator('input[type="password"]').first
            if password_field.count() and password_field.is_visible():
                if not username or not password:
                    raise RuntimeError("ShopBase needs a sign-in, but saved credentials were not found in the local credentials file.")
                username_field = page.locator('input[type="tel"], input[type="email"], input[autocomplete="username"], input[name*="phone" i], input[name*="user" i], input[name*="email" i], input[type="text"]').first
                if not username_field.count() or not username_field.is_visible():
                    raise RuntimeError("Could not locate the ShopBase login fields; no cookie was sent.")
                username_field.fill(username)
                password_field.fill(password)
                submit = page.locator('button[type="submit"], input[type="submit"]').first
                if submit.count() and submit.is_visible():
                    submit.click()
                else:
                    password_field.press("Enter")
                page.wait_for_timeout(3500)
                # Give the owner time to complete an OTP, CAPTCHA, or other human check in the visible window.
                deadline = time.monotonic() + 600
                while time.monotonic() < deadline:
                    still_login = "/store/login" in page.url.lower() and password_field.is_visible()
                    if not still_login:
                        break
                    page.wait_for_timeout(5000)
            page.goto(CATALOG_URL, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(800)
            cookie = cookie_from_context(context)
            if not cookie:
                raise RuntimeError("No ShopBase session cookies are present in the local browser profile.")
            valid, message = verify_session(context, cookie)
            if not valid:
                raise RuntimeError(message)
            return cookie
        finally:
            context.close()


def send_repair(session: requests.Session, api: str, headers: dict, run_id: str, cookie: str | None = None, error: str | None = None):
    payload = {"runId": run_id, "cookie": cookie, "error": error}
    response = session.post(api + "/api/sync-agent/repair", headers=headers, json=payload, timeout=30)
    if response.status_code == 409:
        return
    response.raise_for_status()
    result = response.json()
    print(result.get("message", "Repair status updated."))


def run():
    config = load_config()
    api, token = config["api"], config["token"]
    headers = {"Authorization": "Bearer " + token}
    session = requests.Session()
    print("AARO ShopBase sync agent is running. Cookie values are never logged or copied to the clipboard.")
    while True:
        try:
            response = session.get(api + "/api/sync-agent/poll", headers=headers, timeout=20)
            if response.status_code == 401:
                print("This PC pairing was disconnected. Pair it again from Product sync if you want to reconnect.")
                return
            response.raise_for_status()
            request = response.json()
            if request.get("action") == "check_session":
                run_id = request["runId"]
                try:
                    cookie = ensure_browser()
                    send_repair(session, api, headers, run_id, cookie=cookie)
                except Exception as error:
                    # Never send browser or cookie contents to the server or log; only a short reason.
                    detail = str(error).lower()
                    if "login" in detail or "sign in" in detail or "rejected" in detail or "no shopbase cookies" in detail or "password" in detail:
                        message = "ShopBase needs you to sign in again in the AARO sync browser. Once you sign in, this PC can renew future cookies automatically."
                    elif "could not reach shopbase" in detail or "urlopen error" in detail or "timed out" in detail:
                        message = "This PC could not reach ShopBase to verify its session. It will try again automatically."
                    else:
                        message = "The AARO sync browser is not ready. Open it, sign in to ShopBase if asked, then leave the profile available. The agent will retry."
                    send_repair(session, api, headers, run_id, error=message)
            time.sleep(POLL_SECONDS)
        except Exception as error:
            print("Agent check: " + (str(error)[:180] if "cookie" not in str(error).lower() else "temporary connection or browser issue; retrying"))
            time.sleep(POLL_SECONDS)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--run"
    if mode == "--pair":
        pair()
    elif mode == "--run":
        run()
    else:
        raise RuntimeError("Use --pair to connect this PC, or --run to start the background agent.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("ShopBase auto sync: " + str(exc), file=sys.stderr)
        if sys.stdin and sys.stdin.isatty():
            input("Press Enter to close...")
        raise SystemExit(1)
