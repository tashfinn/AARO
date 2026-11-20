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
origins = list(dict.fromkeys([
    *(x.strip() for x in os.getenv("FRONTEND_ORIGINS", "").split(",") if x.strip()),
    "http://localhost:5173",
    "http://localhost:4173",
    # Keep both active Vercel names usable during the domain migration/redirect.
    "https://aarostore.vercel.app",
    "https://aaro-store.vercel.app",
]))
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
    active: bool = True

class CouponValidationInput(BaseModel):
    code: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")
    subtotal: float = Field(ge=0)


class OfferInput(BaseModel):
    title: str = Field(default="", max_length=120)
    id: str = Field(min_length=1, max_length=80)
    productId: str = Field(default="", max_length=120)
    productIds: list[str] = Field(default_factory=list)
    thumbnailProductIds: list[str] = Field(default_factory=list, max_length=3)
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
def public_offers():
    return sorted(list(db().offers.find({"active": True}, {"_id": 0})), key=lambda offer: offer.get("sortOrder", 0))

@app.get("/api/admin/offers")
def list_offers(authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    return list(db().offers.find({}, {"_id": 0}))

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
    product["images"] = images
    product["image"] = images[0]
    db().admin_products.replace_one({"id": product["id"]}, product, upsert=True)
    return product

@app.get("/api/admin/products")
def list_admin_products(authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    store = db()
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
    products.sort(key=lambda item: str(item.get("title", "")).casefold())
    return products

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
                product = _apply_shopbase_override(product, override)
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
        all_manual_categories = settings.get("manualCategories", [])
        manual_visibility = settings.get("manualCategoryVisibility", {}) if isinstance(settings.get("manualCategoryVisibility", {}), dict) else {}
        manual_categories = [name for name in all_manual_categories if manual_visibility.get(name, True) is not False]
        visible_sources = {str(child.get("sourceId")) for group in groups if group.get("showInStorefront", True) is not False for child in group.get("children", []) if child.get("showInStorefront", True) is not False and child.get("sourceId")}
        visible_names = {str(child.get("name", "")).casefold() for group in groups if group.get("showInStorefront", True) is not False for child in group.get("children", []) if child.get("showInStorefront", True) is not False and child.get("name")}
        visible_names.update(name.casefold() for name in manual_categories)
        products = [item for item in products if (str(item.get("categorySourceId")) in visible_sources if item.get("categorySourceId") else str(item.get("category", "")).casefold() in visible_names)]
        latest = store.sync_runs.find_one({"status": {"$in": ["success", "success_with_skipped_details"]}}, {"_id": 0}, sort=[("finishedAt", -1)])
        visible_shopbase_categories = [item["name"] for item in categories if str(item.get("sourceId", "")) in visible_sources]
        return {"products": products, "categories": list(dict.fromkeys(visible_shopbase_categories + manual_categories)), "categoryGroups": groups, "categoryGroupsManaged": isinstance(settings.get("categoryGroups"), list), "manualCategories": all_manual_categories, "manualCategoryVisibility": manual_visibility, "manualCategoriesManaged": isinstance(settings.get("manualCategories"), list), "content": settings.get("content"), "lastSync": (latest or {}).get("finishedAt"), "productViewCounts": view_counts}
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
            result = _apply_shopbase_override(result, override)
        return result
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=503, detail="Could not load product details.")


