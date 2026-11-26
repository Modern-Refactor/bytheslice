# The order ticket

`/pizza-party` writes `docs/pizza-party/order.md` at the end of the interview and keeps it current for the whole run. It is the run's memory: every later phase, every sub-skill running under `run.unattended: true`, and the conductor after a compaction read it instead of asking. Write it as plain Markdown with exactly these `##` sections, in this order. Where each decision goes, and the exact line formats, come from [decision-routing.md](decision-routing.md). `scripts/pizza-party.js record` counts the list items under **Your call**, **Decided by the team**, **Waiting on the stand-in** and **Deferred**, so keep each entry one `- ` line.

```markdown
# Order: <App name>

Started: <ISO time> · Plugin: <version> · Model: <model id> · Brief: <brief id>

## Brief

<the operator's brief, verbatim>

## Answers

- **App name / folder:** <name> at <absolute path>
- **Stack:** <framework, language, package manager>
- **Host:** <provider and why, or "none: localhost">
- **Database:** <provider and project/schema, or "local SQLite">
- **Auth:** <approach>
- **Look:** <brand words, colors, theme source>
- **UI registries:** <names, or "stock shadcn only">
- **GitHub:** <owner/repo, private>
- <one line per extra interview question: **<topic>:** <answer>>

## Acceptance

- [ ] <one line per success criterion in the brief, written so it can be checked against the running app>

## Your call

- <phase> · <decision> · default: <what was applied> · to change: <how> · <why, in a clause>[ · stand-in | · no stand-in: budget spent]

## Decided by the team

- <phase> · <what was decided> · <why, in a clause>

## Waiting on the stand-in

- <id> · <phase> · <question> · options: <a> | <b> | <c> · context: <one clause> · provisional: <default applied> · blocking: yes|no

## Deferred

- <slice or item> · <reason> · <what was tried>

## Progress

- <phase> · <status: done | running | deferred> · <one-line result, e.g. "PRD at docs/prd-<app>.md">
```

Rules:

- **Answers** come only from the operator (the brief or the interview). Anything the run decides goes under **Your call** (business, with the default applied and how to change it) or **Decided by the team** (technical), never into **Answers**.
- **Your call** is what the operator reviews at the end: each line names the default already applied and how to change it, ordered highest impact first at the end of the run.
- **Waiting on the stand-in** holds business questions whose provisional default is already applied, until the next stand-in dispatch answers them. It is empty when the run ends.
- **Acceptance** is derived from the brief's own success language at the end of the interview, before any building; the final smoke check ticks it.
- **Progress** gets one line per phase as it starts and finishes. After a compaction the conductor reads this section first.
- Never put a secret, token, key value or password anywhere in the ticket. Name the variable, never its value.
- **Old tickets still count.** A ticket written before 7.2.0 has `## Decisions made without you` in place of the three new sections; resume and `record` read its lines as team decisions. When a run resumes on one, leave that section as it is, add the three new sections after it, and write new lines there.
