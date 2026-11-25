#!/usr/bin/env bash
# hooks/shop-status.sh
# SessionStart hook. Injects a compact "shop status" header so Claude
# starts with master-checklist state in context; it replaces the repeated
# Phase 1 "read the checklist" step in several skills.
#
# The checklist is read from the folder the session runs in (the hook
# input's `cwd`), then the default branch, then the primary checkout, and the
# banner names the source (hooks/lib/checklist.sh bts_checklist_locate). With
# Node, the counts come from mcp/checklist-format.js, the same parse the
# kitchen and the Pass use, and its format check appends any lines those
# parsers cannot read. It only warns.
#
# Exit 0; stdout becomes additional session context. With BTS_HOST=cursor it
# runs as Cursor's sessionStart hook and prints the same header as
# {"additional_context": "..."} ({} when there is nothing to say).

set -u

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib/checklist.sh
. "$SELF_DIR/lib/checklist.sh"

if [ "${BTS_HOST:-}" = "cursor" ]; then
  # Cursor names the folder as workspace_roots[0]; hand it on as the cwd the
  # Claude Code path reads, so a Cursor session also prefers its own worktree.
  CINPUT=""
  [ -t 0 ] || CINPUT=$(cat 2>/dev/null)
  ROOT=$(printf '%s' "$CINPUT" | tr -d '\n' | sed -n 's/.*"workspace_roots"[[:space:]]*:[[:space:]]*\[[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  STATUS=$(printf '{"cwd":"%s"}' "$ROOT" | BTS_HOST= bash "$SELF_DIR/shop-status.sh" 2>/dev/null)
  if [ -n "$STATUS" ]; then printf '{"additional_context":"%s"}\n' "$(json_str "$STATUS")"; else printf '{}\n'; fi
  exit 0
fi

[ "${BTS_HOOKS_DISABLED:-0}" = "1" ] && exit 0

INPUT=""
[ -t 0 ] || INPUT=$(cat 2>/dev/null)
HOOK_CWD=$(printf '%s' "$INPUT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)

LOCATED=$(bts_checklist_locate "$HOOK_CWD")
CHECKLIST=$(printf '%s\n' "$LOCATED" | sed -n 1p)
SOURCE=$(printf '%s\n' "$LOCATED" | sed -n 2p)
[ -z "$CHECKLIST" ] && exit 0  # Not a ByTheSlice project; nothing to inject.
export BTS_CHECKLIST="$CHECKLIST"
FORMAT_JS="$SELF_DIR/../mcp/checklist-format.js"
HAVE_NODE=0
command -v node >/dev/null 2>&1 && [ -f "$FORMAT_JS" ] && HAVE_NODE=1

# POSIX awk only in this script: BSD awk (macOS) has no gawk extensions,
# notably no 3-argument match(), so row names are carved out with sub().

LAYOUT=$(bts_checklist_layout)

PREP=$(bts_prep_counts || true)
PREP_LINE=""
if [ -n "$PREP" ]; then
  read -r PDONE PTOTAL <<<"$PREP"
  PREP_LINE=$(printf 'Prep: %d/%d boxes checked' "$PDONE" "$PTOTAL")
fi

printf '[bytheslice shop status]\n'
printf '  checklist: %s (%s)\n' "$BTS_CHECKLIST_REL" "${SOURCE:-this checkout}"
[ -n "$PREP_LINE" ] && printf '  %s\n' "$PREP_LINE"

if [ "$LAYOUT" = "pie" ]; then
  # Nested v5 checklist: the shared parse when Node is here (Prep counts as
  # Pie 1 and its slices count), else the awk fallback in the lib helpers.
  COUNTS=""
  [ "$HAVE_NODE" = 1 ] && COUNTS=$(node "$FORMAT_JS" counts "$CHECKLIST" 2>/dev/null)
  if [ -n "$COUNTS" ]; then
    read -r _ PIES_DONE PIES_TOTAL <<<"$(printf '%s\n' "$COUNTS" | sed -n 1p)"
    read -r _ SLICES_DONE SLICES_TOTAL <<<"$(printf '%s\n' "$COUNTS" | sed -n 2p)"
    NODE_NEXT=$(printf '%s\n' "$COUNTS" | sed -n 's/^next //p')
  else
    read -r PIES_DONE PIES_TOTAL <<<"$(bts_unit_counts || true)"
    read -r SLICES_DONE SLICES_TOTAL <<<"$(bts_slice_counts || true)"
  fi
  printf '  pies: %d total, %d completed / %d open\n' \
    "${PIES_TOTAL:-0}" "${PIES_DONE:-0}" "$(( ${PIES_TOTAL:-0} - ${PIES_DONE:-0} ))"
  if [ -n "${SLICES_TOTAL:-}" ] && [ "${SLICES_TOTAL:-0}" -gt 0 ]; then
    printf '  slices: %d total, %d completed / %d open\n' \
      "$SLICES_TOTAL" "${SLICES_DONE:-0}" "$(( SLICES_TOTAL - ${SLICES_DONE:-0} ))"
  fi
  # First `## Pie N` heading with no done marker ([x], strikethrough, or
  # Status: Completed/Done on the heading line), review annotation stripped.
  if [ -n "$COUNTS" ]; then NEXT_PIE=$NODE_NEXT; else NEXT_PIE=$(awk '
    /^## +Pie[[:space:]]+[0-9]/ {
      if ($0 ~ /\[[xX]\]/ || $0 ~ /~~/ || $0 ~ /[Ss]tatus:[[:space:]]*(Completed|Done)/) next
      line = $0
      sub(/^##[[:space:]]+/, "", line)
      sub(/[[:space:]]*<!--.*$/, "", line)
      sub(/[[:space:]]+$/, "", line)
      print line
      exit
    }
  ' "$CHECKLIST" 2>/dev/null); fi
  [ -n "$NEXT_PIE" ] && printf '  next open pie: %s\n' "$NEXT_PIE"
else
  # Flat v4 fallback: count markdown table rows mentioning "Status:".
  COUNTS=$(awk '
    BEGIN { not_started = 0; in_progress = 0; completed = 0 }
    /Status:[[:space:]]*Not Started/  { not_started++ }
    /Status:[[:space:]]*In Progress/  { in_progress++ }
    /Status:[[:space:]]*Completed/    { completed++ }
    END {
      total = not_started + in_progress + completed
      printf "%d %d %d %d", completed, in_progress, not_started, total
    }
  ' "$CHECKLIST" 2>/dev/null)
  read -r DONE INPROG NOT_STARTED TOTAL <<<"$COUNTS"
  # First not-started row, minus the leading pipe and the trailing Status cell.
  NEXT_ROW=$(awk '
    /Status:[[:space:]]*Not Started/ {
      line = $0
      sub(/^[[:space:]]*\|[[:space:]]*/, "", line)
      sub(/[[:space:]]*\|[[:space:]]*Status:.*$/, "", line)
      print line
      exit
    }
  ' "$CHECKLIST" 2>/dev/null)
  printf '  stages: %d total, %d completed / %d in-progress / %d not started\n' \
    "${TOTAL:-0}" "${DONE:-0}" "${INPROG:-0}" "${NOT_STARTED:-0}"
  [ -n "$NEXT_ROW" ] && printf '  next not-started: %s\n' "$NEXT_ROW"
fi

# Format check: lines the status parsers cannot read, with line numbers and
# the repair route. Context only; nothing waits on it.
if [ "$HAVE_NODE" = 1 ]; then
  node "$FORMAT_JS" check "$CHECKLIST" --label "$BTS_CHECKLIST_REL" 2>/dev/null
fi

# Retired agent names: a chat resumed from before the roster change, or a
# ledger or kitchen log written then, names agents that now run as another
# agent and mode. One pointer line at most, from a tail and a grep (no parse):
# only the last LEGACY_TAIL rows of each log are read, so a ledger written on
# 6.x stops printing the line once new rows push the old names out. The list
# is every LEGACY_AGENT_ALIASES name no longer registered (mod/policy.ts);
# tests/pass/legacy-aliases.test.js holds the two equal.
LEGACY_NAMES='spec-reviewer|quality-reviewer|break-ui-runner|design-critic|discovery|checklist-curator|complexity-assessor|stage-decomposer|db-schema-stage-writer|modern-ux-expert|layout-architect|block-composer|component-crafter|bootstrap-runner|proposal-drafter|consistency-checker'
LEGACY_LOGS=()
for base in "$HOOK_CWD" "$(bts_root)"; do
  [ -n "$base" ] && [ -d "$base" ] || continue
  for rel in .bytheslice/ledger.jsonl .claude/.bytheslice-state/kitchen/activity.jsonl .claude/.bytheslice-state/kitchen/activity.1.jsonl; do
    [ -f "$base/$rel" ] && LEGACY_LOGS+=("$base/$rel")
  done
done
LEGACY_TAIL=500
if [ "${#LEGACY_LOGS[@]}" -gt 0 ]; then
  LEGACY_FOUND=$(for log in "${LEGACY_LOGS[@]}"; do tail -n "$LEGACY_TAIL" "$log" 2>/dev/null; done \
    | grep -oE "\"agent\"[[:space:]]*:[[:space:]]*\"([A-Za-z0-9_-]+:)?($LEGACY_NAMES)\"" 2>/dev/null \
    | sed -E 's/.*[":]([a-z-]+)"$/\1/' | sort -u | tr '\n' ' ' | sed 's/ $//; s/ /, /g')
  if [ -n "$LEGACY_FOUND" ]; then
    printf '  legacy agent names in the ledger or kitchen log (%s): they now run as other agents and modes; read old names through %s\n' \
      "$LEGACY_FOUND" "$(cd "$SELF_DIR/.." && pwd)/skills/sell-slice/references/legacy-agent-names.md"
  fi
fi

exit 0
