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
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pymongo import MongoClient, UpdateOne
import requests
from nacl import encoding, public
from category_groups import category_group_payload

app = FastAPI(title="AARO catalog API", version="0.1.0")
origins = [x.strip() for x in os.getenv("FRONTEND_ORIGINS", "http://localhost:5173,http://localhost:4173").split(",") if x.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"], allow_headers=["*"])
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

class AdminProductInput(BaseModel):
    id: str = Field(min_length=1, max_length=180)
    source: Literal["custom", "shopbase"] = "custom"
    sourceId: str | None = Field(default=None, max_length=180)
    title: str = Field(min_length=1, max_length=300)
    category: str = Field(min_length=1, max_length=180)
    price: float = Field(ge=0)
    compareAt: float | None = Field(default=None, ge=0)
    image: str = Field(min_length=1, max_length=2048)
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
    active: bool = True

class CouponValidationInput(BaseModel):
    code: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")
    subtotal: float = Field(ge=0)


class OfferInput(BaseModel):
    title: str = Field(default="", max_length=120)
    id: str = Field(min_length=1, max_length=80)
    productId: str = Field(default="", max_length=120)
    productIds: list[str] = Field(default_factory=list, max_length=20)
    kind: str
    value: float = Field(default=0, ge=0)
    discountKind: str = "percent"
    quantity: int = Field(default=1, ge=1, le=1000)
    freeQuantity: int = Field(default=1, ge=1, le=1000)
    reward: Literal["discount", "free_delivery", "both"] = "discount"
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
                product = public_product(product, include_details=True)
                product.update({key: override[key] for key in ("title", "category", "price", "compareAt", "image", "description", "stock", "active", "sizes", "options") if key in override})
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
        for offer in store.offers.find({"productId": product_id, "active": True}, {"_id": 0}):
            offer_quantity = max(1, int(offer.get("quantity") or 1))
            if offer.get("kind") == "special_price":
                offer_discount += max(0.0, unit_price - min(unit_price, float(offer.get("value") or 0))) * quantity
            elif offer.get("kind") in ("quantity_discount", "buy_multiple"):
                groups = quantity // offer_quantity
                eligible_quantity = groups * offer_quantity
                reward = offer.get("reward", "discount")
                if offer.get("kind") == "quantity_discount" or reward in ("discount", "both"):
                    saving = eligible_quantity * unit_price * float(offer.get("value") or 0) / 100 if offer.get("discountKind") == "percent" else groups * float(offer.get("value") or 0)
                    offer_discount += min(eligible_quantity * unit_price, saving)
            elif offer.get("kind") == "buy_x_get_y_free":
                free_quantity = max(1, int(offer.get("freeQuantity") or 1))
                offer_discount += (quantity // (offer_quantity + free_quantity)) * free_quantity * unit_price

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
    free_delivery_quantity_offer = any(
        offer.get("kind") == "buy_multiple"
        and offer.get("reward") in ("free_delivery", "both")
        and quantities_by_id.get(offer.get("productId", ""), 0) >= max(1, int(offer.get("quantity") or 1))
        for offer in store.offers.find({"kind": "buy_multiple", "active": True}, {"_id": 0, "productId": 1, "quantity": 1, "reward": 1})
    )
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
def public_offers():
    return list(db().offers.find({"active": True}, {"_id": 0}))

@app.get("/api/admin/offers")
def list_offers(authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    return list(db().offers.find({}, {"_id": 0}))

@app.post("/api/admin/offers")
def save_offer(input: OfferInput, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    if input.kind not in ("special_price", "quantity_discount", "buy_multiple", "buy_x_get_y_free", "bundle", "free_delivery"):
        raise HTTPException(status_code=422, detail="Unknown offer type.")
    if input.kind in ("quantity_discount", "buy_multiple") and input.discountKind not in ("percent", "amount"):
        raise HTTPException(status_code=422, detail="Discount must be a percentage or fixed amount.")
    if input.kind == "buy_multiple" and input.quantity < 2:
        raise HTTPException(status_code=422, detail="A buy-multiple offer must require at least two items.")
    if input.kind in ("special_price", "quantity_discount") and input.value <= 0:
        raise HTTPException(status_code=422, detail="Enter a positive offer value.")
    if input.kind == "buy_multiple" and input.reward in ("discount", "both") and input.value <= 0:
        raise HTTPException(status_code=422, detail="Enter a positive discount for this buy-multiple offer.")
    if input.kind in ("quantity_discount", "buy_multiple") and input.reward in ("discount", "both") and input.discountKind == "percent" and input.value > 100:
        raise HTTPException(status_code=422, detail="A percentage offer cannot exceed 100%.")
    if input.kind in ("special_price", "quantity_discount", "buy_multiple", "buy_x_get_y_free"):
        if not input.productId:
            raise HTTPException(status_code=422, detail="Choose an active product for the offer.")
        if input.productId.startswith("shopbase-"):
            source_id = input.productId.removeprefix("shopbase-")
            product = db().products.find_one({"sourceId": source_id, "source": "shopbase"}, {"_id": 0, "price": 1, "suggestedRetailPrice": 1, "active": 1})
            override = db().admin_products.find_one({"id": input.productId, "source": "shopbase"}, {"_id": 0, "price": 1, "active": 1}) or {}
            price = override["price"] if "price" in override else (product or {}).get("suggestedRetailPrice") or (product or {}).get("price") or 0
            active = bool(product and product.get("active", True) and override.get("active", True))
        else:
            product = db().admin_products.find_one({"id": input.productId, "source": "custom"}, {"_id": 0, "price": 1, "active": 1})
            price = (product or {}).get("price") or 0
            active = bool(product and product.get("active", True))
        if not active:
            raise HTTPException(status_code=422, detail="Choose an active product for the offer.")
        if input.kind == "special_price" and input.value >= float(price):
            raise HTTPException(status_code=422, detail="The offer price must be lower than the product’s current price.")
    if input.kind == "bundle":
        product_ids = list(dict.fromkeys(input.productIds))
        if len(product_ids) < 2:
            raise HTTPException(status_code=422, detail="Choose at least two different products for the bundle.")
        retail_total = 0.0
        for product_id in product_ids:
            if product_id.startswith("shopbase-"):
                source_id = product_id.removeprefix("shopbase-")
                product = db().products.find_one({"sourceId": source_id, "source": "shopbase"}, {"_id": 0, "price": 1, "suggestedRetailPrice": 1, "active": 1})
                override = db().admin_products.find_one({"id": product_id, "source": "shopbase"}, {"_id": 0, "price": 1, "active": 1}) or {}
                active = bool(product and product.get("active", True) and override.get("active", True))
                price = override["price"] if "price" in override else (product or {}).get("suggestedRetailPrice") or (product or {}).get("price") or 0
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

def _category_groups_for_store(store):
    settings = store.store_settings.find_one({"_id": "storefront"}) or {}
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
    return merged, True

@app.get("/api/admin/storefront")
def admin_storefront_settings(authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    settings = db().store_settings.find_one({"_id": "storefront"}) or {}
    return {key: settings[key] for key in ("content", "categoryGroups", "manualCategories") if key in settings}

@app.patch("/api/admin/storefront")
def update_admin_storefront(input: StorefrontSettingsInput, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    values: dict[str, Any] = {}
    if input.content is not None:
        if len(json.dumps(input.content, ensure_ascii=False)) > 8_000_000:
            raise HTTPException(status_code=422, detail="Storefront settings are too large to save.")
        values["content"] = input.content
    if input.categoryGroups is not None:
        groups: list[dict[str, Any]] = []
        for group in input.categoryGroups[:100]:
            if not isinstance(group.get("id"), str) or not isinstance(group.get("name"), str) or not isinstance(group.get("children"), list):
                raise HTTPException(status_code=422, detail="Each category group needs an ID, name, and child list.")
            children = []
            for child in group["children"][:1000]:
                if not isinstance(child, dict) or not isinstance(child.get("name"), str):
                    continue
                children.append({key: child[key] for key in ("name", "sourceId", "sortOrder") if key in child and isinstance(child[key], (str, int, float))})
            groups.append({"id": group["id"][:180], "name": group["name"][:180], "children": children})
        values["categoryGroups"] = groups
    if input.manualCategories is not None:
        values["manualCategories"] = list(dict.fromkeys(value.strip()[:180] for value in input.manualCategories[:500] if value.strip()))
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
    if product["source"] == "shopbase" and not product.get("sourceId"):
        product["sourceId"] = product["id"].removeprefix("shopbase-")
    db().admin_products.replace_one({"id": product["id"]}, product, upsert=True)
    return product

@app.get("/api/admin/products")
def list_admin_products(authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    store = db()
    fields = {"_id": 1, "sourceId": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "suggestedRetailPrice": 1, "compareAt": 1, "image": 1, "stock": 1, "active": 1, "source": 1, "addedAt": 1, "updatedAt": 1, "trending": 1, "offer": 1, "badge": 1, "rating": 1, "reviews": 1, "sizes": 1, "options": 1}
    overrides = {item["id"]: item for item in store.admin_products.find({"source": "shopbase"}, {"_id": 0})}
    products = []
    for item in store.products.find({"source": "shopbase"}, fields).limit(20000):
        product_id = _catalog_product_id(item)
        added_at = item.get("addedAt") or (item.get("_id").generation_time.isoformat() if getattr(item.get("_id"), "generation_time", None) else None)
        product = public_product(item)
        product.pop("_id", None)
        product["addedAt"] = added_at
        override = overrides.get(product_id)
        if override:
            for key in ("title", "category", "price", "compareAt", "image", "description", "stock", "active", "trending", "offer", "badge", "sizes", "sizeChart", "details", "attributes", "options", "categorySourceId", "parentCategory", "parentCategoryId"):
                if key in override:
                    product[key] = override[key]
        products.append(product)
    for item in store.admin_products.find({"source": "custom"}).limit(20000):
        item["addedAt"] = item.get("addedAt") or (item.get("_id").generation_time.isoformat() if getattr(item.get("_id"), "generation_time", None) else None)
        item.pop("_id", None)
        products.append(item)
    products.sort(key=lambda item: str(item.get("title", "")).casefold())
    return products

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
    result = public_product(product, include_details=True)
    if saved:
        for key in ("title", "category", "price", "compareAt", "image", "description", "stock", "active", "trending", "offer", "badge", "sizes", "sizeChart", "details", "attributes", "options", "categorySourceId", "parentCategory", "parentCategoryId"):
            if key in saved:
                result[key] = saved[key]
    return result

def public_product(product, include_details=False):
    product["id"] = f"shopbase-{product.get('sourceId', '')}" if product.get("source") == "shopbase" else str(product.get("id", ""))
    # The supplier's suggested retail price is the storefront price. Keep the
    # wholesale value in MongoDB, but never expose it in the public catalog.
    product["price"] = product.get("suggestedRetailPrice") or product.get("price", 0)
    if product.get("compareAt"):
        try:
            if float(product["compareAt"]) <= float(product["price"]):
                product["compareAt"] = None
        except (TypeError, ValueError):
            product["compareAt"] = None
    for private_field in ("wholesalePrice", "listFingerprint", "lastSeenRun", "missingRuns", "detailsFetchedAt", "detailsVersion", "imageOverride", "sourceImage", "sourceImages"):
        product.pop(private_field, None)
    product.setdefault("rating", 0)
    product.setdefault("reviews", 0)
    product.setdefault("source", "shopbase")
    # Older catalog runs stored recommendation thumbnails alongside the
    # product's actual image. The first item is the primary, high-resolution
    # product photo; never expose the recommendation images as a gallery.
    primary_image = (product.get("images") or [None])[0] or product.get("image")
    if primary_image:
        product["image"] = primary_image
    if include_details:
        product["images"] = [primary_image] if primary_image else []
    else:
        product.pop("images", None)
    if not include_details and product.get("source") == "shopbase":
        product["description"] = ""
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
def catalog():
    try:
        store = db()
        fields = {"_id": 0, "sourceId": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "suggestedRetailPrice": 1, "compareAt": 1, "image": 1, "stock": 1, "active": 1, "source": 1, "updatedAt": 1, "trending": 1, "offer": 1, "badge": 1, "rating": 1, "reviews": 1, "sizes": 1, "options": 1}
        overrides = {item["id"]: item for item in store.admin_products.find({"source": "shopbase"}, {"_id": 0})}
        products = []
        for item in store.products.find({"source": "shopbase"}, fields).limit(20000):
            product_id = _catalog_product_id(item)
            override = overrides.get(product_id)
            if override and override.get("active") is False:
                continue
            product = public_product(item)
            if override:
                for key in ("title", "category", "price", "compareAt", "image", "description", "stock", "active", "trending", "offer", "badge", "sizes", "sizeChart", "details", "attributes", "options", "categorySourceId", "parentCategory", "parentCategoryId"):
                    if key in override:
                        product[key] = override[key]
            products.append(product)
        products.extend(public_product(item) for item in store.admin_products.find({"source": "custom", "active": True}, {"_id": 0}).limit(20000))
        products = [product for product in products if product.get("active", True)]
        products.sort(key=lambda item: str(item.get("title", "")).casefold())
        view_counts = {item["productId"]: int(item.get("views", 0)) for item in store.product_views.find({}, {"_id": 0, "productId": 1, "views": 1})}
        categories = list(store.categories.find({"source": "shopbase", "type": {"$ne": "parent"}}, {"_id": 0, "sourceId": 1, "name": 1, "parentId": 1, "parentName": 1, "sortOrder": 1, "sourceOrder": 1}))
        # The supplier's catalog order is the tie-breaker for same-named child
        # categories (e.g. Denim Jacket under two parent collections).
        if categories and all(item.get("sourceOrder") is not None for item in categories):
            categories.sort(key=lambda item: item["sourceOrder"])
        groups, _ = _category_groups_for_store(store)
        settings = store.store_settings.find_one({"_id": "storefront"}) or {}
        manual_categories = settings.get("manualCategories", [])
        latest = store.sync_runs.find_one({"status": {"$in": ["success", "success_with_skipped_details"]}}, {"_id": 0}, sort=[("finishedAt", -1)])
        return {"products": products, "categories": list(dict.fromkeys([item["name"] for item in categories] + manual_categories)), "categoryGroups": groups, "categoryGroupsManaged": isinstance(settings.get("categoryGroups"), list), "manualCategories": manual_categories, "manualCategoriesManaged": isinstance(settings.get("manualCategories"), list), "content": settings.get("content"), "lastSync": (latest or {}).get("finishedAt"), "productViewCounts": view_counts}
    except HTTPException:
        raise
    except Exception:
        logging.exception("Catalog load failed")
        raise HTTPException(status_code=503, detail="Could not load catalog.")

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

@app.get("/api/products/{source_id}")
def product_details(source_id: str):
    try:
        custom = db().admin_products.find_one({"id": source_id, "source": "custom", "active": True}, {"_id": 0})
        if custom:
            return public_product(custom, include_details=True)
        product = db().products.find_one({"sourceId": source_id, "source": "shopbase", "active": True}, {"_id": 0})
        if not product:
            raise HTTPException(status_code=404, detail="Product is unavailable.")
        result = public_product(product, include_details=True)
        override = db().admin_products.find_one({"id": f"shopbase-{source_id}", "source": "shopbase"}, {"_id": 0})
        if override:
            for key in ("title", "category", "price", "compareAt", "image", "description", "stock", "active", "trending", "offer", "badge", "sizes", "sizeChart", "details", "attributes", "options", "categorySourceId", "parentCategory", "parentCategoryId"):
                if key in override:
                    result[key] = override[key]
        return result
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=503, detail="Could not load product details.")
