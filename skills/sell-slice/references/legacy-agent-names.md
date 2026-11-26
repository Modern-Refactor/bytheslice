<!-- skills/sell-slice/references/legacy-agent-names.md -->
<!-- The old-to-new agent name table for the 7.0.0 and 7.1.0 agent-roster consolidation (52 agents to 28): every agent name removed in either release, the agent and mode or the script that does its job now, and the rule for reading an old name met in a stage file, goal, checklist, ledger or earlier chat message. -->

# Legacy agent names

The plugin consolidated its agent roster. Projects planned or started on an older plugin version still name the old agents in stage files, slice-completion goals, checklist notes, run logs, ledger rows and earlier chat messages. Those files need no edit.

**Reading rule for every conductor** (`/sell-slice`, `/sell-pie`, `/special-order`, `/cook-pizzas`, `/final-quality-check`, `/inspect-display`): when you meet an old name from the **Renamed in 7.0.0 and 7.1.0** table in a stage file, a goal, a checklist, a run log or an earlier chat message, read it as the new agent and mode in the same row and dispatch that, or, when the row names a script, run that script instead of dispatching anything. Never dispatch an old name from that table: it is no longer registered. A line that asks for two old agents now served by one (for example "both `spec-reviewer` and `quality-reviewer` returned `verdict: pass`") is satisfied by one dispatch of the new agent returning that verdict. A goal or checklist line naming an old agent is checked against the new agent's return, not rewritten.

**Config keys under old names.** A `modelTiers` key spelled with an old name (camelCase, for example `qualityReviewer`) or a `pass.spawnPolicy.roles` entry under an old name may only **raise** the new agent's tier above its default, never lower it: `specReviewer: "sonnet"` alone leaves `code-reviewer` on `opus`, and `stageDecomposer: "sonnet"` leaves `stage-planner` on `opus`. An old-name key that would lower the tier is ignored and recorded once as a `policy-override` note marked `ignored` (one that names the tier the agent already has changes nothing). When two old keys land on one agent the higher tier wins (`fable` over `opus` over `sonnet` over `haiku`). An empty `pass.spawnPolicy.roles` list under an old name (`"quality-reviewer": []`) was a deliberate opt-out of the model check and still turns it off for the new agent. A key spelled with the new name sets any tier and always beats old keys. A watchdog budget under an old name (`pass.watchdog.budgetsMs.discovery`) gives the new agent the longer of that value and its default (a shorter one is ignored with the same kind of note); a budget under the new name wins outright.

## Renamed in 7.0.0 and 7.1.0

The first 16 rows left the roster in 7.0.0, the rest in 7.1.0. A row whose Now cell links a script is not an agent any more: the conductor runs the script (it prints one JSON object, and exits 2 with `needs_human` when the conductor must raise a HITL) and reads its output where it used to read the agent's return.

