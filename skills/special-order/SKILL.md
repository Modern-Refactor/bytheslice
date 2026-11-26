---
name: special-order
description: "Cook a slice with the customer's specifications on the spot: add new features mid-flight to an existing project. Auto-detects project type and extends the master checklist with new stages."
model: opus
effort: high
user-invocable: true
triggers: ["/bytheslice:special-order", "/special-order", "custom order", "off-menu request", "/bytheslice:add-feature", "/add-feature", "add a feature", "add features", "extend the app", "bolt on a feature", "what about adding"]
---

<!-- skills/special-order/SKILL.md -->
<!-- Mid-flight feature addition. Pizza-shop framing: a walk-in wants something not on today's menu, cook it on the spot and add it to the tray. Detects project state, traces the code the feature touches, asks about the feature itself, assesses complexity and design options, writes incremental stage files, hands off to /sell-slice. For non-ByTheSlice apps, redirects to /setup-shop. -->

# Special Order: Add Features Mid-Flight

Bolt new features onto an existing project without restarting from a fresh PRD. Used after the original plan has shipped (through `/bytheslice:sell-pie`, `/bytheslice:sell-slice` or `/bytheslice:pizza-party`), OR for adding ByTheSlice to an existing non-ByTheSlice project. `/bytheslice:pizza-party` also runs it mid-build to replan a slice that used up its fix loops into smaller slices.

The flow auto-detects which state the project is in and either runs the addition flow directly or redirects you to the right entry point first.

## Mode detection

`/special-order` is **always sequential**: its entire purpose is to extend an existing master checklist with new feature stages. The skill auto-detects:

- **Path A**: `docs/plans/00_master_checklist.md` exists. Append new feature stages to the existing checklist.
- **Path B**: `package.json` exists but no master checklist. Redirect the user to `/setup-shop` → `/create-menu` → `/cook-pizzas` first.
- **Path C**: no project on disk. Redirect to `/setup-shop` for bootstrap.

There is no standalone "produce a feature spec without a checklist" mode; that would just be `/create-menu` for a new project.

## Reference Files

| File | Purpose |
| --- | --- |
| [`skills/cook-pizzas/references/stage-frontmatter-contract.md`](../cook-pizzas/references/stage-frontmatter-contract.md) | YAML frontmatter shape every new stage file must match |
| [`skills/cook-pizzas/references/templates.md`](../cook-pizzas/references/templates.md) | Stage plan + master checklist templates |
| [`skills/cook-pizzas/references/canned-stages/auth-dev-mode-switcher-task.md`](../cook-pizzas/references/canned-stages/auth-dev-mode-switcher-task.md) | Auto-injected if any new feature is auth-tagged |
| [`skills/setup-shop/references/bytheslice-config-schema.md`](../setup-shop/references/bytheslice-config-schema.md) | Honors `stages.maxTasksPerStage` from `bytheslice.config.json` |

## Sub-agents

| When | File | Model | Effort |
|---|---|---|---|
| Phase 0.5 (skipped for a greenfield project) | [`../sell-slice/agents/code-explorer.md`](../sell-slice/agents/code-explorer.md) (mode `feature-trace`) | `opus` | medium |
| Phase 2 (always) | [`../cook-pizzas/agents/stage-planner.md`](../cook-pizzas/agents/stage-planner.md) (mode `extend`, with `options` folded in) | `opus` | medium |
| Phase 4 (always) | [`../cook-pizzas/agents/phased-plan-writer.md`](../cook-pizzas/agents/phased-plan-writer.md) (mode `incremental`) | `opus` | medium |

