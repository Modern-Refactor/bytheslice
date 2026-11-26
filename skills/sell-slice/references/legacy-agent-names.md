<!-- skills/sell-slice/references/legacy-agent-names.md -->
<!-- The old-to-new agent name table for the 7.0.0 agent-roster consolidation (52 agents to 42): every agent name removed in 7.0.0, the agent and mode that does its job now, the rule for reading an old name met in a stage file, goal, checklist, ledger or earlier chat message, and the planned (not yet made) moves of the agents that stay registered for now. -->

# Legacy agent names

The plugin consolidated its agent roster. Projects planned or started on an older plugin version still name the old agents in stage files, slice-completion goals, checklist notes, run logs, ledger rows and earlier chat messages. Those files need no edit.

**Reading rule for every conductor** (`/sell-slice`, `/sell-pie`, `/special-order`, `/cook-pizzas`, `/final-quality-check`, `/inspect-display`): when you meet an old name from the **Renamed in 7.0.0** table in a stage file, a goal, a checklist, a run log or an earlier chat message, read it as the new agent and mode in the same row, and dispatch that. Never dispatch an old name from that table: it is no longer registered. A line that asks for two old agents now served by one (for example "both `spec-reviewer` and `quality-reviewer` returned `verdict: pass`") is satisfied by one dispatch of the new agent returning that verdict. A goal or checklist line naming an old agent is checked against the new agent's return, not rewritten.

**Config keys under old names.** A `modelTiers` key spelled with an old name (camelCase, for example `qualityReviewer`) or a `pass.spawnPolicy.roles` entry under an old name may only **raise** the new agent's tier above its default, never lower it: `specReviewer: "sonnet"` alone leaves `code-reviewer` on `opus`, and `stageDecomposer: "sonnet"` leaves `stage-planner` on `opus`. An old-name key that would lower the tier is ignored and recorded once as a `policy-override` note marked `ignored` (one that names the tier the agent already has changes nothing). When two old keys land on one agent the higher tier wins (`opus` over `sonnet` over `haiku`). An empty `pass.spawnPolicy.roles` list under an old name (`"quality-reviewer": []`) was a deliberate opt-out of the model check and still turns it off for the new agent. A key spelled with the new name sets any tier and always beats old keys. A watchdog budget under an old name (`pass.watchdog.budgetsMs.discovery`) gives the new agent the longer of that value and its default (a shorter one is ignored with the same kind of note); a budget under the new name wins outright.

## Renamed in 7.0.0

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

## Planned, not yet

These agents are **still registered** in 7.0.0. Dispatch them as-is, under these names; nothing here is renamed yet. A later release plans to replace them, and this note becomes a table only when that release ships.

- `env-scanner`, `github-secrets-scanner`, `checklist-generator`, `env-verifier`: planned as one script.
- `bundle-validator`, `compliance-pre-check`: planned as one script.
- `config-generator`, `local-gates-runner`, `ci-cd-detector`: each planned as a script.
- `e2e-installer`, `workflow-writer`, `husky-installer`, `lint-config-writer`, `branch-protection-writer`: planned as one scaffold-writing agent dispatched once per sub-block.
- `framework-detector`: planned to fold into `scaffold-discovery`.

Unchanged names: `fix-attempter`, `ui-fix-attempter`, `debug-instrumenter` and `ci-fix-attempter` stay separate agents, so the local and CI fix-cap counters still count by agent type.
