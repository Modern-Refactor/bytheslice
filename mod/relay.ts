// mod/relay.ts
// Runs the two silent logging scripts (hooks/kitchen-log.sh for the kitchen activity feed, hooks/lobby-signal.sh for the Lobby) from the Pass instead of hooks.json: each classic event's envelope goes to the script on stdin, exactly as a settings hook would send it. A Bash call reaches the kitchen log only when it runs the /final-quality-check gates script (run-gates.js), so the kitchen can show that phase as verifying. Cursor, which has no mods, still runs the scripts as hooks.

import type { EngineInterface } from 'claude-code'

/** The scripts, relative to the plugin root. */
export const KITCHEN_LOG = 'hooks/kitchen-log.sh'
export const LOBBY_SIGNAL = 'hooks/lobby-signal.sh'

/** A Bash command that runs the /final-quality-check local gates with node (skills/final-quality-check/scripts/run-gates.js); hooks/kitchen-log.sh holds the same pattern. */
export const GATES_COMMAND = /\bnode(?:\.exe)?\s+(?:[^|;&\n]*?[\s/"'])?run-gates\.js(?:[\s"';|&)]|$)/

/** True for a Bash envelope whose command runs the local gates script. */
export function runsGates(envelope: { tool_name?: unknown; tool_input?: unknown }): boolean {
  if (envelope.tool_name !== 'Bash') return false
  const input = envelope.tool_input
  const command = input !== null && typeof input === 'object' ? (input as { command?: unknown }).command : undefined
  return typeof command === 'string' && GATES_COMMAND.test(command)
}

/** Which script runs on which event; `tools` narrows a tool event to those tool names, `gates` adds the gates Bash call. */
export const RELAYS: readonly { event: string; scripts: readonly string[]; tools?: readonly string[]; gates?: boolean }[] = [
  { event: 'SessionStart', scripts: [KITCHEN_LOG, LOBBY_SIGNAL] },
  { event: 'UserPromptSubmit', scripts: [LOBBY_SIGNAL] },
  { event: 'UserPromptExpansion', scripts: [KITCHEN_LOG] },
  { event: 'SubagentStart', scripts: [KITCHEN_LOG, LOBBY_SIGNAL] },
  { event: 'SubagentStop', scripts: [KITCHEN_LOG, LOBBY_SIGNAL] },
  { event: 'PreToolUse', scripts: [KITCHEN_LOG], tools: ['Agent', 'Skill'], gates: true },
  { event: 'PostToolUse', scripts: [KITCHEN_LOG], tools: ['Agent'], gates: true },
  { event: 'Stop', scripts: [KITCHEN_LOG, LOBBY_SIGNAL] },
  { event: 'Notification', scripts: [LOBBY_SIGNAL] },
]

/** The scripts an envelope goes to: none when a tool event names another tool (the gates Bash call excepted). */
export function scriptsFor(event: string, envelope: { tool_name?: unknown; tool_input?: unknown }): readonly string[] {
  const relay = RELAYS.find(r => r.event === event)
  if (!relay) return []
  if (relay.tools && !relay.tools.includes(String(envelope.tool_name ?? '')) && !(relay.gates && runsGates(envelope))) return []
  return relay.scripts
}

/** Hands the envelope to each script in turn; a script that fails or cannot start is skipped. */
export async function relay($: EngineInterface, event: string, envelope: Record<string, unknown>): Promise<number> {
  const scripts = scriptsFor(event, envelope)
  if (scripts.length === 0) return 0
  const root = $.plugin.root.replace(/\/$/, '')
  const cwd = typeof envelope.cwd === 'string' && envelope.cwd !== '' ? envelope.cwd : undefined
  const stdin = JSON.stringify({ hook_event_name: event, ...envelope })
  let ran = 0
  for (const script of scripts) {
    try {
      await $.process.run(['bash', `${root}/${script}`], { ...(cwd ? { cwd } : {}), stdin, timeoutMs: 5000 })
      ran += 1
    } catch {
      // Logging never stands in the way of the session.
    }
  }
  return ran
}
