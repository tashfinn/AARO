"""Print a salted PBKDF2-SHA256 hash for ADMIN_PASSWORD_HASH."""
import base64
import getpass
import hashlib
import secrets

password = getpass.getpass("Admin password: ")
if len(password) < 10:
    raise SystemExit("Use a password with at least 10 characters.")
salt = secrets.token_bytes(16)
rounds = 310_000
digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, rounds)
encode = lambda value: base64.urlsafe_b64encode(value).decode().rstrip("=")
print(f"pbkdf2_sha256${rounds}${encode(salt)}${encode(digest)}")
