# AARO Storefront

React + TypeScript + Vite storefront and moderator dashboard prototype, with a MongoDB catalog API and daily ShopBase reseller-catalog importer.

## Run locally

Requires Node.js 20+ and pnpm.

```sh
pnpm install
pnpm dev
```

Without VITE_API_URL the storefront shows its browser demo catalog. With the backend configured, it loads lightweight product cards, requests product descriptions and galleries only when customers open a product, and renders long listings in batches.

## Backend and daily sync

See backend/README.md for MongoDB Atlas, Render Web Service, Render Cron Job, ShopBase session-cookie, and optional Cloudinary setup. The importer stores product details and source galleries in MongoDB. It can mirror primary images to Cloudinary when explicitly enabled.

The crawler depends on the authenticated ShopBase reseller portal and HTML structure; it is not an official API. The initial import may take much longer than two minutes. Orders, customer accounts, moderator writes, and checkout availability checks are not yet connected to the backend.
