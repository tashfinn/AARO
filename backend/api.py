import logging
import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pymongo import MongoClient
from category_groups import category_group_payload

app = FastAPI(title="AARO catalog API", version="0.1.0")
origins = [x.strip() for x in os.getenv("FRONTEND_ORIGINS", "http://localhost:5173,http://localhost:4173").split(",") if x.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False, allow_methods=["GET"], allow_headers=["*"])
_client = None

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
