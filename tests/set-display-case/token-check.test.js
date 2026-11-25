// tests/set-display-case/token-check.test.js
// Covers token-check.js: the checklist parse, OKLCH lightness, the `complete` gate on written files, a Tailwind v4 entry and the pre-write draft, and the `bundle` validator with its needs_human exits.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tc = require('../../skills/set-display-case/scripts/token-check');

const SCRIPT = path.join(__dirname, '../../skills/set-display-case/scripts/token-check.js');
const FIX = path.join(__dirname, '../fixtures/token-check');
const GOOD = path.join(FIX, 'good');

function copy(t, from = GOOD) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-token-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(from, dir, { recursive: true });
  return dir;
}

function edit(file, from, to) {
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(from), `${path.basename(file)} has ${from}`);
  fs.writeFileSync(file, text.replace(from, to));
}

function run(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, err: r.stderr, json: r.stdout ? JSON.parse(r.stdout) : null };
}

const complete = (dir, ...flags) => run('complete', path.join(dir, 'globals.css'), path.join(dir, 'tailwind.config.ts'), path.join(dir, 'design-system.md'), ...flags);
const category = (r, name) => r.json.categories.find((c) => c.category === name);

test('the checklist parse reads every category from token-checklist.md', () => {
  const cl = tc.readChecklist();
  assert.deepEqual(cl.surface, ['background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground']);
  assert.equal(cl.brand.length, 6);
  assert.deepEqual(cl.semanticRequired, ['destructive', 'destructive-foreground']);
  assert.equal(cl.semanticOptional.length, 6);
  assert.equal(cl.neutrals.length, 5);
  assert.deepEqual(cl.charts, ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5']);
  assert.equal(cl.sidebar.length, 8);
  assert.deepEqual(cl.fontsRequired, ['font-sans', 'font-serif', 'font-mono']);
  assert.deepEqual(cl.fontsOptional, ['font-display', 'font-logo']);
  assert.equal(cl.typeA.length, 8);
  assert.equal(cl.typeB.length, 8);
  assert.ok(cl.typeA.includes('text-4xl') && cl.typeB.includes('text-display'));
  assert.deepEqual(cl.radius, ['radius', 'radius-sm', 'radius-md', 'radius-lg', 'radius-xl', 'radius-pill', 'radius-full']);
  assert.deepEqual(cl.shadows, ['shadow-sm', 'shadow-md', 'shadow-lg', 'shadow-xl', 'shadow-2xl']);
});

test('OKLCH lightness reads oklch, hex, rgb, hsl and bare triplets', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 0.2, `${a} is not near ${b}`);
  near(tc.oklchLightness('#ffffff'), 100);
  near(tc.oklchLightness('#000'), 0);
  near(tc.oklchLightness('oklch(0.62 0.1 250)'), 62);
  near(tc.oklchLightness('oklch(62% 0.1 250)'), 62);
  near(tc.oklchLightness('0.62 0.1 250'), 62);
  near(tc.oklchLightness('rgb(255 255 255)'), 100);
  near(tc.oklchLightness('hsl(0 0% 50%)'), 59.8);
  near(tc.oklchLightness('0 0% 50%'), 59.8);
  assert.equal(tc.oklchLightness('color-mix(in oklab, red, blue)'), null);
});

test('complete passes the full fixture: every category, layer contrast, bindings and dark mode', (t) => {
  const r = complete(copy(t), '--sidebar');
  assert.equal(r.code, 0);
  assert.equal(r.json.gate, 'PASS');
  assert.deepEqual(r.json.failed_categories, []);
  assert.equal(r.json.categories.length, 17);
  assert.equal(category(r, 'Type Scale').approach, 'A');
  assert.deepEqual(r.json.optional_tokens_present, ['--success', '--success-foreground']);
  assert.ok(r.json.layer_contrast.light.every((p) => p.delta >= 2));
});

test('a color token with no dark override fails Dark Mode Parity and its own category', (t) => {
  const dir = copy(t);
  edit(path.join(dir, 'globals.css'), '    --chart-5: 0 72% 55%;\n', '');
  const r = complete(dir, '--sidebar');
  assert.equal(r.json.gate, 'FAIL');
  assert.deepEqual(category(r, 'Charts').missing, ['--chart-5 (dark)']);
  assert.deepEqual(category(r, 'Dark Mode Parity').missing, ['--chart-5']);
});

