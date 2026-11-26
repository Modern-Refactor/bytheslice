# Skill script contract

Every skill script in this plugin (`skills/*/scripts/*.js`) follows one contract, so a conductor reads each the same way. The scripts are deterministic, zero-dependency Node.

## Invocation

```
node "<this-skill-directory>/scripts/<name>.js" <command and flags> <root flag> <project-root>
```

- Run the script by its absolute path. Never `cd` into the skill folder first.
- Pass the project root with the script's root flag (table below). Every script accepts both `--root` and `--cwd`; `write-config.js` also takes `--project-root`.
- A relative path argument is project-relative: the script resolves it against the project root, wherever the shell happens to be.

## Output and exit codes

stdout is exactly one JSON object and nothing else (logs, when a script keeps them, go to files). stderr carries the reason for an exit 1.

| Exit | Meaning | What the conductor does |
|---|---|---|
| 0 | The script ran. A failed verdict is a result in the JSON, never an exit code: `verify` returns `status: fail`, `token-check.js` returns `gate: FAIL`, `run-gates.js` returns `overall: fail` with each gate's result. | Read the JSON and act on its verdict (fix loop, report, next phase). |
| 2 | `needs_human`: the script cannot go on without the operator. stdout is `{"needs_human": {"category", "question", "context"}}`, with any extra facts (`missing_scripts`, `missing_tooling`, `config_path`, `backup_path`, `report`) beside `needs_human`, never inside it. `category` is one of the four HITL categories. | Raise it with `bts_hitl` (`category`, `question`, `context` as given), ask the operator in chat as the skill's HITL flow says, and stop for the answer; then rerun with it. On an unattended run (`run.unattended: true`) never ask: route it per `skills/pizza-party/references/decision-routing.md` (a technical call is decided and recorded, a business one gets its reversible default and joins the stand-in queue, a destructive or credential one is skipped or deferred by the skill's own rule). |
| 1 | A real error: a bad argument (a usage error), an unreadable file, a crash. | Report the stderr line and stop. Never treat it as a gate failure or a HITL. |

No script uses any other exit code.

## The scripts

| Script | Skill | Root flag | Commands | Exits 2 when |
|---|---|---|---|---|
| `env-inventory.js` | `/open-the-shop` | `--root` | `scan`, `secrets`, `checklist`, `verify` | never (the operator-access HITL is the skill's own) |
| `merge-env.js` | `/open-the-shop` (unattended) | `--root` | fills `.env.local` from provider output | never |
| `token-check.js` | `/set-display-case` | `--root` | `bundle`, `complete` | the bundle or an input file is missing (`prd_ambiguity`) |
| `write-config.js` | `/setup-shop` | `--project-root` | writes the JSONC config | the config exists and neither `--merge` nor `--overwrite` was given (`destructive_operation`); an answer looks like a pasted credential (`external_credentials`) |
| `detect-ci.js` | `/setup-shop` | `--root` | detects the CI/CD markers | never |
| `run-gates.js` | `/final-quality-check` | `--cwd` | runs the local gates | no `package.json`, a missing package manager, or a missing required gate script |

The env scripts print key names and paths only, never a value, on stdout and stderr alike.
