// mod/policy.ts
// The Pass check, spawn and watchdog policy: role defaults mirroring each agent's model frontmatter, the watchdog thresholds, the bytheslice.config.json reader and override notes.

import type { EngineInterface } from 'claude-code'

import { stripJsonc } from './jsonc.ts'
import { appendRow, readRows } from './ledger.ts'
import type { PassPolicy, PassRequireTester, PassWatchdog } from './types'

// No runtime import from 'claude-code' here: tests/pass/policy-parity.test.js
// loads this file in plain Node to hold DEFAULT_ROLES to the agent frontmatter.

export const CONFIG_PATH = 'bytheslice.config.json'
export const PROMPT_MAX = 20000

/**
 * Every agent .claude-plugin/plugin.json registers, by role, with the tier its
 * `model:` frontmatter names, one tier each, so the defaults never warn on a
 * spawn that runs as defined (deprecated v4 agents are not registered).
 * tests/pass/policy-parity.test.js fails when a default and its agent disagree.
 */
export const DEFAULT_ROLES: Readonly<Record<string, readonly string[]>> = {
  'a11y-discovery-runner': ['sonnet'],
  'branch-protection-writer': ['haiku'],
  'brief-analyzer': ['sonnet'],
  'bundle-validator': ['sonnet'],
  'checklist-generator': ['haiku'],
  'ci-cd-detector': ['haiku'],
  'ci-fix-attempter': ['sonnet'],
  'code-explorer': ['opus'],
  'code-reviewer': ['opus'],
  'compliance-pre-check': ['sonnet'],
  'config-generator': ['haiku'],
  'debug-instrumenter': ['sonnet'],
  'e2e-installer': ['sonnet'],
  'env-scanner': ['haiku'],
  'env-verifier': ['haiku'],
  'fix-attempter': ['sonnet'],
  'framework-detector': ['haiku'],
  'github-secrets-scanner': ['haiku'],
  'husky-installer': ['haiku'],
  implementer: ['opus'],
  'library-entry-writer': ['sonnet'],
  'library-route-scaffolder': ['sonnet'],
  'lint-config-writer': ['haiku'],
  'local-gates-runner': ['sonnet'],
  'master-checklist-synthesizer': ['opus'],
  'phased-plan-writer': ['opus'],
  'platform-walker': ['sonnet'],
  'prd-reviewer': ['sonnet'],
  'retrospective-reviewer': ['opus'],
  'rules-assembler': ['sonnet'],
  'rules-loader': ['haiku'],
  'scaffold-discovery': ['opus'],
  'slice-tester': ['sonnet'],
  'slice-verifier': ['sonnet'],
  'stage-planner': ['opus'],
  'state-illustrator': ['sonnet'],
  'token-expander': ['opus'],
  'ui-builder': ['sonnet'],
  'ui-fix-attempter': ['opus'],
  'ui-reviewer': ['sonnet'],
  'ux-layout-designer': ['sonnet'],
  'workflow-writer': ['sonnet'],
}

/**
 * Where a retired agent name went: the agent (and mode) that now does its
 * work, or the script that replaced it (`agent: null`), or nothing at all
 * (`agent: null` and no script) for an agent that was deleted outright.
 */
export type LegacyAgentAlias = { agent: string | null; mode?: string; script?: string }

/**
 * Every retired agent name, old name first. Ledger rows, activity rows,
 * spawns and config keys written before a rename keep working because every
 * name lookup goes through canonicalRole. A name still in DEFAULT_ROLES is
 * still registered and resolves to itself (the PR 2 entries below wait for
 * their agents to leave the roster), and an entry with `agent: null` has no
 * role to resolve to, so its old name is kept as it was written.
 */
