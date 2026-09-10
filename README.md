# Web app

A generic, production-minded architecture for **self-hosted, Dockerized web applications**. It is a full-stack Next.js app with a user interface (UI), application programming interface (API), and Server Actions backed by PostgreSQL. It runs on constrained hardware such as a Raspberry Pi and can move to a virtual private server (VPS) with minimal changes.

The non-negotiable engineering principles for this architecture live in [`.specify/memory/constitution.md`](.specify/memory/constitution.md).

## Stack

- **Language / runtime**: TypeScript on Node.js 24 LTS · **pnpm**
- **Framework**: Next.js (App Router) + React in one full-stack `app`, including UI, server-side rendering (SSR), API routes, Server Actions, and authentication
- **Database**: PostgreSQL via Prisma 7 (driver adapter)
- **Validation**: Zod · **Auth**: NextAuth v4 stable · **Email**: Brevo or Mailjet over HTTPS
- **Testing**: Vitest + jsdom + Testing Library + Playwright
- **Logging**: Pino (structured JSON to stdout)
- **Infra**: Docker + Docker Compose · Traefik ingress · Cloudflare Tunnel (home hosting)
- **CI/CD**: GitHub Actions (GitHub-hosted CI + self-hosted deployment runner)

## Requirements

- Node.js 24 LTS + pnpm (`corepack enable`)
- Docker + Docker Compose (for the local database)

## Getting started (development)

```bash
cp .env.example .env          # fill in AUTH_SECRET, POSTGRES_PASSWORD, ...
pnpm install
pnpm dev                      # runs on http://localhost:3000
```

`pnpm dev` starts the database in Docker via the `predev` hook, then launches Next.js. Run the quality gate (`lint` → `typecheck` → `test`) before opening a pull request. The Spec Kit `after_implement` hook (`speckit.quality-gate`) runs it automatically. Continuous integration (CI) runs static checks, coverage, production E2E, relevant email previews, and production image builds in parallel as the authoritative merge gate. The same gate validates the exact `main` revision before invoking deployment. The mandatory `speckit.compliance-check` verifies that each feature's spec, plan, and tasks remain complete. To change the schema, edit `prisma/schema.prisma` and run `pnpm db:migrate`.

Spec Kit creates every feature branch from an up-to-date `origin/main`. Before the first spec, push
the initial main branch (`git push -u origin main`) and commit or stash tracked changes; otherwise
the mandatory `before_specify` hook stops without creating a branch.

### Scripts

| Script | Purpose |
|---|---|
| `pnpm dev` | Start DB (via `predev`), run Next dev |
| `pnpm build` / `pnpm start` | Production build / start |
| `pnpm lint` · `pnpm typecheck` · `pnpm test` | Static and unit/integration gates |
| `pnpm audit:prod` / `pnpm test:e2e` | Production audit / isolated DB + migrations + build + deterministic standalone smoke tests |
| `pnpm db:migrate` / `db:deploy` | Create+apply (dev) / apply (prod) migrations |
| `pnpm db:studio` | Prisma Studio |
| `pnpm db:backup:dev` / `db:restore:dev` | Logical development DB backup / restore |
| `COMPOSE_FILE=<file> pnpm db:backup` / `db:restore` | Backup / restore an explicitly selected Compose stack |

## Architecture

```
Development                     Production
-----------                     ----------
pnpm dev (host)                 Cloudflare Tunnel / DNS
   └── db in Docker (localhost)     └── Traefik
                                         └── app (Next.js)
                                              └── internal network
                                                   ├── migrate (one-shot)
                                                   └── db (PostgreSQL, private)
```

- **Dev** ([`docker-compose.yml`](docker-compose.yml)) runs **only the `db`** (published on
  `localhost:5432`); the app runs on the host with `pnpm dev`.
- **Prod** ([`docker-compose.prod.yml`](docker-compose.prod.yml)) runs `app` behind Traefik, a
  one-shot `migrate` service that applies migrations before `app` starts, and a **private** `db` (no
  public ports). Networks: `traefik_network` (external ingress) + `internal` (private).

## Configuration

All runtime configuration comes from environment variables.

- **Development**: a local `.env` (copy of `.env.example`). Never committed.
- **Production**: **no `.env` file**. The deploy workflow injects values from GitHub into the
  Compose process and containers at runtime. Docker builds use non-secret placeholders only while
  Next.js collects build metadata; real credentials are never baked into the image.

