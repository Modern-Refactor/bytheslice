# Bootstrap Templates Catalog

The `/setup-shop` skill (Step 1, Phase 2) wraps official scaffolders rather than bundling its own templates. This document records which scaffolders are used and why, so the choice is explicit and reproducible.

> **See also** [`framework-detect.md`](./framework-detect.md) for the canonical per-stack scaffolder command list (kept in sync with this file). If they disagree, `framework-detect.md` wins.

## Currently supported

### Single-app — Next.js App Router (most-validated path)

```bash
pnpm dlx create-next-app@latest <name> \
  --typescript \
  --app \
  --tailwind \
  --turbopack \
  --eslint \
  --import-alias "@/*" \
  --use-pnpm
```

**Why this exact invocation:**
- `--typescript` — the rest of ByTheSlice assumes TypeScript everywhere
- `--app` — App Router (ByTheSlice's frontend skill is App-Router-shaped)
- `--tailwind` — design-system gate emits Tailwind config; CSS-in-JS would require a different design-system gate variant
- `--turbopack` — current Next.js default; matches what the skill would expect
- `--eslint` — required by the design-system-compliance CI job (`eslint-plugin-tailwindcss` config additions live there)
- `--import-alias "@/*"` — matches the import-alias convention all ByTheSlice skill examples assume
- `--use-pnpm` — pnpm is the default package manager ByTheSlice assumes

### Single-app — Vite + React

```bash
pnpm create vite@latest <name> -- --template react-ts
cd <name>
pnpm add -D tailwindcss postcss autoprefixer
pnpm dlx tailwindcss init -p
```

**Notes:** Tailwind is not part of the Vite template, so ByTheSlice installs it after scaffold so `set-display-case` has somewhere to write tokens. Routing is left to the user (react-router, TanStack Router, or none) — `library-route-scaffolder` detects on its next run.

### Single-app — SvelteKit

```bash
pnpm create svelte@latest <name>
```

Interactive prompt. Accept: **skeleton project**, **TypeScript syntax**, **Tailwind add-on**, **ESLint + Prettier**.

### Single-app — Astro

```bash
pnpm create astro@latest <name> -- --template minimal --typescript strict --no-install --no-git
cd <name>
pnpm install
pnpm astro add tailwind
```

### Single-app — Node API only

No scaffolder. The user runs `pnpm init` and adds their framework of choice (express / hono / fastify). ByTheSlice does not opinionate the API framework — `/sell-slice` runs `backend` / `db-schema` / `infrastructure` stages without touching any frontend.

### Monorepo

```bash
pnpm dlx create-turbo@latest <name> --example basic
```

**Why `--example basic`:**
- Two starter apps + one shared package — minimal but realistic structure
- Lets the user `pnpm add` more apps as needed without committing to a complex example layout
- ByTheSlice's phased-plan-writer assumes the `apps/*` and `packages/*` shape from this template

After `create-turbo` runs, the user typically removes the example apps (`apps/web`, `apps/docs`) and adds their own — for each new app, pick a per-app scaffolder from the single-app table above (`pnpm dlx create-next-app apps/<name>`, `pnpm create vite apps/<name>`, etc.). Each app's stack is detected independently by `framework-detect.md`.

## Framework adapter status

| Stack | Bootstrap | Design system | Library preview (Phase 4.5) | Frontend slice pipeline |
|---|---|---|---|---|
| `next-app` | ✅ | ✅ | ✅ | ✅ |
| `next-pages` | ✅ | ✅ | ⚠️ HITL — templates not yet ported | ⚠️ HITL |
| `vite-react` | ✅ | ✅ (CSS entry parameterized) | ⚠️ HITL — templates not yet ported | ⚠️ HITL |
| `sveltekit` | ✅ | ✅ (CSS entry parameterized) | ⚠️ HITL — templates not yet ported | ⚠️ HITL |
| `astro` | ✅ | ✅ (CSS entry parameterized) | ⚠️ HITL — templates not yet ported | ⚠️ HITL |
| `node-api` | ✅ | n/a (skipped) | n/a (skipped) | ✅ backend stages only |

"HITL" means the agent will bubble a `prd_ambiguity` to the operator with the framework's idiomatic conventions and ask for sign-off before scaffolding. The bootstrap + design-system stages still complete cleanly.

## How to extend (add a new stack)

The contract is:

1. Add the row to [`framework-detect.md`](./framework-detect.md) (Supported stacks + Detection algorithm + Per-stack path map + Bootstrap scaffolder).
2. Add the scaffolder invocation to **this** catalog.
3. Walk the "Where each skill branches on stack" table in `framework-detect.md` and confirm the per-skill HITL or templated behavior. At minimum the HITL fallback path must work — silent miss is the failure mode to avoid.
4. (Optional, Tier L) Write per-framework Phase 4.5 library-preview templates so the stack graduates from "⚠️ HITL" to "✅".

Adding a non-listed stack without doing step 1 will cause `scaffold-discovery` to return `unknown` and bubble HITL, which is the safe default.

## Out of scope

- **Remix** — different routing primitives, different middleware story. No detection in `framework-detect.md` yet.
- **Nuxt / Vue** — no Tailwind-via-default; would need separate design-system gate path.
- **Python / Django / Rails / etc.** — this is a JS/TS plugin. Use a non-bytheslice flow for these.

These bubble HITL at detection time and stop. Tracking interest via `/bytheslice:close-shop`.

## Future scaffolders we might wrap

- Per-org internal-template scaffolders (companies with bytheslice-pre-wired design systems + auth)
- Remix once routing patterns stabilize and there's user pull