test('adjacent layers under 2 OKLCH lightness points apart fail Surface Colors, naming the pair', (t) => {
  const dir = copy(t);
  edit(path.join(dir, 'globals.css'), '--card: 0 0% 8%;', '--card: 0 0% 4.5%;');
  const r = complete(dir, '--sidebar');
  assert.equal(r.json.gate, 'FAIL');
  const surface = category(r, 'Surface Colors');
  assert.equal(surface.status, 'FAIL');
  assert.match(surface.missing.join('\n'), /dark: --background \(L [\d.]+\) and --card \(L [\d.]+\) are [\d.]+ OKLCH lightness points apart, under 2/);
});

test('a TBD slot anywhere in design-system.md blocks the gate', (t) => {
  const dir = copy(t);
  edit(path.join(dir, 'design-system.md'), '| Relaxed | 1.75 |', '| Relaxed | TBD |');
  const r = complete(dir, '--sidebar');
  assert.equal(r.json.gate, 'FAIL');
  const line = fs.readFileSync(path.join(dir, 'design-system.md'), 'utf8').split('\n').findIndex((l) => l.includes('| Relaxed | TBD |')) + 1;
  assert.deepEqual(r.json.tbd_slots, [{ line, section: 'Line Heights (Leading)' }]);
});

test('a hardcoded color or a missing binding in tailwind.config fails Tailwind Config Bindings', (t) => {
  const dir = copy(t);
  edit(path.join(dir, 'tailwind.config.ts'), 'ring: "hsl(var(--ring))"', 'ring: "#3b82f6"');
  edit(path.join(dir, 'tailwind.config.ts'), 'mono: ["var(--font-mono)", "ui-monospace"],', 'mono: ["ui-monospace"],');
  const r = complete(dir, '--sidebar');
  const tw = category(r, 'Tailwind Config Bindings');
  assert.equal(tw.status, 'FAIL');
  assert.ok(tw.missing.includes('color --ring is not bound'));
  assert.ok(tw.missing.includes('hardcoded color value in colors: #3b82f6'));
  assert.ok(tw.missing.includes('fontFamily.mono is not bound to var(--font-mono)'));
});

test('a darkMode setting that does not match the documented strategy fails', (t) => {
  const dir = copy(t);
  edit(path.join(dir, 'tailwind.config.ts'), 'darkMode: "class"', 'darkMode: "media"');
  const r = complete(dir, '--sidebar');
  assert.ok(category(r, 'Dark Mode Parity').missing.some((m) => /darkMode \(media\) does not match the documented strategy \(class\)/.test(m)));
  assert.equal(category(r, 'Tailwind Config Bindings').status, 'FAIL');
});

test('sidebar tokens are N/A without an app shell and required with one', (t) => {
  const dir = copy(t);
  const css = path.join(dir, 'globals.css');
  fs.writeFileSync(css, fs.readFileSync(css, 'utf8').replace(/^\s*--sidebar-ring:.*\n/gm, ''));
  assert.equal(category(complete(dir, '--no-sidebar'), 'Sidebar').status, 'N/A');
  assert.deepEqual(category(complete(dir, '--sidebar'), 'Sidebar').missing, ['--sidebar-ring', '--sidebar-ring (dark)']);
});

test('an undocumented spacing, breakpoint or z-index decision fails its category', (t) => {
  const dir = copy(t);
  const doc = path.join(dir, 'design-system.md');
  edit(doc, '**Spacing Decision:** Using the Tailwind default 4px-base scale.', 'We space things nicely.');
  edit(doc, '**Breakpoint Decision:** Using Tailwind defaults.\n\n| Name | Value |\n| --- | --- |\n| `sm` | 640px |', '| Name | Value |\n| --- | --- |');
  edit(doc, '| Base | 0 | Document flow |\n| Dropdown | 1000 | Menus |\n| Modal | 1300 | Dialogs |\n| Toast | 1400 | Notifications |\n', '');
  const r = complete(dir, '--sidebar');
  assert.equal(category(r, 'Spacing Decision').status, 'FAIL');
  assert.equal(category(r, 'Breakpoints Decision').status, 'FAIL');
  assert.equal(category(r, 'Z-index Layers').status, 'FAIL');
});

