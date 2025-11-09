# Cardinal GaragePro — Photo → Price Band (MVP)

Single-service Node/Express app with JSON + disk persistence, provider-agnostic inference, and Pro Report unlocks.

## Quick Start (Local)

```
cp .env.example .env
npm install
npm run dev
# open http://localhost:10000
```

## Deploy to Render

- Push to GitHub, then create a Web Service in Render.
- Use `render.yaml` or set:
  - Build: `npm install`
  - Start: `npm start`
  - Persistent disk at `/data`
- Set env vars (domains, limits, pricing).

## DNS (IONOS)

- Point `A`/`ALIAS` for apex and `CNAME` for `www` to Render's provided values.

## Endpoints

- POST `/api/jobs/upload`
- GET `/api/jobs/list`
- GET `/api/me`
- POST `/api/cards/:id/upgrade`
- POST `/api/payments/webhook`
- DELETE `/api/account/delete`

## PWA

- Installable (Add to Home Screen): manifest + service worker included.
- Update `/public/icons/*` and `/public/logo.svg` with your brand.


## Admin (Data-Diode Read-only)

Set `ADMIN_TOKEN`. Access:

- Page: `/admin?token=YOUR_TOKEN`
- API: `GET /api/admin/summary` with header `X-Admin-Token: YOUR_TOKEN`

This view is read-only (no mutations) and aggregates device + card counts by scanning `/data/devices`.


## Community Submissions (Private)
- Submit: `POST /api/submissions` (or use `/submit/` page)
- Moderate (admin): `GET /api/admin/submissions?status=PENDING`
- Approve/Reject: `POST /api/admin/submissions/:id/approve|reject`
- Analytics: `GET /api/admin/analytics` (or `?format=csv`)

Geo indices: `data/geo/index.json` (baseline/states/metros). Normalization uses state/metro index.