export const LEGACY_AGENT_ALIASES: Readonly<Record<string, LegacyAgentAlias>> = {
  // 7.0 merges and deletions.
  'spec-reviewer': { agent: 'code-reviewer' },
  'quality-reviewer': { agent: 'code-reviewer' },
  'break-ui-runner': { agent: 'ui-reviewer', mode: 'break' },
  'design-critic': { agent: 'ui-reviewer', mode: 'critique' },
  discovery: { agent: 'code-explorer', mode: 'stage-recon' },
  'checklist-curator': { agent: 'code-explorer', mode: 'slice-scope' },
  'complexity-assessor': { agent: 'stage-planner', mode: 'extend' },
  'stage-decomposer': { agent: 'stage-planner', mode: 'full' },
  'db-schema-stage-writer': { agent: 'phased-plan-writer', mode: 'db-schema' },
  'modern-ux-expert': { agent: 'ux-layout-designer' },
  'layout-architect': { agent: 'ux-layout-designer' },
  'block-composer': { agent: 'ui-builder' },
  'component-crafter': { agent: 'ui-builder' },
  'bootstrap-runner': { agent: null },
  'proposal-drafter': { agent: null },
  'consistency-checker': { agent: null },
  // The scripts and scaffold merges that follow (still registered until then).
  'env-scanner': { agent: null, script: 'scripts/env-inventory.js' },
  'github-secrets-scanner': { agent: null, script: 'scripts/env-inventory.js' },
  'checklist-generator': { agent: null, script: 'scripts/env-inventory.js' },
  'env-verifier': { agent: null, script: 'scripts/env-inventory.js' },
  'bundle-validator': { agent: null, script: 'scripts/token-check.js' },
  'compliance-pre-check': { agent: null, script: 'scripts/token-check.js' },
  'config-generator': { agent: null, script: 'scripts/write-config.js' },
  'local-gates-runner': { agent: null, script: 'scripts/run-gates.js' },
  'ci-cd-detector': { agent: null, script: 'scripts/detect-ci.js' },
  'e2e-installer': { agent: 'scaffold-writer', mode: 'e2e' },
  'workflow-writer': { agent: 'scaffold-writer', mode: 'workflows' },
  'husky-installer': { agent: 'scaffold-writer', mode: 'husky' },
  'lint-config-writer': { agent: 'scaffold-writer', mode: 'lint' },
  'branch-protection-writer': { agent: 'scaffold-writer', mode: 'branch-protection' },
  'framework-detector': { agent: 'scaffold-discovery' },
}

/**
 * The role an agent name is judged and counted by: any `plugin:` prefix
 * dropped (`bytheslice:spec-reviewer` reads `spec-reviewer`), then a retired
 * name resolved to the agent that replaced it (`code-reviewer`). A registered
 * name, an unknown name and a name with no replacing agent stay as they are.
 */
export function canonicalRole(name: unknown): string {
  if (typeof name !== 'string') return ''
  const trimmed = name.trim()
  const bare = trimmed.slice(trimmed.lastIndexOf(':') + 1)
  if (bare in DEFAULT_ROLES) return bare
  return LEGACY_AGENT_ALIASES[bare]?.agent ?? bare
}

/** The retired names that resolve to a role (its own name excluded), in table order. */
export function legacyNamesOf(role: string): string[] {
  return Object.keys(LEGACY_AGENT_ALIASES).filter(name => name !== role && canonicalRole(name) === role)
}

/**
 * The role a teammate's model is judged by: not an agent file, so it sits
 * beside DEFAULT_ROLES rather than in it. A teammate bakes a whole pie, so it
 * may run on opus or sonnet; `pass.spawnPolicy.roles.teammate` overrides it.
 */
export const TEAMMATE_ROLE = 'teammate'
export const DEFAULT_TEAMMATE_TIERS: readonly string[] = ['opus', 'sonnet']

/** The verify-once gates and reviewers, which stay one-shot subagents: started as a teammate, each is `gate-teamified`. */
export const GATE_ROLES: ReadonlySet<string> = new Set(['implementer', 'slice-tester', 'slice-verifier', 'code-reviewer'])

/** Strings that mark builder context in a reviewer's prompt (verify-once keeps it out). */
export const DEFAULT_MARKERS: readonly string[] = ['files_changed', 'diff --git', 'implementer returned', 'builder transcript']

/** The roles whose prompt must carry the manifest, the Exit criteria and the design-system path only. */
export const CONTEXT_ROLES: ReadonlySet<string> = new Set(['slice-tester', 'slice-verifier', 'code-reviewer'])

