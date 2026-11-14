# AARO backend and daily ShopBase sync

The backend reads product data from MongoDB; a daily Render Cron Job scans the authenticated reseller catalog. It reads category/card snapshots. Full details load immediately for new products or changed listing fields; otherwise details are refreshed in staggered batches every seven days by default. Set SHOPBASE_DETAIL_REFRESH_DAYS=1 for daily full detail refreshes, which can add thousands of requests per run. A missing item must be absent from two successful scans before it is marked unavailable.

This is an HTML importer rather than an official API. It uses a ShopBase session cookie, makes sequential requests with a delay, and stops without pruning if authentication fails or zero products are found. The initial scan of thousands of items may take much longer than two minutes. Later runs should be faster when few products changed.

## Secrets (set only in Render)

MONGODB_URI, MONGODB_DATABASE=aaro, SHOPBASE_SESSION_COOKIE, AARO_MARKUP_PERCENT=20, SHOPBASE_REQUEST_DELAY_SECONDS=0.35, SHOPBASE_DETAIL_REFRESH_DAYS=7, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_MIRROR_IMAGES=false by default; set true only after checking your usage, FRONTEND_ORIGINS.

The ShopBase cookie is as sensitive as a password. Do not paste it into chat or commit it. The current retail markup default is 20%; review it before real orders. Retail is capped at the supplier's suggested maximum when the parser finds one.

## Deploy

1. Push this project to a private GitHub repository.
2. Create an Atlas cluster and a database user restricted to the aaro database. In Atlas Network Access, allow the outbound IP ranges shown for your Render region. Do not use 0.0.0.0/0 in normal operation.
3. Create a Render Web Service from the repository with root directory backend, build command pip install -r requirements.txt, start command uvicorn api:app --host 0.0.0.0 --port $PORT. Add the Mongo variables. It serves /api/health and /api/catalog.
4. Create a Render Cron Job from the same repository with root directory backend, build command pip install -r requirements.txt, command python sync_shopbase.py, schedule 0 7 * * * (13:00 Bangladesh time). Add MongoDB, ShopBase, and optional Cloudinary variables. Render Cron Jobs have a $1/month minimum plus usage.
5. While logged into ShopBase, use Chrome DevTools Network to inspect a category request and copy its Cookie request header. Save it directly in Render as SHOPBASE_SESSION_COOKIE. Refresh this secret if a job is redirected to login.
6. Set FRONTEND_ORIGINS to the exact Vercel origin. Set VITE_API_URL in Vercel to the Render Web Service URL and redeploy.
7. Cloudinary mirrors primary images only when enabled with CLOUDINARY_MIRROR_IMAGES=true. Gallery image URLs are preserved as supplier URLs.

Trigger the first Cron Job manually in Render. Review the logs, catalog, prices, image behavior, and stock status before accepting real orders.
