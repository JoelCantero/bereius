<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project guidelines

## Sources of truth

- Treat `.specify/memory/constitution.md` as the authoritative engineering policy and `README.md` as the operational overview. Do not duplicate or weaken their requirements.
- For feature work, read the applicable artifacts under `specs/<feature>/` before editing implementation code.
- `emails/` is a separate Next.js application with its own `AGENTS.md`, configuration, and tests.
- Read `docs/berea-cat-wordpress.md` before touching booking intake, Holded integration, or customer identity. It describes the upstream WordPress site, its customer area, the booking form's field mapping, and the nightly Holded sync.

## Stack and architecture

- Use the repository's installed stack: Next.js 16 App Router, React 19, TypeScript 6, PostgreSQL, Prisma 7, Zod 4, NextAuth 4, next-intl, Tailwind CSS 4, Vitest, and Playwright.
- Organize product code by domain under `src/modules/<domain>`. Keep shared framework, UI, and infrastructure code in `src/app`, `src/components`, `src/lib`, or `src/server` as appropriate.
- Preserve the normal dependency direction: client UI -> API route or Server Action -> domain service -> `src/lib/db.ts`/Prisma. Server Components may call server-only domain services directly.
- Keep client components free of Prisma, secrets, Node-only modules, and server-only services. Mark server-only modules with `import "server-only"`.
- Use the `@/*` path alias for imports from `src/*`.

## Project conventions

- Validate untrusted input at the boundary with Zod. Never trust client-supplied identity, authorization, locale, role, or ownership data.
- Keep UI copy in `src/messages/<locale>.json`; preserve English, Spanish, and Catalan catalogs together. Use the locale-aware helpers in `src/i18n` for application navigation.
- Read runtime configuration through `src/lib/env.ts`. Never commit secrets or add credentials to source, logs, images, or fixtures.
- Use the structured server logger from `src/lib/logger.ts`, preserving redaction and request correlation. Do not import it into Edge Runtime code such as `src/proxy.ts`.
- Make database changes through `prisma/schema.prisma` and a new forward-only migration. Do not rewrite migrations that may have been applied.
- Prefer the nearest existing implementation and focused tests as the pattern for a change. Do not introduce a new abstraction unless it removes concrete complexity or matches an established boundary.

## Validation

- Run the narrowest relevant test while iterating.
- Before considering implementation complete, run `pnpm lint`, `pnpm typecheck`, and `pnpm test` when the environment permits.
- Use `pnpm test:coverage`, `pnpm audit:prod`, the SpecKit compliance check, production build, and `pnpm test:e2e` when the change or requested quality gate requires the full CI-equivalent suite. CI remains authoritative.
