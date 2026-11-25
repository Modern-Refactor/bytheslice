// mod/policy.test.ts
// Unit tests for the warning plumbing and the policy: defaults, config overrides recorded once, the once-a-minute report, toasts and the atoms.

import { expect, test } from 'claude-code/testing'

import { headsMatch, skillName } from './checks.ts'
import { CHECKLIST_FIXTURE } from './fixtures/checklist.fixture.ts'
import {
  CONTEXT_ROLES,
  DEFAULT_MARKERS,
  DEFAULT_POLICY,
  DEFAULT_ROLES,
  EXPECTED_MARKERS,
  GATE_ROLES,
  LEGACY_AGENT_ALIASES,
  canonicalRole,
  legacyNamesOf,
  policyFrom,
  readPolicy,
  tierAllowed,
} from './policy.ts'
import { CWD, HEAD, LEDGER, activeAt52, bashResult, engineLoops, ledgerLine, ledgerText, rowsOf, stage, warnsOf } from './testing.tsx'

const CONFIG = `${CWD}/bytheslice.config.json`

const PROJECT = `{
  // JSONC, as config-generator writes it.
  "pass": {
    "checks": { "enabled": true, "requireTester": "always" },
    "spawnPolicy": {
      "roles": { "implementer": ["opus"], "bytheslice:discovery": ["haiku", "sonnet"], "fix-attempter": "opus" },
      "contextMarkers": ["files_changed", "my transcript"],
    },
  },
}`

test('the defaults cover every role with one tier each and the four context markers', () => {
  expect(Object.keys(DEFAULT_ROLES)).toHaveLength(28)
  expect(Object.values(DEFAULT_ROLES).every(tiers => tiers.length === 1)).toBe(true)
  expect(DEFAULT_ROLES.implementer).toEqual(['opus'])
  expect(DEFAULT_ROLES['code-reviewer']).toEqual(['opus'])
  expect(DEFAULT_ROLES['fix-attempter']).toEqual(['sonnet'])
  expect(DEFAULT_ROLES['slice-verifier']).toEqual(['sonnet'])
  expect(DEFAULT_ROLES['code-explorer']).toEqual(['opus'])
  expect(DEFAULT_ROLES['ui-reviewer']).toEqual(['sonnet'])
  expect(DEFAULT_ROLES['stage-planner']).toEqual(['opus'])
  expect(DEFAULT_ROLES['ux-layout-designer']).toEqual(['sonnet'])
  expect(DEFAULT_ROLES['ui-builder']).toEqual(['sonnet'])
  expect(DEFAULT_MARKERS).toEqual(['files_changed', 'diff --git', 'implementer returned', 'builder transcript'])
  expect(DEFAULT_POLICY).toMatchObject({ enabled: true, requireTester: 'ui-slices' })
})

test('a project config overrides per role, replaces the markers and lists each change', () => {
  const read = readPolicy(PROJECT)
  expect(read.problem).toBeNull()
  expect(read.policy.requireTester).toBe('always')
  // A retired-name list may only raise a role's tier: haiku and sonnet would lower code-explorer, so it stays opus.
  expect(read.policy.roles['code-explorer']).toEqual(['opus'])
  expect(read.policy.roles.discovery).toBeUndefined()
  expect(read.policy.roles['fix-attempter']).toEqual(['opus'])
  expect(read.policy.roles['slice-verifier']).toEqual(['sonnet'])
  expect(read.policy.contextMarkers).toEqual(['files_changed', 'my transcript'])
  expect(read.overrides.map(o => o.setting)).toEqual([
    'checks.requireTester',
    'roles.code-explorer',
    'roles.fix-attempter',
    'contextMarkers',
  ])
  expect(read.overrides[1]).toEqual({
    setting: 'roles.code-explorer',
    value: ['haiku', 'sonnet'],
    default: ['opus'],
    legacy: ['bytheslice:discovery'],
    ignored: true,
  })
})

test('modelTiers sets a role the conductor dispatches with; spawnPolicy.roles still wins', () => {
  const read = policyFrom({ modelTiers: { fixAttempter: 'opus', tokenExpander: 'sonnet', nobody: 'opus', implementer: 'gpt' } })
  expect(read.policy.roles['fix-attempter']).toEqual(['opus'])
  expect(read.policy.roles['token-expander']).toEqual(['sonnet'])
  expect(read.policy.roles.implementer).toEqual(['opus'])
  expect(read.overrides.map(o => o.setting)).toEqual(['roles.fix-attempter', 'roles.token-expander'])
  const both = policyFrom({ modelTiers: { fixAttempter: 'opus' }, pass: { spawnPolicy: { roles: { 'fix-attempter': ['haiku'] } } } })
  expect(both.policy.roles['fix-attempter']).toEqual(['haiku'])
})

