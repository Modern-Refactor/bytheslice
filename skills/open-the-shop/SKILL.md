---
name: open-the-shop
description: "Doors unlocked, lights flipped, OPEN sign up - scan environment requirements and verify all external service credentials are populated. The most HITL-heavy prep step; the operator personally stocks the cash drawer. Run once before /sell-slice; also invocable standalone."
user-invocable: true
triggers: ["/bytheslice:open-the-shop", "/open-the-shop", "stock the line", "open for business", "doors open", "/bytheslice:setup-environment", "/setup-environment", "env setup", "env-setup stage"]
---
<!-- skills/open-the-shop/SKILL.md -->
<!-- Daily-prep skill - the LAST step before /sell-slice. Pizza-shop framing: doors unlock, lights flip, OPEN sign goes up. Orchestrator-only: runs scripts/env-inventory.js (scan, secrets, checklist, verify) to gate the project on a fully populated environment. Mode-detected (standalone vs sequential). Most HITL-heavy prep step - operator personally provides credentials. -->

# Open the Shop - Environment Gate

Ensures all external services are provisioned and every `.env.local` file is fully populated before feature stages or CI gates begin. Running feature work with missing or placeholder keys causes cascading failures that are hard to diagnose; this gate catches them early.

## Mode detection

This skill runs in one of two modes, auto-detected at startup:

- **Standalone** - no `docs/plans/00_master_checklist.md` at the project root. Walks env-var setup on any project. Runs end-to-end, exits. No checklist coordination.
- **Sequential** - master checklist exists with a `## Prep` section. On completion, flip the `[ ] Shop open` row to `[x]` and surface: *"Shop is open. Foundation prep complete. Run `/sell-slice` to start serving customers."*

Honor an explicit `--standalone` or `--sequential` flag if passed; otherwise auto-detect from disk state.

**Unattended runs.** When `bytheslice.config.json` sets `run.unattended: true` (`/pizza-party` does), Phases 3 and 4 take the **provider-provisioned path** below instead of the manual checklist, and nothing waits on a human: the operator accepted that risk by launching the run. Every choice made in the operator's place is one line in the order ticket (`docs/pizza-party/order.md`), recorded per `skills/pizza-party/references/decision-routing.md`: a provider or local substitute under **Decided by the team**; a paid service or one that holds user data the **Answers** did not name under **Waiting on the stand-in**, with the substitute applied as the provisional default. Without `run.unattended`, the interactive path is unchanged.

## Scripts

Every mechanical step is one deterministic, zero-dependency Node script in `./scripts/`, run by its absolute path (`node "<this-skill-directory>/scripts/<name>.js" ... --root <workspace root>`), never by changing into this skill's folder; a relative path argument resolves against `--root`. The scripts follow the [script contract](../sell-slice/references/script-contract.md): each prints one JSON object on stdout and nothing else, key names and paths only, never a value. Exit 0 is a result (read `status` where there is one); exit 2 is `{"needs_human": {"category", "question", "context"}}`, which the conductor raises with `bts_hitl` and stops for the answer (unattended runs follow the no-provider rule instead); exit 1 is a real error: report the stderr line and stop. Neither script exits 2 today (the operator-access HITL below is this skill's).

| Phase | Command | Returns |
|-------|---------|---------|
| 0 | `node "<this-skill-directory>/scripts/env-inventory.js" scan --root <workspace root>` | `env_examples_found` (path, `expected_local_path`, keys with docstrings), `total_keys_unique`, `no_env_examples_found` |
| 2 | `node "<this-skill-directory>/scripts/env-inventory.js" secrets --root <workspace root>` | `github_secrets_referenced` (name, workflows, `also_in_env_local`), `total_secrets_unique`, `no_workflows_found` |
| 3 | `node "<this-skill-directory>/scripts/env-inventory.js" checklist --root <workspace root>` | `checklist_markdown`, `services_detected`, `services` (service, console URL, keys), `unknown_keys`, `total_checklist_items` |
| 5 | `node "<this-skill-directory>/scripts/env-inventory.js" verify --root <workspace root> [--excused K1,K2] [--confirmed K1,K2]` | `status: pass \| fail`, `missing_files`, `missing_keys_per_file`, `placeholder_keys`, `unchanged_from_example`, `excused_keys`, `confirmed_keys` |

## Reference Files

