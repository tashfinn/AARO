# AARO backend and ShopBase catalog sync

The FastAPI service reads the public catalog from MongoDB. GitHub Actions checks the saved catalog schedule once per hour. The admin Product Sync page can save a 6, 12, 24, or 48-hour interval and an hourly start time in Bangladesh time; the default is 24 hours from midnight. The importer reads category and product-card data, then product detail pages for descriptions, attribute lines, size charts/options, the main image, stock, and suggested retail pricing. A manually started workflow can force-refresh existing product details. A product is marked unavailable only after it is absent from two successful catalog scans.

ShopBase's 107 source categories are grouped under AARO's 13 parent categories in `category_groups.py`. The importer stores mappings by stable ShopBase category ID and restores the parent-category documents on each run. Unrecognized source labels remain under Other Categories and are included in the sync summary for review.

This is an HTML importer, not an official ShopBase API. It uses an authenticated ShopBase session cookie, makes sequential requests with a delay, and avoids pruning when authentication fails or no products are found. A first scan of thousands of products may take hours.

## Secrets and environment

Configure the Render web service with `MONGODB_URI`, `MONGODB_DATABASE=aaro`, `FRONTEND_ORIGINS`, and the admin/account auth settings. Configure GitHub Actions repository secrets with `MONGODB_URI` and `SHOPBASE_SESSION_COOKIE`. Add the ShopBase phone number and password once from Admin → Product sync; the API encrypts them directly into Actions Secrets as `SHOPBASE_USERNAME` and `SHOPBASE_PASSWORD`. Optional Cloudinary credentials are `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`. These credentials enable migration and automatic mirroring of manually uploaded storefront, product, and offer-share images. Mirroring supplier product images during sync remains off unless `CLOUDINARY_MIRROR_IMAGES=true` is explicitly set. The workflow also sets the request delay, markup, and detail-refresh interval.

### New-order email notifications

The API sends a transactional email in the background after each order has been saved. Set these **server-only** environment variables on the Render API service:

- `RESEND_API_KEY`: an API key from Resend.
- `ORDER_NOTIFICATION_FROM`: a sender address on a domain verified in Resend, for example `AARO Orders <orders@yourdomain.com>`.
- `ORDER_NOTIFICATION_EMAIL`: the store inbox that receives new orders. It defaults to `aaro.shop.bd@gmail.com`.

Create a Resend account, verify a sending domain, create an API key, and add the three variables in Render → your API service → Environment. Redeploy the API after saving them. The order is stored before the email task runs, so a mail-provider outage will not interrupt checkout; failures are logged by the API.

## Storefront image CDN

Set the three Cloudinary credentials on the Render API service, deploy the API, then open Admin → Storefront and choose **Move uploaded images to Cloudinary** once. The migration moves existing inline storefront images, manually uploaded product images, and offer share thumbnails to Cloudinary and saves the resulting CDN URLs back to MongoDB. Future storefront, product, and offer saves mirror new uploads automatically. Failed uploads remain inline so the affected images continue to work and can be retried.

Treat the ShopBase cookie like a password. Keep it in GitHub secrets, never in the storefront or repository. The importer uses the supplier's suggested price when available and otherwise applies the configured markup. Wholesale cost is excluded from public API responses.


## Admin Sync Now

The Product Sync screen can save the scheduled interval, dispatch the GitHub Actions workflow, and poll importer counters from MongoDB. Schedule settings are stored in the `sync_settings` collection. Add a server-only `GITHUB_ACTIONS_TOKEN` environment variable to the Render API service. Use a fine-grained GitHub token restricted to `tashfinn/AARO` with Actions read and write access. Never add this token to Vercel or storefront code. Optional settings are `GITHUB_SYNC_REPOSITORY` (defaults to `tashfinn/AARO`) and `GITHUB_SYNC_WORKFLOW` (defaults to `shopbase-sync.yml`). Manual runs refresh product details and show category/product counts, completion percentage, and the GitHub Actions run link.

## Deploy

1. Deploy the `backend` directory as a Render Web Service with `pip install -r requirements.txt` and `uvicorn api:app --host 0.0.0.0 --port $PORT`.
2. Add MongoDB, CORS, auth, and (for order emails) Resend variables to Render. Set `FRONTEND_ORIGINS` to the exact Vercel storefront origin.
3. Add the MongoDB URI and ShopBase session cookie as GitHub repository secrets for the scheduled workflow.
4. Set `VITE_API_URL` in Vercel to the Render Web Service URL and redeploy the frontend.
5. Check `/api/health`, run the GitHub Actions catalog workflow when needed, and review the run summary and catalog before accepting orders.

Customer orders are repriced and validated by the backend, then saved for review. Staff still confirm with the customer and submit orders in ShopBase manually because supplier order submission is not connected. Admin product overrides, category edits, and storefront content are saved in MongoDB and shared with storefront visitors.

## Hosted ShopBase sign-in

In Admin → Product sync, enter the ShopBase account phone number and password under **Hosted automatic sign-in** and save. The Render API encrypts both values with GitHub's repository public key and sends them directly to Actions Secrets. They are not stored in MongoDB or the repository. When a sync detects an expired cookie, the GitHub-hosted runner signs in to ShopBase headlessly, validates catalog access, and resumes that same sync. Your PC does not need to be powered on.

The Render `GITHUB_ACTIONS_TOKEN` must be a fine-grained token limited to `tashfinn/AARO`, with **Actions: Read and write** and **Secrets: Read and write**. The workflow installs Playwright Chromium for hosted sign-in. If ShopBase requires an interactive OTP, CAPTCHA, or other verification, the run reports that clearly; it cannot bypass the challenge, and a fresh cookie must be saved after signing in manually.