test('every retired name resolves to a registered agent, a script or nothing; canonicalRole drops any plugin prefix', () => {
  for (const [name, alias] of Object.entries(LEGACY_AGENT_ALIASES)) {
    if (name in DEFAULT_ROLES) continue
    // A retired name is no role of its own, and its replacement is registered (or it has none).
    if (alias.agent !== null) expect(DEFAULT_ROLES[alias.agent]).toBeDefined()
    expect(canonicalRole(name)).toBe(alias.agent ?? name)
  }
  expect(canonicalRole('bytheslice:spec-reviewer')).toBe('code-reviewer')
  expect(canonicalRole('quality-reviewer')).toBe('code-reviewer')
  expect(canonicalRole('other:design-critic')).toBe('ui-reviewer')
  expect(canonicalRole('bytheslice:break-ui-runner')).toBe('ui-reviewer')
  expect(canonicalRole('discovery')).toBe('code-explorer')
  expect(canonicalRole('checklist-curator')).toBe('code-explorer')
  expect(canonicalRole('complexity-assessor')).toBe('stage-planner')
  expect(canonicalRole('stage-decomposer')).toBe('stage-planner')
  expect(canonicalRole('db-schema-stage-writer')).toBe('phased-plan-writer')
  expect(canonicalRole('modern-ux-expert')).toBe('ux-layout-designer')
  expect(canonicalRole('layout-architect')).toBe('ux-layout-designer')
  expect(canonicalRole('block-composer')).toBe('ui-builder')
  expect(canonicalRole('component-crafter')).toBe('ui-builder')
  // Deleted agents, current names and unknown names stay as written.
  expect(canonicalRole('bytheslice:bootstrap-runner')).toBe('bootstrap-runner')
  expect(canonicalRole('bytheslice:slice-verifier')).toBe('slice-verifier')
  expect(canonicalRole('scaffold-discovery')).toBe('scaffold-discovery')
  expect(canonicalRole('Explore')).toBe('Explore')
  expect(canonicalRole(undefined)).toBe('')
  // The 7.1 merges resolve to scaffold-writer or scaffold-discovery; a script-replaced agent keeps the name it was written under.
  expect(LEGACY_AGENT_ALIASES['e2e-installer']).toEqual({ agent: 'scaffold-writer', mode: 'e2e' })
  expect(canonicalRole('e2e-installer')).toBe('scaffold-writer')
  expect(canonicalRole('bytheslice:branch-protection-writer')).toBe('scaffold-writer')
  expect(canonicalRole('framework-detector')).toBe('scaffold-discovery')
  expect(canonicalRole('env-scanner')).toBe('env-scanner')
  expect(LEGACY_AGENT_ALIASES['local-gates-runner']).toEqual({ agent: null, script: 'skills/final-quality-check/scripts/run-gates.js' })
  expect(LEGACY_AGENT_ALIASES['ci-cd-detector']?.script).toBe('skills/setup-shop/scripts/detect-ci.js')
  expect(LEGACY_AGENT_ALIASES.discovery).toEqual({ agent: 'code-explorer', mode: 'stage-recon' })
  expect(LEGACY_AGENT_ALIASES['design-critic']).toEqual({ agent: 'ui-reviewer', mode: 'critique' })
  expect(legacyNamesOf('code-reviewer')).toEqual(['spec-reviewer', 'quality-reviewer'])
  expect(legacyNamesOf('implementer')).toEqual([])
})

test('code-reviewer is a gate and a context role with the expected markers the two old reviewers had', () => {
  expect(GATE_ROLES.has('code-reviewer')).toBe(true)
  expect(CONTEXT_ROLES.has('code-reviewer')).toBe(true)
  expect(EXPECTED_MARKERS['code-reviewer']).toEqual(['files_changed', 'diff --git', 'implementer returned'])
  for (const old of ['spec-reviewer', 'quality-reviewer']) {
    expect(GATE_ROLES.has(canonicalRole(old))).toBe(true)
    expect(CONTEXT_ROLES.has(canonicalRole(old))).toBe(true)
    expect(EXPECTED_MARKERS[canonicalRole(old)]).toEqual(['files_changed', 'diff --git', 'implementer returned'])
  }
})

