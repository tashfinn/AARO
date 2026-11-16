"""Open an isolated ShopBase Chrome profile, verify its session, then copy cookies."""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    import websocket
except ImportError:
    print("Missing helper dependency. Run Copy-ShopBase-Cookie.bat again.")
    raise SystemExit(1)

SHOP_URL = "https://shopbasebd.com/store/products/all"
PROFILE = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "AARO-ShopBase-Sync"


def chrome_path():
    candidates = [
        os.environ.get("PROGRAMFILES", "") + r"\Google\Chrome\Application\chrome.exe",
        os.environ.get("PROGRAMFILES(X86)", "") + r"\Google\Chrome\Application\chrome.exe",
        os.environ.get("LOCALAPPDATA", "") + r"\Google\Chrome\Application\chrome.exe",
    ]
    for item in candidates:
        if item and Path(item).is_file():
            return item
    return shutil.which("chrome") or shutil.which("chrome.exe")


def read_json(url):
    with urllib.request.urlopen(url, timeout=3) as response:
        return json.load(response)


def get_shopbase_cookie():
    active_port = PROFILE / "DevToolsActivePort"
    try:
        port = int(active_port.read_text(encoding="utf-8").splitlines()[0])
        tabs = read_json(f"http://127.0.0.1:{port}/json")
        tab = next((item for item in tabs if item.get("type") == "page" and "shopbasebd.com" in item.get("url", "")), None)
        if not tab:
            raise RuntimeError("The ShopBase tab is not open in the sync browser.")
        with websocket.create_connection(tab["webSocketDebuggerUrl"], timeout=8, suppress_origin=True) as socket:
            socket.send(json.dumps({"id": 1, "method": "Network.getAllCookies"}))
            while True:
                result = json.loads(socket.recv())
                if result.get("id") == 1:
                    break
        cookies = result.get("result", {}).get("cookies", [])
        pairs = [f"{item['name']}={item['value']}" for item in cookies if item.get("domain", "").lstrip(".").endswith("shopbasebd.com") and item.get("name") and item.get("value")]
        if not pairs:
            raise RuntimeError("No ShopBase cookies are present. Sign in to ShopBase in the opened sync browser, then retry.")
        return "; ".join(pairs)
    except (OSError, ValueError, KeyError, urllib.error.URLError, websocket.WebSocketException) as exc:
        raise RuntimeError(f"Could not read cookies from the ShopBase sync browser: {exc}") from exc


def verify_cookie(cookie):
    request = urllib.request.Request(SHOP_URL, headers={"Cookie": cookie, "User-Agent": "Mozilla/5.0 AARO ShopBase cookie check", "Accept": "text/html"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            final_url = response.geturl().lower()
            body = response.read(1_000_000).decode("utf-8", errors="replace").lower()
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise RuntimeError(f"ShopBase rejected this session (HTTP {exc.code}). Sign in again in the opened browser.") from exc
        raise RuntimeError(f"ShopBase session check failed (HTTP {exc.code}); cookie was not copied.") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"Could not reach ShopBase to verify the session: {exc}; cookie was not copied.") from exc
    if "login" in final_url or "sign-in" in final_url or 'type="password"' in body or "name=\"password\"" in body:
        raise RuntimeError("ShopBase is showing its login page. Sign in in the opened sync browser; the cookie was not copied.")
    if "/store/products/" not in body and "product" not in body:
        raise RuntimeError("ShopBase did not return its product catalog. The cookie was not copied; verify you are signed in with catalog access.")


def copy_clipboard(value):
    import tkinter as tk
    root = tk.Tk()
    root.withdraw()
    root.clipboard_clear()
    root.clipboard_append(value)
    root.update()
    root.destroy()


def main():
    browser = chrome_path()
    if not browser:
        raise RuntimeError("Google Chrome was not found. Install Chrome, then run this tool again.")
    PROFILE.mkdir(parents=True, exist_ok=True)
    port_file = PROFILE / "DevToolsActivePort"
    port_file.unlink(missing_ok=True)
    subprocess.Popen([browser, f"--user-data-dir={PROFILE}", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", SHOP_URL], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("Opened your separate ShopBase sync browser profile.")
    print("Sign in to the correct ShopBase account in that window. This tool does not store or enter your password.")
    input("After the product catalog is visible, return here and press Enter to verify and copy the fresh cookie... ")
    cookie = get_shopbase_cookie()
    verify_cookie(cookie)
    copy_clipboard(cookie)
    print("Verified: ShopBase returned the product catalog for this session.")
    print("Fresh ShopBase cookie copied. Paste it into Admin → Product sync → Sync cookie.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Cookie not copied: {error}", file=sys.stderr)
        input("Press Enter to close...")
        raise SystemExit(1)
