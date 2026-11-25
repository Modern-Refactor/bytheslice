// tests/setup-shop/write-config.test.js
// Covers write-config.js: Flow A and Flow B/C targets, the example template's commented hints kept for untouched sections, gates.enforcement "fix" always written, valid JSONC, the overwrite refusal (which says comments are not kept), merge, the timestamped backup (under .claude/.bytheslice-state/backups/, beside the defaults file for Flow A) before any merge or overwrite, project-relative paths, and the pasted-credential refusal.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseJsonc, stripJsonc } = require('../../skills/setup-shop/scripts/jsonc');

const SCRIPT = path.join(__dirname, '../../skills/setup-shop/scripts/write-config.js');
const TEMPLATE = fs.readFileSync(path.join(__dirname, '../../skills/setup-shop/references/bytheslice.config.example.json'), 'utf8');
const ANSWERS = path.join(__dirname, '../fixtures/setup-shop/answers-flow-c.json');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-write-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args, { input, env } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', input, env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr, json: r.stdout ? JSON.parse(r.stdout) : null };
}

// Every backup file write-config left in a folder (its own .gitignore aside).
const backupsIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.bak')).sort() : []);
const BACKUP_NAME = /^bytheslice\.config\.json\.\d{8}T\d{6}Z(?:-\d+)?\.bak$/;

// The lines of one top-level section block in a rendered or template file.
const sectionText = (text, key) => new RegExp(`\\n  "${key}": \\{\\n[\\s\\S]*?\\n  \\},?\\n`).exec(text)?.[0];

test('Flow C writes <project-root>/bytheslice.config.json from the answers as valid JSONC', (t) => {
  const root = tmp(t);
  const r = run(['--answers', ANSWERS, '--project-root', root]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.config_path, path.join(root, 'bytheslice.config.json'));
  assert.equal(r.json.parses_as_jsonc, true);
  const text = fs.readFileSync(r.json.config_path, 'utf8');
  const config = parseJsonc(text);
  assert.deepEqual(config.stages, { maxTasksPerStage: 5 });
  assert.deepEqual(config.mcps, { shadcn: true, magic: false, figma: true, chromeDevTools: false, supabase: false });
  assert.deepEqual(config.visualReview, { vizzly: false });
  assert.deepEqual(config.hitl.additionalCategories, [{ name: 'legal_review', promptHint: 'Legal sign-off needed before this lands.' }]);
  assert.deepEqual(config.gates, { enforcement: 'fix', advisory: ['visual'], declared: [{ name: 'links', command: 'pnpm check:links' }, 'pnpm check:types'] });
  assert.deepEqual(config.bootstrap, {}, 'bootstrap is Flow A only: its block stays all hints');
  assert.deepEqual(r.json.ignored, ['bootstrap (Flow A only)']);
  assert.deepEqual(r.json.sections_customized.sort(), ['gates', 'hitl', 'mcps', 'stages', 'visualReview']);
  assert.doesNotThrow(() => JSON.parse(stripJsonc(text)));
});

test('sections the operator did not customize keep the template text, commented hints included', (t) => {
  const root = tmp(t);
  const r = run(['--answers', ANSWERS, '--project-root', root]);
  const text = fs.readFileSync(r.json.config_path, 'utf8');
  for (const key of ['modelTiers', 'verification', 'flow', 'review', 'delivery', 'quality', 'ui', 'run', 'rules']) {
    assert.equal(sectionText(text, key), sectionText(TEMPLATE, key), `${key} matches the template`);
  }
  assert.match(text, /^\/\/ bytheslice\.config\.json: copy this file/, 'the template header comment stays');
  assert.match(text, /\n {4}\/\/ "targetFeatureStages": "20-30"/, 'a customized section keeps the hints for keys it did not set');
  assert.match(text, /\n {4}"enforcement": "fix", +\/\/ the only value/, 'enforcement keeps its explanation');
});