test('modelTiers under retired names set the new role: the higher tier wins, one note, and a new-name key always wins', () => {
  // One retired key moves its new role.
  const one = policyFrom({ modelTiers: { designCritic: 'opus' } })
  expect(one.policy.roles['ui-reviewer']).toEqual(['opus'])
  expect(one.overrides).toEqual([{ setting: 'roles.ui-reviewer', value: ['opus'], default: ['sonnet'], legacy: ['designCritic'] }])
  // Two retired keys on one role: the higher tier, recorded once.
  const two = policyFrom({ modelTiers: { specReviewer: 'sonnet', qualityReviewer: 'opus', blockComposer: 'haiku', componentCrafter: 'opus' } })
  expect(two.policy.roles['code-reviewer']).toEqual(['opus'])
  expect(two.policy.roles['ui-builder']).toEqual(['opus'])
  expect(two.overrides).toEqual([
    { setting: 'roles.ui-builder', value: ['opus'], default: ['sonnet'], legacy: ['blockComposer', 'componentCrafter'] },
  ])
  // Retired keys may only raise: two haiku keys would lower ux-layout-designer, so it stays sonnet, with one ignored note.
  const down = policyFrom({ modelTiers: { modernUxExpert: 'haiku', layoutArchitect: 'haiku' } })
  expect(down.policy.roles['ux-layout-designer']).toEqual(['sonnet'])
  expect(down.overrides).toEqual([
    { setting: 'roles.ux-layout-designer', value: ['haiku'], default: ['sonnet'], legacy: ['modernUxExpert', 'layoutArchitect'], ignored: true },
  ])
  // A key under the new name wins over every retired key, whichever comes first.
  const named = policyFrom({ modelTiers: { qualityReviewer: 'opus', codeReviewer: 'sonnet', specReviewer: 'opus' } })
  expect(named.policy.roles['code-reviewer']).toEqual(['sonnet'])
  expect(named.overrides).toEqual([
    { setting: 'roles.code-reviewer', value: ['sonnet'], default: ['opus'], legacy: ['qualityReviewer', 'specReviewer'] },
  ])
  // Every PR 1 retired key reaches its role; the old names gain no role of their own.
  const all = policyFrom({
    modelTiers: {
      discovery: 'sonnet',
      checklistCurator: 'haiku',
      complexityAssessor: 'sonnet',
      stageDecomposer: 'haiku',
      dbSchemaStageWriter: 'sonnet',
      breakUiRunner: 'haiku',
    },
  })
  // Each would lower its role, so every role keeps its default and each is noted as ignored.
  expect(all.policy.roles['code-explorer']).toEqual(['opus'])
  expect(all.policy.roles['stage-planner']).toEqual(['opus'])
  expect(all.policy.roles['phased-plan-writer']).toEqual(['opus'])
  expect(all.policy.roles['ui-reviewer']).toEqual(['sonnet'])
  expect(all.overrides.map(o => [o.setting, o.ignored])).toEqual([
    ['roles.code-explorer', true],
    ['roles.stage-planner', true],
    ['roles.phased-plan-writer', true],
    ['roles.ui-reviewer', true],
  ])
  for (const old of ['discovery', 'checklist-curator', 'stage-decomposer', 'db-schema-stage-writer']) expect(all.policy.roles[old]).toBeUndefined()
  // A key for an agent a script replaced names no role and is ignored.
  expect(policyFrom({ modelTiers: { envScanner: 'sonnet' } }).overrides).toEqual([])
  // A key for an agent merged into scaffold-writer sets that role.
  expect(policyFrom({ modelTiers: { e2eInstaller: 'opus' } }).policy.roles['scaffold-writer']).toEqual(['opus'])
  // A deleted agent's key names no role and is ignored.
  expect(policyFrom({ modelTiers: { bootstrapRunner: 'opus' } }).overrides).toEqual([])
})