| Old name | Now | Mode or input | Notes |
|---|---|---|---|
| `spec-reviewer` | [`code-reviewer`](../agents/code-reviewer.md) | (one pass) | Spec and quality checks in one dispatch per task; the 80+ confidence filter drops only low-confidence nits, never a blocker, a major or a gate failure |
| `quality-reviewer` | [`code-reviewer`](../agents/code-reviewer.md) | (one pass) | Same dispatch as above |
| `break-ui-runner` | [`ui-reviewer`](../agents/frontend/ui-reviewer.md) | `mode: break` | The old `mode: recheck` input is now `run: recheck` |
| `design-critic` | [`ui-reviewer`](../agents/frontend/ui-reviewer.md) | `mode: critique` | The old `mode: recheck` input is now `run: recheck` |
| `discovery` | [`code-explorer`](../agents/code-explorer.md) | `mode: stage-recon` | `/sell-slice` Phase 1 runs it together with `slice-scope` in one dispatch |
| `checklist-curator` | [`code-explorer`](../agents/code-explorer.md) | `mode: slice-scope` | Same dispatch as above; still proposes the checklist diff and never edits |
| `complexity-assessor` | [`stage-planner`](../../cook-pizzas/agents/stage-planner.md) | `mode: extend` | `/special-order` |
| `stage-decomposer` | [`stage-planner`](../../cook-pizzas/agents/stage-planner.md) | `mode: full` | `/cook-pizzas`; `mode: options` is new (design options) |
| `db-schema-stage-writer` | [`phased-plan-writer`](../../cook-pizzas/agents/phased-plan-writer.md) | `mode: db-schema` | Same return envelope |
| `modern-ux-expert` | [`ux-layout-designer`](../agents/frontend/ux-layout-designer.md) | (one dispatch, Part A) | UX spec first, then routes and layouts, then the breakpoint plan, serial inside one agent |
| `layout-architect` | [`ux-layout-designer`](../agents/frontend/ux-layout-designer.md) | (one dispatch, Part B); `start_at: layout` after the framework-gate HITL | Same dispatch as above; a re-dispatch of the old agent alone is `start_at: layout` |
| `block-composer` | [`ui-builder`](../agents/frontend/ui-builder.md) | (one dispatch, Step 1) | Registries first, then crafts the gaps |
| `component-crafter` | [`ui-builder`](../agents/frontend/ui-builder.md) | (Step 2); `mode: revise` for Library Preview Gate notes | Gap crafting is part of the normal dispatch |
| `bootstrap-runner` | none | | Removed; `/setup-shop` Step 1 bootstraps inline |
| `proposal-drafter` | none | | Removed; never dispatched |
| `consistency-checker` | none | | Removed; never dispatched |
| `env-scanner` | [`env-inventory.js`](../../open-the-shop/scripts/env-inventory.js) | `scan` | Never prints a value; `/open-the-shop` Phase 0 |
| `github-secrets-scanner` | [`env-inventory.js`](../../open-the-shop/scripts/env-inventory.js) | `secrets` | `/open-the-shop` Phase 2 |
| `checklist-generator` | [`env-inventory.js`](../../open-the-shop/scripts/env-inventory.js) | `checklist` | Renders from the known-services catalog |
| `env-verifier` | [`env-inventory.js`](../../open-the-shop/scripts/env-inventory.js) | `verify` | Same placeholder detection list; never reads a value into output |
| `bundle-validator` | [`token-check.js`](../../set-display-case/scripts/token-check.js) | `bundle` | `/set-display-case` bundle path |
| `compliance-pre-check` | [`token-check.js`](../../set-display-case/scripts/token-check.js) | `complete` | Also checks the approved draft before any file exists, and reads Tailwind v4 `@theme` |
| `config-generator` | [`write-config.js`](../../setup-shop/scripts/write-config.js) | (answers file) | Never overwrites without a HITL; keeps the JSONC comments |
| `ci-cd-detector` | [`detect-ci.js`](../../setup-shop/scripts/detect-ci.js) | (project root) | Keeps the lean-tier rule; `/setup-shop` Step 3 |
| `local-gates-runner` | [`run-gates.js`](../../final-quality-check/scripts/run-gates.js) | (project root) | Run in the background by the conductor; logs on disk, JSON summary only |
| `e2e-installer` | [`scaffold-writer`](../../final-quality-check/agents/scaffold-writer.md) | `block: e2e` | Sub-block 3A |
| `workflow-writer` | [`scaffold-writer`](../../final-quality-check/agents/scaffold-writer.md) | `block: workflows` | Sub-block 3B |
| `husky-installer` | [`scaffold-writer`](../../final-quality-check/agents/scaffold-writer.md) | `block: husky` | Sub-block 3C; three-way classification of an existing hook |
| `lint-config-writer` | [`scaffold-writer`](../../final-quality-check/agents/scaffold-writer.md) | `block: lint` | Sub-block 3E; preserves every existing rule |
| `branch-protection-writer` | [`scaffold-writer`](../../final-quality-check/agents/scaffold-writer.md) | `block: branch-protection` | Sub-block 3G |
| `framework-detector` | [`scaffold-discovery`](../../final-quality-check/agents/scaffold-discovery.md) | (its `e2e_plan`) | The E2E framework choice is part of the Phase 0 profile |

Unchanged names: `fix-attempter`, `ui-fix-attempter`, `debug-instrumenter` and `ci-fix-attempter` stay separate agents, so the local and CI fix-cap counters still count by agent type.