test('Flow A with no customization writes the defaults file, identical to the template, creating its folder', (t) => {
  const home = tmp(t);
  const target = path.join(home, '.bytheslice', 'defaults.json');
  const r = run([], { input: '{"flow":"A"}', env: { BYTHESLICE_DEFAULTS_PATH: target } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.config_path, target);
  assert.equal(fs.readFileSync(target, 'utf8'), TEMPLATE);
  assert.deepEqual(r.json.sections_customized, ['gates']);
  assert.equal(parseJsonc(fs.readFileSync(target, 'utf8')).gates.enforcement, 'fix');
});

test('Flow A keeps the bootstrap defaults', (t) => {
  const target = path.join(tmp(t), 'defaults.json');
  const r = run(['--flow', 'A', '--target', target], { input: JSON.stringify({ bootstrap: { variant: 'monorepo', stack: 'nextjs', roadmapFile: null } }) });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(parseJsonc(fs.readFileSync(target, 'utf8')).bootstrap, { variant: 'monorepo', stack: 'nextjs', roadmapFile: null });
});

test('gates.enforcement is always "fix", whatever the answers say', (t) => {
  const root = tmp(t);
  const r = run(['--flow', 'B', '--project-root', root], { input: JSON.stringify({ gates: { enforcement: 'off', advisory: [] } }) });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(parseJsonc(fs.readFileSync(r.json.config_path, 'utf8')).gates, { enforcement: 'fix' });
  assert.match(r.json.notes[0], /"fix" is the only value/);
});

test('an advisory class the gate rule does not define is refused', (t) => {
  const r = run(['--flow', 'C', '--project-root', tmp(t)], { input: JSON.stringify({ gates: { advisory: ['everything'] } }) });
  assert.equal(r.code, 1);
  assert.match(r.err, /not a gate class/);
});

test('an existing config is never overwritten without --overwrite: exit 2, destructive_operation, file untouched', (t) => {
  const root = tmp(t);
  const file = path.join(root, 'bytheslice.config.json');
  fs.writeFileSync(file, '{ "quality": { "tier": "lean" } }\n');
  const r = run(['--answers', ANSWERS, '--project-root', root]);
  assert.equal(r.code, 2);
  assert.equal(r.json.needs_human.category, 'destructive_operation');
  assert.deepEqual(Object.keys(r.json.needs_human).sort(), ['category', 'context', 'question'], 'the shared needs_human shape; extra facts sit beside it');
  assert.equal(r.json.needs_human.question, 'This project already has bytheslice.config.json. Overwrite, merge, or cancel? Either way hand-written comments are not carried over; the original is saved under .claude/.bytheslice-state/backups/ first.');
  assert.equal(r.json.overwrite_conflict, true);
  const backups = path.join(root, '.claude', '.bytheslice-state', 'backups');
  assert.equal(r.json.backup_dir, backups);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "quality": { "tier": "lean" } }\n');
  assert.ok(!fs.existsSync(backups), 'no backup until the operator answers');

  const over = run(['--answers', ANSWERS, '--project-root', root, '--overwrite']);
  assert.equal(over.code, 0, over.err);
  assert.equal(over.json.overwrote, true);
  assert.equal(path.dirname(over.json.backup_path), backups);
  assert.match(path.basename(over.json.backup_path), BACKUP_NAME);
  assert.equal(fs.readFileSync(over.json.backup_path, 'utf8'), '{ "quality": { "tier": "lean" } }\n', 'the original is kept byte for byte');
  assert.ok(over.json.notes.some((n) => /overwritten: hand-written comments are not carried over/.test(n) && n.includes(over.json.backup_path)), over.json.notes.join('\n'));
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.endsWith('.bak')), [], 'nothing is left in the project root');
  assert.equal(fs.readFileSync(path.join(backups, '.gitignore'), 'utf8'), '# write-config.js backups: never committed\n*\n', 'the backup folder ignores itself');
  assert.deepEqual(parseJsonc(fs.readFileSync(file, 'utf8')).quality, {}, 'the old tier is gone; the block is back to its hint');
});

test('--merge keeps the existing keys and lays the answers over them', (t) => {
  const root = tmp(t);
  const file = path.join(root, 'bytheslice.config.json');
  fs.writeFileSync(file, '{\n  // mine\n  "quality": { "tier": "lean" },\n  "stages": { "maxTasksPerStage": 3, "targetFeatureStages": "10-15" },\n}\n');
  const original = fs.readFileSync(file, 'utf8');
  const r = run(['--answers', ANSWERS, '--project-root', root, '--merge']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.merged, true);
  // The merge re-renders the file, so the operator's `// mine` comment is gone: the backup keeps it, and the notes say so.
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\/\/ mine/);
  assert.equal(fs.readFileSync(r.json.backup_path, 'utf8'), original);
  assert.ok(r.json.notes.some((n) => /merged: hand-written comments are not carried over/.test(n) && n.includes(r.json.backup_path)), r.json.notes.join('\n'));
  // A second merge keeps the first backup and adds another.
  const again = run(['--answers', ANSWERS, '--project-root', root, '--merge']);
  assert.equal(again.code, 0, again.err);
  assert.notEqual(again.json.backup_path, r.json.backup_path);
  assert.equal(backupsIn(path.join(root, '.claude', '.bytheslice-state', 'backups')).length, 2);
  for (const f of backupsIn(path.join(root, '.claude', '.bytheslice-state', 'backups'))) assert.match(f, BACKUP_NAME);
  const config = parseJsonc(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(config.quality, { tier: 'lean' });
  assert.deepEqual(config.stages, { maxTasksPerStage: 5, targetFeatureStages: '10-15' });
  assert.equal(config.gates.enforcement, 'fix');
});