test('a single retired modelTiers key only raises its new role; a new-name key sets any tier', () => {
  // specReviewer: sonnet alone leaves code-reviewer on opus, with one ignored note.
  const spec = policyFrom({ modelTiers: { specReviewer: 'sonnet' } })
  expect(spec.policy.roles['code-reviewer']).toEqual(['opus'])
  expect(spec.overrides).toEqual([{ setting: 'roles.code-reviewer', value: ['sonnet'], default: ['opus'], legacy: ['specReviewer'], ignored: true }])
  const quality = policyFrom({ modelTiers: { qualityReviewer: 'haiku' } })
  expect(quality.policy.roles['code-reviewer']).toEqual(['opus'])
  expect(quality.overrides[0]?.ignored).toBe(true)
  // stageDecomposer: sonnet leaves stage-planner on opus; complexityAssessor and discovery likewise.
  expect(policyFrom({ modelTiers: { stageDecomposer: 'sonnet' } }).policy.roles['stage-planner']).toEqual(['opus'])
  expect(policyFrom({ modelTiers: { complexityAssessor: 'sonnet' } }).policy.roles['stage-planner']).toEqual(['opus'])
  expect(policyFrom({ modelTiers: { discovery: 'sonnet' } }).policy.roles['code-explorer']).toEqual(['opus'])
  expect(policyFrom({ modelTiers: { checklistCurator: 'haiku' } }).policy.roles['code-explorer']).toEqual(['opus'])
  // A retired key naming the tier the role already has changes nothing and notes nothing.
  expect(policyFrom({ modelTiers: { specReviewer: 'opus' } }).overrides).toEqual([])
  // A retired key above the default raises it.
  const raise = policyFrom({ modelTiers: { breakUiRunner: 'opus' } })
  expect(raise.policy.roles['ui-reviewer']).toEqual(['opus'])
  expect(raise.overrides).toEqual([{ setting: 'roles.ui-reviewer', value: ['opus'], default: ['sonnet'], legacy: ['breakUiRunner'] }])
  expect(policyFrom({ modelTiers: { componentCrafter: 'opus' } }).policy.roles['ui-builder']).toEqual(['opus'])
  // A new-name key sets any tier, down as well as up.
  expect(policyFrom({ modelTiers: { codeReviewer: 'sonnet' } }).policy.roles['code-reviewer']).toEqual(['sonnet'])
  expect(policyFrom({ modelTiers: { stagePlanner: 'haiku' } }).policy.roles['stage-planner']).toEqual(['haiku'])
  expect(policyFrom({ modelTiers: { 'bytheslice:uiReviewer': 'haiku' } }).policy.roles['ui-reviewer']).toEqual(['haiku'])
})

test('spawnPolicy.roles under retired names: every tier either allows, raise only, an empty list opts out, and a new-name key wins', () => {
  // Sonnet and opus over code-reviewer's opus raise nothing, so the role keeps opus and the lists are noted as ignored.
  const two = policyFrom({ pass: { spawnPolicy: { roles: { 'spec-reviewer': ['sonnet'], 'bytheslice:quality-reviewer': ['opus'] } } } })
  expect(two.policy.roles['code-reviewer']).toEqual(['opus'])
  expect(two.overrides).toEqual([
    {
      setting: 'roles.code-reviewer',
      value: ['sonnet', 'opus'],
      default: ['opus'],
      legacy: ['spec-reviewer', 'bytheslice:quality-reviewer'],
      ignored: true,
    },
  ])
  // A single retired list below the default is ignored; one above it adds the higher tier and keeps the default allowed.
  expect(policyFrom({ pass: { spawnPolicy: { roles: { 'stage-decomposer': ['sonnet'] } } } }).policy.roles['stage-planner']).toEqual(['opus'])
  const up = policyFrom({ pass: { spawnPolicy: { roles: { 'design-critic': ['opus'] } } } })
  expect(up.policy.roles['ui-reviewer']).toEqual(['sonnet', 'opus'])
  expect(up.overrides).toEqual([{ setting: 'roles.ui-reviewer', value: ['sonnet', 'opus'], default: ['sonnet'], legacy: ['design-critic'] }])
  // An empty list was a deliberate 6.x opt-out of the model check, so a retired name's empty list is honored, noted once.
  const off = policyFrom({ pass: { spawnPolicy: { roles: { 'quality-reviewer': [] } } } })
  expect(off.policy.roles['code-reviewer']).toEqual([])
  expect(off.overrides).toEqual([{ setting: 'roles.code-reviewer', value: [], default: ['opus'], legacy: ['quality-reviewer'] }])
  expect(policyFrom({ pass: { spawnPolicy: { roles: { 'bytheslice:discovery': '' } } } }).policy.roles['code-explorer']).toEqual([])
  // An empty retired list beside a non-empty retired list on one role still turns the check off (an empty list wins the union).
  expect(policyFrom({ pass: { spawnPolicy: { roles: { 'spec-reviewer': ['opus'], 'quality-reviewer': [] } } } }).policy.roles['code-reviewer']).toEqual([])
  expect(policyFrom({ pass: { spawnPolicy: { roles: { 'code-reviewer': [] } } } }).policy.roles['code-reviewer']).toEqual([])
  // A new-name key still wins outright over a retired empty list.
  const keep = policyFrom({ pass: { spawnPolicy: { roles: { 'quality-reviewer': [], 'code-reviewer': ['sonnet'] } } } })
  expect(keep.policy.roles['code-reviewer']).toEqual(['sonnet'])
  expect(keep.overrides).toEqual([{ setting: 'roles.code-reviewer', value: ['sonnet'], default: ['opus'], legacy: ['quality-reviewer'] }])
  const named = policyFrom({ pass: { spawnPolicy: { roles: { 'spec-reviewer': ['haiku'], 'code-reviewer': ['sonnet'] } } } })
  expect(named.policy.roles['code-reviewer']).toEqual(['sonnet'])
  // Another plugin's agent of a retired name is that plugin's, not an alias.
  expect(policyFrom({ pass: { spawnPolicy: { roles: { 'other:discovery': ['haiku'] } } } }).policy.roles['other:discovery']).toEqual(['haiku'])
})