| GitHub **Variables** (non-sensitive) | GitHub **Secrets** (sensitive) |
|---|---|
| `PROJECT_NAME`, `BRAND_COLOR`, `SUPPORT_EMAIL`, `APP_DOMAIN`, `DEPLOY_BASE_DIR`, `RUNNER_NAME`, `LOG_LEVEL`, `TRUST_PROXY_HEADERS` _(optional)_ | `POSTGRES_PASSWORD`, `AUTH_SECRET` |
| `MAIL_ENABLED`, `MAIL_PROVIDER`, `MAIL_FROM`, `MAIL_LOGO_URL` _(optional)_ | `MAIL_API_KEY`, `MAIL_API_SECRET` _(Mailjet only)_ |
| _(none)_ | `BOOKING_SECRET_KEY` |

`POSTGRES_USER`, `POSTGRES_DB`, `DATABASE_URL` and the image/router names are **derived**
from `PROJECT_NAME` / `APP_DOMAIN`. Production percent-encodes database credentials when it builds
`DATABASE_URL`; for local development, encode reserved password characters in the URL yourself.
`NEXTAUTH_URL` is the canonical external origin (`https://APP_DOMAIN` in production); Auth requests
with a different `Host` or `X-Forwarded-Host` are rejected before NextAuth. `MAIL_ENABLED` is the
single explicit gate for login, signup activation, and existing-account notices. When enabled,
`MAIL_PROVIDER` must be `brevo` or `mailjet`, `MAIL_FROM` must be a verified bare address, and
`MAIL_API_KEY` must be set. Mailjet also requires `MAIL_API_SECRET`. Provider endpoints are fixed in
application code; no runtime endpoint override is supported. Each operation makes one bounded HTTP
submission attempt with no retry or provider fallback.
`BRAND_COLOR` and `SUPPORT_EMAIL` are global requirements used by the web UI and transactional
email; `PROJECT_NAME` supplies the product and legal identity. `MAIL_LOGO_URL` is optional and must
be absolute HTTPS when set for enabled mail; it is ignored while mail is disabled. These public
values are GitHub Variables, never Secrets. Next.js validates the applicable application and
provider configuration during startup, and any malformed required value prevents the application
from becoming ready rather than serving a partially configured instance.
The hardened auth adapter refuses to create unknown users; registration remains a separate product
flow that validates the application's required fields.
Keep `TRUST_PROXY_HEADERS=false` unless Cloudflare is the exclusive route to the origin and the
ingress overwrites `X-Forwarded-Host` and `CF-Connecting-IP` on every request. A private app network
alone is insufficient because a publicly reachable Traefik instance can forward client-supplied
headers. When the guarantee is enforced, set the GitHub Variable to `true`; otherwise forwarded host
and address headers remain ignored and the email limiter uses one conservative shared client bucket.

## Deployment

Push to `main` triggers [`.github/workflows/ci.yml`](.github/workflows/ci.yml). After every parallel
check succeeds for that exact revision, CI invokes
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) on the self-hosted **ARM64** runner
named by the `RUNNER_NAME` Variable. For a manual verified deployment, dispatch the `CI` workflow
from `main`; the deployment workflow cannot be dispatched directly.

The pull-request run validates the merge result, and its `Build` job records that validated tree.
When the squashed commit pushed to `main` has the same tree, CI reuses that result and only builds
and deploys. Any revision whose tree has not been validated is checked in full.

1. `rsync` the repository into the deploy directory (`DEPLOY_BASE_DIR`/`PROJECT_NAME`).
2. Ensure the external `traefik_network` exists.
3. Build the `app` and `migrate` images while the current application remains available.
4. Wait for the database, stop the old application, and run the migrator synchronously.
5. Start the new application and require its container healthcheck to pass.

The local SpecKit hooks provide pre-PR feedback. CI is authoritative and requires lint, typecheck,
unit/integration tests with coverage thresholds, SpecKit compliance, a production dependency audit,
a production build, and Playwright smoke tests for routing, CSP, request correlation, and database
readiness against the standalone artifact. Transactional-email tests use a controlled local HTTP
fixture that intercepts only the exact official provider URLs and exercises the real Auth.js
database-session boundary without external traffic. Deployments are serialized and are never
canceled mid-build or mid-migration.