/**
 * Markers a role's own documented inputs carry, so they are no builder context
 * for it: slice-verifier gets the slice diff and, on a re-verification pass,
 * the fix's `files_changed` (/sell-slice 5.4); code-reviewer (which replaced
 * spec-reviewer and quality-reviewer) reviews the implementer's output and
 * the diff by design. These sets are keyed by canonicalRole, so a spawn under
 * a retired reviewer name is judged as code-reviewer.
 * The slice-tester gets none of these, so every marker counts for it.
 */
export const EXPECTED_MARKERS: Readonly<Record<string, readonly string[]>> = {
  'slice-verifier': ['files_changed', 'diff --git'],
  'code-reviewer': ['files_changed', 'diff --git', 'implementer returned'],
}

const TESTER_MODES: readonly PassRequireTester[] = ['ui-slices', 'always', 'never']

/**
 * The watchdog's defaults: three minutes with no tool activity counts as idle
 * once a role has run past its budget (fifteen minutes, ten for code-explorer,
 * which does the stage recon and the slice scope in one dispatch, thirty for
 * the implementer). `bytheslice.config.json` key `pass.watchdog` overrides; a
 * budget set under a retired name (`discovery`) applies to its new role.
 */
export const DEFAULT_WATCHDOG: PassWatchdog = {
  enabled: true,
  idleMs: 180000,
  budgetsMs: { default: 900000, 'code-explorer': 600000, implementer: 1800000 },
}

const copyWatchdog = (w: PassWatchdog): PassWatchdog => ({ enabled: w.enabled, idleMs: w.idleMs, budgetsMs: { ...w.budgetsMs } })

export const DEFAULT_POLICY: PassPolicy = {
  enabled: true,
  requireTester: 'ui-slices',
  roles: {
    ...Object.fromEntries(Object.entries(DEFAULT_ROLES).map(([role, tiers]) => [role, [...tiers]])),
    [TEAMMATE_ROLE]: [...DEFAULT_TEAMMATE_TIERS],
  },
  contextMarkers: [...DEFAULT_MARKERS],
  watchdog: copyWatchdog(DEFAULT_WATCHDOG),
}

/**
 * How long a role may run before idling counts as a stall: its own budget,
 * else the longer of one kept under a retired name of it (a watchdog built by
 * hand) and the role's shipped default, else `default`. A retired name never
 * shortens the new role's budget.
 */
export function budgetMs(role: string, watchdog: PassWatchdog): number {
  const name = canonicalRole(role)
  const fallback = watchdog.budgetsMs.default ?? DEFAULT_WATCHDOG.budgetsMs.default ?? 900000
  const own = watchdog.budgetsMs[name]
  if (own !== undefined) return own
  const legacy = legacyNamesOf(name).map(old => watchdog.budgetsMs[old]).filter(isSpan)
  if (legacy.length === 0) return fallback
  return Math.max(...legacy, DEFAULT_WATCHDOG.budgetsMs[name] ?? fallback)
}

/**
 * One setting a project's config moved off its default, as the ledger's
 * `policy-override` note records it. `legacy` lists the retired agent names
 * the config set it under (`qualityReviewer`, `discovery`), when it did.
 * `ignored` is true when the setting was read under retired names only and
 * left the role as it was: a retired name may only raise a role's tier (or
 * lengthen its watchdog budget), so `value` is what the config asked for and
 * the role kept `default`.
 */
export type PolicyOverride = { setting: string; value: unknown; default: unknown; legacy?: string[]; ignored?: true }

/** What reading the config gave: the policy, what it overrode, and why it fell back to defaults, if it did. */
export type PolicyRead = { policy: PassPolicy; overrides: PolicyOverride[]; problem: string | null }

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const strings = (value: unknown): string[] | null => {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()]
  if (!Array.isArray(value)) return null
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const isSpan = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/**
 * The role a config key names: `bytheslice:` dropped and a retired name
 * resolved (`discovery` reads `code-explorer`); another plugin's agent type
 * (`other:x`) stays whole. `legacy` is true when the key used a retired name.
 */
function configRole(key: string): { role: string; legacy: boolean } {
  const bare = key.replace(/^bytheslice:/, '').trim()
  if (bare === '' || bare.includes(':')) return { role: bare, legacy: false }
  const role = canonicalRole(bare)
  return { role, legacy: role !== bare }
}