| File | Purpose |
| --- | --- |
| [references/known-services-catalog.md](references/known-services-catalog.md) | Maps key prefixes → service + provisioning console URL. `env-inventory.js checklist` reads it on every run, so a new catalog entry needs no code change. |
| [references/env-checklist-template.md](references/env-checklist-template.md) | Structural pattern for the user-facing checklist. |
| [references/provider-provisioning.md](references/provider-provisioning.md) | Unattended only: read-only authorization checks per provider, how provider tooling writes `.env.local`, local substitutes, and GitHub secrets from provider output. |
| [scripts/env-inventory.js](scripts/env-inventory.js) | Phases 0, 2, 3 and 5: the `.env.example` scan, the CI secrets list, the checklist, and the `.env.local` verification (key names only). |
| [scripts/merge-env.js](scripts/merge-env.js) | Unattended only: merges provider output into `.env.local`, filling only missing, placeholder or still-example keys, printing key names only. |

## When to Use

- `/sell-slice` reaches a `type: env-setup` stage in the master checklist (auto-dispatch).
- User runs `/open-the-shop` directly as an escape hatch.
- User says "env setup", "set up environment", "populate env vars", or "provision services".
- After CI/CD scaffold is complete (`final-quality-check`) and before the first feature stage.

## Inputs and Preconditions

- Repository exists with at least one `apps/` or `packages/` directory.
- `final-quality-check` (Stage 2) has completed: `.github/workflows/` exists.
- Clean git working tree on `main`, OR explicit user OK to proceed dirty.

If no `.env.example` files are found at all, stop and tell the user - this likely means the apps were not scaffolded yet. Recommend completing Stage 2 first. Under `run.unattended: true`, a scaffolded app with no `.env.example` simply needs no keys: record that, write the pass marker, and complete. A dirty tree or a branch other than `main` is recorded and the run continues.

## Workflow

### Phase 0 - Scan

Run `node "<this-skill-directory>/scripts/env-inventory.js" scan --root <workspace root>`. It finds every `.env.example` at the repo root and under `apps/` and `packages/` (skipping `node_modules`, build output and dot-folders), and returns each file's keys (comment lines ignored, up to 3 comment lines above a key kept as its docstring; a commented-out `KEY=value` line or a credential-shaped comment is never kept, so no example secret reaches the checklist) and the `.env.local` path each one expects. It never opens a `.env.local`. When `no_env_examples_found` is true, stop and tell the user (see Inputs and Preconditions).

### Phase 1 - Service Detection

No separate step: Phase 3's `checklist` run maps each key to its service from the catalog.

### Phase 2 - GitHub Secrets Detection

Run `node "<this-skill-directory>/scripts/env-inventory.js" secrets --root <workspace root>`. It reads every `${{ secrets.NAME }}` in `.github/workflows/*.yml` (skipping `vars.*`, which are Actions Variables, not secrets) and marks each name `also_in_env_local` when a `.env.example` lists it; the rest are CI-only. `no_workflows_found: true` is fine: the GitHub Secrets section just says none are needed.

This skill cannot verify GitHub secrets directly (no read access to org secrets, and it never fetches a value through the GitHub API); it records the user's verbal confirmation only.

### Phase 3 - Checklist Generation

Run `node "<this-skill-directory>/scripts/env-inventory.js" checklist --root <workspace root>`. It reads [references/known-services-catalog.md](references/known-services-catalog.md), maps each key to a service (a direct match wins, then the longest wildcard prefix, then the same lookups with `NEXT_PUBLIC_` and similar public prefixes stripped; no match goes to "Other / Unknown", never dropped), groups the keys in the catalog's order with Other / Unknown last, and renders `checklist_markdown`: one section per service with its console link, one `- [ ]` item per key naming the `.env.local` file(s) that need it and its docstring, then the GitHub Secrets section from Phase 2 and the final confirmation boxes.

Display `checklist_markdown` to the user in full and verbatim.

### Phases 3 and 4 under `run.unattended: true` - Provider-provisioned path

Replaces the checklist display and the wait. Follow [references/provider-provisioning.md](references/provider-provisioning.md):

