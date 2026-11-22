import logging
import os
import base64
import hashlib
import hmac
import json
import re
import secrets
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from fastapi import FastAPI, HTTPException, Header, Query, Request
from fastapi.responses import Response, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, Field
from pymongo import MongoClient, UpdateOne
import requests
from nacl import encoding, public
from category_groups import category_group_payload

app = FastAPI(title="AARO catalog API", version="0.1.0")
origins = list(dict.fromkeys([
    *(x.strip() for x in os.getenv("FRONTEND_ORIGINS", "").split(",") if x.strip()),
    "http://localhost:5173",
    "http://localhost:4173",
    # Keep both active Vercel names usable during the domain migration/redirect.
    "https://aarostore.vercel.app",
    "https://aaro-store.vercel.app",
]))
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=1000)
_client = None
PASSWORD_ROUNDS = 310_000
try:
    with (Path(__file__).resolve().parent / "bangladesh-locations.json").open(encoding="utf-8") as location_file:
        _location_payload = json.load(location_file)
    BANGLADESH_AREAS = {
        district["name"]: {area["name"]: area["zone"] for area in district["areas"]}
        for district in _location_payload["districts"]
    }
except (OSError, KeyError, TypeError, json.JSONDecodeError):
    BANGLADESH_AREAS = {}

def _offer_tier_allocations(offer: dict[str, Any], quantity: int) -> list[tuple[dict[str, Any], int]]:
    remaining = quantity
    allocations: list[tuple[dict[str, Any], int]] = []
    tiers = sorted((tier for tier in offer.get("tiers", []) if isinstance(tier, dict)), key=lambda item: int(item.get("quantity") or 0), reverse=True)
    for tier in tiers:
        tier_quantity = max(1, int(tier.get("quantity") or 1))
        groups = remaining // tier_quantity
        if groups:
            remaining -= groups * tier_quantity
            allocations.append((tier, groups))
    return allocations

def _offer_units_retail(lines: list[dict[str, Any]], quantity: int, cheapest_first: bool = False) -> float:
    candidates = [{"quantity": int(line.get("quantity") or 0), "price": max(0.0, float(line.get("price") or 0))} for line in lines]
    if cheapest_first:
        candidates.sort(key=lambda line: line["price"])
    remaining = max(0, quantity)
    retail = 0.0
    for line in candidates:
        count = min(remaining, line["quantity"])
        retail += count * line["price"]
        remaining -= count
        if not remaining:
            break
    return retail

def _offer_tier_savings(offer: dict[str, Any], lines: list[dict[str, Any]]) -> float:
    candidates = [{"quantity": int(line.get("quantity") or 0), "price": max(0.0, float(line.get("price") or 0))} for line in lines]
    total_quantity = sum(line["quantity"] for line in candidates)
    savings = 0.0
    for tier, groups in _offer_tier_allocations(offer, total_quantity):
        units = groups * max(1, int(tier.get("quantity") or 1))
        eligible_retail = 0.0
        for line in candidates:
            count = min(units, line["quantity"])
            eligible_retail += count * line["price"]
            line["quantity"] -= count
            units -= count
            if not units:
                break
        value = max(0.0, float(tier.get("value") or 0))
        if tier.get("mode") == "price":
            saving = max(0.0, eligible_retail - groups * value)
        elif tier.get("mode") == "none":
            saving = 0.0
        elif tier.get("discountKind") == "percent":
            saving = eligible_retail * min(value, 100.0) / 100
        else:
            saving = groups * value
        savings += min(eligible_retail, saving)
    return savings

class CustomerCredentials(BaseModel):
    identifier: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=10, max_length=256)
    name: str | None = Field(default=None, min_length=2, max_length=120)

class SyncRequest(BaseModel):
    refresh_details: bool = True

class SyncScheduleInput(BaseModel):
    intervalHours: int
    startTime: str = "00:00"

class StorefrontSettingsInput(BaseModel):
    content: dict[str, Any] | None = None
    categoryGroups: list[dict[str, Any]] | None = None
    manualCategories: list[str] | None = None
    manualCategoryVisibility: dict[str, bool] | None = None

class AdminProductInput(BaseModel):
    id: str = Field(min_length=1, max_length=180)
    source: Literal["custom", "shopbase"] = "custom"
    sourceId: str | None = Field(default=None, max_length=180)
    title: str = Field(min_length=1, max_length=300)
    category: str = Field(min_length=1, max_length=180)
    price: float = Field(ge=0)
    compareAt: float | None = Field(default=None, ge=0)
    originalPrice: float | None = Field(default=None, ge=0)
    discountedPrice: float | None = Field(default=None, ge=0)
    image: str = Field(min_length=1, max_length=8_000_000)
    images: list[str] = Field(default_factory=list, max_length=20)
    description: str = Field(default="", max_length=20000)
    rating: float = Field(default=0, ge=0, le=5)
    reviews: int = Field(default=0, ge=0)
    badge: str | None = Field(default=None, max_length=80)
    stock: int = Field(default=0, ge=0)
    active: bool = True
    trending: bool = False
    offer: bool = False
    updatedAt: str | None = None
    addedAt: str | None = None
    sizes: list[str] = Field(default_factory=list, max_length=100)
    sizeChart: str | None = Field(default=None, max_length=10000)
    details: str | None = Field(default=None, max_length=20000)
    attributes: list[str] = Field(default_factory=list, max_length=100)
    options: list[dict[str, Any]] = Field(default_factory=list, max_length=30)
    categorySourceId: str | None = None
    parentCategory: str | None = None
    parentCategoryId: str | None = None

class AdminProductImport(BaseModel):
    products: list[AdminProductInput] = Field(min_length=1, max_length=2000)

class SyncCookieInput(BaseModel):
    cookie: str = Field(min_length=20, max_length=20000)

class ShopBaseLoginInput(BaseModel):
    username: str = Field(min_length=3, max_length=180)
    password: str = Field(min_length=1, max_length=256)

class AdminCredentials(BaseModel):
    identifier: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=256)
    remember_me: bool = False

class ProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    email: str | None = Field(default=None, max_length=254)
    phone: str | None = Field(default=None, max_length=32)

class PasswordUpdate(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=10, max_length=256)

class AddressUpdate(BaseModel):
    addresses: list[dict[str, Any]] = Field(default_factory=list, max_length=20)

class OrderInput(BaseModel):
    customer: dict[str, Any]
    items: list[dict[str, Any]] = Field(min_length=1, max_length=100)
    # Price fields remain optional for compatibility with older storefronts,
    # but create_order always calculates them from the saved catalog.
    subtotal: float | None = Field(default=None, ge=0)
    delivery: float | None = Field(default=None, ge=0)
    discount: float | None = Field(default=None, ge=0)
    total: float | None = Field(default=None, ge=0)
    deliveryZone: Literal["inside", "outside", "city", "sub_dhaka"] = "outside"
    coupon: str | None = None

class CouponInput(BaseModel):
    code: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")
    kind: str
    value: float = Field(gt=0)
    minimum: float | None = Field(default=None, ge=0)

class BulkPriceAdjustmentInput(BaseModel):
    scope: Literal["all", "category", "subcategory", "offer"] = "all"
    categorySourceId: str = ""
    parentCategoryId: str = ""
    category: str = ""
    offerId: str = ""
    search: str = ""
    adjustmentType: Literal["amount", "percent"] = "amount"
    direction: Literal["increase", "decrease"] = "decrease"
    value: float = Field(gt=0, le=100000)
    active: bool = True

class CouponValidationInput(BaseModel):
    code: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")
    subtotal: float = Field(ge=0)


class OfferInput(BaseModel):
    title: str = Field(default="", max_length=120)
    shareImage: str = Field(default="", max_length=8_000_000)
    id: str = Field(min_length=1, max_length=80)
    productId: str = Field(default="", max_length=120)
    productIds: list[str] = Field(default_factory=list)
    thumbnailProductIds: list[str] = Field(default_factory=list, max_length=3)
    productCount: int | None = Field(default=None, ge=0)
    sortOrder: int = Field(default=0, ge=0)
    kind: str
    value: float = Field(default=0, ge=0)
    discountKind: str = "percent"
    quantity: int = Field(default=1, ge=1, le=1000)
    freeQuantity: int = Field(default=1, ge=1, le=1000)
    reward: Literal["discount", "free_delivery", "both"] = "discount"
    tiers: list[dict[str, Any]] = Field(default_factory=list, max_length=10)
    active: bool = True

class OrderStatusInput(BaseModel):
    status: str

class StoreStatusInput(BaseModel):
    isLive: bool

@app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
def root():
    # UptimeRobot's HTTP monitor checks the service root with HEAD. Return a
    # successful response here so a healthy API isn't reported as an outage.
    return {"ok": True, "service": "AARO catalog API"}

@app.get("/api/store-status")
def public_store_status():
    setting = db().store_settings.find_one({"_id": "store-status"}, {"_id": 0, "isLive": 1})
    return {"isLive": setting.get("isLive", True) if setting else True}