Application code may be reverted only while it remains compatible with the applied schema. Prisma
migrations are forward-only: recover with a corrective migration in normal operation. For an
incompatible or destructive change, restore a verified backup into a fresh database/volume and
switch traffic only after validation; reverting Git does not reverse schema or data. Public signup
does not introduce automatic or opportunistic pending-user deletion; retained `PENDING` accounts are
part of forward recovery and must remain reusable by later valid submissions.

## Signup and login lifecycle

- **Signup is explicit registration.** Signed-out visitors use `/signup`, `/es/signup`, or
  `/ca/signup` and provide a validated name, normalized email, and one unchecked combined Terms and
  Privacy acceptance. Signup is the only flow allowed to create a `PENDING` user.
- **Login remains existing-user-only.** Ordinary email login resolves only `ACTIVE` users. Unknown
  and pending addresses keep the same private accepted response but receive no login credential;
  the Auth.js adapter's `createUser` method remains an unconditional failure.
- **Mailbox activation owns the transition.** A pending signup receives one newest-only 15-minute
  onboarding link. Its candidate name, locale, `2026-08-18-draft` policy versions, and server time
  stay bound to that credential until atomic consumption activates the same user and inserts one
  immutable policy acceptance. Auth.js alone creates the normal database session and cookie.
- **Existing accounts are not modified.** Signup for an active address returns the same public
  confirmation and privately sends a credential-free localized login notice. It does not change
  profile, acceptance, token, or session data.
- **Pending users are retained for recovery.** A later valid signup reuses the row and supersedes its
  earlier candidate link. Isolated delivery failure removes the unusable newest token without
  restoring its predecessor; the pending account remains safe to retry. No cleanup job deletes it.
- **Limits and availability are shared.** Login and signup share PostgreSQL-backed limits of five
  attempts per trusted client and three per normalized address in 15 minutes. Provider availability
  is a recipient-independent metadata probe cached for 60 seconds; individual send outcomes never
  change shared health.
- **Policy content is product-owned development input.** English, Spanish, and Catalan Terms and
  Privacy Notice pages use the user-authorized `2026-08-18-draft` dummy content. Every page visibly
  identifies it as an unreviewed development draft and not legal advice. A reviewed replacement must
  update the source-controlled copy and version identifiers together; engineering does not determine
  legal sufficiency.
- **Deployment reuses existing infrastructure.** Signup uses the selected HTTP provider, existing
  `AUTH_SECRET`, canonical `NEXTAUTH_URL`, PostgreSQL database, and Auth.js database sessions. It adds
  no runtime service, port, queue, custom session cookie, webhook, or delivery-status persistence.

## Booking pipeline

The booking module (`src/modules/booking`) replaces the retired n8n workflow. Requests arrive from
the public Gravity Forms form, are reviewed on screen, and become a Holded contact, estimate and
reserve invoice on approval.

- **No new service.** A scheduler starts from [`src/instrumentation.ts`](src/instrumentation.ts) in
  every Node instance and runs the hourly Gravity Forms intake, the outbox drain, and the daily
  expiry of unpaid requests. Jobs are claimed atomically in PostgreSQL, so running more than one
  instance is safe.
- **External calls go through an outbox.** Approving is a local transaction; the Holded calls and
  the booking email are queued and retried with backoff, so a decision is never lost because a
  provider was unreachable. Exhausted jobs are parked in a visible dead state.
- **Credentials are application settings, not environment variables.** An administrator configures
  the Holded API key, the Gravity Forms credentials and the booking SMTP mailbox under
  `/[locale]/bookings/settings`. They are stored AES-256-GCM encrypted, are write-only in the UI,
  and a test-connection action reports a failure category rather than the provider's message.
- **`BOOKING_SECRET_KEY` is the envelope key** for those credentials, and the only new secret. It
  must live outside the database it protects. Generate it with `openssl rand -base64 32`. Without
  it the settings screen refuses to store a credential.
- **Booking mail is a separate channel.** Operational notices are sent over the configured SMTP
  mailbox, independently of the account mail provider; commercial documents are delivered by Holded.

The lifecycle, the pricing rules and the delivery phases are specified in
[`specs/20260909-project-specification/spec.md`](specs/20260909-project-specification/spec.md).

