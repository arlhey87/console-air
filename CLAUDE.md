# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# console-air — agent guide

Self-custody (AEP-84) fork of Akash Console: a self-hostable crypto-wallet UI for deploying on the
Akash Network. The user signs every transaction with their own wallet; there is **no managed backend
holding keys**. The only app is `apps/deploy-web` (there is **no `apps/api`** — see "Architecture").

## Commands

Run from the repo root (npm workspaces):

- `npm run dev` — start the Next.js app (`apps/deploy-web`) on http://localhost:3000.
- `npm run build` — production build of the app.
- `npm run lint` — ESLint across the whole monorepo.
- `npm run format` — Prettier write.

App-scoped scripts (run from `apps/deploy-web`, or `-w apps/deploy-web` from root):

- `npm run test:unit` — Vitest, run once. Sets `NODE_ENV=test DEPLOYMENT_ENV=staging`.
- `npm run test:unit -- path/to/file.spec.ts` — run a single spec file.
- `npm run test:unit -- -t "describe or it name"` — run tests matching a name.
- `npm run test:e2e` — Playwright end-to-end tests.
- `npm run type-check` — `tsc` (no emit).
- `npm run start` — serve the production build.

No env config is required to run the app: it ships with production defaults pointing at the hosted
Akash infrastructure. To override endpoints, copy `apps/deploy-web/env/.env.sample` to
`env/.env.local` (the `env/` dir is gitignored).

## Architecture

`apps/deploy-web` is a **Next.js Pages Router** app (`src/pages`). Despite being a "frontend", it runs
server-side code through Next API routes and middleware, so most modules must work in **both**
`browser` and `nodejs` runtimes.

- **Dependency injection** (`src/services/app-di-container`, `src/services/container/createContainer.ts`):
  services are wired through a lazy DI container. `createContainer` builds an object of lazily-resolved
  singletons (each factory runs once, on first access; circular deps throw). There are separate
  `browser-di-container` and `server-di-container` builds. Access services via the container / the
  `ServicesProvider` context rather than instantiating them directly. Most factories take a
  `runtimeEnv: "nodejs" | "browser"` and branch on it.
- **Same-origin BFF proxy** (`src/pages/api/proxy/*`, `src/pages/api/provider-proxy/*`): browser
  traffic to the Akash REST, RPC, provider proxy, and templates endpoints is routed through Next API
  routes so the browser stays same-origin and avoids CORS preflight failures. Server-side code hits
  the upstreams directly (CORS doesn't apply). WebSockets bypass the proxy (Next API routes can't
  upgrade) and hit the upstream directly. When adding a new upstream call, decide which side it runs
  on and follow this pattern — see the comments in `app-di-container.ts`.
- **Self-custody signing** (`src/context/WalletProvider/WalletProvider.tsx`): wallets connect via
  `@cosmos-kit/react` (Keplr, Cosmostation, MetaMask-cosmos). `signAndBroadcastTx(msgs)` estimates
  the fee, signs with the user's wallet (optionally under a `feeGranter`), and broadcasts — all
  client-side. This is the core of the fork: no server ever holds keys or signs.
- **Chain SDK**: transactions and certificates use `@akashnetwork/chain-sdk` (currently a
  `1.0.0-alpha.*` release targeting Cosmos SDK 53 / Akash). Message construction and SDL handling
  live alongside the deployment flows in `src/components` and `src/hooks`.
- **State**: Jotai stores in `src/store` (`walletStore`, `networkStore`, `sdlStore`,
  `certificateStore`, `routeStore`, `global-store`). Server state is TanStack Query — query hooks
  live in `src/queries` with keys centralized in `queryKeys.ts`.

### Workspace packages (`packages/`)

Shared libraries consumed by the app (all `@akashnetwork/*`, referenced as `*` versions):

- `net` — network config (RPC/REST endpoints, chain IDs). **Generated**: `src/generated/netConfigData.ts`
  is produced by `scripts/generate.ts`. Do not hand-edit the generated file; run `npm run generate -w
  packages/net`. A husky `pre-commit` hook regenerates it and `git add`s it on every commit.
- `http-sdk` — Axios-based HTTP service layer (e.g. `TemplateHttpService`, `UsageHttpService`,
  `ApiKeyHttpService`). New upstream API clients usually belong here.
- `react-query-sdk` / `react-query-proxy` — generated TanStack Query hooks over the OpenAPI surface.
- `network-store` — browser storage abstraction. `env-loader` — env var loading + schema.
  `logging` — `LoggerService`. `ui` — shared component library. `dev-config` — shared tsconfig /
  eslint / build config.

### Path aliases

`@src/*` → `apps/deploy-web/src/*`, `@tests/*` → `apps/deploy-web/tests/*`.

## Git conventions

**Branch names: `<type>/<short-kebab-description>`.** Examples: `feat/forward-sdl-reclamation`,
`chore/bump-chain-sdk-alpha-34`, `fix/provider-dedup-alias-resolution`. `<type>` is the
conventional-commit type (`feat|fix|chore|docs|ci|refactor|test|perf|style|build|revert`).

- **Do NOT use Linear's auto-generated `gitBranchName`** (e.g. `<author>/con-434-l-15-...`),
  even when a handoff, plan, or Linear issue suggests it. Reference the CON issue in the **commit
  message and PR body**, not the branch name.
- One PR per Linear issue. If issue B depends on issue A, stack B's branch on A's and set the PR base
  to A's branch.

**Commits are linted** (husky `commit-msg` → commitlint, `@commitlint/config-conventional`):
- Body lines must be **≤ 100 chars** (enforced by config-conventional).
- Conventional scope is a team convention (not enforced by lint). Use one of: `network, wallet, sdl,
  user, auth, billing, provider, deployment, indexer, certificate, dx, config, stats, release, ci,
  repo, styling, observability, analytics, template, notifications, alert, notification-channel, jwt,
  log-collector, bid, onboarding, managed-wallet`. There is **no `deps` scope** — use `chore(repo)`
  for dependency bumps.
- The `pre-commit` hook also runs `npm ci --dry-run` to verify `package.json` / `package-lock.json`
  are in sync, in addition to regenerating `packages/net` (see above).

## Dependencies

`.npmrc` sets `save-exact=true` (lockstep, exact versions — no `^`/`~`) and `legacy-peer-deps=true`.
Pin exact versions for any new dependency. `engines` requires Node >= 20, npm >= 10; the repo
pins `npm@11.11.0` via `packageManager`.

## Tests

Frontend tests are Vitest, co-located (`*.spec.ts` / `*.spec.tsx`). Follow the `console-tests` skill
conventions: the `setup()` pattern, `describe(Subject.name, ...)`, and `mock<T>()` from
`vitest-mock-extended`. E2E is Playwright (`apps/deploy-web/tests`, `playwright.config.ts`).
