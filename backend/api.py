import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pymongo import MongoClient

app = FastAPI(title="AARO catalog API", version="0.1.0")
origins = [x.strip() for x in os.getenv("FRONTEND_ORIGINS", "http://localhost:5173,http://localhost:4173").split(",") if x.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False, allow_methods=["GET"], allow_headers=["*"])
_client = None

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
    product.setdefault("rating", 0)
    product.setdefault("reviews", 0)
    product.setdefault("source", "shopbase")
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
        fields = {"_id": 0, "sourceId": 1, "title": 1, "category": 1, "price": 1, "compareAt": 1, "image": 1, "stock": 1, "active": 1, "source": 1, "updatedAt": 1, "trending": 1, "offer": 1, "badge": 1, "rating": 1, "reviews": 1}
        products = [public_product(item) for item in store.products.find({"active": True}, fields).sort("title", 1).limit(20000)]
        categories = list(store.categories.find({}, {"_id": 0}).sort("name", 1))
        latest = store.sync_runs.find_one({"status": "success"}, {"_id": 0}, sort=[("finishedAt", -1)])
        return {"products": products, "categories": [item["name"] for item in categories], "lastSync": (latest or {}).get("finishedAt")}
    except HTTPException:
        raise
    except Exception:
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
