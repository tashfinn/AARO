import logging
import os
import base64
import hashlib
import hmac
import json
import secrets
import time
import uuid
from datetime import datetime, timezone
from typing import Any
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pymongo import MongoClient
import requests
from category_groups import category_group_payload

app = FastAPI(title="AARO catalog API", version="0.1.0")
origins = [x.strip() for x in os.getenv("FRONTEND_ORIGINS", "http://localhost:5173,http://localhost:4173").split(",") if x.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"], allow_headers=["*"])
_client = None
PASSWORD_ROUNDS = 310_000

class CustomerCredentials(BaseModel):
    identifier: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=10, max_length=256)
    name: str | None = Field(default=None, min_length=2, max_length=120)

class SyncRequest(BaseModel):
    refresh_details: bool = True

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
    subtotal: float = Field(ge=0)
    delivery: float = Field(ge=0)
    discount: float = Field(ge=0)
    total: float = Field(ge=0)
    coupon: str | None = None

class CouponInput(BaseModel):
    code: str = Field(min_length=3, max_length=32)
    kind: str
    value: float = Field(gt=0)
    minimum: float | None = Field(default=None, ge=0)
    active: bool = True


class OfferInput(BaseModel):
    title: str = Field(default="", max_length=120)
    id: str = Field(min_length=1, max_length=80)
    productId: str = Field(min_length=1, max_length=120)
    kind: str
    value: float = Field(default=0, ge=0)
    discountKind: str = "percent"
    quantity: int = Field(default=1, ge=1, le=1000)
    freeQuantity: int = Field(default=1, ge=1, le=1000)
    active: bool = True

class OrderStatusInput(BaseModel):
    status: str

@app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
def root():
    # UptimeRobot's HTTP monitor checks the service root with HEAD. Return a
    # successful response here so a healthy API isn't reported as an outage.
    return {"ok": True, "service": "AARO catalog API"}

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
    addresses = [{**address, "id": str(address.get("id") or uuid.uuid4().hex)} for address in input.addresses]
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

@app.get("/api/admin/coupons")
def list_coupons(authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    return list(db().coupons.find({}, {"_id": 0}))

@app.post("/api/admin/coupons")
def save_coupon(input: CouponInput, authorization: str | None = Header(default=None)):
    _admin_from_auth(authorization)
    if input.kind not in ("percent", "amount"):
        raise HTTPException(status_code=422, detail="Coupon type must be percent or amount.")
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
    user = _customer_from_auth(authorization) if authorization else None
    order_id = f"AR-{uuid.uuid4().hex[:8].upper()}"
    order = {**input.model_dump(), "id": order_id, "customerId": user["_id"] if user else None, "createdAt": datetime.now(timezone.utc).isoformat(), "status": "Pending confirmation"}
    db().orders.insert_one(order)
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
    if input.kind not in ("special_price", "quantity_discount", "buy_x_get_y_free"):
        raise HTTPException(status_code=422, detail="Unknown offer type.")
    if input.kind == "quantity_discount" and input.discountKind not in ("percent", "amount"):
        raise HTTPException(status_code=422, detail="Discount must be a percentage or fixed amount.")
    if input.kind != "buy_x_get_y_free" and input.value <= 0:
        raise HTTPException(status_code=422, detail="Enter a positive offer value.")
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
        return progress
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
        response["progressPercent"] = 15 + round((response.get("productsProcessed", 0) / response["totalProducts"]) * 85)
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

def public_product(product, include_details=False):
    product["id"] = f"shopbase-{product.get('sourceId', '')}"
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
    if not include_details:
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
        fields = {"_id": 0, "sourceId": 1, "title": 1, "category": 1, "categorySourceId": 1, "parentCategory": 1, "parentCategoryId": 1, "price": 1, "suggestedRetailPrice": 1, "compareAt": 1, "image": 1, "stock": 1, "active": 1, "source": 1, "updatedAt": 1, "trending": 1, "offer": 1, "badge": 1, "rating": 1, "reviews": 1}
        products = [public_product(item) for item in store.products.find({"active": True}, fields).limit(20000)]
        products.sort(key=lambda item: str(item.get("title", "")).casefold())
        categories = list(store.categories.find({"source": "shopbase", "type": {"$ne": "parent"}}, {"_id": 0, "sourceId": 1, "name": 1, "parentId": 1, "parentName": 1, "sortOrder": 1, "sourceOrder": 1}))
        # The supplier's catalog order is the tie-breaker for same-named child
        # categories (e.g. Denim Jacket under two parent collections).
        if categories and all(item.get("sourceOrder") is not None for item in categories):
            categories.sort(key=lambda item: item["sourceOrder"])
        groups = category_group_payload(categories)
        latest = store.sync_runs.find_one({"status": "success"}, {"_id": 0}, sort=[("finishedAt", -1)])
        return {"products": products, "categories": [item["name"] for item in categories], "categoryGroups": groups, "lastSync": (latest or {}).get("finishedAt")}
    except HTTPException:
        raise
    except Exception:
        logging.exception("Catalog load failed")
        raise HTTPException(status_code=503, detail="Could not load catalog.")

@app.get("/api/products/{source_id}")
def product_details(source_id: str):
    try:
        product = db().products.find_one({"sourceId": source_id, "source": "shopbase", "active": True}, {"_id": 0})
        if not product:
            raise HTTPException(status_code=404, detail="Product is unavailable.")
        return public_product(product, include_details=True)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=503, detail="Could not load product details.")