1. **Map keys to services.** Run the Phase 3 `checklist` command as usual; use its `services` grouping, not its markdown.
2. **Find the authorized provider per service.** Read the order ticket's **Answers** (Host, Database, Auth) for the provider and project each service uses. Confirm each with its read-only check (`vercel whoami`, `netlify status`, `wrangler whoami`, `supabase projects list`, `neonctl me`, `turso auth whoami`, `railway whoami`, `fly auth whoami`, `stripe config --list` with output discarded, and the like) or a connected MCP for it. Never pick a provider the operator has not authorized.
3. **Let the provider tooling write the values.** Pipe each provider's output (`vercel env pull`, the `supabase` CLI, `netlify env:list --plain`, and the like) into `node "<this-skill-directory>/scripts/merge-env.js" --root <workspace root> --example <.env.example> --target <.env.local> --source -`, which fills only keys the `.env.example` lists that are missing, placeholder or still the `.env.example` value. The agent never prints, logs, reads back or types a secret value; an MCP supplies only public values (a project URL, a publishable key).
4. **Keys no provider covered** follow the no-provider rule:
   - **Optional** (the app runs without it): leave it out, record it, and pass it to `verify --excused` (Phase 5).
   - **Required with a local substitute** (SQLite or a local Postgres for a database, a local session or magic-link-to-console for auth, a console logger for email): use the substitute, write its local values through `merge-env.js`, record it.
   - **Required with no substitute** (the app truly cannot run without it): mark every slice that needs it deferred in the master checklist (row stays `[ ]`, `**Status:** deferred: needs <service> credentials`), record the blocker under the ticket's **Deferred**, excuse its keys, and finish with `status: complete_with_deferrals`. Never `needs_human`.
5. **Destructive operations on shared resources the operator did not name** (creating or deleting a project, resetting a database, rotating keys) are skipped and recorded, never asked about.

Then go straight to Phase 5.

### Phase 4 - Wait for Confirmation

After displaying the checklist, ask the user to confirm when they have completed all steps.

**Always provide a recommended answer in available options** when prompting.

**HITL bubble-up rule (interactive path only):** if the user signals they cannot access a required service (no account, blocked by billing, etc.), set `needs_human: true` with `hitl_category: external_credentials` and surface the specific service and key as `hitl_question`.

When the user confirms "done", proceed to Phase 5.

### Phase 5 - Verification

Run `node "<this-skill-directory>/scripts/env-inventory.js" verify --root <workspace root>`. Under `run.unattended: true`, add `--excused K1,K2`: the keys recorded in the ticket as optional-and-omitted or deferred (a `.env.local` whose every key is excused may be absent). The script:
- Confirms a `.env.local` exists alongside every `.env.example`
- Confirms every key from `.env.example` is present in `.env.local` with a non-empty value that is not a placeholder shape: only x's, `your_key_here` / `your-key-here`, any `your_` or `your-` word (`YOUR_SUPABASE_URL`, `https://your-project.supabase.co`), a trailing `_here` or `...` (`sk_test_...`), any `<...>` or `{{...}}`, `TODO`, `REPLACE_ME` spelled any way, `insert_here`, `paste_here`, `sk-...`, `pk_test_x...` / `sk_test_x...` / `rk_test_x...`, or the words example, placeholder, dummy and changeme (trailing digits allowed) standing alone: the whole value, or a value whose other parts are only digits, key prefixes or credential nouns (`sk_test_example`, `dummy-token`), never one part of a longer identifier (`my-example-app` passes)
- Lists under `unchanged_from_example` each key still holding the same value it has in `.env.example` (a localhost URL, a number or a boolean excepted). This never fails `status` by itself: `us-east-1`, `development` or a local database URL is often the intended value. Keys passed with `--confirmed` leave the list
- Prints key names and file paths only, never a value; it judges presence and placeholder shape, not whether a real-looking value is correct

**If `unchanged_from_example` is non-empty**, ask once, in one short question: "These keys still hold the .env.example value: K1, K2. Intentional?" Yes: rerun `verify` with `--confirmed K1,K2` (plus any `--excused`). No: the operator edits `.env.local`, then return to Phase 4 and verify again. Under `run.unattended: true` there is no one to ask: pass the listed keys with `--confirmed` and record a note (key names only) in the report and the order ticket.

**If verification passes (`status: pass`):** proceed to Phase 6 - stage complete.

**If verification fails (`status: fail`):** remove `.claude/.bytheslice-state/env-check-passed` if it exists, then display a targeted report (missing files, missing keys, placeholder values per file). Then return to Phase 4 and wait for the user to fix and re-confirm. Loop until `status: pass`.

Under `run.unattended: true` there is no one to wait for: rerun the provider pass once for the failing keys, then send whatever still fails through the no-provider rule (step 4 above) and verify again. The second verify is final.