test('a missing or malformed config gives the defaults; a malformed one says why', () => {
  expect(readPolicy(null)).toEqual({ policy: DEFAULT_POLICY, overrides: [], problem: null })
  const broken = readPolicy('{ "pass": ')
  expect(broken.policy).toEqual(DEFAULT_POLICY)
  expect(broken.problem).not.toBeNull()
  expect(policyFrom({ pass: { checks: { enabled: 'no', requireTester: 'sometimes' } } }).overrides).toEqual([])
})

test('tiers match model aliases and API ids by substring, case-insensitively', () => {
  expect(tierAllowed('claude-sonnet-4-6', ['sonnet'])).toBe(true)
  expect(tierAllowed('Opus', ['opus'])).toBe(true)
  expect(tierAllowed('claude-opus-5-5', ['haiku', 'sonnet'])).toBe(false)
  expect(tierAllowed('anything', [])).toBe(false)
})

test('heads match on a shared prefix of seven or more; skill names lose their plugin prefix', () => {
  expect(headsMatch('a1b2c3d', 'a1b2c3d4e5f6')).toBe(true)
  expect(headsMatch('a1b2c3', 'a1b2c3d4e5f6')).toBe(false)
  expect(headsMatch(null, 'a1b2c3d')).toBe(false)
  expect(skillName('bytheslice:sell-pie')).toBe('sell-pie')
  expect(skillName('/cook-pizzas')).toBe('cook-pizzas')
  expect(skillName('commit')).toBeNull()
})

test('at session start the policy is read once and each override is recorded once as a note', async ($, on) => {
  const { world, start } = stage(on, { checklist: CHECKLIST_FIXTURE, files: { [CONFIG]: PROJECT } })
  await start($)
  const notes = rowsOf(world).filter(row => row.ev === 'note')
  expect(notes).toHaveLength(4)
  expect(notes[1]?.data).toEqual({
    kind: 'policy-override',
    setting: 'roles.code-explorer',
    value: ['haiku', 'sonnet'],
    default: ['opus'],
    legacy: ['bytheslice:discovery'],
    ignored: true,
  })
  // A second session over the same ledger records nothing new.
  await start($)
  expect(rowsOf(world).filter(row => row.ev === 'note')).toHaveLength(4)
})

test('without a master checklist the policy is read but nothing is recorded', async ($, on) => {
  const { world, start } = stage(on, { files: { [CONFIG]: PROJECT } })
  await start($)
  expect(world.files[LEDGER]).toBeUndefined()
})

test('a malformed config logs why and the checks run on the defaults', async ($, on) => {
  const { world, start } = stage(on, { checklist: CHECKLIST_FIXTURE, files: { [CONFIG]: '{ nope' } })
  await start($)
  expect(world.logs.some(line => line.includes('could not read bytheslice.config.json'))).toBe(true)
  expect(rowsOf(world).filter(row => row.ev === 'note')).toEqual([])
})

