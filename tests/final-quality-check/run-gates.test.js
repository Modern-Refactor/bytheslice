// tests/final-quality-check/run-gates.test.js
// Covers skills/final-quality-check/scripts/run-gates.js against a fixture project whose gate scripts are `node -e` one-liners: the JSON summary shape, one log file per gate, every gate run past a failure, first-run visual baselines (per-app --baselines-dir folders included), --update-snapshots forwarding through each package manager and turbo, --only, the lean tier, exit 0 with overall: fail on a failed gate, and the exit-2 needs_human contract for missing scripts and missing tooling, with stdout holding only JSON.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../../skills/final-quality-check/scripts/run-gates.js');
const gates = require('../../skills/final-quality-check/scripts/run-gates.js');
const FIXTURE = path.join(__dirname, 'fixtures/project');

function project(t, edit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-run-gates-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pkg = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'package.json'), 'utf8'));
  if (edit) edit(pkg.scripts);
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  return dir;
}

function run(dir, args = [], env = process.env) {
  const res = spawnSync(process.execPath, [SCRIPT, '--cwd', dir, '--pm', 'npm', ...args], { encoding: 'utf8', env });
  const lines = res.stdout.split('\n').filter(Boolean);
  // stdout is exactly one JSON line: npm's own chatter and the gates' output go to the logs.
  assert.equal(lines.length, 1, `stdout is not one line:\n${res.stdout}\nstderr:\n${res.stderr}`);
  return { code: res.status, json: JSON.parse(lines[0]), stderr: res.stderr };
}

const byName = (json) => Object.fromEntries(json.gates.map((g) => [g.name, g]));

test('standard tier: summary shape, a log per gate, every gate run past a failure', (t) => {
  const dir = project(t);
  const { code, json } = run(dir);
  assert.equal(code, 0, 'a failed gate is a result in the JSON, not an error exit');
  assert.equal(json.overall, 'fail');
  assert.equal(json.tier, 'standard');
  assert.equal(json.package_manager, 'npm');
  assert.equal(json.log_dir, path.join('.claude', '.bytheslice-state', 'gates'));
  const g = byName(json);
  for (const name of ['lint', 'typecheck', 'check_design_system', 'unit_integration', 'build', 'feature_e2e', 'regression_core_e2e', 'visual_e2e']) {
    const gate = g[name];
    assert.ok(gate, `${name} missing`);
    for (const key of ['name', 'command', 'status', 'exit_code', 'duration_ms', 'log', 'tail']) assert.ok(key in gate, `${name}.${key} missing`);
    assert.equal(typeof gate.duration_ms, 'number');
    assert.ok(gate.command.startsWith('npm run '), gate.command);
    assert.ok(fs.existsSync(path.join(dir, gate.log)), `${gate.log} not written`);
  }
  assert.equal(g.lint.status, 'pass');
  assert.equal(g.lint.tail, null);
  assert.match(fs.readFileSync(path.join(dir, g.lint.log), 'utf8'), /lint ok/);
  // A failing gate carries its exit code and log tail, and later gates still ran.
  assert.equal(g.unit_integration.status, 'fail');
  assert.equal(g.unit_integration.exit_code, 1);
  assert.match(g.unit_integration.tail, /expected 2, got 3/);
  assert.equal(g.regression_core_e2e.status, 'pass');
  assert.deepEqual(g.feature_e2e.failed_specs, ['e2e/feature/smoke.spec.ts']);
  // An optional gate with no script, and a lean-only gate, are not_applicable, never run.
  assert.equal(g.integration.status, 'not_applicable');
  assert.equal(g.smoke_e2e.status, 'not_applicable');
  assert.ok(fs.existsSync(path.join(dir, json.log_dir, 'summary.json')));
});

test('first run generates the visual baselines; the next run compares against them', (t) => {
  const dir = project(t);
  const first = byName(run(dir, ['--only', 'visual_e2e']).json).visual_e2e;
  assert.equal(first.status, 'baselines_generated');
  assert.match(first.command, /-- --update-snapshots$/);
  assert.deepEqual(first.new_baselines, [path.join('tests', 'visual', 'baselines', 'home-mobile.png')]);
  const second = run(dir, ['--only', 'test:e2e:visual']);
  assert.equal(second.code, 0);
  const visual = byName(second.json).visual_e2e;
  assert.equal(visual.status, 'pass');
  assert.deepEqual(visual.new_baselines, []);
  assert.doesNotMatch(visual.command, /update-snapshots/);
});