## Database, backups & health

- **Migrations**: versioned in `prisma/migrations/`; applied by the `migrate` service on deploy.
- **Persistent data**: the named volume `pgdata`.
- **Backup / restore**: `pnpm db:backup:dev` creates a portable logical development dump and
  `pnpm db:restore:dev <file>` restores it. Other stacks require an explicit selection, for example
  `COMPOSE_FILE=docker-compose.prod.yml pnpm db:backup`. Restore deliberately refuses a non-empty
  database and runs transactionally, preventing mixed old/restored state.
- **Restore verification**: the weekly/manual `Verify Backup And Restore` workflow starts the
  production Compose database without publishing it, migrates it, creates a logical backup,
  recreates its volume, restores it, and verifies a sentinel record.
- **Healthcheck**: `GET /api/health` (used by the container healthcheck).

## Security and observability baseline

- The proxy adds a nonce-based CSP with `strict-dynamic`; locale pages render per request so Next.js
  can attach the nonce to framework scripts and styles. Standard security headers apply globally.
- Every proxied response carries `x-request-id`; server logs can create Pino child loggers with the
  same ID for correlation.
- The optional email sign-in endpoint includes a PostgreSQL-backed limit of five attempts per client
  and three per normalized email every 15 minutes, shared by all application replicas. Email keys
  are SHA-256 hashes, so the limiter does not retain addresses. The adapter rejects implicit user
  creation; the first application spec must still add tests for the chosen account lifecycle.
- Public endpoints and privileged actions must document threats, abuse controls, trust boundaries,
  and residual risk in their SpecKit feature specification.

## Convert this template into an application

1. Create the new repository from this template and change `name` in `package.json`.
2. Replace `fullstack-webapp-template` in `.env.example` with the application's stable
   `PROJECT_NAME`. Keep it suitable for Docker names and PostgreSQL identifiers.
3. Set the real domain, identity, and deployment target through GitHub Variables: `PROJECT_NAME`,
  `BRAND_COLOR`, `SUPPORT_EMAIL`, `APP_DOMAIN`, `DEPLOY_BASE_DIR`, and `RUNNER_NAME`; optionally
  configure `LOG_LEVEL`. Set `TRUST_PROXY_HEADERS=true` only after enforcing the exclusive
  Cloudflare ingress contract above.
4. Create `POSTGRES_PASSWORD`, `AUTH_SECRET`, and `MAIL_API_KEY` as GitHub Secrets. For Mailjet also
  create `MAIL_API_SECRET`. Configure `MAIL_ENABLED`, `MAIL_PROVIDER`, and `MAIL_FROM` as GitHub
  Variables after verifying the sender and the login/signup lifecycle tests. Add the optional
  `MAIL_LOGO_URL` Variable only for a shared absolute HTTPS email asset.
5. Confirm the `traefik_network` exists on the target host and that the named ARM64 runner is online.
6. Adapt locales, message catalogs, Auth.js providers, Prisma models, resource limits, retention,
   availability, and monitoring to the derived application's requirements.
7. Push the initial `main` to `origin`, then start the first real feature through SpecKit. Feature
  directories use `YYYYMMDD-english-feature-name`; use a distinct concise English suffix for each
  feature created on the same date. The template itself intentionally has no product-specific
  `specs/` directory.
8. Before production, run the CI gate, the backup/restore verification workflow, and a deployment
   healthcheck against the actual target environment.

## Account Profile Behavior

- Protected localized routes:
  - `/account`
  - `/es/account`
  - `/ca/account`
- Signed-out access to those routes redirects to the matching localized login page with a validated
  account callback destination.
- Profile updates are limited to one mutable field: `name`.
- Name validation rules:
  - Required after trim.
  - Maximum 80 characters.
  - Letters, spaces, apostrophes, and hyphens only.
- Immutable fields on the profile page:
  - `email` is read-only and cannot be changed through profile updates.
  - `image` can be rendered but is not mutable from this flow.
- Authenticated navigation adds an Account entry in the user controls while preserving logout,
  language selection, and theme switching.

## VPS migration

Portable by design: install Docker on the target, copy the repository + compose files, recreate the
environment variables/secrets (no `.env` to copy because they are injected at runtime), restore the DB
backup/volume, create the networks, run Compose, and repoint DNS / the Cloudflare Tunnel.
