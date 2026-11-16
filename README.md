# AARO storefront

React, TypeScript, and Vite storefront with a FastAPI/MongoDB catalog service and a scheduled ShopBase catalog importer.

## Run locally

Requires Node.js 20+ and pnpm.

```sh
pnpm install
pnpm dev
```

Set `VITE_API_URL` to the deployed backend URL. A production build without this setting will show a catalog connection error; it does not substitute a sample catalog. Product cards load from the backend, and product descriptions and additional details load when a product is opened.

## Current persistence boundaries

- ShopBase catalog products, admin product overrides, categories, homepage content, offers, coupons, orders, customer accounts, and product view counts use the backend and MongoDB.
- The server recalculates order prices, discounts, and delivery charges from its saved catalog and rejects unavailable products, missing variant choices, and orders while the store is closed.
- Customers can place orders; the order is recorded for admin review. Staff still confirm by phone and submit the order to ShopBase manually because supplier order submission is not connected.
- Combo bundles are not connected to checkout. Do not advertise a combo as a purchasable bundle until bundle ordering is implemented.

Verify the deployed environment variables, database connectivity, live store status, checkout, and order confirmation process before taking paid orders.

## Backend and scheduled catalog sync

See [backend/README.md](backend/README.md) for MongoDB Atlas, Render, ShopBase session-cookie, and optional Cloudinary setup. GitHub Actions checks the saved 6, 12, 24, or 48-hour cadence once per hour. The Product Sync page controls the cadence and Bangladesh-time anchor. The importer reads one primary product image and extracts product descriptions, attributes, size options, and other detail-page data for MongoDB.

This importer reads the authenticated ShopBase reseller portal; it is not an official ShopBase API. It uses a ShopBase session cookie, makes sequential requests with a delay, and stops without pruning if authentication fails or no products are found. Initial imports may take hours. Protect and rotate the session cookie as needed; never put it in storefront code or commit it.