test('--only runs just the named gates, by gate name or script name', (t) => {
  const dir = project(t);
  const { code, json } = run(dir, ['--only', 'lint,typecheck', '--only', 'test:e2e:regression']);
  assert.equal(code, 0);
  assert.equal(json.overall, 'pass');
  assert.deepEqual(json.gates.map((g) => g.name), ['lint', 'typecheck', 'regression_core_e2e']);
  const logs = fs.readdirSync(path.join(dir, json.log_dir)).sort();
  assert.deepEqual(logs, ['lint.log', 'regression_core_e2e.log', 'summary.json', 'typecheck.log']);
});

test('lean tier runs the lean set and marks the standard suites not_applicable', (t) => {
  const dir = project(t, (s) => { s.test = "node -e \"console.log('unit ok')\""; });
  const { code, json } = run(dir, ['--tier', 'lean']);
  assert.equal(code, 0);
  const g = byName(json);
  for (const name of ['lint', 'typecheck', 'unit_integration', 'build', 'smoke_e2e']) assert.equal(g[name].status, 'pass', name);
  assert.equal(g.check_design_system.status, 'not_applicable');
  for (const name of ['feature_e2e', 'regression_core_e2e', 'visual_e2e']) assert.equal(g[name].status, 'not_applicable', name);
  const withDs = byName(run(dir, ['--tier', 'lean', '--design-system', '--only', 'check_design_system']).json);
  assert.equal(withDs.check_design_system.status, 'pass');
});

test('--skip-e2e marks every e2e suite not_applicable', (t) => {
  const dir = project(t, (s) => { delete s['test:e2e:feature']; delete s['test:e2e:regression']; delete s['test:e2e:visual']; });
  const g = byName(run(dir, ['--skip-e2e', '--only', 'lint,feature_e2e,visual_e2e']).json);
  assert.equal(g.lint.status, 'pass');
  assert.equal(g.feature_e2e.status, 'not_applicable');
  assert.equal(g.visual_e2e.status, 'not_applicable');
});

test('a missing required script exits 2 with needs_human and runs nothing', (t) => {
  const dir = project(t, (s) => { delete s['test:e2e:visual']; delete s.typecheck; });
  const { code, json } = run(dir);
  assert.equal(code, 2);
  assert.deepEqual(Object.keys(json.needs_human).sort(), ['category', 'context', 'question']);
  assert.equal(json.needs_human.category, 'prd_ambiguity');
  assert.deepEqual(json.missing_scripts, ['typecheck', 'test:e2e:visual']);
  assert.ok(json.needs_human.question);
  const logs = path.join(dir, '.claude', '.bytheslice-state', 'gates');
  assert.deepEqual(fs.readdirSync(logs), ['summary.json'], 'a gate ran before the preflight stopped');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(logs, 'summary.json'), 'utf8')), json, 'summary.json holds the needs_human result too');
  // --only scopes the check: a missing script outside the selection is not asked about.
  assert.equal(run(dir, ['--only', 'lint']).code, 0);
});

test('a package manager missing from PATH exits 2 with needs_human', (t) => {
  const dir = project(t);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-run-gates-path-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const { code, json } = run(dir, [], { ...process.env, PATH: empty });
  assert.equal(code, 2);
  assert.deepEqual(json.missing_tooling, ['npm']);
  assert.equal(json.needs_human.category, 'external_credentials');
});

test('no package.json exits 2 with needs_human', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-run-gates-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { code, json } = run(dir);
  assert.equal(code, 2);
  assert.ok(json.needs_human.question);
  assert.ok(json.needs_human.context);
});

test('a usage error prints nothing on stdout and exits 1', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--only', 'nope'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /unknown gate nope/);
});

