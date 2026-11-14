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

- ShopBase catalog products, product detail data, categories, orders, customer accounts, and coupon codes use the backend and MongoDB.
- The admin product/category edits and storefront content editor currently save in the current browser only. They are not written to MongoDB or shared with shoppers on other devices.
- Customers can place orders; the order is recorded for admin review. Staff still confirm by phone and submit the order to ShopBase manually because supplier order submission is not connected.
- The storefront does not currently offer combo bundles.

The storefront should not be considered fully launch-ready for self-service catalog or homepage changes until those admin edits are connected to durable server storage. The UI labels these browser-only changes to avoid implying they are globally published.

## Backend and scheduled catalog sync

See [backend/README.md](backend/README.md) for MongoDB Atlas, Render, ShopBase session-cookie, and optional Cloudinary setup. GitHub Actions refreshes the catalog daily at 12:00 a.m. Bangladesh time (18:00 UTC). The importer reads one primary product image and extracts product descriptions, attributes, size options, and other detail-page data for MongoDB.

This importer reads the authenticated ShopBase reseller portal; it is not an official ShopBase API. It uses a ShopBase session cookie, makes sequential requests with a delay, and stops without pruning if authentication fails or no products are found. Initial imports may take hours. Protect and rotate the session cookie as needed; never put it in storefront code or commit it.