test("the project's requireTester always asks a tester pass of an infrastructure slice too", async ($, on) => {
  const { world, start } = stage(on, { checklist: CHECKLIST_FIXTURE, files: { [CONFIG]: PROJECT } })
  world.files[LEDGER] = ledgerText([ledgerLine(1, 'verdict', '5.1', { gate: 'slice-verifier', overall: 'pass', fix_targets: [], head: HEAD })])
  on('tool.call', () => ({ result: {} }))
  await start($)
  await $.tool.call({
    tool: 'Edit',
    file_path: 'docs/plans/00_master_checklist.md',
    old_string: '### Slice 5.1 - Pass pane and band [ ]',
    new_string: '### Slice 5.1 - Pass pane and band [x]',
  })
  expect(warnsOf(world)).toEqual([['checkbox-without-tester', '5.1']])
})

test('checks turned off in the config raise nothing', async ($, on) => {
  const off = '{ "pass": { "checks": { "enabled": false } } }'
  const { world, start } = stage(on, { checklist: CHECKLIST_FIXTURE, files: { [CONFIG]: off }, branch: 'main' })
  on('tool.call', () => bashResult())
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(warnsOf(world)).toEqual([])
})

test('a report writes one warn row and one toast, and the same key repeats only after a minute', async ($, on) => {
  const { world, clock, start } = stage(on, { checklist: CHECKLIST_FIXTURE, branch: 'main' })
  on('tool.call', () => bashResult())
  await start($)
  const first = await $.tool.call({ tool: 'Bash', command: 'git commit -m one' })
  const again = await $.tool.call({ tool: 'Bash', command: 'git commit -m two' })
  expect(first.context?.[0]).toContain('The Pass warning (commit-on-main): A git commit ran while this session is on main')
  expect(again.context).toBeUndefined()
  expect(warnsOf(world)).toEqual([['commit-on-main', null]])
  const row = rowsOf(world).find(entry => entry.ev === 'warn')
  expect(row).toMatchObject({ ev: 'warn', data: { code: 'commit-on-main' } })
  expect(Object.keys((row?.data ?? {}) as object).sort()).toEqual(['code', 'text'])
  expect(JSON.stringify(row)).not.toContain('git commit -m one')
  expect(world.toasts).toHaveLength(1)
  expect(world.toasts[0]?.startsWith('Pass commit-on-main: A git commit ran')).toBe(true)
  await clock.advance(61000)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m three' })
  expect(warnsOf(world)).toHaveLength(2)
})

test('HEAD, branch and the active skill follow the session, as the checks read them', async ($, on) => {
  const next = 'feedfacecafe1234feedfacecafe1234feedface'
  const { world, start } = stage(on, { checklist: activeAt52(CHECKLIST_FIXTURE) })
  world.files[LEDGER] = ledgerText([ledgerLine(1, 'verdict', '5.2', { gate: 'slice-verifier', overall: 'pass', fix_targets: [], head: next })])
  engineLoops(on)
  on('tool.call', (_$, e) => (e.tool === 'Bash' ? bashResult({ commit: { sha: next, kind: 'committed', branch: 'pie-5-the-pass' } }) : { result: {} }))
  await start($)
  // HEAD: the verifier passed at the commit made in this session, so the flip is silent.
  world.head = next
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat(pie-5): 5.2 task 1 x"' })
  await $.tool.call({
    tool: 'Edit',
    file_path: 'docs/plans/00_master_checklist.md',
    old_string: '### Slice 5.2 - Ledger and status tool [ ]',
    new_string: '### Slice 5.2 - Ledger and status tool [x]',
  })
  expect(warnsOf(world)).toEqual([])
  // Branch: a switch to main is read again, so the next commit there warns.
  world.branch = 'main'
  await $.tool.call({ tool: 'Bash', command: 'git switch main' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m y' })
  expect(warnsOf(world)).toEqual([['commit-on-main', null]])
  // Skill: sell-slice makes a plan write warn; a skill of another plugin leaves it so.
  await $.skill.prompt({ skill: 'bytheslice:sell-slice', text: 'sell', frontmatter: {}, source: 'plugin' })
  await $.skill.prompt({ skill: 'commit', text: 'not ours', frontmatter: {}, source: 'built-in' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/docs/plans/stage_53_pass_checks.md', content: 'x' })
  expect(warnsOf(world).map(([code]) => code)).toEqual(['commit-on-main', 'plan-write-during-bake'])
})