/** Config entries for one role: the one under its own name, if any, and those under retired names of it. */
type ByRole<V> = { own: V | undefined; legacy: { key: string; value: V }[] }

/** Groups config entries by the role each key names, in first-seen order. */
function byRole<V>(entries: ReadonlyArray<[string, V]>, nameOf: (key: string) => string): Map<string, ByRole<V>> {
  const out = new Map<string, ByRole<V>>()
  for (const [key, value] of entries) {
    const { role, legacy } = configRole(nameOf(key))
    if (role === '') continue
    const entry = out.get(role) ?? { own: undefined, legacy: [] }
    if (legacy) entry.legacy.push({ key, value })
    else entry.own = value
    out.set(role, entry)
  }
  return out
}

/**
 * One value per role: the key under the role's own name always wins; else the
 * retired names are folded with `pick` (two retired names on one role give one
 * value and one override note). `legacy` names the retired keys that were read.
 */
function resolveByRole<V>(group: ByRole<V>, pick: (values: V[]) => V): { value: V; legacy?: string[] } | null {
  const legacy = group.legacy.length === 0 ? {} : { legacy: group.legacy.map(item => item.key) }
  if (group.own !== undefined) return { value: group.own, ...legacy }
  if (group.legacy.length === 0) return null
  return { value: pick(group.legacy.map(item => item.value)), ...legacy }
}

/** Folds `pass.watchdog` over the watchdog's defaults: `enabled`, `idleMs`, and each role of `budgetsMs`. */
function watchdogOver(policy: PassPolicy, raw: unknown, overrides: PolicyOverride[]): void {
  if (!isObject(raw)) return
  const dog = policy.watchdog
  if (typeof raw.enabled === 'boolean' && raw.enabled !== dog.enabled) {
    overrides.push({ setting: 'watchdog.enabled', value: raw.enabled, default: dog.enabled })
    dog.enabled = raw.enabled
  }
  if (isSpan(raw.idleMs) && raw.idleMs !== dog.idleMs) {
    overrides.push({ setting: 'watchdog.idleMs', value: raw.idleMs, default: dog.idleMs })
    dog.idleMs = raw.idleMs
  }
  const budgets = isObject(raw.budgetsMs) ? raw.budgetsMs : {}
  const spans = Object.entries(budgets).filter((entry): entry is [string, number] => isSpan(entry[1]))
  // A budget under a retired name (`discovery`) applies to its new role, the
  // longest of several, and only when it is longer than the role's default
  // budget (a shorter one is ignored, with a note); a new-name key wins outright.
  for (const [role, group] of byRole(spans, key => key)) {
    const picked = resolveByRole(group, values => Math.max(...values))
    if (picked === null) continue
    const before = dog.budgetsMs[role] ?? dog.budgetsMs.default ?? null
    if (group.own === undefined && before !== null && picked.value <= before) {
      if (picked.value < before) overrides.push({ setting: `watchdog.budgetsMs.${role}`, value: picked.value, default: before, ...legacyOf(picked), ignored: true })
      continue
    }
    if (dog.budgetsMs[role] === picked.value) continue
    overrides.push({ setting: `watchdog.budgetsMs.${role}`, value: picked.value, default: dog.budgetsMs[role] ?? null, ...legacyOf(picked) })
    dog.budgetsMs[role] = picked.value
  }
}

const legacyOf = (picked: { legacy?: string[] }): { legacy?: string[] } => (picked.legacy === undefined ? {} : { legacy: picked.legacy })

const TIERS = ['haiku', 'sonnet', 'opus']

/** The highest of several tiers (opus over sonnet over haiku). */
const highestTier = (tiers: string[]): string => tiers.reduce((best, tier) => (TIERS.indexOf(tier) > TIERS.indexOf(best) ? tier : best))

/** Several tier lists for one role as one: every tier any of them allows; an empty list (no model check) wins. */
const unionTiers = (lists: string[][]): string[] => (lists.some(list => list.length === 0) ? [] : [...new Set(lists.flat())])

/** The rank of a role's highest allowed tier (-1 for none, and for an empty list, which checks no model). */
const topRank = (tiers: readonly string[]): number => Math.max(-1, ...tiers.map(tier => TIERS.indexOf(tier)))

