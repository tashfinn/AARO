# AARO backend and ShopBase catalog sync

The FastAPI service reads the public catalog from MongoDB. GitHub Actions runs the authenticated ShopBase importer daily at 12:00 a.m. Bangladesh time (18:00 UTC). The importer reads category and product-card data, then product detail pages for descriptions, attribute lines, size charts/options, the main image, stock, and suggested retail pricing. A manually started workflow can force-refresh existing product details. A product is marked unavailable only after it is absent from two successful catalog scans.

ShopBase's 107 source categories are grouped under AARO's 13 parent categories in `category_groups.py`. The importer stores mappings by stable ShopBase category ID and restores the parent-category documents on each run. Unrecognized source labels remain under Other Categories and are included in the sync summary for review.

This is an HTML importer, not an official ShopBase API. It uses an authenticated ShopBase session cookie, makes sequential requests with a delay, and avoids pruning when authentication fails or no products are found. A first scan of thousands of products may take hours.

## Secrets and environment

Configure the Render web service with `MONGODB_URI`, `MONGODB_DATABASE=aaro`, `FRONTEND_ORIGINS`, and the admin/account auth settings. Configure GitHub Actions repository secrets with `MONGODB_URI` and `SHOPBASE_SESSION_COOKIE`. Optional Cloudinary secrets are `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`; image mirroring is off unless `CLOUDINARY_MIRROR_IMAGES=true` is explicitly set. The workflow also sets the request delay, markup, and detail-refresh interval.

Treat the ShopBase cookie like a password. Keep it in GitHub secrets, never in the storefront or repository. The importer uses the supplier's suggested price when available and otherwise applies the configured markup. Wholesale cost is excluded from public API responses.


## Admin Sync Now

The Product Sync screen can dispatch the existing GitHub Actions workflow and poll importer counters from MongoDB. Add a server-only `GITHUB_ACTIONS_TOKEN` environment variable to the Render API service. Use a fine-grained GitHub token restricted to `tashfinn/AARO` with Actions read and write access. Never add this token to Vercel or storefront code. Optional settings are `GITHUB_SYNC_REPOSITORY` (defaults to `tashfinn/AARO`) and `GITHUB_SYNC_WORKFLOW` (defaults to `shopbase-sync.yml`). Manual runs refresh product details and show category/product counts, completion percentage, and the GitHub Actions run link.

## Deploy

1. Deploy the `backend` directory as a Render Web Service with `pip install -r requirements.txt` and `uvicorn api:app --host 0.0.0.0 --port $PORT`.
2. Add MongoDB, CORS, and auth variables to Render. Set `FRONTEND_ORIGINS` to the exact Vercel storefront origin.
3. Add the MongoDB URI and ShopBase session cookie as GitHub repository secrets for the scheduled workflow.
4. Set `VITE_API_URL` in Vercel to the Render Web Service URL and redeploy the frontend.
5. Check `/api/health`, run the GitHub Actions catalog workflow when needed, and review the run summary and catalog before accepting orders.

Customer orders are saved for review, but staff still confirm with the customer and submit orders in ShopBase manually because supplier order submission is not connected. Product, category, and storefront-content edits in the current admin panel are browser-local; they are not durable MongoDB changes.
