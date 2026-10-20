# SalesMesh PWA

Installable Next.js 16 / React 19 / Tailwind v4 client for the SalesMesh gateway: phone + PIN
sign-in, account activation, a role-guarded agent shell (light) and admin shell (dark).

## Run

```bash
npm ci
npm run dev            # http://localhost:3000, proxies /api/v1/* to GATEWAY_URL
npm run typecheck && npm run lint && npm test && npm run build
npm start              # production server (registers the service worker)
```

Node >= 22.12. Tests run with `--pool=threads --maxWorkers=2` (low-RAM friendly).

## Environment

| Variable | Where | Purpose |
|---|---|---|
| `GATEWAY_URL` | build time | Target of the same-origin rewrite `/api/v1/:path*` (default `http://localhost:4000`). Baked into the build, so set it as a Docker build arg. |
| `NEXT_PUBLIC_SITE_URL` | build time | Canonical origin for metadata. |
| `BUILD_ID` | build time, optional | Overrides the build ID that `scripts/stamp-sw.mjs` stamps into the generated `public/sw.js` (cache name) and `.build-id` (Next build ID). |

The gateway must allow this app's origin, because `/refresh` and `/logout` check `Origin`:

- dev: `CORS_ORIGINS=http://localhost:3000`, `AUTH_COOKIE_INSECURE_DEV=true` (Safari rejects `__Secure-` cookies over http)
- prod: `CORS_ORIGINS=<app origin>`, `TRUST_PROXY=<hop count>` (Next is 1 hop, add 1 per ingress) so the per-IP login throttle sees client IPs.

If the origin is missing, the app shows a configuration screen instead of looping on `/refresh`.

## Architecture

```
src/
  core/            kernel shared by every feature
    domain/        Result<T, AppError>, AppError, UseCase
    data/          HttpClient: auth-aware fetch, one shared refresh + one retry
    di/            container.ts, the composition root
  shared/
    domain/        msisdn, pin-policy (mirrors the gateway), money, escrow-status
    presentation/  theme tokens + UI primitives (Button, Field, PhoneInput, PinInput, Money, StatusPill, ...)
  features/<name>/
    domain/        entities, repository interfaces, use cases (no React/Next, no data/presentation imports)
    data/          datasources, DTO mappers, repository implementations
    presentation/  components, state, nav config
  app/             Next routes: /, /login, /register, /offline, (dashboard)/{agent,admin}, icons/[size]
```

Dependency rule: domain imports nothing from data, presentation, React or Next (enforced by ESLint
`no-restricted-imports` on `src/**/domain/**`). Data implements domain interfaces. Presentation calls
use cases through the composition root (`getContainer()`; components read it from `useSession().container`, which tests inject). Use cases return `Result`; nothing throws across layers.

`features/agent-ledger` (#13): balance slip, accrual timeline with hold countdowns, claim flow (Fuliza disclosure, PIN), payout-line verification and payout history over `/api/v1/payouts` and `/api/v1/payout-destinations`, refreshed by visibility-aware polling (15 s while visible; on focus, `online` and hold maturity). `features/admin-oversight` (#14): the risk queue over `/api/v1/admin` (frozen commission overdue first, a SHAP waterfall of the run that froze each item, release / keep held and unconfirmed-payout resolve with a reason note and the admin's PIN), and the `/admin` totals; same polling and error states as the ledger. The agents directory is still an empty state.

### Auth

- The access token lives in memory only. Reloads restore it with a silent `POST /api/v1/auth/refresh`
  using the gateway's HttpOnly cookie (path `/api/v1/auth`, through the same-origin rewrite).
- Public pages only try that refresh when a `salesmesh.session-hint` flag is in localStorage (not a
  credential), so anonymous visitors never make a guaranteed-401 request. Dashboards always probe.
- Refresh is single-flight and runs ~60 s before `expires_in`. Only a 401 from a Bearer route triggers
  one refresh and one retry; `/auth/*` 401s are never retried (they count toward lockout).
- Logout and PIN change broadcast sign-out to other tabs (`BroadcastChannel('salesmesh-auth')`).
- The route guard is client-only: dashboards render a skeleton until the session resolves.

### PWA

The service worker source is `scripts/sw.template.js` (tracked). `npm run build` (prebuild) and
`npm run dev` (predev) generate the gitignored `public/sw.js` from it with the build ID stamped in;
edit the template, never `public/sw.js`. It caches only `/_next/static/*`, `/icons/*`, `/` and `/offline`. It never caches `/api/*`
or dashboard HTML; offline navigations get `/offline`. On install it also caches the `/_next/static`
assets referenced by `/offline`, so the offline page renders styled. `/sw.js` is served `Cache-Control: no-cache`.
Icons are generated at build time by `app/icons/[size]` (192, 512 and maskable variants).

## Docker

```bash
docker build --build-arg GATEWAY_URL=http://gateway:4000 -t salesmesh-pwa .
docker run -p 3000:3000 salesmesh-pwa
```