// A visual script that writes its baseline under BASE (an app's own folder) on --update-snapshots, else compares.
const appVisual = (base) => `node -e "const fs=require('fs');const d='${base}';if(process.argv.includes('--update-snapshots')){fs.mkdirSync(d,{recursive:true});fs.writeFileSync(d+'/home.png','png')}else if(!fs.existsSync(d+'/home.png')){console.error('missing baseline');process.exit(1)}" --`;

test('per-app --baselines-dir: an empty app folder generates once, then compares, while the root folder stays empty', (t) => {
  const dir = project(t, (s) => { s['test:e2e:visual'] = appVisual('apps/web/tests/visual/baselines'); });
  const args = ['--only', 'visual_e2e', '--baselines-dir', 'apps/web/tests/visual/baselines'];
  const first = byName(run(dir, args).json).visual_e2e;
  assert.equal(first.status, 'baselines_generated');
  assert.deepEqual(first.baselines_dirs, [path.join('apps', 'web', 'tests', 'visual', 'baselines')]);
  assert.deepEqual(first.new_baselines, [path.join('apps', 'web', 'tests', 'visual', 'baselines', 'home.png')]);
  const second = byName(run(dir, args).json).visual_e2e;
  assert.equal(second.status, 'pass', 'the second run compares instead of regenerating');
  assert.doesNotMatch(second.command, /update-snapshots/);
  assert.ok(!fs.existsSync(path.join(dir, 'tests', 'visual', 'baselines')), 'the root folder is not consulted under a per-app plan');
});

test('--baselines-dir takes a comma list or repeats; a folder with baselines blocks regeneration for the rest', (t) => {
  const dir = project(t, (s) => { s['test:e2e:visual'] = appVisual('apps/web/b'); });
  fs.mkdirSync(path.join(dir, 'apps/admin/b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps/admin/b/home.png'), 'png');
  const gate = byName(run(dir, ['--only', 'visual_e2e', '--baselines-dir', 'apps/web/b,apps/admin/b']).json).visual_e2e;
  assert.doesNotMatch(gate.command, /update-snapshots/, 'existing admin baselines are never rewritten');
  assert.deepEqual(gate.empty_baselines_dirs, [path.join('apps', 'web', 'b')]);
  assert.deepEqual(gates.parseArgs(['--baselines-dir', 'a,b', '--baselines-dir', 'c']).baselinesDirs, ['a', 'b', 'c']);
});

test('--update-snapshots follows a `--` each package manager forwards, and a second `--` for a turbo pipeline', () => {
  for (const pm of ['npm', 'pnpm', 'bun', 'yarn']) {
    assert.deepEqual(gates.commandFor(pm, 'test:e2e:visual', ['--update-snapshots']), ['run', 'test:e2e:visual', '--', '--update-snapshots'], pm);
  }
  assert.deepEqual(gates.commandFor('yarn', 'test:e2e:visual', ['--update-snapshots'], { yarnBerry: true }), ['run', 'test:e2e:visual', '--update-snapshots']);
  assert.deepEqual(gates.commandFor('npm', 'lint'), ['run', 'lint']);
  for (const cmd of ['turbo run test:e2e:visual', 'turbo test:e2e:visual --filter=web', 'npx turbo run test:e2e:visual', 'pnpm exec turbo run test:e2e:visual']) {
    assert.ok(gates.isTurbo(cmd), cmd);
    assert.deepEqual(gates.runnerArgs(cmd, ['--update-snapshots']), ['--', '--update-snapshots'], cmd);
  }
  for (const cmd of ['playwright test --grep @visual', 'node scripts/turbocharge.js']) assert.deepEqual(gates.runnerArgs(cmd, ['--update-snapshots']), ['--update-snapshots'], cmd);
  assert.deepEqual(gates.commandFor('pnpm', 'test:e2e:visual', gates.runnerArgs('turbo run test:e2e:visual', ['--update-snapshots'])), ['run', 'test:e2e:visual', '--', '--', '--update-snapshots']);
});

test('a relative --log-dir and --baselines-dir resolve against --cwd, wherever the script runs from', (t) => {
  const dir = project(t);
  const res = spawnSync(process.execPath, [SCRIPT, '--cwd', dir, '--pm', 'npm', '--only', 'lint', '--log-dir', 'gate-logs'], { encoding: 'utf8', cwd: os.tmpdir() });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'gate-logs', 'lint.log')));
});