/**
 * What tiers read under retired names only may make of a role's tiers: they
 * may raise it, never lower it. `null` when nothing in them ranks above the
 * role's highest tier today (or the list is empty, which policyFrom honors
 * before asking, or the role checks no model already); else the role's tiers
 * plus each higher one.
 */
function raisedTiers(before: readonly string[] | null, asked: readonly string[]): string[] | null {
  if (before === null || before.length === 0 || asked.length === 0) return null
  const top = topRank(before)
  const higher = asked.filter(tier => TIERS.indexOf(tier) > top)
  return higher.length === 0 ? null : [...new Set([...before, ...higher])]
}

/**
 * The policy from a parsed config over the defaults. Top-level `modelTiers`
 * (camelCase agent names, the tier conductors dispatch with) replaces a role's
 * default first; then a `pass.spawnPolicy.roles` list replaces it (an empty
 * list stops checking its model); `contextMarkers` replaces the default list.
 * A key under a retired agent name (`qualityReviewer`, `discovery`) reaches
 * the agent that replaced it but may only RAISE that agent's tier, never lower
 * it (`specReviewer: "sonnet"` alone leaves code-reviewer on opus); a retired
 * key that would not raise it is ignored and listed with `ignored: true`. The
 * one exception is an EMPTY `spawnPolicy.roles` list under a retired name
 * (`"quality-reviewer": []`), a deliberate 6.x opt-out: it turns the model
 * check off for the agent that replaced it, as a new-name empty list does. A
 * key under the new name sets any tier and always wins, and two retired keys
 * on one role give the higher tier (`modelTiers`) or every tier either allows
 * (`spawnPolicy.roles`) before the raise-only rule applies. Each change is
 * listed once.
 */
export function policyFrom(config: unknown): { policy: PassPolicy; overrides: PolicyOverride[] } {
  const policy: PassPolicy = {
    enabled: DEFAULT_POLICY.enabled,
    requireTester: DEFAULT_POLICY.requireTester,
    roles: Object.fromEntries(Object.entries(DEFAULT_POLICY.roles).map(([role, tiers]) => [role, [...tiers]])),
    contextMarkers: [...DEFAULT_POLICY.contextMarkers],
    watchdog: copyWatchdog(DEFAULT_POLICY.watchdog),
  }
  const overrides: PolicyOverride[] = []
  const tiers = isObject(config) && isObject(config.modelTiers) ? config.modelTiers : {}
  const valid = Object.entries(tiers).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && TIERS.includes(entry[1]))
  const camel = (key: string): string => key.replace(/^bytheslice:/, '').replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)
  for (const [role, group] of byRole(valid, camel)) {
    const picked = resolveByRole(group, highestTier)
    if (picked === null || !(role in policy.roles)) continue
    const before = policy.roles[role] ?? null
    if (group.own === undefined && raisedTiers(before, [picked.value]) === null) {
      if (!same(before, [picked.value])) overrides.push({ setting: `roles.${role}`, value: [picked.value], default: before, ...legacyOf(picked), ignored: true })
      continue
    }
    if (same(before, [picked.value])) continue
    overrides.push({ setting: `roles.${role}`, value: [picked.value], default: before, ...legacyOf(picked) })
    policy.roles[role] = [picked.value]
  }
  const pass = isObject(config) ? config.pass : undefined
  if (!isObject(pass)) return { policy, overrides }
  const checks = isObject(pass.checks) ? pass.checks : {}
  if (typeof checks.enabled === 'boolean' && checks.enabled !== policy.enabled) {
    overrides.push({ setting: 'checks.enabled', value: checks.enabled, default: policy.enabled })
    policy.enabled = checks.enabled
  }
  const tester = checks.requireTester
  if (typeof tester === 'string' && (TESTER_MODES as readonly string[]).includes(tester) && tester !== policy.requireTester) {
    overrides.push({ setting: 'checks.requireTester', value: tester, default: policy.requireTester })
    policy.requireTester = tester as PassRequireTester
  }
  const spawn = isObject(pass.spawnPolicy) ? pass.spawnPolicy : {}
  const roles = isObject(spawn.roles) ? spawn.roles : {}
  const lists = Object.entries(roles)
    .map(([key, value]): [string, string[] | null] => [key, strings(value)])
    .filter((entry): entry is [string, string[]] => entry[1] !== null)
  for (const [role, group] of byRole(lists, key => key)) {
    const picked = resolveByRole(group, unionTiers)
    if (picked === null) continue
    const before = policy.roles[role] ?? null
    let value = picked.value
    // An empty list under a retired name was a deliberate 6.x opt-out of the
    // model check, so it is honored as is; a non-empty one may only raise.
    if (group.own === undefined && picked.value.length > 0) {
      const raised = raisedTiers(before, picked.value)
      if (raised === null) {
        if (!same(before, picked.value)) overrides.push({ setting: `roles.${role}`, value: picked.value, default: before, ...legacyOf(picked), ignored: true })
        continue
      }
      value = raised
    }
    if (same(before, value)) continue
    overrides.push({ setting: `roles.${role}`, value, default: before, ...legacyOf(picked) })
    policy.roles[role] = value
  }
  const markers = strings(spawn.contextMarkers)
  if (markers !== null && !same(markers, policy.contextMarkers)) {
    overrides.push({ setting: 'contextMarkers', value: markers, default: policy.contextMarkers })
    policy.contextMarkers = markers
  }
  watchdogOver(policy, pass.watchdog, overrides)
  return { policy, overrides }
}