`phased-plan-writer` runs in **incremental mode** for this skill (no PRD context, receives the user's feature description + the stage-planner output + the chosen approach + existing-stages context directly). See its incremental-mode block.

> **Older agent names.** A stage file, checklist, run log or earlier message that names `complexity-assessor` means `stage-planner` mode `extend`. Read it that way; nothing on disk needs rewriting. The full old-to-new table is [`legacy-agent-names.md`](../sell-slice/references/legacy-agent-names.md).

## Project Config

Honor these `bytheslice.config.json` keys when present (see [`skills/setup-shop/references/bytheslice-config-schema.md`](../setup-shop/references/bytheslice-config-schema.md)):

- `stages.maxTasksPerStage`: passed to stage-planner and phased-plan-writer for the new stage(s)
- `modelTiers.stagePlanner`: overrides this skill's stage-planner model (a legacy `modelTiers.complexityAssessor` key is read as `stagePlanner`; a `stagePlanner` key wins over it)
- `modelTiers.codeExplorer`: overrides the Phase 0.5 code-explorer model
- `hitl.additionalCategories`: additional bubble-up categories the planner may use
- `run.unattended`: when `true` (set by `/pizza-party`), the run is unattended; see "Unattended runs" below

## Flow Detection

Run this detection before doing any work. It picks one of three paths.

```
1. Does docs/plans/00_master_checklist.md exist?
   Yes → Path A (ByTheSlice-built project, proceed with feature addition)
   No  → continue to step 2

2. Does package.json exist in the working directory?
   Yes → Path B (existing app, not ByTheSlice, redirect to /bytheslice:setup-shop
                  for config + CI/CD baseline before re-invoking special-order)
   No  → Path C (no project on disk, redirect to /bytheslice:setup-shop for
                  full bootstrap before any feature work)
```

Announce which path applies and why before continuing.

---

## Path A: ByTheSlice-built project (explore → ask → assess → write stages → handoff)

### Unattended runs

A run is **unattended** when `run.unattended: true` is set in `bytheslice.config.json` (`/pizza-party` sets it, and runs this skill mid-build to replan a stuck slice or fix a failed smoke check) or when the operator's run instruction says to proceed autonomously. An unattended run asks nothing and waits for nothing:

- **Phase 1:** no questions. Every answer comes from the invocation, the order ticket `docs/pizza-party/order.md` when it exists (its **Answers**), and the code-explorer output; anything they leave open takes the recommended option and is recorded as an **assumption**.
- **Phase 3:** the breakdown is auto-authorized, and every multi-stage feature takes the `pragmatic` approach.
- **Recording.** Every assumption and every auto-picked approach is written down three ways: in the new stage file (the writer puts the approach and why in the Architecture note; assumptions go under it as `Assumption:` lines), as one `bts_note` per feature, and, when the order ticket exists, as one line each under its "Decisions made without you" section (`- special-order · <feature>: <assumption or approach> · <why, in a clause>`).
- Without an unattended signal, every question is asked as written.

### Phase 0: Orientation

1. Read `docs/plans/00_master_checklist.md`: get the list of every existing stage and its status.
2. Read every `docs/plans/stage_*.md` quickly (frontmatter only: `name`, `type`, `slice`, `mvp`, `depends_on`, `completion_criteria`).
3. Find the highest existing stage number. New stages will start at `<highest> + 1`.
4. Read the original PRD at `docs/prd-*.md` if present, useful for the "don't drift outside scope" check, but NOT required.
5. Read `bytheslice.config.json` at the project root if present.
6. Read the project rules file (`CLAUDE.md` or `AGENTS.md`).
7. Confirm git state: `git status --short`, `git rev-parse --abbrev-ref HEAD`. Should be clean and on `main`.
8. Note whether the run is unattended (see "Unattended runs").
9. Switch to **Plan Mode** (interactive runs only).

### Phase 0.5: Code exploration (before the Phase 1 questions)

Ground the questions and the assessment in the code the feature will touch, before asking anything.

1. **Get the feature request.** Take the feature list from the invocation (`/special-order add CSV export to orders`, or the stuck slice and its Exit criteria handed over by `/pizza-party`). When the invocation names no feature, ask **Q-features** (Phase 1) first, then come back here.
2. **Skip for a greenfield project.** When the project has no application code yet (no tracked source files beyond the scaffolder's starter files, for example a checklist whose stages are all unbuilt), skip the dispatch, record `exploration: skipped (greenfield)` in the run log, and go to Phase 1.
3. **Dispatch `bytheslice:code-explorer` with `mode: feature-trace`** ([definition](../sell-slice/agents/code-explorer.md); fallback on hosts without plugin agents: Read the file and dispatch it per [`loop-workflow-fallback-pattern.md`](../cook-pizzas/references/loop-workflow-fallback-pattern.md) "Agent shape on the fallback path"; log one self-check line per dispatch in the run log). Pass the feature request verbatim and the paths to the PRD (when present) and `docs/plans/00_master_checklist.md`. It is read-only and returns, per feature, the 5 to 10 key files, the entry points, the patterns and conventions those files follow, the integration points and the risks (callers that break, a pattern the request conflicts with, missing infrastructure, and anything the request leaves undecided that changes the design).
4. **Read the key files it names** that bear on the feature, so the questions and the recommended answers below come from the code, not from the feature's name.

The explorer's output travels with the run: Phase 1 uses it to decide which feature questions are worth asking and what to recommend, and Phase 2 passes it to `stage-planner` as `code_explorer_output`.

### Phase 1: Feature elicitation (Plan Mode)

Ask the user with `ask_user_input_v0`, one question at a time. **Unattended runs skip every question here** and record assumptions instead (see "Unattended runs").

**Always provide a recommended answer in available options.**

**Q-features** (skipped when the invocation already named the features)
> "What feature(s) do you want to add? List each as a one-line summary. (You can paste multiple, one per line.)"
> text_input: multiline

**Q-relationship**
> "For each feature: is it brand-new, or does it extend something already built?"
> single_select: ["All brand-new", "All extending existing features", "Mix, I'll annotate per-feature"]
> If "Mix": follow-up text input asking the user to label each feature line as `[new]` or `[ext: <existing-feature>]`.

**Feature questions (Q-feature-\*), only where the code leaves real ambiguity**

Then ask about the feature itself. Draw each question from the explorer output (or, for a greenfield project, from the PRD and the feature request), and ask it **only** when the code and the request leave the answer genuinely open; a decision the existing code already makes (an error pattern every route follows, a table the feature must extend) is a convention, not a question. Each question is short, one decision, with a recommended option drawn from the code's conventions. Cover, where they apply:

- **Edge cases**: the boundary inputs and states the feature must handle (for example "Export an empty list?" with "Yes, header-only file" recommended).
- **Error handling**: what the user sees when the feature fails (for example "On a failed send, retry or show an error?").
- **Scope boundaries**: what is in and out of this request (for example "Include admins' orders?").
- **Integration points**: which existing module, table or service the feature hooks into when more than one fits (for example "Reuse `lib/mailer.ts` or add a queue?").

One decision per question; split any question that would bundle two. Ask none of these when the code answers them all. Every answer (and, unattended, every assumption) goes to Phase 2 as `feature_answers`.

**Q-conventions**
> "Should the new feature(s) follow the existing patterns (project rules file + recent stage conventions), or do you have new patterns to introduce?"
> single_select: ["Follow existing conventions", "Introduce new patterns (I'll specify in next step)"]
> If "Introduce new": follow-up text input asking the user to describe.

**Q-mvp-band**
> "Mark new stages as `mvp: true` (Phase 1 / immediate ship) or `mvp: false` (Phase 2 / later batch)?"
> single_select: ["mvp: true, ship immediately", "mvp: false, batch as Phase 2", "Mix, let me annotate per-feature"]

**Q-pr-style**
> "Open PRs against `main` directly, or against an integration branch?"
> single_select: ["main (one PR per stage, default)", "integration branch (specify name in next step)"]

Confirm answers before proceeding.

### Phase 2: Complexity assessment and design options

Dispatch `bytheslice:stage-planner` with `mode: extend` and `include_options: true` ([definition](../cook-pizzas/agents/stage-planner.md); one dispatch covers both the assessment and the design options; fallback on hosts without plugin agents: Read the file and dispatch it per [`loop-workflow-fallback-pattern.md`](../cook-pizzas/references/loop-workflow-fallback-pattern.md) "Agent shape on the fallback path": its frontmatter goes first as a header (model tier and effort, the normalized tool allowlist, the read-only line for an agent without write tools, the no-git-writes line), then its body, then the inputs; log one self-check line per dispatch in the run log). Pass:
- The user's feature list (from Q-features) plus annotations
- The relationship answer (Q-relationship) per feature
- The `mvp:` band per feature (Q-mvp-band)
- The conventions choice (Q-conventions)
- The current highest stage number
- Frontmatter excerpts from the most-recent 3-5 stages (for pattern matching)
- The `bytheslice.config.json` (esp. `stages.maxTasksPerStage`)
- The project rules file path
- The PRD path if present (read-only)
- The Phase 0.5 code-explorer output as `code_explorer_output` (absent for a greenfield project)
- The Phase 1 feature answers (or, unattended, the recorded assumptions) as `feature_answers`
- `run_unattended: true | false`

The planner returns a per-feature recommendation: single-stage or multi-stage, with proposed stage names, types, slices, dependencies, and estimated tasks. For every feature that splits into **2 or more stages** it also returns 2 to 3 design approaches (`minimal` change, `clean` architecture, `pragmatic` balance), each with its trade-offs and the stage breakdown it implies, plus a recommendation. A single-stage feature gets no options.

### Phase 3: Surface assessment, choose approaches, authorize

**Design options first (multi-stage features only).** For each feature that came back with `approaches`, show one compact table, the recommended row marked:

```
Reviews on product page (multi-stage)
┌──────────────┬────────┬─────────────────────────────┬──────────────────────────────┐
│ Approach     │ Stages │ Pros                        │ Cons                         │
├──────────────┼────────┼─────────────────────────────┼──────────────────────────────┤
│ minimal      │ 1      │ reuses the comments table   │ no moderation path later     │
│ clean        │ 3      │ own reviews module + schema │ touches checkout types       │
│ pragmatic ★  │ 2      │ new table, existing UI kit  │ moderation stays manual      │
└──────────────┴────────┴─────────────────────────────┴──────────────────────────────┘
Recommended: pragmatic. <the planner's one-sentence rationale>
```

Then ask one short question per feature, recommended option first:

> "Which approach for <feature>?"
> single_select: ["<recommended id>: <title> (recommended)", "<other id>: <title>", ...]

The chosen approach's `proposed_stages` replace the feature's `proposed_stages` in the breakdown below. When the operator wants an approach changed rather than picked, re-dispatch `stage-planner` with `mode: options` for that feature and their feedback; this counts toward the re-assessment cap below.

**Unattended:** ask nothing. Every multi-stage feature takes `pragmatic`, whatever the planner recommended. Record it (see "Unattended runs"): call `bts_note` once per feature with `special-order: <feature> took the pragmatic approach (unattended auto-pick, planner recommended <id>): <rationale, and the planner's unattended_note when it recommended another approach>`, and pass the choice to the writer in Phase 4 so it lands in the stage file.

**Interactive runs record the choice too:** one `bts_note` per multi-stage feature naming the approach the operator picked, and the same Phase 4 hand-off to the stage file.

**Renumber the batch after every choice is applied.** A chosen approach can hold more or fewer stages than the recommended one, so its numbers can collide with the stages the planner gave later features (recommended stages 28 and 29 swapped for a three-stage approach would add a stage 30 that the next feature already owns). Once every feature's approach is set (picked, auto-picked, or revised), renumber the whole selected batch in feature order from the highest existing stage number plus one, and remap every `depends_on` that points at a renumbered stage, inside the batch or from another new stage. Render the table below, pass stage numbers to the Phase 4 writers, and append to the checklist in Phase 5 only from this renumbered batch. A single-stage-only batch with no approach changes keeps the planner's numbers.

Then render the planner's output (with the chosen approaches applied) as a compact table:

```
┌──────────────────┬────────────┬────────┬────────────────────────────────┐
│ Feature          │ Complexity │ Stages │ Stage names (proposed)         │
├──────────────────┼────────────┼────────┼────────────────────────────────┤
│ Reviews on       │ multi      │ 2      │ stage_28 reviews-shell         │
│ product page     │            │        │ stage_29 reviews-data          │
├──────────────────┼────────────┼────────┼────────────────────────────────┤
│ CSV export       │ single     │ 1      │ stage_30 admin-csv-export      │
└──────────────────┴────────────┴────────┴────────────────────────────────┘
```

End with: **"Authorize this stage breakdown? (yes / edits / cancel)"** and wait. Do not proceed until the user says yes.

If the user requests edits, re-dispatch the planner (`mode: extend`, `iteration: 2`, the user's feedback and the previous return). Cap at 2 re-assessment rounds; on round 3 → bubble HITL `prd_ambiguity`.

**Unattended:** the breakdown is auto-authorized; show the table in the run output for the record and go straight to Phase 4. An out-of-scope flag still never writes a stage: the feature is dropped and recorded as a decision line instead.

### Phase 4: Write stage files

Dispatch `bytheslice:phased-plan-writer` ONCE PER NEW STAGE in **incremental mode** ([definition](../cook-pizzas/agents/phased-plan-writer.md); fallback: read-and-paste). Pass:
- Stage number, short name, output path (`docs/plans/stage_<N>_<slug>.md`)
- One-sentence goal
- `mvp:` flag from Q-mvp-band
- Scope: in-scope tasks list (≤ `stages.maxTasksPerStage`, default 6)
- Context: feature description + the stage-planner block for this stage (`stage_planner_output`: rationale, `grounded_in`, `auth_tagged`) + relationship to existing features + similar-stage frontmatter for pattern matching
- For a multi-stage feature: the chosen approach (`id`, title, the planner's rationale, and `unattended auto-pick` when the run was unattended), which the writer records in the stage's Architecture note
- The code-explorer key files and conventions for this feature as prior-stage context (absent for a greenfield project)
- Unattended runs: the Phase 1 assumptions for this feature, written as `Assumption:` lines under the Architecture note
- Auth-tagged? If yes, the writer auto-injects the dev-mode auth helpers task, localhost auto-login (opt-in via `DEV_AUTH_BYPASS`) + user switcher banner, as one combined task (per [`auth-dev-mode-switcher-task.md`](../cook-pizzas/references/canned-stages/auth-dev-mode-switcher-task.md))
- Dependencies: stages this new feature depends on (from `depends_on:` frontmatter, usually `[]` or just the design-system + db-schema foundation stages already built)
- The project rules file path

Dispatch all per-stage writers in parallel where independent; sequentially where one stage depends on another being defined first.

**Verify Exit-criteria contract before accepting each writer's output.** Every new stage file's body MUST end with an `**Exit criteria:**` block where each bullet is transcript-verifiable, binary, and specific to the slice (per [`../cook-pizzas/references/templates.md`](../cook-pizzas/references/templates.md) → "Exit-criteria contract (consumed by `/goal`)"). This block is what `/bytheslice:sell-slice` Phase 2.5 lifts into the session-scoped `/goal`: vague lines like "tests pass" or "looks good" break the goal evaluator. If a writer's output has weak Exit criteria, re-dispatch with a critique citing the contract. Cap at 2 re-write rounds; on round 3 → bubble HITL `prd_ambiguity`.

### Phase 5: Update master checklist

Append the new stages to `docs/plans/00_master_checklist.md`:

```markdown
## Stage 28: reviews-shell
Status: Not Started
Type: frontend
Slice: vertical
MVP: true
Depends on: 1, 4
Completion criteria:
  - tests_passing
  - <other criteria from the new stage frontmatter>

## Stage 29: reviews-data
Status: Not Started
[etc.]
```

Use the same checklist row format as the existing stages in the file. Do NOT alter completed stages' rows.

### Phase 6: Commit + Handoff

1. **Stage and commit the new plan files** on a `chore/add-stages-<lo>-<hi>` branch (e.g. `chore/add-stages-28-30` for three new stages 28 to 30):
   - Create the branch off `main`: `git checkout -b chore/add-stages-<lo>-<hi>`
   - Stage every new `docs/plans/stage_<n>_*.md` file plus the modified `docs/plans/00_master_checklist.md`
   - Conventional commit: `chore: add stages <lo>-<hi> (<feature names>)` with a body listing each new stage and its `type:` / `mvp:` flag
   - Working tree should be clean on the branch after this commit
2. **Do NOT push or open a PR from this skill.** That's `/bytheslice:box-it-up`'s responsibility, keeping the same separation as `/sell-slice`.
3. Print the handoff message:

> Stage(s) added to `docs/plans/00_master_checklist.md` and committed on branch `chore/add-stages-<lo>-<hi>`:
> - `stage_28_reviews-shell.md` (frontend, mvp)
> - `stage_29_reviews-data.md` (full-stack, mvp)
> - `stage_30_admin-csv-export.md` (backend, mvp)
>
> **Next steps (pick one):**
> - **Ship the plan changes as a chore PR first** (recommended for clean separation): run `/bytheslice:box-it-up`. The plan-only PR opens, CI runs (lint / link-check on the new files), you approve merge, the chore branch is cleaned up. Then start a fresh chat and run `/bytheslice:sell-slice` to ship the first new stage.
> - **Skip the chore PR, start delivery immediately**: switch back to `main` (`git checkout main`), then run `/bytheslice:sell-slice`. The first slice's PR will mix the new plan files with the implementation.
> - **Multi-stage autonomous delivery**: `/bytheslice:sell-pie` bakes every new stage of the pie end to end in one run (build, test, verify, fix per slice) and stops at the pie boundary for one PR. Best for batches you want shipped without per-stage babysitting.
>
> All new stages run the tiered gates: tier 1 while coding, tier 2 (the slice's own tests, build, DB tests when the schema changes) before each commit, tier 3 (`slice-verifier`, the full local suite) once at slice end, and the full CI suite (`@feature` + `@regression-core` + `@visual` + design-system-compliance + db-schema-drift if applicable) once at the PR (tier 4). Visual + design-system-compliance gates require the project to have already run `/bytheslice:final-quality-check`: if absent, the orchestrator will surface that and ask whether to scaffold first.

Return.

---

## Path B: Existing app, not ByTheSlice-built

**Detection:** `package.json` exists, `docs/plans/` does NOT exist.

Print to the user:

> This project has a `package.json` but no `docs/plans/`: it wasn't built with ByTheSlice.
>
> Before adding features through ByTheSlice, run `/bytheslice:setup-shop` first. It will:
> 1. Drop in a per-project `bytheslice.config.json` (Step 2 of Setup)
> 2. Check for CI/CD baseline and offer to scaffold it via `/bytheslice:final-quality-check` if missing (Step 3 of Setup, new in v2.2)
>
> After setup completes, re-invoke `/bytheslice:special-order` and I'll detect the new state and proceed with Path A, but note: without an existing `docs/plans/` and a master checklist of completed work, I'll be working with a much narrower context. You may want to first run `/bytheslice:create-menu` against the EXISTING app's known surface area to give the stage planner better grounding.

Bubble HITL:

```yaml
status: needs_human
summary: Existing project detected (has package.json) but not ByTheSlice-built (no docs/plans/). Redirecting to /bytheslice:setup-shop before feature addition can proceed.
artifacts: []
needs_human: true
hitl_category: prd_ambiguity
hitl_question: "Run /bytheslice:setup-shop first to add the config + CI/CD baseline, then re-invoke /bytheslice:special-order?"
hitl_context: "No docs/plans/00_master_checklist.md found in working directory; package.json present at <path>."
```

Then return.

---

## Path C: No project on disk

**Detection:** Neither `package.json` nor `docs/plans/` exists.

Print:

> No project detected in this directory. Run `/bytheslice:setup-shop` first; it will scaffold a fresh Next.js single-app or Turborepo monorepo (Flow B) and drop in the per-project config. Once a project exists, run `/bytheslice:create-menu` for new builds, or `/bytheslice:special-order` once you have a master checklist to extend.

Bubble HITL:

```yaml
status: needs_human
summary: No project on disk. Redirecting to /bytheslice:setup-shop for project bootstrap.
artifacts: []
needs_human: true
hitl_category: prd_ambiguity
hitl_question: "Run /bytheslice:setup-shop to scaffold a new project, then run /bytheslice:create-menu to start the full PRD-to-app flow?"
hitl_context: "Working directory has no package.json and no docs/plans/."
```

Then return.

---

## Hard Constraints

- **Never invent a master checklist.** Only Path A operates on existing `docs/plans/`. Paths B and C ALWAYS redirect to setup.
- **Never alter completed stage rows.** special-order only APPENDS new stages. Existing stages are read-only context.
- **One slice per PR is still the rule.** Pass `pr_style` from Q-pr-style to phased-plan-writer; default is one PR per stage.
- **Honor `stages.maxTasksPerStage`** from `bytheslice.config.json` (default 6). The stage-planner uses this when proposing breakdowns and design options.
- **Unattended runs never wait.** No Phase 1 question, no Phase 3 prompt; assumptions and the auto-picked `pragmatic` approach are recorded in the stage file, a `bts_note`, and the order ticket when one exists.
- **Auth-tagged stages must inject the dev-mode auth helpers task**: one combined task with two sub-bullets (localhost auto-login + user switcher banner) that ship together. This is mandatory per [`auth-dev-mode-switcher-task.md`](../cook-pizzas/references/canned-stages/auth-dev-mode-switcher-task.md). The phased-plan-writer handles this in incremental mode the same way it does in cook-pizzas mode.
- **Out-of-scope guard.** If the user proposes features that contradict the original PRD's "Out of Scope" section (Section 7), surface as HITL `prd_ambiguity` BEFORE writing any stage files.

---

## Completion Checklist

- [ ] Detection ran and announced the chosen path
- [ ] (Path A only) Phase 0 orientation complete (master checklist read, recent stages scanned, git state clean)
- [ ] (Path A only) Code-explorer `feature-trace` dispatched and its key files read (or skipped and logged for a greenfield project)
- [ ] (Path A only) Plan-mode question gate ran (Q-features, Q-relationship, the feature questions the code left open, Q-conventions, Q-mvp-band, Q-pr-style), or, unattended, assumptions recorded instead
- [ ] (Path A only) Stage-planner (`extend`, options folded in) dispatched and returned
- [ ] (Path A only) Design options shown and an approach chosen for every multi-stage feature (unattended: `pragmatic`, recorded in the stage file and a `bts_note`)
- [ ] (Path A only) Assessment surfaced to user; user authorization received (unattended: auto-authorized)
- [ ] (Path A only) phased-plan-writer dispatched once per new stage (incremental mode)
- [ ] (Path A only) Master checklist updated with new stage rows (existing rows untouched)
- [ ] (Path A only) New plan files + master-checklist update committed on a `chore/add-stages-<lo>-<hi>` branch (no push, no PR, handed off to `/bytheslice:box-it-up`)
- [ ] (Path A only) Handoff message printed with the three next-step options (`/box-it-up` for plan-only chore PR / direct `/sell-slice` / `/sell-pie` for batch)
- [ ] (Path B only) HITL bubble surfaced; user redirected to /bytheslice:setup-shop
- [ ] (Path C only) HITL bubble surfaced; user redirected to /bytheslice:setup-shop for bootstrap

---

## Sub-agent return contract

```yaml
status: complete | failed | needs_human
summary: <one paragraph>
artifacts:
  - <list every new stage file path created>
  - docs/plans/00_master_checklist.md (if Path A and updated)
needs_human: false | true
hitl_category: null | "prd_ambiguity" | "external_credentials" | "destructive_operation" | "creative_direction"
hitl_question: null | "<plain-language question>"
hitl_context: null | "<what triggered this>"
```