@app.patch("/api/admin/store-status")
def update_store_status(input: StoreStatusInput, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    db().store_settings.update_one(
        {"_id": "store-status"},
        {"$set": {"isLive": input.isLive, "updatedAt": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    return {"isLive": input.isLive}

def db():
    global _client
    uri = os.getenv("MONGODB_URI")
    if not uri:
        raise HTTPException(status_code=503, detail="Catalog database is not configured.")
    if _client is None:
        _client = MongoClient(uri, serverSelectionTimeoutMS=5000)
    return _client[os.getenv("MONGODB_DATABASE", "aaro")]

@app.on_event("startup")
def ensure_storefront_indexes():
    """Keep the read paths used by the storefront on indexed queries."""
    try:
        store = db()
        store.product_views.create_index([("views", -1), ("productId", 1)], name="storefront_trending_views")
        store.products.create_index([("source", 1), ("categorySourceId", 1), ("_id", 1)], name="storefront_category_samples")
        store.products.create_index([("source", 1), ("sourceId", 1)], name="storefront_product_source_id")
        store.admin_products.create_index([("source", 1), ("id", 1)], name="storefront_product_overrides")
    except Exception:
        # A temporary database outage should not prevent the API from starting.
        logging.exception("Could not ensure storefront query indexes")

def _password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PASSWORD_ROUNDS)
    return f"pbkdf2_sha256${PASSWORD_ROUNDS}${base64.urlsafe_b64encode(salt).decode().rstrip('=')}${base64.urlsafe_b64encode(digest).decode().rstrip('=')}"

def _password_matches(password: str, encoded: str) -> bool:
    try:
        algorithm, rounds, salt_text, expected_text = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        salt = base64.urlsafe_b64decode(salt_text + "=" * (-len(salt_text) % 4))
        expected = base64.urlsafe_b64decode(expected_text + "=" * (-len(expected_text) % 4))
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(rounds))
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False

def _cloudinary_credentials() -> tuple[str, str, str] | None:
    cloud, key, secret = (os.getenv(name, "").strip() for name in ("CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"))
    return (cloud, key, secret) if cloud and key and secret else None

def _cloudinary_upload_data_uri(value: str, public_id: str, credentials: tuple[str, str, str]) -> str:
    match = re.fullmatch(r"data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)", value)
    if not match:
        raise ValueError("Unsupported inline image format.")
    try:
        image = base64.b64decode(match.group(2), validate=True)
    except ValueError as error:
        raise ValueError("Invalid inline image data.") from error
    cloud, key, secret = credentials
    response = requests.post(
        f"https://api.cloudinary.com/v1_1/{cloud}/image/upload",
        data={"public_id": public_id, "overwrite": "true", "invalidate": "true"},
        files={"file": (f"{public_id.rsplit('/', 1)[-1]}.{match.group(1).split('/')[-1]}", image, match.group(1))},
        auth=(key, secret),
        timeout=(10, 60),
    )
    if not response.ok:
        logging.error("Cloudinary upload failed with HTTP %s: %s", response.status_code, response.text[:500])
        raise RuntimeError("Cloudinary could not store an image.")
    secure_url = response.json().get("secure_url")
    if not isinstance(secure_url, str) or not secure_url.startswith(f"https://res.cloudinary.com/{cloud}/"):
        raise RuntimeError("Cloudinary returned an invalid image URL.")
    return secure_url.replace("/image/upload/", "/image/upload/f_auto,q_auto,w_2400,c_limit/")

def _mirror_inline_media(value: Any, path: str, credentials: tuple[str, str, str] | None, *, required: bool = False, image_cache: dict[str, str] | None = None) -> tuple[Any, int]:
    image_cache = image_cache if image_cache is not None else {}
    if isinstance(value, str) and value.startswith("data:image/"):
        if credentials is None:
            if required:
                raise HTTPException(status_code=503, detail="Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET on the API service.")
            return value, 0
        if value in image_cache:
            return image_cache[value], 0
        public_id = f"aaro/media/{hashlib.sha256((path + ':' + value).encode('utf-8')).hexdigest()[:32]}"
        try:
            url = _cloudinary_upload_data_uri(value, public_id, credentials)
            image_cache[value] = url
            return url, 1
        except (requests.RequestException, ValueError, RuntimeError) as error:
            logging.warning("Could not mirror uploaded image at %s: %s", path, error)
            if required:
                raise HTTPException(status_code=502, detail="Cloudinary could not store every uploaded image. The affected records were left unchanged.") from error
            return value, 0
    if isinstance(value, list):
        items = []
        count = 0
        for index, item in enumerate(value):
            updated, uploaded = _mirror_inline_media(item, f"{path}/{index}", credentials, required=required, image_cache=image_cache)
            items.append(updated)
            count += uploaded
        return items, count
    if isinstance(value, dict):
        result = {}
        count = 0
        for key, item in value.items():
            updated, uploaded = _mirror_inline_media(item, f"{path}/{key}", credentials, required=required, image_cache=image_cache)
            result[key] = updated
            count += uploaded
        return result, count
    return value, 0

def _count_inline_images(value: Any) -> int:
    if isinstance(value, str):
        return int(value.startswith("data:image/"))
    if isinstance(value, list):
        return sum(_count_inline_images(item) for item in value)
    if isinstance(value, dict):
        return sum(_count_inline_images(item) for item in value.values())
    return 0

def _count_cloudinary_images(value: Any) -> int:
    if isinstance(value, str):
        return int(value.startswith("https://res.cloudinary.com/"))
    if isinstance(value, list):
        return sum(_count_cloudinary_images(item) for item in value)
    if isinstance(value, dict):
        return sum(_count_cloudinary_images(item) for item in value.values())
    return 0

def _stored_media_counts(store) -> tuple[int, int]:
    settings = store.store_settings.find_one({"_id": "storefront"}, {"_id": 0, "content": 1}) or {}
    content = settings.get("content") if isinstance(settings.get("content"), dict) else {}
    inline = _count_inline_images(content)
    cloudinary = _count_cloudinary_images(content)
    media_filter = {"$or": [
        {"image": {"$regex": "^(data:image/|https://res\\.cloudinary\\.com/)"}},
        {"images": {"$regex": "^(data:image/|https://res\\.cloudinary\\.com/)"}},
    ]}
    for product in store.admin_products.find(media_filter, {"_id": 0, "image": 1, "images": 1}):
        media = {key: product[key] for key in ("image", "images") if key in product}
        inline += _count_inline_images(media)
        cloudinary += _count_cloudinary_images(media)
    for offer in store.offers.find({}, {"_id": 0, "shareImage": 1}):
        inline += _count_inline_images(offer.get("shareImage", ""))
        cloudinary += _count_cloudinary_images(offer.get("shareImage", ""))
    return inline, cloudinary

def _migrate_product_collection_images(collection, collection_name: str, credentials: tuple[str, str, str] | None) -> int:
    uploaded_total = 0
    inline_filter = {"$or": [{"image": {"$regex": "^data:image/"}}, {"images": {"$regex": "^data:image/"}}]}
    for product in collection.find(inline_filter, {"_id": 1, "id": 1, "sourceId": 1, "image": 1, "images": 1}):
        product_key = str(product.get("id") or product.get("sourceId") or product.get("_id"))
        cache: dict[str, str] = {}
        updates: dict[str, Any] = {}
        uploaded = 0
        original_images = product.get("images")
        if isinstance(original_images, list):
            updates["images"], count = _mirror_inline_media(original_images, f"{collection_name}/{product_key}/images", credentials, image_cache=cache)
            uploaded += count
        original_image = product.get("image")
        if isinstance(original_image, str):
            updates["image"], count = _mirror_inline_media(original_image, f"{collection_name}/{product_key}/image", credentials, image_cache=cache)
            uploaded += count
        if isinstance(original_images, list) and original_images and original_image == original_images[0]:
            updates["image"] = updates["images"][0]
        if uploaded and updates:
            collection.update_one({"_id": product["_id"]}, {"$set": updates})
            uploaded_total += uploaded
    return uploaded_total

def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")

def _auth_secret() -> bytes:
    value = os.getenv("AUTH_SECRET", "")
    if len(value) < 32:
        raise HTTPException(status_code=503, detail="Authentication is not configured.")
    return value.encode()

def _make_token(subject: str, role: str, remember_me: bool = False) -> str:
    lifetime = 60 * 60 * 24 * 30 if remember_me else 60 * 60 * 12
    payload = _b64(json.dumps({"sub": subject, "role": role, "exp": int(time.time()) + lifetime}, separators=(",", ":")).encode())
    signature = _b64(hmac.new(_auth_secret(), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{signature}"

def _decode_token(authorization: str | None, required_role: str | None = None) -> dict[str, str]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Please sign in.")
    try:
        payload_text, signature = authorization[7:].split(".", 1)
        expected = _b64(hmac.new(_auth_secret(), payload_text.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            raise ValueError("signature")
        payload = json.loads(base64.urlsafe_b64decode(payload_text + "=" * (-len(payload_text) % 4)))
        if int(payload.get("exp", 0)) < int(time.time()):
            raise ValueError("expired")
        if required_role and payload.get("role") != required_role:
            raise ValueError("role")
        return payload
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Your session expired. Please sign in again.")

def _identity(identifier: str) -> tuple[str, str]:
    value = identifier.strip()
    if "@" in value:
        email = value.lower()
        if len(email) > 254 or email.count("@") != 1 or "." not in email.rsplit("@", 1)[1]:
            raise HTTPException(status_code=422, detail="Enter a valid email address or phone number.")
        return "email", email
    phone = "".join(character for character in value if character.isdigit())
    if len(phone) < 8 or len(phone) > 15:
        raise HTTPException(status_code=422, detail="Enter a valid email address or phone number.")
    return "phone", phone

def _public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {"id": str(user.get("_id", "")), "name": user.get("name", ""), "email": user.get("email", ""), "phone": user.get("phone", ""), "addresses": user.get("addresses", []), "defaultAddressId": user.get("defaultAddressId")}

def _customer_from_auth(authorization: str | None) -> dict[str, Any]:
    payload = _decode_token(authorization, "customer")
    user = db().users.find_one({"_id": payload["sub"]})
    if not user:
        raise HTTPException(status_code=401, detail="Account not found.")
    return user

def _admin_from_auth(authorization: str | None) -> dict[str, str]:
    return _decode_token(authorization, "admin")

@app.post("/api/auth/register")
def register_customer(input: CustomerCredentials):
    if not input.name:
        raise HTTPException(status_code=422, detail="Your full name is required.")
    field, value = _identity(input.identifier)
    store = db()
    if store.users.find_one({field: value}):
        raise HTTPException(status_code=409, detail="An account already uses this email or phone.")
    user_id = uuid.uuid4().hex
    user = {"_id": user_id, "name": input.name.strip(), "email": value if field == "email" else "", "phone": value if field == "phone" else "", "passwordHash": _password_hash(input.password), "addresses": [], "createdAt": datetime.now(timezone.utc).isoformat()}
    store.users.insert_one(user)
    return {"accessToken": _make_token(user_id, "customer"), "user": _public_user(user)}

@app.post("/api/auth/login")
def login_customer(input: CustomerCredentials):
    field, value = _identity(input.identifier)
    user = db().users.find_one({field: value})
    if not user or not _password_matches(input.password, user.get("passwordHash", "")):
        raise HTTPException(status_code=401, detail="Email/phone or password is incorrect.")
    return {"accessToken": _make_token(user["_id"], "customer"), "user": _public_user(user)}

@app.get("/api/account")
def get_account(authorization: str | None = Header(default=None)):
    return _public_user(_customer_from_auth(authorization))

@app.patch("/api/account")
def update_account(input: ProfileUpdate, authorization: str | None = Header(default=None)):
    user = _customer_from_auth(authorization)
    updates: dict[str, Any] = {}
    if input.name is not None:
        updates["name"] = input.name.strip()
    if input.email is not None:
        kind, value = _identity(input.email)
        if kind != "email":
            raise HTTPException(status_code=422, detail="Enter a valid email address.")
        collision = db().users.find_one({"email": value, "_id": {"$ne": user["_id"]}})
        if collision:
            raise HTTPException(status_code=409, detail="That email is already used by another account.")
        updates["email"] = value
    if input.phone is not None:
        kind, value = _identity(input.phone)
        if kind != "phone":
            raise HTTPException(status_code=422, detail="Enter a valid phone number.")
        collision = db().users.find_one({"phone": value, "_id": {"$ne": user["_id"]}})
        if collision:
            raise HTTPException(status_code=409, detail="That phone is already used by another account.")
        updates["phone"] = value
    if updates:
        db().users.update_one({"_id": user["_id"]}, {"$set": updates})
    return _public_user(db().users.find_one({"_id": user["_id"]}))

@app.put("/api/account/password")
def update_password(input: PasswordUpdate, authorization: str | None = Header(default=None)):
    user = _customer_from_auth(authorization)
    if not _password_matches(input.current_password, user.get("passwordHash", "")):
        raise HTTPException(status_code=401, detail="Current password is incorrect.")
    db().users.update_one({"_id": user["_id"]}, {"$set": {"passwordHash": _password_hash(input.new_password)}})
    return {"ok": True}

@app.put("/api/account/addresses")
def update_addresses(input: AddressUpdate, authorization: str | None = Header(default=None)):
    user = _customer_from_auth(authorization)
    addresses = []
    for raw_address in input.addresses:
        address = dict(raw_address)
        for field, label, limit in (("recipient", "Recipient", 120), ("phone", "Phone number", 32), ("district", "District", 80), ("thana", "Thana or area", 100), ("address", "Delivery address", 1000)):
            value = address.get(field)
            if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
                raise HTTPException(status_code=422, detail=f"Enter a valid {label.lower()}.")
            address[field] = value.strip()
        district_areas = BANGLADESH_AREAS.get(address["district"])
        if not district_areas or address["thana"] not in district_areas:
            raise HTTPException(status_code=422, detail="Choose a valid district and thana or area from the address lists.")
        digits = "".join(character for character in address["phone"] if character.isdigit())
        if not 8 <= len(digits) <= 15:
            raise HTTPException(status_code=422, detail="Enter a valid phone number.")
        comments = address.get("comments")
        if comments is not None and (not isinstance(comments, str) or len(comments) > 1000):
            raise HTTPException(status_code=422, detail="Comments must be 1,000 characters or fewer.")
        address["area"] = f"{address['thana']}, {address['district']}"
        address["comments"] = comments.strip() or None if isinstance(comments, str) else None
        address["id"] = str(address.get("id") or uuid.uuid4().hex)
        address["isDefault"] = bool(address.get("isDefault"))
        addresses.append(address)
    default_ids = [item["id"] for item in addresses if item.get("isDefault")]
    if len(default_ids) > 1:
        raise HTTPException(status_code=422, detail="Choose only one default address.")
    db().users.update_one({"_id": user["_id"]}, {"$set": {"addresses": addresses, "defaultAddressId": default_ids[0] if default_ids else None}})
    return {"addresses": addresses, "defaultAddressId": default_ids[0] if default_ids else None}

@app.post("/api/admin/login")
def login_admin(input: AdminCredentials):
    expected_id = os.getenv("ADMIN_ID", "")
    password_hash = os.getenv("ADMIN_PASSWORD_HASH", "")
    if not expected_id or not password_hash or not hmac.compare_digest(input.identifier.strip(), expected_id) or not _password_matches(input.password, password_hash):
        raise HTTPException(status_code=401, detail="ID or password is incorrect.")
    return {"accessToken": _make_token(expected_id, "admin", input.remember_me), "adminId": expected_id}

@app.get("/api/admin/session")
def check_admin_session(authorization: str | None = Header(default=None)):
    admin = _admin_from_auth(authorization)
    return {"ok": True, "adminId": admin.get("sub", "")}

@app.get("/api/admin/coupons")
def list_coupons(authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    return list(db().coupons.find({}, {"_id": 0}))

@app.post("/api/coupons/validate")
def validate_coupon(input: CouponValidationInput):
    code = input.code.strip().upper()
    coupon = db().coupons.find_one({"code": code, "active": True}, {"_id": 0, "code": 1, "kind": 1, "value": 1, "minimum": 1, "active": 1})
    if not coupon:
        raise HTTPException(status_code=422, detail="That coupon code is not active.")
    if coupon.get("kind") not in ("percent", "amount"):
        raise HTTPException(status_code=503, detail="This coupon is configured incorrectly. Contact the store.")
    if input.subtotal < float(coupon.get("minimum") or 0):
        raise HTTPException(status_code=422, detail=f"This code requires an order subtotal of at least ৳{float(coupon.get('minimum') or 0):g}.")
    value = float(coupon.get("value") or 0)
    if value <= 0 or coupon.get("kind") == "percent" and value > 100:
        raise HTTPException(status_code=503, detail="This coupon is configured incorrectly. Contact the store.")
    return {"coupon": coupon, "discount": min(input.subtotal, input.subtotal * value / 100 if coupon["kind"] == "percent" else value)}

@app.post("/api/admin/coupons")
def save_coupon(input: CouponInput, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    if input.kind not in ("percent", "amount"):
        raise HTTPException(status_code=422, detail="Coupon type must be percent or amount.")
    if input.kind == "percent" and input.value > 100:
        raise HTTPException(status_code=422, detail="A percentage coupon cannot exceed 100%.")
    coupon = input.model_dump()
    coupon["code"] = input.code.strip().upper()
    db().coupons.replace_one({"code": coupon["code"]}, coupon, upsert=True)
    return coupon

@app.delete("/api/admin/coupons/{code}")
def remove_coupon(code: str, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    result = db().coupons.delete_one({"code": code.strip().upper()})
    if not result.deleted_count:
        raise HTTPException(status_code=404, detail="Coupon not found.")
    return {"ok": True}

@app.get("/api/orders")
def customer_orders(authorization: str | None = Header(default=None)):
    user = _customer_from_auth(authorization)
    return list(db().orders.find({"customerId": user["_id"]}, {"_id": 0}).sort("createdAt", -1))

@app.post("/api/orders")
def create_order(input: OrderInput, authorization: str | None = Header(default=None)):
    store = db()
    status = store.store_settings.find_one({"_id": "store-status"}, {"_id": 0, "isLive": 1})
    if status and status.get("isLive") is False:
        raise HTTPException(status_code=503, detail="The store is temporarily closed and is not accepting orders.")
    user = _customer_from_auth(authorization) if authorization else None

    customer = {key: input.customer.get(key) for key in ("name", "phone", "district", "thana", "address", "email", "comments") if key in input.customer}
    for field, label, limit in (("name", "Full name", 120), ("phone", "Phone number", 32), ("district", "District", 80), ("thana", "Thana or area", 100), ("address", "Delivery address", 1000)):
        value = customer.get(field)
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
            raise HTTPException(status_code=422, detail=f"Enter a valid {label.lower()}.")
        customer[field] = value.strip()
    district_areas = BANGLADESH_AREAS.get(customer["district"])
    if not district_areas or customer["thana"] not in district_areas:
        raise HTTPException(status_code=422, detail="Choose a valid district and thana or area from the address lists.")
    delivery_zone = district_areas[customer["thana"]]
    customer["area"] = f"{customer['thana']}, {customer['district']}"
    if customer.get("comments") is not None:
        if not isinstance(customer["comments"], str) or len(customer["comments"]) > 1000:
            raise HTTPException(status_code=422, detail="Comments must be 1,000 characters or fewer.")
        customer["comments"] = customer["comments"].strip() or None
    digits = "".join(character for character in customer["phone"] if character.isdigit())
    if not 8 <= len(digits) <= 15:
        raise HTTPException(status_code=422, detail="Enter a valid phone number for order confirmation.")
    if customer.get("email") is not None and (not isinstance(customer["email"], str) or len(customer["email"]) > 254):
        raise HTTPException(status_code=422, detail="Enter a valid email address.")

    products_by_id: dict[str, dict[str, Any]] = {}
    quantities_by_id: dict[str, int] = {}
    priced_items: list[dict[str, Any]] = []
    subtotal = 0.0
    offer_discount = 0.0
    for requested in input.items:
        product_id = requested.get("productId")
        quantity = requested.get("quantity")
        if not isinstance(product_id, str) or not product_id or len(product_id) > 180 or isinstance(quantity, bool) or not isinstance(quantity, int) or not 1 <= quantity <= 100:
            raise HTTPException(status_code=422, detail="An order item or quantity is invalid.")
        if product_id not in products_by_id:
            if product_id.startswith("shopbase-"):
                source_id = product_id.removeprefix("shopbase-")
                product = store.products.find_one({"sourceId": source_id, "source": "shopbase"}, {"_id": 0})
                override = store.admin_products.find_one({"id": product_id, "source": "shopbase"}, {"_id": 0}) or {}
                if not product:
                    raise HTTPException(status_code=409, detail="One of the products is no longer available. Refresh the catalog and try again.")
                product = _apply_shopbase_override(public_product(product, include_details=True), override)
            else:
                product = store.admin_products.find_one({"id": product_id, "source": "custom"}, {"_id": 0})
                if not product:
                    raise HTTPException(status_code=409, detail="One of the products is no longer available. Refresh the catalog and try again.")
            if product.get("active", True) is False or product.get("stock") is not None and int(product.get("stock") or 0) <= 0:
                raise HTTPException(status_code=409, detail=f"{product.get('title', 'A selected product')} is no longer available.")
            products_by_id[product_id] = product

        product = products_by_id[product_id]
        stock = product.get("stock")
        requested_total = quantities_by_id.get(product_id, 0) + quantity
        quantities_by_id[product_id] = requested_total
        if stock is not None and requested_total > int(stock):
            raise HTTPException(status_code=409, detail=f"Only {int(stock)} of {product.get('title', 'this product')} are currently available.")
        size = requested.get("size")
        sizes = product.get("sizes") if isinstance(product.get("sizes"), list) else []
        defined_options = product.get("options") if isinstance(product.get("options"), list) else []
        size_option = next((option for option in defined_options if isinstance(option, dict) and isinstance(option.get("name"), str) and option["name"].casefold() == "size"), None)
        option_sizes = size_option.get("values") if isinstance(size_option, dict) and isinstance(size_option.get("values"), list) else []
        if size is not None and not isinstance(size, str):
            raise HTTPException(status_code=422, detail="A selected product size is invalid.")
        required_sizes = sizes or option_sizes
        if required_sizes and (not isinstance(size, str) or size not in required_sizes):
            raise HTTPException(status_code=422, detail=f"Choose a valid size for {product.get('title', 'the selected product')}.")
        if size and not required_sizes:
            raise HTTPException(status_code=422, detail=f"The selected size for {product.get('title', 'this product')} is no longer available.")
        requested_options = requested.get("options") or {}
        if not isinstance(requested_options, dict) or any(not isinstance(key, str) or not isinstance(value, str) for key, value in requested_options.items()):
            raise HTTPException(status_code=422, detail="A product option is invalid.")
        normalized_options: dict[str, str] = {}
        for option in defined_options:
            name = option.get("name") if isinstance(option, dict) else None
            values = option.get("values") if isinstance(option, dict) else None
            if not isinstance(name, str) or not isinstance(values, list) or not values:
                continue
            if name.casefold() == "size":
                if values and (not isinstance(size, str) or size not in values):
                    raise HTTPException(status_code=422, detail=f"Choose a valid size for {product.get('title', 'the selected product')}.")
                continue
            value = requested_options.get(name)
            if value not in values:
                raise HTTPException(status_code=422, detail=f"Choose a valid {name.lower()} for {product.get('title', 'the selected product')}.")
            normalized_options[name] = value
        if set(requested_options) - set(normalized_options):
            raise HTTPException(status_code=422, detail="A selected product option is no longer available.")

        unit_price = max(0.0, float(product.get("price") or 0))
        subtotal += unit_price * quantity
        priced_items.append({"productId": product_id, "title": str(product.get("title") or "Product"), "image": str(product.get("image") or ""), "price": unit_price, "quantity": quantity, **({"size": size} if size else {}), **({"options": normalized_options} if normalized_options else {})})

    for offer in store.offers.find({"active": True, "kind": {"$in": ["special_price", "quantity_discount", "buy_multiple", "buy_x_get_y_free"]}}, {"_id": 0}):
        target_ids = list(dict.fromkeys(offer.get("productIds") or ([offer.get("productId")] if offer.get("productId") else [])))
        offer_lines = [item for item in priced_items if item["productId"] in target_ids]
        quantity = sum(item["quantity"] for item in offer_lines)
        if not quantity:
            continue
        if offer.get("kind") == "special_price":
            offer_discount += sum(max(0.0, item["price"] - min(item["price"], float(offer.get("value") or 0))) * item["quantity"] for item in offer_lines)
            continue
        offer_quantity = max(1, int(offer.get("quantity") or 1))
        if offer.get("kind") == "buy_multiple" and offer.get("tiers"):
            offer_discount += _offer_tier_savings(offer, offer_lines)
        elif offer.get("kind") in ("quantity_discount", "buy_multiple"):
            groups = quantity // offer_quantity
            eligible_quantity = groups * offer_quantity
            eligible_retail = _offer_units_retail(offer_lines, eligible_quantity)
            reward = offer.get("reward", "discount")
            if eligible_quantity and (offer.get("kind") == "quantity_discount" or reward in ("discount", "both")):
                saving = eligible_retail * float(offer.get("value") or 0) / 100 if offer.get("discountKind") == "percent" else groups * float(offer.get("value") or 0)
                offer_discount += min(eligible_retail, saving)
        elif offer.get("kind") == "buy_x_get_y_free":
            free_quantity = max(1, int(offer.get("freeQuantity") or 1))
            free_count = (quantity // (offer_quantity + free_quantity)) * free_quantity
            offer_discount += _offer_units_retail(offer_lines, free_count, cheapest_first=True)

    for offer in store.offers.find({"kind": "bundle", "active": True}, {"_id": 0}):
        product_ids = list(dict.fromkeys(item for item in offer.get("productIds", []) if isinstance(item, str)))
        if len(product_ids) < 2 or any(product_id not in products_by_id for product_id in product_ids):
            continue
        group_quantity = max(1, int(offer.get("quantity") or 1))
        bundle_count = min(quantities_by_id.get(product_id, 0) // group_quantity for product_id in product_ids)
        retail_total = sum(float(products_by_id[product_id].get("price") or 0) for product_id in product_ids)
        offer_discount += max(0.0, retail_total - float(offer.get("value") or 0)) * bundle_count

    content = (store.store_settings.find_one({"_id": "storefront"}, {"_id": 0, "content": 1}) or {}).get("content") or {}
    # Migrate the original two-tier default the first time this newer three-tier flow runs.
    legacy_default = "deliverySubDhaka" not in content and content.get("deliveryInDhaka") == 60 and content.get("deliveryOutsideDhaka", 120) == 120
    if legacy_default:
        delivery = {"city": 70, "sub_dhaka": 100, "outside": 120}[delivery_zone]
    else:
        rate_key = {"city": "deliveryInDhaka", "sub_dhaka": "deliverySubDhaka", "outside": "deliveryOutsideDhaka"}[delivery_zone]
        default_rate = {"city": 70, "sub_dhaka": 100, "outside": 120}[delivery_zone]
        try:
            delivery = float(content.get(rate_key, default_rate))
        except (TypeError, ValueError):
            raise HTTPException(status_code=503, detail="Delivery charges are not configured correctly. Contact the store before retrying.")
    if not 0 <= delivery <= 10000:
        raise HTTPException(status_code=503, detail="Delivery charges are outside the allowed range. Contact the store before retrying.")
    free_delivery_offer = any(float(offer.get("value") or 0) <= subtotal for offer in store.offers.find({"kind": "free_delivery", "active": True}, {"_id": 0, "value": 1}))
    free_delivery_quantity_offer = False
    for offer in store.offers.find({"kind": "buy_multiple", "active": True}, {"_id": 0, "productId": 1, "productIds": 1, "quantity": 1, "reward": 1, "tiers": 1}):
        target_ids = list(dict.fromkeys(offer.get("productIds") or ([offer.get("productId")] if offer.get("productId") else [])))
        quantity = sum(quantities_by_id.get(product_id, 0) for product_id in target_ids)
        if (
            any(tier.get("freeDelivery") for tier, _groups in _offer_tier_allocations(offer, quantity))
            if offer.get("tiers") else offer.get("reward") in ("free_delivery", "both") and quantity >= max(1, int(offer.get("quantity") or 1))
        ):
            free_delivery_quantity_offer = True
            break
    if free_delivery_offer or free_delivery_quantity_offer:
        delivery = 0.0
    discount = offer_discount
    coupon_code = input.coupon.strip().upper() if isinstance(input.coupon, str) and input.coupon.strip() else None
    if coupon_code:
        coupon = store.coupons.find_one({"code": coupon_code, "active": True}, {"_id": 0})
        if not coupon:
            raise HTTPException(status_code=422, detail="That coupon is no longer active. Remove it and place your order again.")
        if subtotal < float(coupon.get("minimum") or 0):
            raise HTTPException(status_code=422, detail="Your order no longer meets this coupon’s minimum amount.")
        coupon_saving = subtotal * float(coupon.get("value") or 0) / 100 if coupon.get("kind") == "percent" else float(coupon.get("value") or 0)
        discount += min(subtotal, coupon_saving)
    discount = min(subtotal, discount)
    total = max(0.0, subtotal + delivery - discount)
    order_id = f"AR-{uuid.uuid4().hex[:8].upper()}"
    order = {"id": order_id, "customer": customer, "items": priced_items, "subtotal": subtotal, "delivery": delivery, "deliveryZone": delivery_zone, "discount": discount, "total": total, "coupon": coupon_code, "customerId": user["_id"] if user else None, "createdAt": datetime.now(timezone.utc).isoformat(), "status": "Pending confirmation"}
    store.orders.insert_one(order)
    order.pop("_id", None)
    return order


@app.get("/api/offers")
def public_offers(response: Response):
    # Share images are stored as base64 on the offer document. They are only
    # needed by the dedicated link-preview endpoint; including them here makes
    # every storefront visit download hundreds of KB of unrelated media.
    store = db()
    result = list(store.offers.find({"active": True}, {"_id": 0, "shareImage": 0}))
    storewide_count: int | None = None
    for offer in result:
        if not isinstance(offer.get("productCount"), int):
            if offer.get("kind") == "free_delivery":
                if storewide_count is None:
                    storewide_count = store.products.count_documents({"source": "shopbase", "active": {"$ne": False}}) + store.admin_products.count_documents({"source": "custom", "active": True})
                offer["productCount"] = storewide_count
            else:
                offer["productCount"] = len(offer.get("productIds") or ([offer.get("productId")] if offer.get("productId") else []))
            store.offers.update_one({"id": offer.get("id"), "productCount": {"$exists": False}}, {"$set": {"productCount": offer["productCount"]}})
    response.headers["Cache-Control"] = "public, max-age=15, stale-while-revalidate=120"
    return sorted(result, key=lambda offer: offer.get("sortOrder", 0))

@app.get("/api/admin/offers")
def list_offers(authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    return sorted(list(db().offers.find({}, {"_id": 0})), key=lambda offer: offer.get("sortOrder", 0))

@app.post("/api/admin/offers")
def save_offer(input: OfferInput, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    if input.kind not in ("special_price", "quantity_discount", "buy_multiple", "buy_x_get_y_free", "bundle", "free_delivery"):
        raise HTTPException(status_code=422, detail="Unknown offer type.")
    if input.kind != "free_delivery":
        input.productIds = list(dict.fromkeys(input.productIds or ([input.productId] if input.productId else [])))
        if input.kind == "bundle" and len(input.productIds) < 2:
            raise HTTPException(status_code=422, detail="Choose at least two different products for the bundle.")
        if input.kind != "bundle" and not input.productIds:
            raise HTTPException(status_code=422, detail="Choose at least one active product for the offer.")
        input.productId = input.productIds[0] if input.productIds else ""
    if input.kind in ("quantity_discount", "buy_multiple") and input.discountKind not in ("percent", "amount"):
        raise HTTPException(status_code=422, detail="Discount must be a percentage or fixed amount.")
    if input.kind == "buy_multiple" and not input.tiers and input.quantity < 2:
        raise HTTPException(status_code=422, detail="A buy-multiple offer must require at least two items.")
    if input.kind == "buy_multiple" and input.tiers:
        seen_quantities: set[int] = set()
        for tier in input.tiers:
            try:
                quantity = int(tier.get("quantity", 0))
                mode = tier.get("mode", "discount")
                value = float(tier.get("value", 0))
                discount_kind = tier.get("discountKind", "percent")
            except (TypeError, ValueError):
                raise HTTPException(status_code=422, detail="One of the quantity tiers is invalid.")
            if quantity < 1 or quantity in seen_quantities:
                raise HTTPException(status_code=422, detail="Quantity tiers must use unique quantities of 1 or more.")
            if mode not in ("price", "discount", "none") or value < 0 or (mode == "discount" and value <= 0) or (mode == "none" and not tier.get("freeDelivery")):
                raise HTTPException(status_code=422, detail="Enter a valid set price or discount for every tier.")
            if mode == "discount" and (discount_kind not in ("percent", "amount") or discount_kind == "percent" and value > 100):
                raise HTTPException(status_code=422, detail="A tier discount must be a valid amount or a percentage up to 100%.")
            seen_quantities.add(quantity)
    if input.kind in ("special_price", "quantity_discount") and input.value <= 0:
        raise HTTPException(status_code=422, detail="Enter a positive offer value.")
    if input.kind == "buy_multiple" and not input.tiers and input.reward in ("discount", "both") and input.value <= 0:
        raise HTTPException(status_code=422, detail="Enter a positive discount for this buy-multiple offer.")
    if input.kind in ("quantity_discount", "buy_multiple") and (input.kind != "buy_multiple" or not input.tiers) and input.reward in ("discount", "both") and input.discountKind == "percent" and input.value > 100:
        raise HTTPException(status_code=422, detail="A percentage offer cannot exceed 100%.")
    if input.kind in ("special_price", "quantity_discount", "buy_multiple", "buy_x_get_y_free"):
        for product_id in input.productIds:
            if product_id.startswith("shopbase-"):
                source_id = product_id.removeprefix("shopbase-")
                product = db().products.find_one({"sourceId": source_id, "source": "shopbase"}, {"_id": 0, "price": 1, "suggestedRetailPrice": 1, "active": 1})
                override = db().admin_products.find_one({"id": product_id, "source": "shopbase"}, {"_id": 0, "price": 1, "compareAt": 1, "discountedPrice": 1, "active": 1}) or {}
                price = _shopbase_effective_price(product, override)
                active = bool(product and product.get("active", True) and override.get("active", True))
            else:
                product = db().admin_products.find_one({"id": product_id, "source": "custom"}, {"_id": 0, "price": 1, "active": 1})
                price = (product or {}).get("price") or 0
                active = bool(product and product.get("active", True))
            if not active:
                raise HTTPException(status_code=422, detail="Choose active products for the offer.")
            if input.kind == "buy_multiple" and input.tiers and any(tier.get("mode") == "price" and float(tier.get("value") or 0) >= int(tier.get("quantity") or 1) * float(price) for tier in input.tiers):
                raise HTTPException(status_code=422, detail="Each quantity set price must be lower than every selected product’s regular combined price.")
            if input.kind == "special_price" and input.value >= float(price):
                raise HTTPException(status_code=422, detail="The offer price must be lower than every selected product’s current price.")
    if input.kind == "bundle":
        product_ids = input.productIds
        if len(product_ids) < 2:
            raise HTTPException(status_code=422, detail="Choose at least two different products for the bundle.")
        retail_total = 0.0
        for product_id in product_ids:
            if product_id.startswith("shopbase-"):
                source_id = product_id.removeprefix("shopbase-")
                product = db().products.find_one({"sourceId": source_id, "source": "shopbase"}, {"_id": 0, "price": 1, "suggestedRetailPrice": 1, "active": 1})
                override = db().admin_products.find_one({"id": product_id, "source": "shopbase"}, {"_id": 0, "price": 1, "compareAt": 1, "discountedPrice": 1, "active": 1}) or {}
                active = bool(product and product.get("active", True) and override.get("active", True))
                price = _shopbase_effective_price(product, override)
            else:
                product = db().admin_products.find_one({"id": product_id, "source": "custom"}, {"_id": 0, "price": 1, "active": 1})
                active = bool(product and product.get("active", True))
                price = (product or {}).get("price") or 0
            if not active:
                raise HTTPException(status_code=422, detail="Choose active products for the bundle.")
            retail_total += float(price)
        if input.value >= retail_total:
            raise HTTPException(status_code=422, detail="The bundle price must be lower than the products’ combined price.")
        input.productIds = product_ids
    if input.kind == "free_delivery":
        input.productId = ""
        input.productIds = []
    offer = input.model_dump()
    if input.kind == "free_delivery":
        offer["productCount"] = (
            db().products.count_documents({"source": "shopbase", "active": {"$ne": False}})
            + db().admin_products.count_documents({"source": "custom", "active": True})
        )
    else:
        offer["productCount"] = len(input.productIds)
    offer["shareImage"], _ = _mirror_inline_media(
        offer.get("shareImage", ""),
        f"offers/{offer['id']}/shareImage",
        _cloudinary_credentials(),
    )
    db().offers.replace_one({"id": offer["id"]}, offer, upsert=True)
    return offer

@app.delete("/api/admin/offers/{offer_id}")
def remove_offer(offer_id: str, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    result = db().offers.delete_one({"id": offer_id})
    if not result.deleted_count:
        raise HTTPException(status_code=404, detail="Offer not found.")
    return {"ok": True}

@app.get("/api/admin/orders")
def admin_orders(authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    return list(db().orders.find({}, {"_id": 0}).sort("createdAt", -1))

def _github_sync_settings():
    token = os.getenv("GITHUB_ACTIONS_TOKEN", "").strip()
    repository = os.getenv("GITHUB_SYNC_REPOSITORY", "tashfinn/AARO").strip()
    workflow = os.getenv("GITHUB_SYNC_WORKFLOW", "shopbase-sync.yml").strip()
    if not token:
        raise HTTPException(status_code=503, detail="Add GITHUB_ACTIONS_TOKEN to the Render API environment to enable Sync Now.")
    if repository.count("/") != 1 or not workflow:
        raise HTTPException(status_code=500, detail="GitHub sync repository or workflow configuration is invalid.")
    return token, repository, workflow

def _github_headers(token: str):
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
    }

def _save_github_secret(name: str, value: str):
    if name not in ("SHOPBASE_SESSION_COOKIE", "SHOPBASE_USERNAME", "SHOPBASE_PASSWORD"):
        raise HTTPException(status_code=400, detail="Unsupported GitHub secret name.")
    token, repository, _ = _github_sync_settings()
    headers = _github_headers(token)
    try:
        key_response = requests.get(f"https://api.github.com/repos/{repository}/actions/secrets/public-key", headers=headers, timeout=15)
        if key_response.status_code in (401, 403):
            raise HTTPException(status_code=502, detail="GitHub token needs repository secrets read and write permission.")
        key_response.raise_for_status()
        key = key_response.json()
        sealed = public.SealedBox(public.PublicKey(key["key"], encoding.Base64Encoder)).encrypt(value.encode())
        response = requests.put(f"https://api.github.com/repos/{repository}/actions/secrets/{name}", headers=headers, json={"encrypted_value": base64.b64encode(sealed).decode(), "key_id": key["key_id"]}, timeout=15)
        if response.status_code in (401, 403):
            raise HTTPException(status_code=502, detail="GitHub token needs repository secrets write permission.")
        if response.status_code not in (201, 204):
            response.raise_for_status()
            raise HTTPException(status_code=502, detail=f"GitHub did not accept the encrypted {name} secret.")
    except requests.RequestException as error:
        raise HTTPException(status_code=502, detail="Could not update the GitHub Actions secret.") from error

def _save_github_shopbase_cookie(cookie: str):
    _save_github_secret("SHOPBASE_SESSION_COOKIE", cookie)

def _valid_shopbase_cookie(cookie: str):
    return "\n" not in cookie and "\r" not in cookie and ("cookie" in cookie.lower() or "=" in cookie)

@app.put("/api/admin/sync/cookie")
def update_shopbase_cookie(input: SyncCookieInput, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    cookie = input.cookie.strip()
    if not _valid_shopbase_cookie(cookie):
        raise HTTPException(status_code=422, detail="Paste the ShopBase Cookie request value.")
    _save_github_shopbase_cookie(cookie)
    return {"ok": True, "message": "ShopBase sync cookie saved securely to GitHub Actions."}

@app.get("/api/admin/sync/login")
def shopbase_login_status(authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    settings = db().sync_settings.find_one({"_id": "shopbase-hosted-login"}, {"_id": 0, "configuredAt": 1}) or {}
    return {"configured": bool(settings.get("configuredAt")), "configuredAt": settings.get("configuredAt")}

@app.put("/api/admin/sync/login")
def save_shopbase_login(input: ShopBaseLoginInput, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    username = input.username.strip()
    if not username or "\n" in username or "\r" in username or "\n" in input.password or "\r" in input.password:
        raise HTTPException(status_code=422, detail="Enter a valid ShopBase phone number and password.")
    _save_github_secret("SHOPBASE_USERNAME", username)
    _save_github_secret("SHOPBASE_PASSWORD", input.password)
    configured_at = datetime.now(timezone.utc).isoformat()
    db().sync_settings.update_one({"_id": "shopbase-hosted-login"}, {"$set": {"configuredAt": configured_at}}, upsert=True)
    return {"ok": True, "configured": True, "configuredAt": configured_at, "message": "ShopBase login saved as encrypted GitHub Actions secrets. The credentials are not stored in the catalog database."}

@app.delete("/api/admin/sync/login")
def remove_shopbase_login(authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    token, repository, _ = _github_sync_settings()
    headers = _github_headers(token)
    try:
        for name in ("SHOPBASE_USERNAME", "SHOPBASE_PASSWORD"):
            response = requests.delete(f"https://api.github.com/repos/{repository}/actions/secrets/{name}", headers=headers, timeout=15)
            if response.status_code in (401, 403):
                raise HTTPException(status_code=502, detail="GitHub token needs repository secrets write permission.")
            if response.status_code not in (204, 404):
                response.raise_for_status()
    except requests.RequestException as error:
        raise HTTPException(status_code=502, detail="Could not remove the hosted ShopBase login secrets.") from error
    db().sync_settings.delete_one({"_id": "shopbase-hosted-login"})
    return {"ok": True, "configured": False, "message": "Hosted ShopBase login secrets removed from GitHub Actions."}

def _github_sync_runs(token: str, repository: str, workflow: str):
    url = f"https://api.github.com/repos/{repository}/actions/workflows/{workflow}/runs"
    response = requests.get(url, headers=_github_headers(token), params={"per_page": 20}, timeout=15)
    if response.status_code in (401, 403):
        raise HTTPException(status_code=502, detail="GitHub rejected GITHUB_ACTIONS_TOKEN. It needs Actions read and write access to this repository.")
    response.raise_for_status()
    payload = response.json()
    return payload.get("workflow_runs", []) if isinstance(payload, dict) else []

def _stamp(value: str | None):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None

@app.get("/api/admin/sync/schedule")
def admin_sync_schedule(authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    settings = db().sync_settings.find_one({"_id": "catalog-schedule"}, {"_id": 0, "intervalHours": 1, "startTime": 1}) or {}
    interval = settings.get("intervalHours", 24)
    start_time = settings.get("startTime", "00:00")
    if not isinstance(start_time, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):00", start_time):
        start_time = "00:00"
    return {"intervalHours": interval if interval in (6, 12, 24, 48) else 24, "startTime": start_time}

@app.patch("/api/admin/sync/schedule")
def update_admin_sync_schedule(input: SyncScheduleInput, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    if input.intervalHours not in (6, 12, 24, 48):
        raise HTTPException(status_code=422, detail="Choose a 6, 12, 24, or 48 hour sync interval.")
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):00", input.startTime):
        raise HTTPException(status_code=422, detail="Choose an hourly start time in Bangladesh time.")
    db().sync_settings.update_one(
        {"_id": "catalog-schedule"},
        {"$set": {"intervalHours": input.intervalHours, "startTime": input.startTime, "updatedAt": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    return {"intervalHours": input.intervalHours, "startTime": input.startTime}

@app.post("/api/admin/sync/run")
def start_admin_sync(input: SyncRequest, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    token, repository, workflow = _github_sync_settings()
    try:
        runs = _github_sync_runs(token, repository, workflow)
        active = next((run for run in runs if run.get("status") in ("queued", "in_progress")), None)
        if active:
            requested_at = active.get("created_at") or datetime.now(timezone.utc).isoformat()
            db().sync_control.update_one({"_id": "manual"}, {"$set": {
                "requestedAt": requested_at,
                "runId": active.get("id"),
                "status": active.get("status"),
                "htmlUrl": active.get("html_url"),
                "repository": repository,
                "workflow": workflow,
            }}, upsert=True)
            return {"status": "running", "requestedAt": requested_at, "workflowRunId": active.get("id"), "workflowUrl": active.get("html_url"), "alreadyRunning": True}

        requested_at = datetime.now(timezone.utc).isoformat()
        db().sync_control.update_one({"_id": "manual"}, {"$set": {
            "requestedAt": requested_at,
            "runId": None,
            "status": "queued",
            "htmlUrl": None,
            "repository": repository,
            "workflow": workflow,
            "error": None,
        }}, upsert=True)
        url = f"https://api.github.com/repos/{repository}/actions/workflows/{workflow}/dispatches"
        response = requests.post(
            url,
            headers=_github_headers(token),
            json={"ref": "main", "inputs": {"refresh_details": "true" if input.refresh_details else "false"}},
            timeout=20,
        )
        if response.status_code in (401, 403):
            raise HTTPException(status_code=502, detail="GitHub rejected GITHUB_ACTIONS_TOKEN. It needs Actions write access to this repository.")
        if response.status_code != 204:
            response.raise_for_status()
            raise HTTPException(status_code=502, detail="GitHub did not accept the sync workflow request.")
        return {"status": "queued", "requestedAt": requested_at, "refreshDetails": input.refresh_details}
    except HTTPException as error:
        db().sync_control.update_one({"_id": "manual"}, {"$set": {"status": "failed", "error": error.detail, "updatedAt": datetime.now(timezone.utc).isoformat()}}, upsert=True)
        raise
    except requests.RequestException as error:
        message = "Could not start the GitHub sync workflow. Check the Render API outbound connection and GitHub token."
        db().sync_control.update_one({"_id": "manual"}, {"$set": {"status": "failed", "error": message, "updatedAt": datetime.now(timezone.utc).isoformat()}}, upsert=True)
        raise HTTPException(status_code=502, detail=message) from error

@app.get("/api/admin/sync/progress")
def admin_sync_progress(authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    fields = {"_id": 0, "runId": 1, "status": 1, "phase": 1, "error": 1, "startedAt": 1, "updatedAt": 1, "finishedAt": 1, "categoriesProcessed": 1, "totalCategories": 1, "productsDiscovered": 1, "productsProcessed": 1, "totalProducts": 1, "created": 1, "changed": 1, "unchanged": 1, "skippedDetails": 1}
    progress = db().sync_runs.find_one({}, fields, sort=[("startedAt", -1)]) or {"status": "not_started", "phase": "idle"}
    control = db().sync_control.find_one({"_id": "manual"}, {"_id": 0})
    if not control:
        response = dict(progress)
        try:
            token, repository, workflow = _github_sync_settings()
            scheduled_runs = [run for run in _github_sync_runs(token, repository, workflow) if run.get("event") == "schedule"]
            latest_scheduled = scheduled_runs[0] if scheduled_runs else None
            if latest_scheduled:
                workflow_time = _stamp(latest_scheduled.get("created_at"))
                importer_time = _stamp(progress.get("startedAt"))
                importer_is_current = bool(workflow_time and importer_time and importer_time >= workflow_time)
                response.update({
                    "workflowStatus": latest_scheduled.get("status"),
                    "workflowRunId": latest_scheduled.get("id"),
                    "workflowUrl": latest_scheduled.get("html_url"),
                    "workflowStartedAt": latest_scheduled.get("run_started_at") or latest_scheduled.get("created_at"),
                    "workflowFinishedAt": latest_scheduled.get("updated_at") if latest_scheduled.get("status") == "completed" else None,
                })
                if not importer_is_current and latest_scheduled.get("status") in ("queued", "in_progress"):
                    response.update({"status": "running", "phase": "schedule_check" if latest_scheduled.get("status") == "in_progress" else "queued", "startedAt": latest_scheduled.get("created_at"), "progressPercent": 0})
                elif not importer_is_current and latest_scheduled.get("status") == "completed" and latest_scheduled.get("conclusion") not in ("success", "skipped"):
                    response.update({"status": "failed", "phase": "failed", "error": "The scheduled GitHub workflow failed before it reported catalog progress. Open the workflow run for its failure details."})
        except (HTTPException, requests.RequestException):
            pass
        return response
    response = dict(progress)
    response["workflowStatus"] = control.get("status", "queued")
    response["workflowRunId"] = control.get("runId")
    response["workflowUrl"] = control.get("htmlUrl")
    requested_at = control.get("requestedAt")
    progress_at = _stamp(progress.get("startedAt"))
    request_time = _stamp(requested_at)
    importer_is_current = bool(progress_at and request_time and progress_at >= request_time)
    if control.get("status") == "failed" and not importer_is_current:
        response.update({"status": "failed", "phase": "failed", "error": control.get("error", "Could not start sync.")})
        return response
    try:
        token, repository, workflow = _github_sync_settings()
        runs = _github_sync_runs(token, repository, workflow)
        run = next((item for item in runs if item.get("id") == control.get("runId")), None)
        if not run and request_time:
            candidates = [
                item for item in runs
                if item.get("event") == "workflow_dispatch"
                and _stamp(item.get("created_at"))
                and _stamp(item.get("created_at")) >= request_time
            ]
            run = candidates[0] if candidates else None
        if run:
            response["workflowStatus"] = run.get("status", "queued")
            response["workflowConclusion"] = run.get("conclusion")
            response["workflowRunId"] = run.get("id")
            response["workflowUrl"] = run.get("html_url")
            response["workflowStartedAt"] = run.get("run_started_at") or run.get("created_at")
            response["workflowFinishedAt"] = run.get("updated_at") if run.get("status") == "completed" else None
            db().sync_control.update_one({"_id": "manual"}, {"$set": {
                "runId": run.get("id"),
                "status": run.get("status"),
                "htmlUrl": run.get("html_url"),
                "updatedAt": datetime.now(timezone.utc).isoformat(),
            }})
            if not importer_is_current:
                if run.get("status") in ("queued", "in_progress"):
                    response.update({"status": "running", "phase": "queued" if run.get("status") == "queued" else "starting", "startedAt": requested_at})
                elif run.get("status") == "completed" and run.get("conclusion") != "success":
                    response.update({"status": "failed", "phase": "failed", "error": "GitHub Actions sync failed before the importer reported progress."})
                elif run.get("status") == "completed" and run.get("conclusion") == "success":
                    response.update({"status": "failed", "phase": "failed", "error": "The workflow completed without writing importer progress. Check the GitHub Actions run."})
    except (HTTPException, requests.RequestException):
        if not importer_is_current and control.get("status") in ("queued", "in_progress"):
            response.update({"status": "running", "phase": "queued", "startedAt": requested_at})
    if response.get("status") in ("success", "success_with_skipped_details"):
        response["progressPercent"] = 100
    elif response.get("phase") == "updating_products" and response.get("totalProducts"):
        response["progressPercent"] = min(99, 15 + round((response.get("productsProcessed", 0) / response["totalProducts"]) * 85))
    elif response.get("totalCategories"):
        response["progressPercent"] = round((response.get("categoriesProcessed", 0) / response["totalCategories"]) * 15)
    else:
        response["progressPercent"] = 0
    return response


@app.patch("/api/admin/orders/{order_id}")
def update_order(order_id: str, input: OrderStatusInput, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    allowed = {"Pending confirmation", "Confirmed", "Processing", "Shipped", "Delivered", "Cancelled"}
    if input.status not in allowed:
        raise HTTPException(status_code=422, detail="Unknown order status.")
    result = db().orders.update_one({"id": order_id}, {"$set": {"status": input.status}})
    if not result.matched_count:
        raise HTTPException(status_code=404, detail="Order not found.")
    return {"ok": True}

def _catalog_product_id(product: dict[str, Any]) -> str:
    return f"shopbase-{product.get('sourceId', '')}" if product.get("source") == "shopbase" else str(product.get("id", ""))

def _shopbase_effective_price(source: dict[str, Any] | None, override: dict[str, Any]) -> float:
    source = source or {}
    original = float(source.get("suggestedRetailPrice") or source.get("price") or 0)
    discounted = override.get("discountedPrice")
    if discounted is None:
        try:
            legacy_price = float(override.get("price"))
            legacy_compare = float(override.get("compareAt"))
            if legacy_price < legacy_compare:
                discounted = legacy_price
        except (TypeError, ValueError):
            pass
    try:
        discounted = float(discounted) if discounted is not None else None
    except (TypeError, ValueError):
        discounted = None
    return discounted if discounted is not None and 0 <= discounted < original else original

def _category_groups_for_store(store):
    settings = store.store_settings.find_one({"_id": "storefront"}, {"_id": 0, "categoryGroups": 1}) or {}
    categories = list(store.categories.find({"source": "shopbase", "type": {"$ne": "parent"}}, {"_id": 0, "sourceId": 1, "name": 1, "parentId": 1, "parentName": 1, "sortOrder": 1, "sourceOrder": 1}))
    if categories and all(item.get("sourceOrder") is not None for item in categories):
        categories.sort(key=lambda item: item["sourceOrder"])
    live_groups = category_group_payload(categories)
    saved_groups = settings.get("categoryGroups")
    if not isinstance(saved_groups, list):
        return live_groups, False
    normalize = lambda value: re.sub(r"[\s\u00a0\-–—_.,:;|]+", "", str(value or "").casefold())
    merged = []
    for saved in saved_groups:
        live = next((group for group in live_groups if group["id"] == saved["id"]), None)
        children = list(saved.get("children", []))
        known = {child.get("sourceId") or normalize(child.get("name")) for child in children}
        if live:
            for child in live.get("children", []):
                key = child.get("sourceId") or normalize(child.get("name"))
                match_index = next((index for index, item in enumerate(children) if (item.get("sourceId") and item.get("sourceId") == child.get("sourceId")) or normalize(item.get("name")) == normalize(child.get("name"))), None)
                if match_index is None and key not in known:
                    children.append(child)
                    known.add(key)
                elif match_index is not None and not children[match_index].get("sourceId") and child.get("sourceId"):
                    children[match_index]["sourceId"] = child["sourceId"]
            merged.append({**saved, "children": children})
        else:
            merged.append(saved)
    saved_ids = {group["id"] for group in saved_groups}
    merged.extend(group for group in live_groups if group["id"] not in saved_ids)
    # ShopBase can expose a duplicate subcategory ID with the same visible
    # name. Keep the populated source category and drop an empty duplicate.
    product_counts = {str(row["_id"]): row["count"] for row in store.products.aggregate([
        {"$match": {"source": "shopbase", "categorySourceId": {"$exists": True, "$ne": None}}},
        {"$group": {"_id": {"$toString": "$categorySourceId"}, "count": {"$sum": 1}}},
    ])}
    for group in merged:
        children = group.get("children", [])
        by_name = {}
        for child in children:
            key = re.sub(r"[\s\u00a0\-–—_.,:;|]+", "", str(child.get("name", "")).casefold())
            by_name.setdefault(key, []).append(child)
        drop_ids = set()
        for duplicates in by_name.values():
            populated = [item for item in duplicates if product_counts.get(str(item.get("sourceId", "")), 0) > 0]
            if len(duplicates) > 1 and populated:
                drop_ids.update(str(item.get("sourceId")) for item in duplicates if item not in populated)
        group["children"] = [item for item in children if str(item.get("sourceId")) not in drop_ids]
    return merged, True

@app.get("/api/admin/storefront")
def admin_storefront_settings(authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    settings = db().store_settings.find_one({"_id": "storefront"}) or {}
    return {key: settings[key] for key in ("content", "categoryGroups", "manualCategories", "manualCategoryVisibility") if key in settings}

@app.get("/api/admin/storefront-media/status")
def storefront_media_status(authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    store = db()
    inline, cloudinary = _stored_media_counts(store)
    return {
        "configured": _cloudinary_credentials() is not None,
        "cloudinaryImages": cloudinary,
        "inlineImages": inline,
    }

@app.post("/api/admin/storefront-media/migrate")
def migrate_storefront_media(authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    store = db()
    credentials = _cloudinary_credentials()
    settings = store.store_settings.find_one({"_id": "storefront"}, {"_id": 0, "content": 1}) or {}
    content = settings.get("content") if isinstance(settings.get("content"), dict) else {}
    updated, uploaded = _mirror_inline_media(content, "content", credentials)
    if uploaded:
        store.store_settings.update_one(
            {"_id": "storefront"},
            {"$set": {"content": updated, "updatedAt": datetime.now(timezone.utc).isoformat()}},
        )
    uploaded += _migrate_product_collection_images(store.admin_products, "admin-products", credentials)
    offers_uploaded = 0
    for offer in store.offers.find({"shareImage": {"$regex": "^data:image/"}}, {"_id": 1, "id": 1, "shareImage": 1}):
        offer_id = str(offer.get("id") or offer.get("_id"))
        share_image, count = _mirror_inline_media(offer.get("shareImage", ""), f"offers/{offer_id}/shareImage", credentials)
        if count:
            store.offers.update_one({"_id": offer["_id"]}, {"$set": {"shareImage": share_image}})
            offers_uploaded += count
    uploaded += offers_uploaded
    remaining, cloudinary = _stored_media_counts(store)
    return {"content": updated, "uploaded": uploaded, "remainingInlineImages": remaining, "cloudinaryImages": cloudinary}

@app.get("/api/storefront-preview")
def storefront_preview_settings():
    settings = db().store_settings.find_one({"_id": "storefront"}, {"_id": 0, "content.socialShareImage": 1}) or {}
    content = settings.get("content") if isinstance(settings.get("content"), dict) else {}
    return {"socialShareImage": content.get("socialShareImage", "")}

@app.get("/api/storefront-hero")
def storefront_hero(response: Response):
    # Project metadata in Mongo so inline banner images never travel in this
    # JSON response. Each image is fetched separately and browser-cacheable.
    settings = next(iter(db().store_settings.aggregate([
        {"$match": {"_id": "storefront"}},
        {"$project": {
            "_id": 0,
            "updatedAt": 1,
            "heroSlides": {"$map": {
                "input": {"$ifNull": ["$content.heroSlides", []]},
                "as": "slide",
                "in": {
                    "title": "$$slide.title",
                    "description": "$$slide.description",
                    "cta": "$$slide.cta",
                    "link": "$$slide.link",
                    "image": {"$cond": [
                        {"$regexMatch": {"input": {"$convert": {"input": "$$slide.image", "to": "string", "onNull": ""}}, "regex": "^data:image/"}},
                        None,
                        "$$slide.image",
                    ]},
                    "imageIsInline": {"$regexMatch": {"input": {"$convert": {"input": "$$slide.image", "to": "string", "onNull": ""}}, "regex": "^data:image/"}},
                    "mobileImage": {"$cond": [
                        {"$regexMatch": {"input": {"$convert": {"input": "$$slide.mobileImage", "to": "string", "onNull": ""}}, "regex": "^data:image/"}},
                        None,
                        {"$ifNull": ["$$slide.mobileImage", ""]},
                    ]},
                    "mobileImageIsInline": {"$regexMatch": {"input": {"$convert": {"input": "$$slide.mobileImage", "to": "string", "onNull": ""}}, "regex": "^data:image/"}},
                },
            }},
        }},
    ])), {})
    slides = settings.get("heroSlides", []) if isinstance(settings, dict) else []
    version = str(settings.get("updatedAt") or "0") if isinstance(settings, dict) else "0"
    for index, slide in enumerate(slides):
        if not isinstance(slide, dict):
            continue
        if slide.pop("imageIsInline", False):
            slide["image"] = f"/api/storefront-hero-image/{index}?variant=desktop&v={version}"
        if slide.pop("mobileImageIsInline", False):
            slide["mobileImage"] = f"/api/storefront-hero-image/{index}?variant=mobile&v={version}"
    response.headers["Cache-Control"] = "public, max-age=60, stale-while-revalidate=300"
    return {"heroSlides": slides}

@app.get("/api/storefront-hero-image/{index}")
def storefront_hero_image(index: int, variant: Literal["desktop", "mobile"] = "desktop"):
    if index < 0 or index >= 100:
        raise HTTPException(status_code=404, detail="Banner image not found.")
    settings = db().store_settings.find_one(
        {"_id": "storefront"},
        {"_id": 0, "content.heroSlides": {"$slice": [index, 1]}, "updatedAt": 1},
    ) or {}
    content = settings.get("content") if isinstance(settings.get("content"), dict) else {}
    slides = content.get("heroSlides") if isinstance(content.get("heroSlides"), list) else []
    if not slides or not isinstance(slides[0], dict):
        raise HTTPException(status_code=404, detail="Banner image not found.")
    value = slides[0].get("mobileImage" if variant == "mobile" else "image", "")
    match = re.fullmatch(r"data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)", value if isinstance(value, str) else "")
    if not match:
        raise HTTPException(status_code=404, detail="Banner image not found.")
    try:
        image = base64.b64decode(match.group(2), validate=True)
    except ValueError:
        raise HTTPException(status_code=404, detail="Banner image not found.")
    etag = hashlib.sha256(image).hexdigest()
    return Response(image, media_type=match.group(1), headers={"Cache-Control": "public, max-age=3600, stale-while-revalidate=86400", "ETag": f'"{etag}"'})

@app.get("/api/share-thumbnail/{kind}/{resource_id}")
def share_thumbnail(kind: str, resource_id: str):
    if kind == "home":
        settings = db().store_settings.find_one({"_id": "storefront"}, {"_id": 0, "content.socialShareImage": 1}) or {}
        content = settings.get("content") if isinstance(settings.get("content"), dict) else {}
        value = content.get("socialShareImage", "")
    elif kind == "offer":
        offer = db().offers.find_one({"id": resource_id, "active": True}, {"_id": 0, "shareImage": 1}) or {}
        value = offer.get("shareImage", "")
    else:
        raise HTTPException(status_code=404, detail="Thumbnail not found.")
    if isinstance(value, str) and value.startswith("https://res.cloudinary.com/"):
        return RedirectResponse(value, status_code=307, headers={"Cache-Control": "public, max-age=86400"})
    match = re.fullmatch(r"data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)", value if isinstance(value, str) else "")
    if not match:
        raise HTTPException(status_code=404, detail="Thumbnail not found.")
    try:
        image = base64.b64decode(match.group(2), validate=True)
    except ValueError:
        raise HTTPException(status_code=404, detail="Thumbnail not found.")
    return Response(image, media_type=match.group(1), headers={"Cache-Control": "public, max-age=300"})

@app.patch("/api/admin/storefront")
def update_admin_storefront(input: StorefrontSettingsInput, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    values: dict[str, Any] = {}
    if input.content is not None:
        content, _ = _mirror_inline_media(input.content, "content", _cloudinary_credentials())
        if len(json.dumps(content, ensure_ascii=False)) > 8_000_000:
            raise HTTPException(status_code=422, detail="Storefront settings are too large to save.")
        values["content"] = content
    if input.categoryGroups is not None:
        groups: list[dict[str, Any]] = []
        for group in input.categoryGroups[:100]:
            if not isinstance(group.get("id"), str) or not isinstance(group.get("name"), str) or not isinstance(group.get("children"), list):
                raise HTTPException(status_code=422, detail="Each category group needs an ID, name, and child list.")
            children = []
            for child in group["children"][:1000]:
                if not isinstance(child, dict) or not isinstance(child.get("name"), str):
                    continue
                item = {key: child[key] for key in ("name", "sourceId", "sortOrder") if key in child and isinstance(child[key], (str, int, float))}
                if isinstance(child.get("showInStorefront"), bool):
                    item["showInStorefront"] = child["showInStorefront"]
                children.append(item)
            saved_group = {"id": group["id"][:180], "name": group["name"][:180], "children": children}
            if isinstance(group.get("showInStorefront"), bool):
                saved_group["showInStorefront"] = group["showInStorefront"]
            groups.append(saved_group)
        values["categoryGroups"] = groups
    if input.manualCategories is not None:
        values["manualCategories"] = list(dict.fromkeys(value.strip()[:180] for value in input.manualCategories[:500] if value.strip()))
    if input.manualCategoryVisibility is not None:
        values["manualCategoryVisibility"] = {name.strip()[:180]: visible for name, visible in list(input.manualCategoryVisibility.items())[:500] if isinstance(name, str) and name.strip() and isinstance(visible, bool)}
    if values:
        values["updatedAt"] = datetime.now(timezone.utc).isoformat()
        db().store_settings.update_one({"_id": "storefront"}, {"$set": values}, upsert=True)
    return {key: values[key] for key in values if key != "updatedAt"}

@app.put("/api/admin/products")
def save_admin_product(input: AdminProductInput, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    product = input.model_dump(exclude_unset=True)
    product.setdefault("updatedAt", datetime.now(timezone.utc).isoformat())
    existing = db().admin_products.find_one({"id": product["id"]})
    if not product.get("addedAt"):
        product["addedAt"] = (existing or {}).get("addedAt") or (existing.get("_id").generation_time.isoformat() if existing and getattr(existing.get("_id"), "generation_time", None) else datetime.now(timezone.utc).isoformat())
    if product["source"] == "shopbase":
        if not product.get("sourceId"):
            product["sourceId"] = product["id"].removeprefix("shopbase-")
        source = db().products.find_one({"sourceId": product["sourceId"], "source": "shopbase"}, {"_id": 0, "price": 1, "suggestedRetailPrice": 1})
        if not source:
            raise HTTPException(status_code=404, detail="The ShopBase product is no longer in the catalog.")
        # Supplier price is the default, but admins may set a durable selling
        # price override for imported products from the catalog editor.
        original_price = float(product.get("originalPrice") if product.get("originalPrice") is not None else (source.get("suggestedRetailPrice") or source.get("price") or 0))
        discounted_price = product.get("discountedPrice")
        if discounted_price is not None and float(discounted_price) >= original_price:
            raise HTTPException(status_code=422, detail="Discounted selling price must be lower than the original price.")
        product["originalPrice"] = original_price
        product["discountedPrice"] = float(discounted_price) if discounted_price is not None else None
        product["price"] = float(discounted_price) if discounted_price is not None else original_price
        product["compareAt"] = original_price if discounted_price is not None else None
    else:
        original_price = product.get("originalPrice")
        if original_price is None:
            legacy_compare = product.get("compareAt")
            original_price = legacy_compare if legacy_compare is not None and float(legacy_compare) > float(product["price"]) else product["price"]
        discounted_price = product.get("discountedPrice")
        if discounted_price is None and float(product["price"]) < float(original_price):
            discounted_price = product["price"]
        if discounted_price is not None and float(discounted_price) >= float(original_price):
            raise HTTPException(status_code=422, detail="Discounted selling price must be lower than the original price.")
        product["originalPrice"] = float(original_price)
        product["discountedPrice"] = float(discounted_price) if discounted_price is not None else None
        product["price"] = float(discounted_price) if discounted_price is not None else float(original_price)
        product["compareAt"] = float(original_price) if discounted_price is not None else None
    images = product.get("images") or [product.get("image", "")]
    images = list(dict.fromkeys(image.strip() for image in images if isinstance(image, str) and image.strip()))[:20]
    if not images or any(len(image) > 8_000_000 or not image.startswith(("http://", "https://", "data:image/")) for image in images):
        raise HTTPException(status_code=422, detail="Add at least one valid product image URL.")
    product["images"], _ = _mirror_inline_media(images, f"admin-products/{product['id']}/images", _cloudinary_credentials())
    product["image"] = product["images"][0]
    db().admin_products.replace_one({"id": product["id"]}, product, upsert=True)
    return product

@app.post("/api/admin/products/bulk-price-adjustment")
def bulk_adjust_product_prices(input: BulkPriceAdjustmentInput, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    store = db()
    query: dict[str, Any] = {"source": "shopbase", "sourceId": {"$exists": True}}
    if input.scope == "subcategory":
        if input.categorySourceId:
            query["categorySourceId"] = input.categorySourceId
        elif input.category:
            query["category"] = input.category
        else:
            raise HTTPException(status_code=422, detail="Choose a subcategory first.")
    elif input.scope == "category":
        if input.parentCategoryId:
            query["parentCategoryId"] = input.parentCategoryId
        elif input.category:
            query["category"] = input.category
        else:
            raise HTTPException(status_code=422, detail="Choose a category first.")
    elif input.scope == "offer":
        offer = store.offers.find_one({"id": input.offerId}, {"_id": 0, "productIds": 1, "productId": 1}) if input.offerId else None
        if not offer:
            raise HTTPException(status_code=422, detail="Choose an offer first.")
        ids = list(dict.fromkeys((offer.get("productIds") or []) + ([offer.get("productId")] if offer.get("productId") else [])))
        query = {"source": "shopbase", "$or": [{"sourceId": {"$in": [value.removeprefix("shopbase-") for value in ids]}}, {"id": {"$in": ids}}]}
    if input.search.strip():
        query["title"] = {"$regex": re.escape(input.search.strip()[:100]), "$options": "i"}
    sources = list(store.products.find(query, {"_id": 0, "sourceId": 1, "id": 1, "title": 1, "category": 1, "price": 1, "suggestedRetailPrice": 1}))
    source_ids = [str(item.get("sourceId")) for item in sources if item.get("sourceId")]
    overrides = {item["id"]: item for item in store.admin_products.find({"source": "shopbase", "id": {"$in": [f"shopbase-{value}" for value in source_ids]}})}
    changed = 0
    now = datetime.now(timezone.utc).isoformat()
    def adjust(value: float) -> float:
        delta = value * input.value / 100 if input.adjustmentType == "percent" else input.value
        return round(max(0, value + delta * (1 if input.direction == "increase" else -1)), 2)
    for source in sources:
        pid = f"shopbase-{source['sourceId']}"
        override = overrides.get(pid, {})
        regular = float(override.get("originalPrice") or override.get("compareAt") or source.get("suggestedRetailPrice") or source.get("price") or 0)
        sale = override.get("discountedPrice")
        sale = float(sale) if sale is not None and float(sale) < regular else None
        new_regular = adjust(regular)
        new_sale = min(adjust(sale), max(0, new_regular - 0.01)) if sale is not None else None
        store.admin_products.update_one({"id": pid}, {"$set": {"id": pid, "source": "shopbase", "sourceId": str(source["sourceId"]), "title": override.get("title") or source.get("title", ""), "category": override.get("category") or source.get("category", ""), "originalPrice": new_regular, "discountedPrice": new_sale, "price": new_sale if new_sale is not None else new_regular, "compareAt": new_regular if new_sale is not None else None, "updatedAt": now}}, upsert=True)
        changed += 1
    custom_query: dict[str, Any] = {"source": "custom"}
    if input.scope == "subcategory": custom_query["categorySourceId" if input.categorySourceId else "category"] = input.categorySourceId or input.category
    elif input.scope == "category": custom_query["parentCategoryId" if input.parentCategoryId else "category"] = input.parentCategoryId or input.category
    elif input.scope == "offer":
        custom_query["id"] = {"$in": ids}
    if input.search.strip(): custom_query["title"] = {"$regex": re.escape(input.search.strip()[:100]), "$options": "i"}
    for product in store.admin_products.find(custom_query):
        regular = float(product.get("originalPrice") or product.get("compareAt") or product.get("price") or 0)
        sale = product.get("discountedPrice")
        sale = float(sale) if sale is not None and float(sale) < regular else None
        new_regular = adjust(regular)
        new_sale = min(adjust(sale), max(0, new_regular - 0.01)) if sale is not None else None
        store.admin_products.update_one({"_id": product["_id"]}, {"$set": {"originalPrice": new_regular, "discountedPrice": new_sale, "price": new_sale if new_sale is not None else new_regular, "compareAt": new_regular if new_sale is not None else None, "updatedAt": now}})
        changed += 1
    return {"updated": changed}

@app.get("/api/admin/products")
def list_admin_products(authorization: str | None = Header(default=None), offset: int | None = Query(default=None, ge=0), limit: int = Query(default=100, ge=1, le=400), search: str | None = Query(default=None, max_length=100), sort: Literal["added", "updated", "name-asc", "name-desc", "price-asc", "price-desc", "views"] = "name-asc"):
    _admin_from_auth(authorization)
    store = db()
    needle = (search or "").strip()
    if sort == "views" and offset is not None:
        fields = {"_id": 1, "sourceId": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "suggestedRetailPrice": 1, "wholesalePrice": 1, "compareAt": 1, "image": 1, "stock": 1, "active": 1, "source": 1, "addedAt": 1, "updatedAt": 1, "trending": 1, "offer": 1, "badge": 1, "rating": 1, "reviews": 1, "sizes": 1, "options": 1}
        view_query: dict[str, Any] = {}
        if needle:
            escaped = re.escape(needle.removeprefix("shopbase-")[:100])
            view_query["productId"] = {"$regex": escaped, "$options": "i"}
        ranked = list(store.product_views.find(view_query, {"_id": 0, "productId": 1, "views": 1}).sort([("views", -1), ("productId", 1)]).skip(offset).limit(limit))
        ranked_ids = [str(item.get("productId", "")) for item in ranked if item.get("productId")]
        source_ids = [value.removeprefix("shopbase-") for value in ranked_ids if value.startswith("shopbase-")]
        custom_ids = [value for value in ranked_ids if not value.startswith("shopbase-")]
        source_docs = list(store.products.find({"source": "shopbase", "sourceId": {"$in": source_ids}}, fields)) if source_ids else []
        custom_fields = {**fields, "_id": 0, "id": 1}
        custom_docs = list(store.admin_products.find({"source": "custom", "id": {"$in": custom_ids}}, custom_fields)) if custom_ids else []
        ids = [_catalog_product_id(item) for item in source_docs]
        override_fields = {"_id": 0, "id": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "originalPrice": 1, "discountedPrice": 1, "compareAt": 1, "image": 1, "images": {"$slice": 1}, "stock": 1, "active": 1, "trending": 1, "offer": 1, "badge": 1, "sizes": 1, "options": 1, "updatedAt": 1}
        overrides = {item["id"]: item for item in store.admin_products.find({"source": "shopbase", "id": {"$in": ids}}, override_fields)} if ids else {}
        by_id: dict[str, dict[str, Any]] = {}
        for item in source_docs:
            product = public_product(item); product.pop("_id", None)
            product["addedAt"] = item.get("addedAt") or (item.get("_id").generation_time.isoformat() if getattr(item.get("_id"), "generation_time", None) else None)
            override = overrides.get(product["id"])
            by_id[product["id"]] = _apply_shopbase_override(product, override, retailer_price=item.get("wholesalePrice")) if override else product
        for item in custom_docs:
            item["addedAt"] = item.get("addedAt") or (item.get("_id").generation_time.isoformat() if getattr(item.get("_id"), "generation_time", None) else None)
            item.pop("_id", None); by_id[item["id"]] = item
        products = [by_id[pid] for pid in ranked_ids if pid in by_id]
        total = store.products.count_documents({"source": "shopbase"}) + store.admin_products.count_documents({"source": "custom"})
        if len(products) < limit and offset + len(ranked) >= store.product_views.count_documents(view_query):
            missing = max(0, limit - len(products))
            fallback_query: dict[str, Any] = {"source": "shopbase"}
            if needle:
                pattern = re.escape(needle)
                fallback_query["$or"] = [{"title": {"$regex": pattern, "$options": "i"}}, {"category": {"$regex": pattern, "$options": "i"}}, {"sourceId": {"$regex": pattern, "$options": "i"}}]
            excluded = [pid.removeprefix("shopbase-") for pid in ranked_ids if pid.startswith("shopbase-")]
            if excluded: fallback_query["sourceId"] = {"$nin": excluded}
            fallback = list(store.products.find(fallback_query, fields).sort([("title", 1), ("_id", 1)]).limit(missing))
            fallback_source_ids = [str(item.get("sourceId")) for item in fallback if item.get("sourceId")]
            fallback_product_ids = [f"shopbase-{value}" for value in fallback_source_ids]
            fallback_overrides = {item["id"]: item for item in store.admin_products.find({"source": "shopbase", "id": {"$in": fallback_product_ids}}, override_fields)} if fallback_product_ids else {}
            for item in fallback:
                product = public_product(item); product.pop("_id", None)
                override = fallback_overrides.get(product["id"])
                products.append(_apply_shopbase_override(product, override, retailer_price=item.get("wholesalePrice")) if override else product)
            if missing > len(fallback):
                custom_filter: dict[str, Any] = {"source": "custom"}
                if needle: custom_filter["title"] = {"$regex": re.escape(needle), "$options": "i"}
                if excluded: custom_filter["id"] = {"$nin": [f"shopbase-{value}" for value in excluded]}
                extra = list(store.admin_products.find(custom_filter, custom_fields).sort([("title", 1), ("_id", 1)]).limit(missing - len(fallback)))
                for item in extra: item.pop("_id", None); products.append(item)
        return {"products": products, "hasMore": offset + len(products) < total, "nextOffset": offset + len(products), "total": total}
    if needle and sort == "name-asc":
        pattern = re.escape(needle)
        source_needle = needle.removeprefix("shopbase-")
        search_fields = [
            {"title": {"$regex": pattern, "$options": "i"}},
            {"category": {"$regex": pattern, "$options": "i"}},
            {"sourceId": {"$regex": re.escape(source_needle), "$options": "i"}},
            {"id": {"$regex": pattern, "$options": "i"}},
        ]
        shopbase_query = {"source": "shopbase", "$or": search_fields}
        custom_query = {"source": "custom", "$or": search_fields}
        override_query = {"source": "shopbase", "$or": search_fields}
        override_matches = list(store.admin_products.find(override_query, {"_id": 0, "id": 1, "sourceId": 1, "title": 1}).sort([("title", 1), ("id", 1)]))
        override_source_ids = list(dict.fromkeys(str(item.get("sourceId") or str(item.get("id", "")).removeprefix("shopbase-")) for item in override_matches))
        base_search_ids = {str(item.get("sourceId", "")) for item in store.products.find(shopbase_query, {"_id": 0, "sourceId": 1}) if item.get("sourceId")}
        matching_override_ids = {str(item.get("sourceId", "")) for item in store.products.find({"source": "shopbase", "sourceId": {"$in": override_source_ids}}, {"_id": 0, "sourceId": 1}) if item.get("sourceId")} if override_source_ids else set()
        shopbase_count = len(base_search_ids | matching_override_ids)
        custom_count = store.admin_products.count_documents(custom_query)
        total = shopbase_count + custom_count
        candidate_count = (offset or 0) + limit
        fields = {"_id": 1, "sourceId": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "suggestedRetailPrice": 1, "wholesalePrice": 1, "compareAt": 1, "image": 1, "stock": 1, "active": 1, "source": 1, "addedAt": 1, "updatedAt": 1, "trending": 1, "offer": 1, "badge": 1, "rating": 1, "reviews": 1, "sizes": 1, "options": 1}
        shopbase_items = list(store.products.find(shopbase_query, fields).sort([("title", 1), ("_id", 1)]).limit(candidate_count))
        override_candidate_source_ids = override_source_ids[:candidate_count]
        if override_candidate_source_ids:
            included_source_ids = {str(item.get("sourceId", "")) for item in shopbase_items}
            additional_items = store.products.find({"source": "shopbase", "sourceId": {"$in": override_candidate_source_ids}}, fields).sort([("title", 1), ("_id", 1)]).limit(candidate_count)
            shopbase_items.extend(item for item in additional_items if str(item.get("sourceId", "")) not in included_source_ids)
        shopbase_items = list({str(item.get("sourceId", "")): item for item in reversed(shopbase_items)}.values())
        source_ids = [_catalog_product_id(item) for item in shopbase_items]
        override_fields = {"_id": 0, "id": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "originalPrice": 1, "discountedPrice": 1, "compareAt": 1, "image": 1, "images": {"$slice": 1}, "stock": 1, "active": 1, "trending": 1, "offer": 1, "badge": 1, "sizes": 1, "options": 1, "updatedAt": 1}
        overrides = {item["id"]: item for item in store.admin_products.find({"source": "shopbase", "id": {"$in": source_ids}}, override_fields)} if source_ids else {}
        results: list[dict[str, Any]] = []
        for item in shopbase_items:
            product = public_product(item)
            product.pop("_id", None)
            product["addedAt"] = item.get("addedAt") or (item.get("_id").generation_time.isoformat() if getattr(item.get("_id"), "generation_time", None) else None)
            override = overrides.get(product["id"])
            results.append(_apply_shopbase_override(product, override, retailer_price=item.get("wholesalePrice")) if override else {**product, **({"retailerPrice": item["wholesalePrice"]} if item.get("wholesalePrice") is not None else {})})
        custom_fields = {"_id": 1, "id": 1, "sourceId": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "originalPrice": 1, "discountedPrice": 1, "compareAt": 1, "image": 1, "images": {"$slice": 1}, "stock": 1, "active": 1, "source": 1, "addedAt": 1, "updatedAt": 1, "trending": 1, "offer": 1, "badge": 1, "rating": 1, "reviews": 1, "sizes": 1, "options": 1}
        for item in store.admin_products.find(custom_query, custom_fields).sort([("title", 1), ("_id", 1)]).limit(candidate_count):
            item["addedAt"] = item.get("addedAt") or (item.get("_id").generation_time.isoformat() if getattr(item.get("_id"), "generation_time", None) else None)
            item.pop("_id", None)
            results.append(item)
        exact = needle.removeprefix("shopbase-").casefold()
        def relevance(product: dict[str, Any]) -> tuple[int, str, str]:
            product_id = str(product.get("sourceId") or product.get("id") or "").casefold()
            if product_id.removeprefix("shopbase-") == exact:
                rank = 0
            elif product_id.startswith(exact):
                rank = 1
            elif exact in str(product.get("title", "")).casefold():
                rank = 2
            else:
                rank = 3
            return rank, str(product.get("title", "")).casefold(), str(product.get("id", ""))
        results.sort(key=relevance)
        page_offset = offset or 0
        products = results[page_offset:page_offset + limit]
        return {"products": products, "hasMore": page_offset + len(products) < total, "nextOffset": page_offset + len(products), "total": total}
    if offset is not None and sort == "name-asc":
        shopbase_query = {"source": "shopbase"}
        custom_query = {"source": "custom"}
        shopbase_count = store.products.count_documents(shopbase_query)
        custom_count = store.admin_products.count_documents(custom_query)
        shopbase_offset = min(offset, shopbase_count)
        shopbase_take = min(limit, max(0, shopbase_count - shopbase_offset))
        fields = {"_id": 1, "sourceId": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "suggestedRetailPrice": 1, "wholesalePrice": 1, "compareAt": 1, "image": 1, "stock": 1, "active": 1, "source": 1, "addedAt": 1, "updatedAt": 1, "trending": 1, "offer": 1, "badge": 1, "rating": 1, "reviews": 1, "sizes": 1, "options": 1}
        shopbase_items = list(store.products.find(shopbase_query, fields).sort("_id", 1).skip(shopbase_offset).limit(shopbase_take))
        ids = [_catalog_product_id(item) for item in shopbase_items]
        override_fields = {"_id": 0, "id": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "originalPrice": 1, "discountedPrice": 1, "compareAt": 1, "image": 1, "images": {"$slice": 1}, "stock": 1, "active": 1, "trending": 1, "offer": 1, "badge": 1, "sizes": 1, "options": 1, "updatedAt": 1}
        overrides = {item["id"]: item for item in store.admin_products.find({"source": "shopbase", "id": {"$in": ids}}, override_fields)} if ids else {}
        products = []
        for item in shopbase_items:
            product = public_product(item)
            product.pop("_id", None)
            product["addedAt"] = item.get("addedAt") or (item.get("_id").generation_time.isoformat() if getattr(item.get("_id"), "generation_time", None) else None)
            override = overrides.get(product["id"])
            products.append(_apply_shopbase_override(product, override, retailer_price=item.get("wholesalePrice")) if override else {**product, **({"retailerPrice": item["wholesalePrice"]} if item.get("wholesalePrice") is not None else {})})
        custom_offset = max(0, offset - shopbase_count)
        custom_take = max(0, limit - len(shopbase_items))
        custom_fields = {"_id": 1, "id": 1, "sourceId": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "originalPrice": 1, "discountedPrice": 1, "compareAt": 1, "image": 1, "images": {"$slice": 1}, "stock": 1, "active": 1, "source": 1, "addedAt": 1, "updatedAt": 1, "trending": 1, "offer": 1, "badge": 1, "rating": 1, "reviews": 1, "sizes": 1, "options": 1}
        custom_items = list(store.admin_products.find(custom_query, custom_fields).sort([("title", 1), ("_id", 1)]).skip(custom_offset).limit(custom_take))
        for item in custom_items:
            item["addedAt"] = item.get("addedAt") or (item.get("_id").generation_time.isoformat() if getattr(item.get("_id"), "generation_time", None) else None)
            item.pop("_id", None)
            products.append(item)
        next_offset = offset + len(shopbase_items) + len(custom_items)
        products.sort(key=lambda item: str(item.get("title", "")).casefold())
        return {"products": products, "hasMore": next_offset < shopbase_count + custom_count, "nextOffset": next_offset, "total": shopbase_count + custom_count}
    fields = {"_id": 1, "sourceId": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "suggestedRetailPrice": 1, "wholesalePrice": 1, "compareAt": 1, "image": 1, "stock": 1, "active": 1, "source": 1, "addedAt": 1, "updatedAt": 1, "trending": 1, "offer": 1, "badge": 1, "rating": 1, "reviews": 1, "sizes": 1, "options": 1}
    overrides = {item["id"]: item for item in store.admin_products.find({"source": "shopbase"}, {"_id": 0})}
    products = []
    for item in store.products.find({"source": "shopbase"}, fields).limit(20000):
        product_id = _catalog_product_id(item)
        added_at = item.get("addedAt") or (item.get("_id").generation_time.isoformat() if getattr(item.get("_id"), "generation_time", None) else None)
        retailer_price = item.get("wholesalePrice")
        product = public_product(item)
        product.pop("_id", None)
        product["addedAt"] = added_at
        override = overrides.get(product_id)
        if override:
            product = _apply_shopbase_override(product, override, retailer_price=retailer_price)
        elif retailer_price is not None:
            product["retailerPrice"] = retailer_price
        products.append(product)
    for item in store.admin_products.find({"source": "custom"}).limit(20000):
        item["addedAt"] = item.get("addedAt") or (item.get("_id").generation_time.isoformat() if getattr(item.get("_id"), "generation_time", None) else None)
        item.pop("_id", None)
        products.append(item)
    if needle:
        term = needle.casefold().removeprefix("shopbase-")
        products = [item for item in products if term in " ".join(str(item.get(key, "")) for key in ("title", "category", "sourceId", "id")).casefold()]
    views = {str(item.get("productId")): int(item.get("views", 0) or 0) for item in store.product_views.find({}, {"_id": 0, "productId": 1, "views": 1})} if sort == "views" else {}
    if sort == "price-asc": products.sort(key=lambda item: (float(item.get("price") or 0), str(item.get("title", "")).casefold()))
    elif sort == "price-desc": products.sort(key=lambda item: (-float(item.get("price") or 0), str(item.get("title", "")).casefold()))
    elif sort == "added": products.sort(key=lambda item: item.get("addedAt") or "", reverse=True)
    elif sort == "updated": products.sort(key=lambda item: item.get("updatedAt") or "", reverse=True)
    elif sort == "name-desc": products.sort(key=lambda item: str(item.get("title", "")).casefold(), reverse=True)
    else: products.sort(key=lambda item: (-views.get(str(item.get("id", "")), 0), str(item.get("title", "")).casefold()))
    total = len(products)
    page_offset = offset or 0
    products = products[page_offset:page_offset + limit]
    return {"products": products, "hasMore": page_offset + len(products) < total, "nextOffset": page_offset + len(products), "total": total}

@app.post("/api/admin/products/{product_id}/availability-check")
def check_one_product_availability(product_id: str, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    if not product_id.startswith("shopbase-"):
        raise HTTPException(status_code=422, detail="Availability checks are only supported for ShopBase products.")
    source_id = product_id.removeprefix("shopbase-")
    if not db().products.find_one({"sourceId": source_id, "source": "shopbase"}, {"_id": 1}):
        raise HTTPException(status_code=404, detail="This ShopBase product is not in the saved catalog.")
    token, repository, workflow = _github_sync_settings()
    check_id = str(uuid.uuid4())
    db().availability_checks.insert_one({"checkId": check_id, "productId": product_id, "sourceId": source_id, "status": "queued", "createdAt": datetime.now(timezone.utc).isoformat()})
    response = requests.post(
        f"https://api.github.com/repos/{repository}/actions/workflows/{workflow}/dispatches",
        headers=_github_headers(token),
        json={"ref": "main", "inputs": {"refresh_details": "false", "check_product_id": source_id, "check_id": check_id}},
        timeout=20,
    )
    if response.status_code in (401, 403):
        db().availability_checks.update_one({"checkId": check_id}, {"$set": {"status": "failed", "error": "GitHub rejected the workflow request. Check the Actions permission on the saved GitHub token."}})
        raise HTTPException(status_code=502, detail="GitHub rejected the workflow request. Check the Actions permission on the saved GitHub token.")
    if response.status_code != 204:
        db().availability_checks.update_one({"checkId": check_id}, {"$set": {"status": "failed", "error": f"GitHub could not start the check (HTTP {response.status_code})."}})
        raise HTTPException(status_code=502, detail=f"GitHub could not start the single-product check (HTTP {response.status_code}).")
    return {"ok": True, "checkId": check_id, "sourceId": source_id}

@app.get("/api/admin/products/{product_id}/availability-check/{check_id}")
def get_one_product_availability(product_id: str, check_id: str, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    result = db().availability_checks.find_one({"checkId": check_id, "productId": product_id}, {"_id": 0})
    if not result:
        raise HTTPException(status_code=404, detail="Availability check not found.")
    return result

@app.post("/api/admin/products/import")
def import_admin_products(input: AdminProductImport, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    products = [item.model_dump() for item in input.products]
    if any(item.get("source") != "custom" for item in products):
        raise HTTPException(status_code=422, detail="CSV products must be imported as manually managed products.")
    operations = [UpdateOne({"id": item["id"]}, {"$set": {**item, "updatedAt": datetime.now(timezone.utc).isoformat()}, "$setOnInsert": {"addedAt": item.get("addedAt") or datetime.now(timezone.utc).isoformat()}}, upsert=True) for item in products]
    db().admin_products.bulk_write(operations, ordered=False)
    categories = list(dict.fromkeys(item["category"] for item in products if item.get("category")))
    settings = db().store_settings.find_one({"_id": "storefront"}, {"_id": 0, "manualCategories": 1}) or {}
    existing = settings.get("manualCategories", [])
    manual_categories = list(dict.fromkeys([*(existing if isinstance(existing, list) else []), *categories]))
    db().store_settings.update_one({"_id": "storefront"}, {"$set": {"manualCategories": manual_categories}}, upsert=True)
    return {"ok": True, "imported": len(products)}

@app.delete("/api/admin/products/{product_id}")
def delete_admin_product(product_id: str, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    existing = db().admin_products.find_one({"id": product_id}, {"_id": 0})
    if existing and existing.get("source") == "custom":
        db().admin_products.delete_one({"id": product_id})
    elif product_id.startswith("shopbase-"):
        source_id = product_id.removeprefix("shopbase-")
        db().admin_products.update_one(
            {"id": product_id},
            {"$set": {"id": product_id, "source": "shopbase", "sourceId": source_id, "active": False, "updatedAt": datetime.now(timezone.utc).isoformat()}},
            upsert=True,
        )
    else:
        raise HTTPException(status_code=404, detail="Product not found.")
    return {"ok": True}

@app.get("/api/admin/products/{product_id}")
def get_admin_product(product_id: str, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    store = db()
    saved = store.admin_products.find_one({"id": product_id}, {"_id": 0})
    if saved and saved.get("source") == "custom":
        return saved
    source_id = saved.get("sourceId") if saved else product_id.removeprefix("shopbase-")
    product = store.products.find_one({"sourceId": source_id, "source": "shopbase"}, {"_id": 0})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found.")
    retailer_price = product.get("wholesalePrice")
    result = public_product(product, include_details=True)
    if saved:
        result = _apply_shopbase_override(result, saved, retailer_price=retailer_price)
    elif retailer_price is not None:
        result["retailerPrice"] = retailer_price
    return result

def public_product(product, include_details=False):
    # MongoDB's ObjectId is not JSON serializable. Most catalog queries
    # project it out already; strip it here as a final guard for every public
    # feed, including explicit-ID feeds such as homepage trends and offers.
    product.pop("_id", None)
    product["id"] = f"shopbase-{product.get('sourceId', '')}" if product.get("source") == "shopbase" else str(product.get("id", ""))
    if product.get("source") == "shopbase":
        # The current supplier retail price is always the original price.
        # Storefront discounts are explicit admin overrides, never inferred
        # from a stale catalog price or supplier comparison field.
        original_price = product.get("suggestedRetailPrice") or product.get("price", 0)
        product["originalPrice"] = original_price
        product["discountedPrice"] = None
        product["price"] = original_price
        product["compareAt"] = None
    else:
        try:
            price = float(product.get("price", 0) or 0)
            legacy_original = float(product.get("compareAt") or 0)
            original_price = float(product.get("originalPrice") or (legacy_original if legacy_original > price else price))
            discounted_price = product.get("discountedPrice")
            if discounted_price is None and price < original_price:
                discounted_price = price
            discounted_price = float(discounted_price) if discounted_price is not None else None
            if discounted_price is not None and discounted_price >= original_price:
                discounted_price = None
            product["originalPrice"] = original_price
            product["discountedPrice"] = discounted_price
            product["price"] = discounted_price if discounted_price is not None else original_price
            product["compareAt"] = original_price if discounted_price is not None else None
        except (TypeError, ValueError):
            product["originalPrice"] = product.get("price", 0)
            product["discountedPrice"] = None
    for private_field in ("wholesalePrice", "retailerPrice", "listFingerprint", "lastSeenRun", "missingRuns", "detailsFetchedAt", "detailsVersion", "imageOverride", "sourceImage", "sourceImages"):
        product.pop(private_field, None)
    product.setdefault("rating", 0)
    product.setdefault("reviews", 0)
    product.setdefault("source", "shopbase")
    # Older catalog runs stored recommendation thumbnails alongside the
    # product's actual image. The first item is the primary, high-resolution
    # product photo; never expose the recommendation images as a gallery.
    source_images = product.get("images") if isinstance(product.get("images"), list) else []
    primary_image = (source_images or [None])[0] or product.get("image")
    if primary_image:
        product["image"] = primary_image
    if include_details:
        if product.get("source") == "custom":
            product["images"] = list(dict.fromkeys(image for image in source_images if isinstance(image, str) and image.strip())) or ([primary_image] if primary_image else [])
        else:
            product["images"] = [primary_image] if primary_image else []
    else:
        product.pop("images", None)
    if not include_details and product.get("source") == "shopbase":
        product["description"] = ""
    return product

def _catalog_image_url(request: Request, product_id: str, image_index: int, image: Any) -> str:
    if not isinstance(image, str) or not image.startswith("data:image/"):
        return image if isinstance(image, str) else ""
    version = hashlib.sha256(image.encode("utf-8")).hexdigest()[:20]
    return str(request.url_for("catalog_product_image").include_query_params(product_id=product_id, image_index=image_index, v=version))

def _externalize_product_images(product: dict[str, Any], request: Request) -> dict[str, Any]:
    """Replace base64 JSON payloads with cacheable image URLs."""
    product_id = str(product.get("id") or "")
    images = product.get("images")
    if isinstance(images, list):
        product["images"] = [_catalog_image_url(request, product_id, index, image) for index, image in enumerate(images)]
    if isinstance(product.get("image"), str):
        product["image"] = _catalog_image_url(request, product_id, 0, product["image"])
    return product

@app.get("/api/catalog-image", name="catalog_product_image")
def catalog_product_image(
    request: Request,
    product_id: str = Query(min_length=1, max_length=180),
    image_index: int = Query(default=0, ge=0, le=20),
    version: str | None = Query(default=None, alias="v", max_length=40),
):
    """Serve one product image separately so product feeds stay small and cacheable."""
    store = db()
    saved = store.admin_products.find_one(
        {"id": product_id, "source": {"$in": ["shopbase", "custom"]}},
        {"_id": 0, "source": 1, "sourceId": 1, "image": 1, "images": {"$slice": [image_index, 1]}},
    )
    image = None
    if saved and (saved.get("images") or saved.get("image")):
        saved_images = saved.get("images") if isinstance(saved.get("images"), list) else []
        image = saved_images[0] if saved_images else (saved.get("image") if image_index == 0 else None)
    elif product_id.startswith("shopbase-"):
        source_id = product_id.removeprefix("shopbase-")
        base = store.products.find_one(
            {"sourceId": source_id, "source": "shopbase"},
            {"_id": 0, "image": 1, "images": {"$slice": [image_index, 1]}},
        )
        if base:
            base_images = base.get("images") if isinstance(base.get("images"), list) else []
            image = base_images[0] if base_images else (base.get("image") if image_index == 0 else None)
    if not isinstance(image, str) or not image:
        raise HTTPException(status_code=404, detail="Product image not found.")
    if image.startswith(("https://", "http://")):
        return RedirectResponse(image, headers={"Cache-Control": "public, max-age=86400, stale-while-revalidate=604800"})
    match = re.fullmatch(r"data:(image/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)", image)
    if not match or match.group(1).lower() not in {"image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"}:
        raise HTTPException(status_code=404, detail="Product image is not available.")
    try:
        image_bytes = base64.b64decode(match.group(2).replace("\r", "").replace("\n", ""), validate=True)
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Product image data is invalid.") from error
    etag = f'"{hashlib.sha256(image_bytes).hexdigest()}"'
    headers = {"Cache-Control": "public, max-age=31536000, immutable", "ETag": etag}
    if etag in request.headers.get("if-none-match", "").split(","):
        return Response(status_code=304, headers=headers)
    return Response(content=image_bytes, media_type=match.group(1).lower(), headers=headers)

def _apply_shopbase_override(product: dict[str, Any], override: dict[str, Any], *, retailer_price: Any = None) -> dict[str, Any]:
    """Apply admin overrides while refreshing supplier data not overridden by admin."""
    try:
        original_price = float(override.get("originalPrice") if override.get("originalPrice") is not None else (product.get("originalPrice") or product.get("price") or 0))
    except (TypeError, ValueError):
        original_price = float(product.get("originalPrice") or product.get("price") or 0)
    for key in ("title", "category", "image", "description", "stock", "active", "trending", "offer", "badge", "sizes", "sizeChart", "details", "attributes", "options", "categorySourceId", "parentCategory", "parentCategoryId"):
        if key in override:
            product[key] = override[key]
    images = override.get("images")
    if isinstance(images, list):
        images = list(dict.fromkeys(image for image in images if isinstance(image, str) and image.strip()))[:20]
        if images:
            product["images"] = images
            product["image"] = images[0]
    discounted_price = override.get("discountedPrice")
    if discounted_price is None:
        # Preserve an intentional sale created by the previous editor version.
        try:
            legacy_price = float(override.get("price"))
            legacy_compare = float(override.get("compareAt"))
            if legacy_price < legacy_compare:
                discounted_price = legacy_price
        except (TypeError, ValueError):
            pass
    try:
        discounted_price = float(discounted_price) if discounted_price is not None else None
    except (TypeError, ValueError):
        discounted_price = None
    if discounted_price is not None and not 0 <= discounted_price < original_price:
        discounted_price = None
    product["originalPrice"] = original_price
    product["discountedPrice"] = discounted_price
    product["price"] = discounted_price if discounted_price is not None else original_price
    product["compareAt"] = original_price if discounted_price is not None else None
    if retailer_price is not None:
        product["retailerPrice"] = retailer_price
    return product

@app.get("/api/health")
def health():
    try:
        db().command("ping")
        return {"ok": True, "database": "connected"}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=503, detail="Catalog database is unavailable.")

@app.get("/api/catalog")
def catalog(response: Response, request: Request):
    try:
        store = db()
        fields = {"_id": 0, "sourceId": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "suggestedRetailPrice": 1, "compareAt": 1, "image": 1, "stock": 1, "active": 1, "source": 1, "trending": 1, "offer": 1, "badge": 1}
        override_fields = {"_id": 0, "id": 1, "active": 1, "title": 1, "category": 1, "image": 1, "images": {"$slice": 1}, "stock": 1, "trending": 1, "offer": 1, "badge": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "originalPrice": 1, "discountedPrice": 1, "compareAt": 1, "price": 1}
        overrides = {item["id"]: item for item in store.admin_products.find({"source": "shopbase"}, override_fields)}
        products = []
        for item in store.products.find({"source": "shopbase"}, fields).limit(20000):
            product_id = _catalog_product_id(item)
            override = overrides.get(product_id)
            if override and override.get("active") is False:
                continue
            product = public_product(item)
            if override:
                product = _apply_shopbase_override(product, override)
            products.append(product)
        products.extend(public_product(item) for item in store.admin_products.find({"source": "custom", "active": True}, {"_id": 0}).limit(20000))
        products = [_externalize_product_images(product, request) for product in products if product.get("active", True)]
        products.sort(key=lambda item: str(item.get("title", "")).casefold())
        view_counts = {item["productId"]: int(item.get("views", 0)) for item in store.product_views.find({}, {"_id": 0, "productId": 1, "views": 1})}
        categories = list(store.categories.find({"source": "shopbase", "type": {"$ne": "parent"}}, {"_id": 0, "sourceId": 1, "name": 1, "parentId": 1, "parentName": 1, "sortOrder": 1, "sourceOrder": 1}))
        # The supplier's catalog order is the tie-breaker for same-named child
        # categories (e.g. Denim Jacket under two parent collections).
        if categories and all(item.get("sourceOrder") is not None for item in categories):
            categories.sort(key=lambda item: item["sourceOrder"])
        groups, _ = _category_groups_for_store(store)
        # Avoid reading/returning the storefront's base64 hero and social
        # thumbnails as part of the full product catalog payload.
        settings = store.store_settings.find_one({"_id": "storefront"}, {
            "_id": 0,
            "categoryGroups": 1,
            "manualCategories": 1,
            "manualCategoryVisibility": 1,
            "content.heroTitle": 1,
            "content.heroSubtitle": 1,
            "content.heroCta": 1,
            "content.offerTitle": 1,
            "content.offerSubtitle": 1,
            "content.announcement": 1,
            "content.trendingIds": 1,
            "content.offerIds": 1,
            "content.combos": 1,
            "content.categoryImages": 1,
            "content.deliveryInDhaka": 1,
            "content.deliverySubDhaka": 1,
            "content.deliveryOutsideDhaka": 1,
        }) or {}
        all_manual_categories = settings.get("manualCategories", [])
        manual_visibility = settings.get("manualCategoryVisibility", {}) if isinstance(settings.get("manualCategoryVisibility", {}), dict) else {}
        manual_categories = [name for name in all_manual_categories if manual_visibility.get(name, True) is not False]
        visible_sources = {str(child.get("sourceId")) for group in groups if group.get("showInStorefront", True) is not False for child in group.get("children", []) if child.get("showInStorefront", True) is not False and child.get("sourceId")}
        visible_names = {str(child.get("name", "")).casefold() for group in groups if group.get("showInStorefront", True) is not False for child in group.get("children", []) if child.get("showInStorefront", True) is not False and child.get("name")}
        visible_names.update(name.casefold() for name in manual_categories)
        products = [item for item in products if (str(item.get("categorySourceId")) in visible_sources if item.get("categorySourceId") else str(item.get("category", "")).casefold() in visible_names)]
        latest = store.sync_runs.find_one({"status": {"$in": ["success", "success_with_skipped_details"]}}, {"_id": 0}, sort=[("finishedAt", -1)])
        visible_shopbase_categories = [item["name"] for item in categories if str(item.get("sourceId", "")) in visible_sources]
        response.headers["Cache-Control"] = "public, max-age=30, stale-while-revalidate=120"
        return {"products": products, "categories": list(dict.fromkeys(visible_shopbase_categories + manual_categories)), "categoryGroups": groups, "categoryGroupsManaged": isinstance(settings.get("categoryGroups"), list), "manualCategories": all_manual_categories, "manualCategoryVisibility": manual_visibility, "manualCategoriesManaged": isinstance(settings.get("manualCategories"), list), "content": settings.get("content"), "lastSync": (latest or {}).get("finishedAt"), "productViewCounts": view_counts}
    except HTTPException:
        raise
    except Exception:
        logging.exception("Catalog load failed")
        raise HTTPException(status_code=503, detail="Could not load catalog.")

@app.get("/api/catalog-page")
def catalog_page(
    response: Response,
    request: Request,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=400, ge=1, le=800),
    include_meta: bool = Query(default=True),
):
    """Return a small catalog page so the storefront need not wait for every SKU."""
    try:
        store = db()
        shopbase_query = {"source": "shopbase", "sourceId": {"$exists": True}, "active": {"$ne": False}}
        custom_query = {"source": "custom", "active": True}
        shopbase_count = store.products.count_documents(shopbase_query)
        custom_count = store.admin_products.count_documents(custom_query)
        shopbase_offset = min(offset, shopbase_count)
        shopbase_take = min(limit, max(0, shopbase_count - shopbase_offset))
        product_fields = {"_id": 0, "sourceId": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "suggestedRetailPrice": 1, "compareAt": 1, "image": 1, "stock": 1, "active": 1, "source": 1, "trending": 1, "offer": 1, "badge": 1}
        shopbase_items = list(store.products.find(shopbase_query, product_fields).skip(shopbase_offset).limit(shopbase_take))
        ids = [_catalog_product_id(item) for item in shopbase_items]
        override_fields = {"_id": 0, "id": 1, "active": 1, "title": 1, "category": 1, "image": 1, "images": {"$slice": 1}, "stock": 1, "trending": 1, "offer": 1, "badge": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "originalPrice": 1, "discountedPrice": 1, "compareAt": 1, "price": 1}
        overrides = {item["id"]: item for item in store.admin_products.find({"source": "shopbase", "id": {"$in": ids}}, override_fields)} if ids else {}
        products = []
        for item in shopbase_items:
            product = public_product(item)
            override = overrides.get(product["id"])
            if override and override.get("active") is False:
                continue
            products.append(_apply_shopbase_override(product, override) if override else product)
        custom_offset = max(0, offset - shopbase_count)
        custom_take = max(0, limit - len(shopbase_items))
        custom_items = list(store.admin_products.find(custom_query, {"_id": 0}).sort([("title", 1), ("_id", 1)]).skip(custom_offset).limit(custom_take))
        products.extend(public_product(item) for item in custom_items)
        next_offset = offset + len(shopbase_items) + len(custom_items)
        products = [_externalize_product_images(product, request) for product in products]
        payload: dict[str, Any] = {"products": products, "hasMore": next_offset < shopbase_count + custom_count, "nextOffset": next_offset}
        if include_meta:
            categories = list(store.categories.find({"source": "shopbase", "type": {"$ne": "parent"}}, {"_id": 0, "sourceId": 1, "name": 1, "parentId": 1, "parentName": 1, "sortOrder": 1, "sourceOrder": 1}))
            if categories and all(item.get("sourceOrder") is not None for item in categories):
                categories.sort(key=lambda item: item["sourceOrder"])
            groups, _ = _category_groups_for_store(store)
            settings = store.store_settings.find_one({"_id": "storefront"}, {
                "_id": 0, "categoryGroups": 1, "manualCategories": 1, "manualCategoryVisibility": 1,
                "content.heroTitle": 1, "content.heroSubtitle": 1, "content.heroCta": 1,
                "content.offerTitle": 1, "content.offerSubtitle": 1, "content.announcement": 1,
                "content.trendingIds": 1, "content.offerIds": 1, "content.combos": 1,
                "content.categoryImages": 1, "content.deliveryInDhaka": 1,
                "content.deliverySubDhaka": 1, "content.deliveryOutsideDhaka": 1,
            }) or {}
            all_manual_categories = settings.get("manualCategories", [])
            manual_visibility = settings.get("manualCategoryVisibility", {}) if isinstance(settings.get("manualCategoryVisibility", {}), dict) else {}
            manual_categories = [name for name in all_manual_categories if manual_visibility.get(name, True) is not False]
            visible_sources = {str(child.get("sourceId")) for group in groups if group.get("showInStorefront", True) is not False for child in group.get("children", []) if child.get("showInStorefront", True) is not False and child.get("sourceId")}
            visible_shopbase_categories = [item["name"] for item in categories if str(item.get("sourceId", "")) in visible_sources]
            latest = store.sync_runs.find_one({"status": {"$in": ["success", "success_with_skipped_details"]}}, {"_id": 0}, sort=[("finishedAt", -1)])
            payload.update({
                "categories": list(dict.fromkeys(visible_shopbase_categories + manual_categories)),
                "categoryGroups": groups,
                "categoryGroupsManaged": isinstance(settings.get("categoryGroups"), list),
                "manualCategories": all_manual_categories,
                "manualCategoryVisibility": manual_visibility,
                "manualCategoriesManaged": isinstance(settings.get("manualCategories"), list),
                "content": settings.get("content"),
                "lastSync": (latest or {}).get("finishedAt"),
                "productViewCounts": {item["productId"]: int(item.get("views", 0)) for item in store.product_views.find({}, {"_id": 0, "productId": 1, "views": 1}).sort("views", -1).limit(1000)},
            })
        response.headers["Cache-Control"] = "public, max-age=30, stale-while-revalidate=120"
        return payload
    except HTTPException:
        raise
    except Exception:
        logging.exception("Catalog page load failed")
        raise HTTPException(status_code=503, detail="Could not load catalog page.")

@app.post("/api/products/{product_id}/view")
def record_product_view(product_id: str):
    if not product_id or len(product_id) > 180:
        raise HTTPException(status_code=422, detail="Invalid product ID.")
    result = db().product_views.find_one_and_update(
        {"productId": product_id},
        {"$inc": {"views": 1}, "$setOnInsert": {"productId": product_id}},
        upsert=True,
        return_document=True,
    )
    return {"productId": product_id, "views": int(result.get("views", 0))}

@app.get("/api/product-views")
def product_view_counts():
    counts = db().product_views.find({}, {"_id": 0, "productId": 1, "views": 1})
    return {item["productId"]: int(item.get("views", 0)) for item in counts}

def _home_category_samples(store, settings: dict[str, Any], category_offset: int, page_size: int = 15) -> tuple[list[dict[str, Any]], int, bool]:
    """Return one product image per next visible category page."""
    category_docs = list(store.categories.find(
        {"source": "shopbase", "type": {"$ne": "parent"}},
        {"_id": 0, "sourceId": 1, "name": 1, "sourceOrder": 1},
    ))

    def category_order(item: dict[str, Any]) -> tuple[float, str]:
        try:
            source_order = float(item.get("sourceOrder"))
        except (TypeError, ValueError):
            source_order = float("inf")
        return source_order, str(item.get("name", ""))

    category_docs.sort(key=category_order)
    saved_groups = settings.get("categoryGroups")
    if isinstance(saved_groups, list):
        visible_source_ids = {
            str(child.get("sourceId"))
            for group in saved_groups if isinstance(group, dict) and group.get("showInStorefront", True) is not False
            for child in group.get("children", []) if isinstance(child, dict) and child.get("showInStorefront", True) is not False and child.get("sourceId")
        }
        category_docs = [item for item in category_docs if str(item.get("sourceId", "")) in visible_source_ids]

    start = min(max(0, category_offset), len(category_docs))
    end = min(start + page_size * 2, len(category_docs))
    category_candidates = category_docs[start:end]
    candidate_source_ids = [item.get("sourceId") for item in category_candidates if item.get("sourceId") is not None]
    category_samples: dict[str, dict[str, Any]] = {}
    if candidate_source_ids:
        for row in store.products.aggregate([
            {"$match": {"source": "shopbase", "active": {"$ne": False}, "categorySourceId": {"$in": candidate_source_ids}}},
            {"$project": {"sourceId": 1, "source": 1, "active": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "suggestedRetailPrice": 1, "compareAt": 1, "image": 1, "stock": 1, "rating": 1, "reviews": 1, "trending": 1, "offer": 1, "badge": 1}},
            {"$sort": {"categorySourceId": 1, "_id": 1}},
            {"$group": {"_id": "$categorySourceId", "product": {"$first": "$$ROOT"}}},
            {"$replaceRoot": {"newRoot": "$product"}},
            {"$project": {"_id": 0, "sourceId": 1, "source": 1, "active": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "suggestedRetailPrice": 1, "compareAt": 1, "image": 1, "stock": 1, "rating": 1, "reviews": 1, "trending": 1, "offer": 1, "badge": 1}},
        ]):
            category_samples[str(row.get("categorySourceId", ""))] = row

    sample_rows = [category_samples[str(item.get("sourceId", ""))] for item in category_candidates if str(item.get("sourceId", "")) in category_samples]
    sample_ids = [_catalog_product_id(item) for item in sample_rows]
    category_overrides = {
        item["id"]: item
        for item in store.admin_products.find(
            {"source": "shopbase", "id": {"$in": sample_ids}},
            {"_id": 0, "id": 1, "active": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "image": 1, "images": {"$slice": 1}, "stock": 1, "rating": 1, "reviews": 1, "trending": 1, "offer": 1, "badge": 1, "originalPrice": 1, "discountedPrice": 1, "compareAt": 1, "price": 1},
        )
    } if sample_ids else {}
    products: list[dict[str, Any]] = []
    for item in sample_rows:
        product = public_product(item)
        override = category_overrides.get(product["id"])
        if override and override.get("active") is False:
            continue
        products.append(_apply_shopbase_override(product, override) if override else product)
        if len(products) >= page_size:
            break
    return products, end, end < len(category_docs)

@app.get("/api/catalog-priority")
def catalog_priority(
    response: Response,
    request: Request,
    kind: Literal["home", "home_categories", "trending", "offers", "offer", "category", "search"],
    limit: int = Query(default=50, ge=1, le=400),
    offset: int = Query(default=0, ge=0),
    category_offset: int = Query(default=0, ge=0),
    category: str | None = None,
    category_source_id: str | None = None,
    parent_category_id: str | None = None,
    search: str | None = None,
    offer_id: str | None = None,
    sort: Literal["recommended", "low-high", "high-low"] = "recommended",
):
    """Fetch only the products needed for the current storefront view."""
    store = db()
    response.headers["Cache-Control"] = "public, max-age=15, stale-while-revalidate=120"
    settings = store.store_settings.find_one({"_id": "storefront"}, {"_id": 0, "content.trendingIds": 1, "content.offerIds": 1, "categoryGroups": 1, "manualCategories": 1, "manualCategoryVisibility": 1}) or {}
    content = settings.get("content") if isinstance(settings.get("content"), dict) else {}
    explicit_ids: list[str] = []
    priority_trending_ids: list[str] = []
    category_products: list[dict[str, Any]] = []
    next_category_offset = category_offset
    category_has_more = False
    query: dict[str, Any] = {"source": "shopbase", "sourceId": {"$exists": True}, "active": {"$ne": False}}

    if kind == "trending":
        # Keep the storefront homepage on its fast first-20 path, while the
        # dedicated trending page can request subsequent view-ranked batches.
        viewed = store.product_views.find({}, {"_id": 0, "productId": 1}).sort([("views", -1), ("productId", 1)]).limit(offset + limit)
        ranked_ids = list(dict.fromkeys(str(item.get("productId", "")) for item in viewed if item.get("productId")))
        priority_trending_ids = ranked_ids
        explicit_ids.extend(ranked_ids)
    elif kind == "home":
        # View rows are only created by record_product_view, so scanning the
        # top of the compound index is enough; a range filter makes MongoDB
        # examine extra index entries before it can satisfy the same sort.
        viewed = store.product_views.find({}, {"_id": 0, "productId": 1, "views": 1}).sort([("views", -1), ("productId", 1)]).limit(20)
        priority_trending_ids.extend(str(item.get("productId", "")) for item in viewed if item.get("productId"))
        priority_trending_ids.extend(str(item) for item in content.get("trendingIds", []) if isinstance(item, str))
        priority_trending_ids = list(dict.fromkeys(item for item in priority_trending_ids if item))[:20]
        if len(priority_trending_ids) < 20:
            flag_query: dict[str, Any] = {"source": "shopbase", "sourceId": {"$exists": True}, "active": {"$ne": False}, "trending": True}
            existing_source_ids = {item.removeprefix("shopbase-") for item in priority_trending_ids if item.startswith("shopbase-")}
            if existing_source_ids:
                flag_query["sourceId"] = {"$exists": True, "$nin": list(existing_source_ids)}
            flagged_trending = list(store.products.find(flag_query, {"_id": 0, "sourceId": 1}).limit(20 - len(priority_trending_ids)))
            priority_trending_ids.extend(f"shopbase-{item['sourceId']}" for item in flagged_trending if item.get("sourceId"))
        explicit_ids.extend(priority_trending_ids)
    elif kind == "home_categories":
        pass
    elif kind == "offers":
        for offer in store.offers.find({"active": True}, {"_id": 0, "thumbnailProductIds": 1, "productIds": 1, "productId": 1}):
            thumbnail_ids = offer.get("thumbnailProductIds") or offer.get("productIds") or ([offer.get("productId")] if offer.get("productId") else [])
            explicit_ids.extend(str(item) for item in thumbnail_ids[:3] if isinstance(item, str))
    elif kind == "offer":
        offer = store.offers.find_one({"id": offer_id, "active": True}, {"_id": 0, "kind": 1, "productId": 1, "productIds": 1}) if offer_id else None
        if not offer:
            return {"products": [], "hasMore": False, "nextOffset": 0, "total": 0}
        if offer.get("kind") != "free_delivery":
            explicit_ids.extend(str(item) for item in (offer.get("productIds") or ([offer.get("productId")] if offer.get("productId") else [])) if isinstance(item, str))
    else:
        if kind == "search" and search:
            raw_search = search.strip()[:100]
            pattern = re.escape(raw_search)
            source_pattern = re.escape(raw_search.removeprefix("shopbase-"))
            query["$or"] = [{"title": {"$regex": pattern, "$options": "i"}}, {"category": {"$regex": pattern, "$options": "i"}}, {"sourceId": {"$regex": source_pattern, "$options": "i"}}, {"description": {"$regex": pattern, "$options": "i"}}, {"details": {"$regex": pattern, "$options": "i"}}]
        elif category_source_id:
            query["categorySourceId"] = str(category_source_id)
        elif parent_category_id:
            query["parentCategoryId"] = str(parent_category_id)
        elif category:
            query["category"] = category
        if kind == "category" and search and search.strip():
            pattern = re.escape(search.strip()[:100])
            source_pattern = re.escape(search.strip().removeprefix("shopbase-")[:100])
            query["$and"] = [{"$or": [{"title": {"$regex": pattern, "$options": "i"}}, {"category": {"$regex": pattern, "$options": "i"}}, {"sourceId": {"$regex": source_pattern, "$options": "i"}}, {"description": {"$regex": pattern, "$options": "i"}}, {"details": {"$regex": pattern, "$options": "i"}}]}]

    # Price sorting ranks only compact metadata, then fetches full product
    # records (including image URLs) for the requested page. This keeps All,
    # parent-category, and subcategory sorting consistent without loading the
    # entire image catalog into the response or browser.
    if kind in ("category", "search") and sort in ("low-high", "high-low"):
        reverse = sort == "high-low"
        custom_query: dict[str, Any] = {"source": "custom", "active": True}
        if kind == "search" and search and search.strip():
            pattern = re.escape(search.strip()[:100])
            source_pattern = re.escape(search.strip().removeprefix("shopbase-")[:100])
            search_terms = [{"title": {"$regex": pattern, "$options": "i"}}, {"category": {"$regex": pattern, "$options": "i"}}, {"id": {"$regex": pattern, "$options": "i"}}, {"sourceId": {"$regex": source_pattern, "$options": "i"}}, {"description": {"$regex": pattern, "$options": "i"}}, {"details": {"$regex": pattern, "$options": "i"}}]
            query["$or"] = search_terms
            custom_query["$or"] = search_terms
        else:
            if category_source_id:
                custom_query["categorySourceId"] = str(category_source_id)
            elif parent_category_id:
                custom_query["parentCategoryId"] = str(parent_category_id)
            elif category:
                custom_query["category"] = category
            if kind == "category" and search and search.strip():
                pattern = re.escape(search.strip()[:100])
                source_pattern = re.escape(search.strip().removeprefix("shopbase-")[:100])
                custom_query["$and"] = [{"$or": [{"title": {"$regex": pattern, "$options": "i"}}, {"category": {"$regex": pattern, "$options": "i"}}, {"id": {"$regex": pattern, "$options": "i"}}, {"sourceId": {"$regex": source_pattern, "$options": "i"}}, {"description": {"$regex": pattern, "$options": "i"}}, {"details": {"$regex": pattern, "$options": "i"}}]}]
        # Use compact fields for the ranking scan. Large uploaded image data is
        # fetched only for the selected page below.
        metadata_fields = {"_id": 1, "sourceId": 1, "id": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "suggestedRetailPrice": 1, "wholesalePrice": 1, "compareAt": 1, "originalPrice": 1, "discountedPrice": 1, "source": 1, "active": 1}
        override_fields = {"_id": 0, "id": 1, "active": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "originalPrice": 1, "discountedPrice": 1, "compareAt": 1}
        source_docs = list(store.products.find(query, metadata_fields))
        source_product_ids = [_catalog_product_id(item) for item in source_docs]
        overrides = {item["id"]: item for item in store.admin_products.find({"source": "shopbase", "id": {"$in": source_product_ids}}, override_fields)} if source_product_ids else {}
        ranked = []
        for item in source_docs:
            product = public_product(item)
            override = overrides.get(product["id"])
            if override and override.get("active") is False:
                continue
            if override:
                product = _apply_shopbase_override(product, override, retailer_price=item.get("wholesalePrice"))
            elif item.get("wholesalePrice") is not None:
                product["retailerPrice"] = item["wholesalePrice"]
            ranked.append(product)
        for item in store.admin_products.find(custom_query, metadata_fields):
            ranked.append(public_product(item))
        ranked.sort(key=lambda item: (float(item.get("price") or 0) * (-1 if reverse else 1), str(item.get("title", "")).casefold(), str(item.get("id", ""))))
        total = store.products.count_documents(query) + store.admin_products.count_documents(custom_query)
        ranked_page = ranked[offset:offset + limit]
        source_ids = [str(item["sourceId"]) for item in ranked_page if item.get("source") == "shopbase" and item.get("sourceId")]
        custom_ids = [str(item["id"]) for item in ranked_page if item.get("source") != "shopbase" and item.get("id")]
        source_fields = {"_id": 0, "sourceId": 1, "source": 1, "active": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "suggestedRetailPrice": 1, "compareAt": 1, "image": 1, "images": {"$slice": 1}, "stock": 1, "rating": 1, "reviews": 1, "trending": 1, "offer": 1, "badge": 1}
        docs = list(store.products.find({"source": "shopbase", "sourceId": {"$in": source_ids}}, source_fields)) if source_ids else []
        product_ids = [f"shopbase-{source_id}" for source_id in source_ids]
        override_fields = {"_id": 0, "id": 1, "active": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "image": 1, "images": {"$slice": 1}, "stock": 1, "description": 1, "trending": 1, "offer": 1, "badge": 1, "originalPrice": 1, "discountedPrice": 1, "compareAt": 1, "price": 1}
        overrides = {item["id"]: item for item in store.admin_products.find({"source": "shopbase", "id": {"$in": product_ids}}, override_fields)} if product_ids else {}
        products_by_id: dict[str, dict[str, Any]] = {}
        for item in docs:
            product = public_product(item)
            override = overrides.get(product["id"])
            products_by_id[product["id"]] = _apply_shopbase_override(product, override) if override else product
        custom_docs = list(store.admin_products.find({"source": "custom", "active": True, "id": {"$in": custom_ids}}, {"_id": 0})) if custom_ids else []
        for item in custom_docs:
            products_by_id[str(item["id"])] = public_product(item)
        ordered_ids = [str(item.get("id", "")) for item in ranked_page]
        page_products = [products_by_id[product_id] for product_id in ordered_ids if product_id in products_by_id]
        return {"products": [_externalize_product_images(product, request) for product in page_products], "hasMore": offset + len(ranked_page) < total, "nextOffset": offset + len(ranked_page), "total": total}

    if kind in ("home", "home_categories"):
        try:
            category_products, next_category_offset, category_has_more = _home_category_samples(store, settings, category_offset)
        except Exception:
            logging.exception("Could not load homepage category samples")
    if kind == "home_categories":
        return {
            "products": [],
            "categoryProducts": [_externalize_product_images(product, request) for product in category_products],
            "categoryHasMore": category_has_more,
            "nextCategoryOffset": next_category_offset,
        }

    explicit_ids = list(dict.fromkeys(item for item in explicit_ids if item))
    if kind == "trending":
        explicit_ids = priority_trending_ids
    if kind in ("home", "trending") and not explicit_ids:
        query["trending"] = True
    if kind == "offers" and not explicit_ids:
        return {"products": [], "hasMore": False, "nextOffset": 0, "total": 0, "trendingIds": []}
    if explicit_ids:
        if kind == "offer" and sort in ("low-high", "high-low"):
            source_ids_for_sort = [item.removeprefix("shopbase-") for item in explicit_ids if item.startswith("shopbase-")]
            custom_ids_for_sort = [item for item in explicit_ids if not item.startswith("shopbase-")]
            source_fields_for_sort = {"_id": 0, "sourceId": 1, "title": 1, "price": 1, "suggestedRetailPrice": 1, "wholesalePrice": 1}
            source_docs_for_sort = list(store.products.find({"source": "shopbase", "sourceId": {"$in": source_ids_for_sort}}, source_fields_for_sort)) if source_ids_for_sort else []
            override_ids_for_sort = [f"shopbase-{item}" for item in source_ids_for_sort]
            sort_overrides = {item["id"]: item for item in store.admin_products.find({"source": "shopbase", "id": {"$in": override_ids_for_sort}}, {"_id": 0, "id": 1, "active": 1, "title": 1, "originalPrice": 1, "discountedPrice": 1, "price": 1, "compareAt": 1})} if override_ids_for_sort else {}
            prices: dict[str, tuple[float, str]] = {}
            selected_offer = store.offers.find_one({"id": offer_id, "active": True}, {"_id": 0}) or {}
            def deal_price(price: float) -> float:
                candidates: list[float] = []
                if selected_offer.get("kind") == "special_price":
                    candidates.append(float(selected_offer.get("value") or 0))
                elif selected_offer.get("kind") == "quantity_discount" and int(selected_offer.get("quantity") or 0) == 1:
                    value = float(selected_offer.get("value") or 0)
                    candidates.append(price * (1 - value / 100) if selected_offer.get("discountKind") == "percent" else price - value)
                elif selected_offer.get("kind") == "buy_multiple":
                    for tier in selected_offer.get("tiers") or []:
                        if int(tier.get("quantity") or 0) != 1: continue
                        value = float(tier.get("value") or 0)
                        candidates.append(value if tier.get("mode") == "price" else price * (1 - value / 100) if tier.get("discountKind") == "percent" else price - value if tier.get("mode") == "discount" else price)
                valid = [value for value in candidates if 0 < value < price]
                return min(valid) if valid else price
            for item in source_docs_for_sort:
                product = public_product(item)
                override = sort_overrides.get(product["id"])
                if override and override.get("active") is not False:
                    product = _apply_shopbase_override(product, override)
                prices[product["id"]] = (deal_price(float(product.get("price") or 0)), str((override or {}).get("title") or product.get("title", "")).casefold())
            for item in store.admin_products.find({"source": "custom", "active": True, "id": {"$in": custom_ids_for_sort}}, {"_id": 0, "id": 1, "title": 1, "price": 1, "originalPrice": 1, "discountedPrice": 1, "compareAt": 1}):
                product = public_product(item)
                prices[product["id"]] = (deal_price(float(product.get("price") or 0)), str(product.get("title", "")).casefold())
            explicit_ids.sort(key=lambda product_id: ((prices.get(product_id, (0, ""))[0] * (-1 if sort == "high-low" else 1)), prices.get(product_id, (0, ""))[1], product_id))
        selected_ids = explicit_ids[offset:offset + limit]
        source_ids = [item.removeprefix("shopbase-") for item in selected_ids if item.startswith("shopbase-")]
        custom_ids = [item for item in selected_ids if not item.startswith("shopbase-")]
        id_query: dict[str, Any] = {"$or": ([{"sourceId": {"$in": source_ids}}] if source_ids else []) + ([{"id": {"$in": custom_ids}}] if custom_ids else [])}
        # Keep priority feeds small and JSON-safe. Returning whole Mongo
        # documents here leaked ObjectIds into the response and made every
        # explicit-ID feed (home, trends and offer detail) fail serialization.
        source_fields = {"_id": 0, "sourceId": 1, "source": 1, "active": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "suggestedRetailPrice": 1, "compareAt": 1, "image": 1, "stock": 1, "rating": 1, "reviews": 1, "trending": 1, "offer": 1, "badge": 1}
        custom_fields = {"_id": 0, "id": 1, "sourceId": 1, "source": 1, "active": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "originalPrice": 1, "discountedPrice": 1, "compareAt": 1, "image": 1, "stock": 1, "description": 1, "rating": 1, "reviews": 1, "trending": 1, "offer": 1, "badge": 1}
        override_fields = {"_id": 0, "id": 1, "active": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "image": 1, "images": {"$slice": 1}, "stock": 1, "description": 1, "trending": 1, "offer": 1, "badge": 1, "originalPrice": 1, "discountedPrice": 1, "compareAt": 1, "price": 1}
        docs = list(store.products.find({**query, **id_query}, source_fields).limit(limit)) if source_ids else []
        custom_docs = list(store.admin_products.find({"source": "custom", "active": True, "id": {"$in": custom_ids}}, custom_fields).limit(limit)) if custom_ids else []
        overrides = {item["id"]: item for item in store.admin_products.find({"source": "shopbase", "id": {"$in": [f"shopbase-{source_id}" for source_id in source_ids]}}, override_fields)} if source_ids else {}
        products_by_id: dict[str, dict[str, Any]] = {}
        for item in docs:
            product = public_product(item)
            override = overrides.get(product["id"])
            if not override or override.get("active") is not False:
                products_by_id[product["id"]] = _apply_shopbase_override(product, override) if override else product
        for item in custom_docs:
            product = public_product(item)
            products_by_id[product["id"]] = product
        products = [_externalize_product_images(products_by_id[item], request) for item in selected_ids if item in products_by_id]
        total = store.product_views.count_documents({}) if kind == "trending" else len(explicit_ids)
        payload = {"products": products, "hasMore": offset + len(selected_ids) < total, "nextOffset": offset + len(selected_ids), "total": total, "trendingIds": priority_trending_ids}
        if category_products or kind == "home":
            payload["categoryProducts"] = [_externalize_product_images(product, request) for product in category_products]
            payload["categoryHasMore"] = category_has_more
            payload["nextCategoryOffset"] = next_category_offset
        return payload
    else:
        source_fields = {"_id": 0, "sourceId": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "suggestedRetailPrice": 1, "image": 1, "stock": 1, "active": 1, "source": 1, "trending": 1, "offer": 1, "badge": 1}
        custom_query: dict[str, Any] = {"source": "custom", "active": True}
        if kind == "search" and search:
            raw_search = search.strip()[:100]
            pattern = re.escape(raw_search)
            source_pattern = re.escape(raw_search.removeprefix("shopbase-"))
            custom_query["$or"] = [{"title": {"$regex": pattern, "$options": "i"}}, {"category": {"$regex": pattern, "$options": "i"}}, {"id": {"$regex": pattern, "$options": "i"}}, {"sourceId": {"$regex": source_pattern, "$options": "i"}}, {"description": {"$regex": pattern, "$options": "i"}}, {"details": {"$regex": pattern, "$options": "i"}}]
        elif category_source_id:
            custom_query["categorySourceId"] = str(category_source_id)
        elif parent_category_id:
            custom_query["parentCategoryId"] = str(parent_category_id)
        elif category:
            custom_query["category"] = category
        if kind == "category" and search and search.strip():
            pattern = re.escape(search.strip()[:100])
            source_pattern = re.escape(search.strip().removeprefix("shopbase-")[:100])
            custom_query["$and"] = [{"$or": [{"title": {"$regex": pattern, "$options": "i"}}, {"category": {"$regex": pattern, "$options": "i"}}, {"id": {"$regex": pattern, "$options": "i"}}, {"sourceId": {"$regex": source_pattern, "$options": "i"}}, {"description": {"$regex": pattern, "$options": "i"}}, {"details": {"$regex": pattern, "$options": "i"}}]}]
        custom_count = store.admin_products.count_documents(custom_query)
        search_candidates = kind == "search" and bool(search and search.strip())
        override_matches: list[dict[str, Any]] = []
        override_source_ids: list[str] = []
        if search_candidates:
            raw_search = search.strip()[:100]
            pattern = re.escape(raw_search)
            source_pattern = re.escape(raw_search.removeprefix("shopbase-"))
            override_query = {"source": "shopbase", "active": {"$ne": False}, "$or": [{"title": {"$regex": pattern, "$options": "i"}}, {"category": {"$regex": pattern, "$options": "i"}}, {"id": {"$regex": pattern, "$options": "i"}}, {"sourceId": {"$regex": source_pattern, "$options": "i"}}, {"description": {"$regex": pattern, "$options": "i"}}, {"details": {"$regex": pattern, "$options": "i"}}]}
            override_matches = list(store.admin_products.find(override_query, {"_id": 0, "id": 1, "sourceId": 1, "title": 1}).sort([("title", 1), ("id", 1)]))
            override_source_ids = list(dict.fromkeys(str(item.get("sourceId") or str(item.get("id", "")).removeprefix("shopbase-")) for item in override_matches))
            base_search_ids = {str(item.get("sourceId", "")) for item in store.products.find(query, {"_id": 0, "sourceId": 1}) if item.get("sourceId")}
            matched_override_ids = {str(item.get("sourceId", "")) for item in store.products.find({"source": "shopbase", "active": {"$ne": False}, "sourceId": {"$in": override_source_ids}}, {"_id": 0, "sourceId": 1}) if item.get("sourceId")} if override_source_ids else set()
            shopbase_count = len(base_search_ids | matched_override_ids)
        else:
            shopbase_count = store.products.count_documents(query)
        candidate_limit = max(offset + limit, limit * 20) if search_candidates else limit
        shopbase_offset = 0 if search_candidates else min(offset, shopbase_count)
        shopbase_take = min(candidate_limit, max(0, shopbase_count - shopbase_offset))
        shopbase_sort = [("title", 1), ("_id", 1)] if search_candidates else [("_id", 1)]
        docs = list(store.products.find(query, source_fields).sort(shopbase_sort).skip(shopbase_offset).limit(shopbase_take))
        if search_candidates:
            needle = search.strip()
            source_needle = needle.removeprefix("shopbase-")
            prioritized_shopbase = list(store.products.find({"source": "shopbase", "sourceId": source_needle, "active": {"$ne": False}}, source_fields).limit(1))
            prioritized_shopbase.extend(store.products.find({"source": "shopbase", "title": {"$regex": f"^{re.escape(needle)}$", "$options": "i"}, "active": {"$ne": False}}, source_fields).limit(5))
            known_source_ids = {str(item.get("sourceId", "")) for item in docs}
            docs.extend(item for item in prioritized_shopbase if str(item.get("sourceId", "")) not in known_source_ids)
            override_candidate_source_ids = override_source_ids[:candidate_limit]
            if override_candidate_source_ids:
                docs.extend(store.products.find({"source": "shopbase", "active": {"$ne": False}, "sourceId": {"$in": override_candidate_source_ids}}, source_fields).limit(candidate_limit))
            docs = list({str(item.get("sourceId", "")): item for item in reversed(docs)}.values())
        source_ids = [_catalog_product_id(item) for item in docs]
        overrides = {item["id"]: item for item in store.admin_products.find({"source": "shopbase", "id": {"$in": source_ids}}, {"_id": 0})} if source_ids else {}
        products = []
        for item in docs:
            product = public_product(item)
            override = overrides.get(product["id"])
            if not override or override.get("active") is not False:
                products.append(_apply_shopbase_override(product, override) if override else product)
        custom_offset = 0 if search_candidates else max(0, offset - shopbase_count)
        custom_take = candidate_limit if search_candidates else max(0, limit - len(products))
        custom_sort = [("title", 1), ("_id", 1)] if search_candidates else [("_id", 1)]
        custom_docs = list(store.admin_products.find(custom_query, {"_id": 0}).sort(custom_sort).skip(custom_offset).limit(custom_take))
        if search_candidates:
            needle = search.strip()
            prioritized_custom = list(store.admin_products.find({"source": "custom", "id": needle, "active": True}, {"_id": 0}).limit(1))
            prioritized_custom.extend(store.admin_products.find({"source": "custom", "title": {"$regex": f"^{re.escape(needle)}$", "$options": "i"}, "active": True}, {"_id": 0}).limit(5))
            known_custom_ids = {str(item.get("id", "")) for item in custom_docs}
            custom_docs.extend(item for item in prioritized_custom if str(item.get("id", "")) not in known_custom_ids)
        products.extend(public_product(item) for item in custom_docs)
        if search_candidates:
            needle = search.strip().casefold().removeprefix("shopbase-")
            def search_relevance(product: dict[str, Any]) -> tuple[int, str, str]:
                product_id = str(product.get("sourceId") or product.get("id") or "").casefold().removeprefix("shopbase-")
                title = str(product.get("title", "")).casefold()
                category_name = str(product.get("category", "")).casefold()
                rank = 0 if product_id == needle else 1 if title == needle else 2 if title.startswith(needle) else 3 if needle in title else 4 if needle in category_name else 5
                return rank, title, str(product.get("id", ""))
            products.sort(key=search_relevance)
            page_products = products[offset:offset + limit]
            return {"products": [_externalize_product_images(product, request) for product in page_products], "hasMore": offset + len(page_products) < shopbase_count + custom_count, "nextOffset": offset + len(page_products), "total": shopbase_count + custom_count}
        next_offset = offset + len(products)
        if kind in ("home", "trending") and not priority_trending_ids:
            priority_trending_ids = [product["id"] for product in products if product.get("trending")][:20]
        payload = {"products": [_externalize_product_images(product, request) for product in products], "hasMore": next_offset < shopbase_count + custom_count, "nextOffset": next_offset, "total": shopbase_count + custom_count, "trendingIds": priority_trending_ids}
        if category_products or kind == "home":
            payload["categoryProducts"] = [_externalize_product_images(product, request) for product in category_products]
            payload["categoryHasMore"] = category_has_more
            payload["nextCategoryOffset"] = next_category_offset
        return payload

    total = len(products)
    sliced = products[offset:offset + limit]
    return {"products": sliced, "hasMore": offset + len(sliced) < total, "nextOffset": offset + len(sliced), "total": total}

@app.get("/api/admin/catalog-summary")
def admin_catalog_summary(authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    store = db()
    latest = store.sync_runs.find_one({"status": {"$in": ["success", "success_with_skipped_details"]}}, {"_id": 0}, sort=[("finishedAt", -1)])
    category_counts: dict[str, int] = {}
    try:
        groups = store.products.aggregate([
            {"$match": {"source": "shopbase"}},
            {"$group": {"_id": {"sourceId": "$categorySourceId", "name": "$category"}, "count": {"$sum": 1}}},
        ])
        for group in groups:
            key = group.get("_id") or {}
            if key.get("sourceId"):
                category_counts[str(key["sourceId"])] = category_counts.get(str(key["sourceId"]), 0) + int(group.get("count", 0))
            if key.get("name"):
                name = str(key["name"]).strip().casefold()
                category_counts[name] = category_counts.get(name, 0) + int(group.get("count", 0))
        for group in store.admin_products.aggregate([
            {"$match": {"source": "custom"}},
            {"$group": {"_id": {"sourceId": "$categorySourceId", "name": "$category"}, "count": {"$sum": 1}}},
        ]):
            key = group.get("_id") or {}
            if key.get("sourceId"):
                category_counts[str(key["sourceId"])] = category_counts.get(str(key["sourceId"]), 0) + int(group.get("count", 0))
            if key.get("name"):
                name = str(key["name"]).strip().casefold()
                category_counts[name] = category_counts.get(name, 0) + int(group.get("count", 0))
    except Exception:
        logging.exception("Could not calculate category product counts")
    return {
        "importedProducts": store.products.count_documents({"source": "shopbase"}),
        "customProducts": store.admin_products.count_documents({"source": "custom"}),
        "lastSync": (latest or {}).get("finishedAt"),
        "categoryCounts": category_counts,
    }

@app.get("/api/products/{source_id}")
def product_details(source_id: str, request: Request):
    try:
        custom = db().admin_products.find_one({"id": source_id, "source": "custom", "active": True}, {"_id": 0})
        if custom:
            return _externalize_product_images(public_product(custom, include_details=True), request)
        product = db().products.find_one({"sourceId": source_id, "source": "shopbase", "active": True}, {"_id": 0})
        if not product:
            raise HTTPException(status_code=404, detail="Product is unavailable.")
        result = public_product(product, include_details=True)
        override = db().admin_products.find_one({"id": f"shopbase-{source_id}", "source": "shopbase"}, {"_id": 0})
        if override:
            result = _apply_shopbase_override(result, override)
        return _externalize_product_images(result, request)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=503, detail="Could not load product details.")


