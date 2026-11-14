# AARO production setup checklist

## Services and secrets

- Render web service: deploy from `backend/`; run `pip install -r requirements.txt` and `uvicorn api:app --host 0.0.0.0 --port $PORT`.
- Render environment: configure MongoDB, the application auth secret and password hash, and `FRONTEND_ORIGINS` for the exact Vercel domain.
- GitHub repository secrets: configure `MONGODB_URI` and `SHOPBASE_SESSION_COOKIE` for the scheduled catalog workflow. Keep supplier credentials out of source code and browser settings.
- Vercel: set `VITE_API_URL` to the Render web service URL.
- Catalog workflow: GitHub Actions refreshes the catalog daily at 12:00 a.m. Bangladesh time (18:00 UTC). Use its manual run option for an on-demand sync and inspect the run summary and progress.

## Before accepting orders

- Check `/api/health` and confirm the live catalog loads from MongoDB.
- Review imported prices, the single primary image, descriptions, size/options, category mapping, and availability after a successful sync.
- Place a test order and verify it appears in the admin review queue. Staff currently confirm orders by phone and submit them to ShopBase manually.
- Keep in mind that product edits, manual categories, category groupings, featured-product flags, and storefront content are currently saved in the admin browser only. They are not shared or persisted in MongoDB yet.