/** Reads config text (JSONC); missing gives the defaults, malformed gives the defaults and says why. */
export function readPolicy(text: string | null): PolicyRead {
  if (text === null) return { ...policyFrom(undefined), problem: null }
  try {
    return { ...policyFrom(JSON.parse(stripJsonc(text)) as unknown), problem: null }
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] ?? 'unreadable' : 'unreadable'
    return { ...policyFrom(undefined), problem: reason }
  }
}

/** True when a model (an alias or an API id) names any of the allowed tiers, by case-insensitive substring. */
export function tierAllowed(model: string, allowed: readonly string[]): boolean {
  const name = model.toLowerCase()
  return allowed.some(tier => tier !== '' && name.includes(tier.toLowerCase()))
}

/**
 * Appends one `note` row per override the ledger does not already hold with
 * the same setting and value, so each override is recorded once. Resolves the
 * number written.
 */
export async function recordOverrides($: EngineInterface, overrides: readonly PolicyOverride[]): Promise<number> {
  if (overrides.length === 0) return 0
  const rows = await readRows($)
  let written = 0
  for (const override of overrides) {
    const known = rows.some(
      row =>
        row.ev === 'note' &&
        row.data?.kind === 'policy-override' &&
        row.data.setting === override.setting &&
        same(row.data.value, override.value) &&
        (row.data.ignored === true) === (override.ignored === true),
    )
    if (known) continue
    const row = await appendRow($, {
      ev: 'note',
      data: {
        kind: 'policy-override',
        setting: override.setting,
        value: override.value,
        default: override.default,
        ...(override.legacy === undefined ? {} : { legacy: override.legacy }),
        ...(override.ignored === true ? { ignored: true } : {}),
      },
    })
    if (row) written += 1
  }
  return written
}

/**
 * Reads `bytheslice.config.json` in the session's directory, key `pass` (call it once per session): the
 * defaults when the file is missing, and when it cannot be read, with a log
 * line saying so. With `record`, each override not yet in the ledger becomes a note row.
 */
export async function loadPolicy($: EngineInterface, options: { record?: boolean } = {}): Promise<PassPolicy> {
  let text: string | null = null
  try {
    const cwd = (await $.session.cwd().catch(() => '.')).replace(/\/$/, '')
    const path = `${cwd}/${CONFIG_PATH}`
    text = (await $.fs.exists(path)) ? await $.fs.read(path) : null
  } catch {
    text = null
  }
  const read = readPolicy(text)
  if (read.problem !== null) {
    try {
      $.ui.log(`The Pass could not read ${CONFIG_PATH} (${read.problem}); its checks use the default policy.`)
    } catch {
      // Nothing else to tell.
    }
  }
  if (options.record === true) await recordOverrides($, read.overrides).catch(() => 0)
  return read.policy
}