### Phase 6 - Closeout

1. After `verify` returns `status: pass`, write the literal `pass\n` to `.claude/.bytheslice-state/env-check-passed` (create the state directory if needed). This local marker records only the successful check. Never write environment values, secret names, credentials, or verifier output into it. Remove an existing marker when a later verification fails so the kitchen does not display a stale pass. Record confirmation that all `.env.local` files pass verification.
2. Record user's verbal confirmation that GitHub secrets are set (if any were listed in Phase 2). Under `run.unattended: true`, set only the secrets a workflow references, with `gh secret set` fed from the provider tooling through a pipe, never echoed (see the reference's "GitHub Actions secrets"). Under ship-once only the app's final PR runs CI, so this can happen any time before that PR; record each secret name set, and each referenced secret with no provider path.
3. Mark the stage complete in `docs/plans/00_master_checklist.md`.
4. Walk the [Completion Checklist](#completion-checklist) below and confirm every box is `[x]`.
5. Report to the user: which services were set up, which files were verified, and the total key count. Under `run.unattended: true`, add which provider filled each service, every substitute or omission, and every deferral (key names and services only), and append a **Progress** line to the order ticket.

## Completion Checklist

Walk this checklist at the end of every run. The stage is not "done" until all items are checked.

- [ ] All `.env.example` files in the repo have been scanned and all keys catalogued
- [ ] All detected services are represented in the manual checklist displayed to the user
- [ ] GitHub Secrets section was generated (or confirmed empty if no CI secrets needed)
- [ ] User confirmed all provisioning steps are complete
- [ ] `env-inventory.js verify` returned `status: pass` with zero `missing_files`, zero `missing_keys_per_file`, and zero `placeholder_keys`
- [ ] Every key listed under `unchanged_from_example` was confirmed by the operator (`--confirmed`), or, under `run.unattended: true`, confirmed with a recorded note
- [ ] User confirmed GitHub repository secrets are set (or confirmed none are required)
- [ ] If invoked as a `type: env-setup` stage by `sell-slice`, the master-checklist row is flipped to `Completed`

Under `run.unattended: true`, the rows "User confirmed all provisioning steps" and "User confirmed GitHub repository secrets" read instead:

- [ ] Every service was filled by an authorized provider's tooling, a recorded local substitute, a recorded omission (optional), or a recorded deferral, each with its ticket line
- [ ] No command output, log line, ticket line or report shows a secret value
- [ ] Referenced GitHub secrets were set through a pipe from provider tooling, or recorded as having no provider path
- [ ] `env-inventory.js verify` returned `status: pass` with every remaining gap listed under `excused_keys`

## Hard Constraints

- **Never read, log, or display actual secret values.** `env-inventory.js` only checks existence and placeholder shape and prints key names only. This skill must not work around that constraint (never `cat` a `.env.local`, never echo a value).
- **The agent never writes a value into `.env.local` itself.** On the interactive path population is the user's manual action. Under `run.unattended: true`, provider tooling writes the values through `scripts/merge-env.js`, which fills only missing, placeholder or still-example keys and never replaces an operator-set value.
- **Under `run.unattended: true`, never return `needs_human`.** A required service with no provider becomes a local substitute or a deferral (`status: complete_with_deferrals`).
- **Never skip the verification loop.** Even if the user says "I've done everything", `env-inventory.js verify` must run before the stage is marked complete.
- **Sub-skill contract.** When invoked as a `type: env-setup` stage by `sell-slice`, this skill is the entire stage. After completion, mark the stage `Completed` in `docs/plans/00_master_checklist.md`.
- **The mechanical steps live in `./scripts/`.** This SKILL.md is workflow only: run the scripts, never re-implement their checks by hand.

## Sub-agent Return Contract

When this skill is invoked as a sub-skill by `sell-slice`, return:

```yaml
status: complete | complete_with_deferrals | failed | needs_human   # never needs_human under run.unattended
summary: <one paragraph describing what services were detected, which files were verified, and the final verification outcome>
deferred: []   # unattended only: [{service, keys: [<names>], slices: ["N.M"], reason}]
substitutes: []   # unattended only: [{service, substitute}]
artifacts: [docs/plans/00_master_checklist.md]
needs_human: false | true
hitl_category: null | "external_credentials"
hitl_question: null | "<which service the user cannot access and why>"
hitl_context: null | "<what triggered this - e.g., user reported no access to Stripe billing>"
```
