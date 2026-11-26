# Decision routing (unattended runs)

Under `/pizza-party` (`run.unattended: true`, `run.conductor: "pizza-party"`) the operator answers the interview once and may review at the very end. Every question a skill would ask mid-run is routed by this page. It is the single source: every skill that records into the order ticket points here (by its path, so a skill installed alone does not pull in /pizza-party) instead of restating it. Interactive runs never read it.

## The three classes

**Technical: decided by the team, never reviewed.** Libraries, frameworks, architecture, file layout, schema shape inside the run's own new database, test strategy, CI config, local substitutes for missing services, roadmap sizing and ordering, design-token values derived from the **Look** answer, fix approaches, which registry item to install. The conductor's rule table settles it (the recommended option, or the one most consistent with the brief and the **Answers**). No agent dispatch. One line under `## Decided by the team`.

**Business: your call, applied with a reversible default and reviewed at the end.** Anything that changes what the product does for its users or the business: a feature added, cut or deferred; how an **Acceptance** line is interpreted; who the users are, their roles and what each may see or do; pricing, plans, payments; what personal data is collected, kept or shared, and for how long; user-facing naming, copy tone or brand beyond the **Look** answer; a paid third-party service or one that holds user data; legal terms; anything that would reach real people (emails, notifications) or production data. The default is applied at once, the question joins the queue, and the decision ends up under `## Your call` with how to change it.

**Never decided (unchanged).** A destructive operation on anything shared the operator did not name is skipped and recorded under `## Deferred`. Credentials are never invented: a local substitute or a deferral, as before.

A business question the brief or the **Answers** already settle is no question: apply that answer and record it under `## Decided by the team`, citing the answer. When the class is unclear, queue it with `class_hint: unsure`; the stand-in classifies it.

## The reversible default rule (business)

Pick the option that is cheapest to undo and keeps the most later choices open. Anything that adds outside exposure ships off by default (behind a flag or a disabled setting). Nothing is sent to real people. Collect the least data that meets the brief.

## The stand-in operator

`bytheslice:stand-in-operator` (agent file [`../agents/stand-in-operator.md`](../agents/stand-in-operator.md)) answers a batch of open questions the way the operator would. It runs on Fable: pass `model: "fable"` explicitly on every dispatch. It is read-only, never asks the human, never writes a file, never approves a destructive operation on anything shared the operator did not name, and never invents or requests a credential.

**Dispatch it only when at least one holds** (token control):

1. The question is business and the brief and **Answers** do not already settle it.
2. A `/sell-pie` approval-batch item the **Answers** do not cover (a migration, a data load, a size exception) that would otherwise defer the slice.
3. A technical question where the asking agent gave no recommended option, or two options fit the brief equally.
4. A stuck-slice replan through `/special-order` would drop or change an Exit criterion or an **Acceptance** line.

Never for a technical call the rule table settles. Never once per question when a batch is possible.

**Only the conductor dispatches it**: `/pizza-party` at phase boundaries, and `/sell-pie` (running inside the same session) for a blocking approval. Every other skill only records.

### Batching

- **Non-blocking questions queue.** The asking skill applies the provisional default first (work never waits), then appends one line to `## Waiting on the stand-in`.
- **Phase boundary.** When the queue is non-empty at the end of a phase, the conductor dispatches the stand-in once with the whole queue, before the next phase consumes that phase's output, so an override is cheap (edit the PRD, a plan, the ticket or the config).
- **Pie boundary.** In Phase 6, once per pie boundary when the queue is non-empty.
- **Blocking questions** (a slice cannot proceed without the answer: triggers 2 and 4) dispatch at once and carry everything queued so far.

### The dispatch

Input: `ticket` (`docs/pizza-party/order.md`), `prd` (its path, when one exists), `phase`, and `questions[]`, each `{id, phase, class_hint: business|technical|unsure, category, question, context, options[], recommended|null, blocking, provisional|null}`. The queue line holds the id, phase, question and provisional default; the conductor adds the category, context and options from the asking skill's return or the artifact it wrote.

Output: `answers[]`, each `{id, class, decision, reversible, how_to_change, rationale, confidence, overrides_provisional, defer, defer_reason}`, plus `rank` (business answer ids, highest impact first) and up to 3 lines of `notes`.

Applying it, per answer:

- `class: technical`: one `## Decided by the team` line.
- `class: business`, `defer: false`: when `overrides_provisional` is true, apply the decision now (PRD, plan, ticket or config) before anything downstream reads the old one. One `## Your call` line ending ` · stand-in`.
- `defer: true` (only when no option is both safe and reversible): one `## Deferred` line with its `defer_reason`; a slice it blocks is deferred by the `/sell-pie` defer rule.
- Remove the item's queue line. Append one **Progress** line per dispatch: `- <phase> · stand-in <k> of <max> · <n> answered, <m> overridden, <d> deferred`.

### Budget

`run.standIn.maxDispatches` in `bytheslice.config.json` (default 8) caps dispatches for the whole run; the conductor counts its own `stand-in <k> of <max>` **Progress** lines, so the count survives a compaction. Past the cap, the conductor resolves every remaining question with the rule table plus the reversible default rule, ends each `## Your call` line with ` · no stand-in: budget spent`, and records one **Progress** line saying the budget is spent. `run.standIn.enabled: false` turns the stand-in off: every question resolves by the rule table and the reversible default at the boundary (business lines still go under `## Your call`).

## Ticket line formats

The order ticket ([order-ticket.md](order-ticket.md)) keeps one `- ` line per entry:

```markdown
## Your call

- <phase> · <decision> · default: <what was applied> · to change: <how> · <why, in a clause>[ · stand-in | · no stand-in: budget spent]

## Decided by the team

- <phase> · <what was decided> · <why, in a clause>

## Waiting on the stand-in

- <id> · <phase> · <question> · options: <a> | <b> | <c> · context: <one clause> · provisional: <default applied> · blocking: yes|no
```

- `<phase>` is the skill or conductor phase that met the question (`create-menu`, `cook-pizzas`, `sell-pie 3.2`).
- `<id>` is unique in the run: `<phase>-<n>`, for example `create-menu-2`.
- A queue line carries the options and the one-clause context the asking skill gave, so the conductor can brief the stand-in from the ticket alone after a compaction. Separate options with ` | `; write `options: none` when the asking skill gave none.
- `## Waiting on the stand-in` is empty at the end of every run.
- In Phase 9 the conductor orders `## Your call` highest impact first, by the stand-in's `rank` lists; a line no rank covers goes last.

## For a skill running under /pizza-party

Ask nothing. For each question:

- **Technical**: take the recommended option (or the one most consistent with the brief and the **Answers**) and record one line under `## Decided by the team`.
- **Business**: apply the reversible default, then queue one line under `## Waiting on the stand-in` with that default as `provisional`.
- **Never decided**: skip or defer and record it, as the skill already says.

A skill that also writes its own record (the stage file's `Assumption:` lines, `docs/design-system.md`'s "Decisions made without review", a `bts_note`) keeps writing it; the ticket line is in addition. Old tickets with `## Decisions made without you` still count as team decisions.
