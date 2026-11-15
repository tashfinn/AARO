"""Copy the ShopBase session cookie from the current Chrome profile."""
import sys
try:
    import browser_cookie3
except ImportError:
    print("Install helper requirements first: py -m pip install -r tools/requirements.txt")
    raise SystemExit(1)
try:
    jar = browser_cookie3.chrome(domain_name="shopbasebd.com")
    cookies = [f"{c.name}={c.value}" for c in jar if c.domain.lstrip(".").endswith("shopbasebd.com")]
    if not cookies:
        raise RuntimeError("No ShopBase cookies found. Sign in to ShopBase in Chrome, then retry.")
    value = "; ".join(cookies)
    import tkinter as tk
    root = tk.Tk(); root.withdraw(); root.clipboard_clear(); root.clipboard_append(value); root.update(); root.destroy()
    print("ShopBase cookie copied to clipboard. Paste it into Admin → Product sync → Sync cookie.")
except Exception as exc:
    print(f"Could not read/copy Chrome cookies: {exc}", file=sys.stderr)
    raise SystemExit(1)
