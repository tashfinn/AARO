# AARO setup: daily catalog sync

The daily importer and read-only catalog API are in backend/. Never put passwords, cookies, database URIs, or Cloudinary secrets in chat or source code.

## 1. Push to a private GitHub repository

The D: project must be in a private Git repository before Render can deploy it.

## 2. Create MongoDB Atlas

Create a cluster and a database user with read/write access restricted to the aaro database. In Atlas Network Access, allow the outbound IP ranges shown for your Render region; avoid 0.0.0.0/0. Add the Atlas connection string to Render as MONGODB_URI.

## 3. Deploy on Render

Create a Web Service and Cron Job from the same repository. Root directory: backend. Build command: pip install -r requirements.txt. Web command: uvicorn api:app --host 0.0.0.0 --port $PORT. Cron command: python sync_shopbase.py. Schedule: 0 7 * * * (13:00 Bangladesh time). Render Cron Jobs currently have a $1/month minimum plus runtime usage.

Set MONGODB_URI and MONGODB_DATABASE=aaro on both services. Set SHOPBASE_SESSION_COOKIE on the Cron Job only. While logged into ShopBase, inspect a category request in Chrome DevTools Network and copy its Cookie request header. Save it directly in Render; do not paste it into chat. Refresh it if the job is redirected to login.

## 4. Add Cloudinary (optional)

Create a Cloudinary account and add the cloud name, API key, and API secret to Render's Cron Job environment. The secret stays server-side. The importer can mirror the primary image; gallery URLs remain supplier URLs. Set CLOUDINARY_MIRROR_IMAGES=true only after reviewing your Cloudinary usage for a first import of thousands of images.

## 5. Connect Vercel

Set FRONTEND_ORIGINS to the exact Vercel storefront origin on the Web Service. Set VITE_API_URL to the Render service URL in Vercel and redeploy. Check /api/health and manually trigger one Cron Job run.

Review the default 20% markup, supplier suggested-price parsing, stock status, and image URLs before taking real orders. Listing prices are checked daily; unchanged product descriptions and galleries are refreshed in staggered weekly batches. Storefront order/account/admin writes and checkout availability checks still need backend integration.