test('--base merges a run config under the answers (unattended runs)', (t) => {
  const root = tmp(t);
  const base = path.join(root, 'run-config.json');
  fs.writeFileSync(base, JSON.stringify({ run: { unattended: true }, quality: { tier: 'auto' }, delivery: { mode: 'ship-once' } }));
  const r = run(['--flow', 'B', '--project-root', root, '--base', base], { input: '{}' });
  assert.equal(r.code, 0, r.err);
  const config = parseJsonc(fs.readFileSync(r.json.config_path, 'utf8'));
  assert.deepEqual(config.run, { unattended: true });
  assert.deepEqual(config.delivery, { mode: 'ship-once' });
  assert.equal(config.gates.enforcement, 'fix');
});

test('a pasted credential is refused with external_credentials, nothing is written, and the value is never printed', (t) => {
  const root = tmp(t);
  const pasted = 'sk-ant-api03-FIXTUREfixtureFIXTUREfixture0123';
  const r = run(['--flow', 'C', '--project-root', root], { input: JSON.stringify({ rules: [`https://example.test/rules.md?token=${pasted}`] }) });
  assert.equal(r.code, 2);
  assert.equal(r.json.needs_human.category, 'external_credentials');
  assert.match(r.json.needs_human.question, /rules\.imports\[0\]/);
  assert.ok(!r.out.includes(pasted) && !r.err.includes(pasted));
  assert.ok(!fs.existsSync(path.join(root, 'bytheslice.config.json')));
});

test('a flow is required', (t) => {
  const r = run(['--project-root', tmp(t)], { input: '{}' });
  assert.equal(r.code, 1);
  assert.match(r.err, /flow must be A, B or C/);
});

test('a fresh write makes no backup', (t) => {
  const root = tmp(t);
  const r = run(['--answers', ANSWERS, '--project-root', root]);
  assert.equal(r.json.backup_path, null);
  assert.ok(!fs.existsSync(path.join(root, '.claude')));
});

test('Flow A keeps its backup beside the defaults file, timestamped, with no .gitignore', (t) => {
  const home = tmp(t);
  const target = path.join(home, '.bytheslice', 'defaults.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{ "quality": { "tier": "lean" } }\n');
  const ask = run([], { input: '{"flow":"A"}', env: { BYTHESLICE_DEFAULTS_PATH: target } });
  assert.equal(ask.code, 2);
  assert.equal(ask.json.needs_human.question, '~/.bytheslice/defaults.json already exists. Overwrite, merge, or cancel? Either way hand-written comments are not carried over; the original is saved beside it in ~/.bytheslice/ first.');
  assert.equal(ask.json.backup_dir, path.dirname(target));
  const r = run(['--overwrite'], { input: '{"flow":"A"}', env: { BYTHESLICE_DEFAULTS_PATH: target } });
  assert.equal(r.code, 0, r.err);
  assert.equal(path.dirname(r.json.backup_path), path.dirname(target));
  assert.match(path.basename(r.json.backup_path), /^defaults\.json\.\d{8}T\d{6}Z(?:-\d+)?\.bak$/);
  assert.equal(fs.readFileSync(r.json.backup_path, 'utf8'), '{ "quality": { "tier": "lean" } }\n');
  assert.ok(r.json.notes.some((n) => n.includes(r.json.backup_path)));
  assert.ok(!fs.existsSync(path.join(path.dirname(target), '.gitignore')));
});

test('relative --answers, --base and --target paths resolve against --project-root, wherever the script runs from', (t) => {
  const root = tmp(t);
  fs.copyFileSync(ANSWERS, path.join(root, 'answers.json'));
  fs.writeFileSync(path.join(root, 'run-config.json'), JSON.stringify({ delivery: { mode: 'ship-once' } }));
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  const r = spawnSync(process.execPath, [SCRIPT, '--answers', 'answers.json', '--base', 'run-config.json', '--target', 'out/bytheslice.config.json', '--root', root], { encoding: 'utf8', cwd: os.tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.config_path, path.join(root, 'out', 'bytheslice.config.json'));
  assert.deepEqual(parseJsonc(fs.readFileSync(out.config_path, 'utf8')).delivery, { mode: 'ship-once' });
});