test('a Tailwind v4 entry with @theme bindings and no tailwind.config passes', () => {
  const r = run('complete', path.join(FIX, 'v4/globals.css'), path.join(GOOD, 'design-system.md'), '--sidebar');
  assert.equal(r.code, 0);
  assert.equal(r.json.gate, 'PASS');
  assert.match(r.json.tailwind_config_path, /@theme/);
});

test('a Tailwind v4 entry without the class dark variant does not match a class strategy', (t) => {
  const dir = copy(t, path.join(FIX, 'v4'));
  edit(path.join(dir, 'globals.css'), '@custom-variant dark (&:is(.dark *));', '');
  const r = run('complete', path.join(dir, 'globals.css'), path.join(GOOD, 'design-system.md'), '--sidebar');
  assert.equal(r.json.gate, 'FAIL');
  assert.ok(category(r, 'Dark Mode Parity').missing.some((m) => /\(media\) does not match the documented strategy \(class\)/.test(m)));
});

test('the pre-write check reads the approved draft and leaves the Tailwind check for the written files', () => {
  const r = run('complete', '--draft', path.join(FIX, 'draft/design-system-draft.md'), '--sidebar');
  assert.equal(r.code, 0);
  assert.equal(r.json.gate, 'PASS');
  assert.equal(r.json.pre_write, true);
  assert.equal(category(r, 'Tailwind Config Bindings').status, 'N/A');
});

test('an input file that cannot be read exits 2 with a prd_ambiguity needs_human', (t) => {
  const dir = copy(t);
  const r = run('complete', path.join(dir, 'globals.css'), path.join(dir, 'tailwind.config.ts'), path.join(dir, 'missing.md'));
  assert.equal(r.code, 2);
  assert.equal(r.json.needs_human.category, 'prd_ambiguity');
  assert.match(r.json.needs_human.question, /^I can't find .*missing\.md\. Can you confirm the correct path\?$/);
});

test('bundle validates structure, tokens and dark parity, and canonicalizes paths', (t) => {
  const dir = copy(t);
  const r = run('bundle', dir);
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'pass');
  assert.equal(r.json.structural.status, 'pass');
  assert.equal(r.json.token_completeness.status, 'pass');
  assert.equal(r.json.dark_mode_parity.status, 'pass');
  assert.equal(r.json.canonicalized_paths.css_variables_file, path.join(dir, 'globals.css'));
  assert.equal(r.json.canonicalized_paths.tailwind_config_file, path.join(dir, 'tailwind.config.ts'));
  assert.equal(r.json.canonicalized_paths.token_reference_file, path.join(dir, 'design-system.md'));
  assert.equal(r.json.has_sidebar, true);
});

test('bundle reports token gaps as a failed status, not a needs_human', (t) => {
  const dir = copy(t);
  edit(path.join(dir, 'globals.css'), '    --shadow-2xl: 0 25px 50px rgb(0 0 0 / 0.2);\n', '');
  edit(path.join(dir, 'globals.css'), '    --ring: 217 91% 60%;\n', '');
  const r = run('bundle', dir);
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'fail');
  assert.equal(r.json.token_completeness.status, 'partial');
  assert.deepEqual(r.json.token_completeness.missing_categories, ['Neutrals', 'Shadows']);
  assert.deepEqual(r.json.dark_mode_parity.tokens_missing_dark_override, ['--ring']);
});

test('a bundle missing a primary file, or a path that does not exist, exits 2 with needs_human', (t) => {
  const dir = copy(t);
  fs.rmSync(path.join(dir, 'tailwind.config.ts'));
  const r = run('bundle', dir);
  assert.equal(r.code, 2);
  assert.equal(r.json.needs_human.category, 'prd_ambiguity');
  assert.deepEqual(r.json.report.structural.missing_files, ['tailwind.config.ts or tailwind.config.js']);
  const gone = run('bundle', path.join(dir, 'nope'));
  assert.equal(gone.code, 2);
  assert.equal(gone.json.needs_human.question, "The bundle path provided doesn't exist. Can you confirm the correct path to the Claude Design export?");
});
