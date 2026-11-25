// tests/setup-shop/detect-ci.test.js
// Covers detect-ci.js: the four CI/CD baseline markers under the standard tier, the lean rule (build and smoke jobs, design-system-compliance only with a design system), quality.tier auto, and the legacy full-chain hook.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { detect } = require('../../skills/setup-shop/scripts/detect-ci');

const SCRIPT = path.join(__dirname, '../../skills/setup-shop/scripts/detect-ci.js');
const STANDARD = path.join(__dirname, '../fixtures/detect-ci/standard');

const LEAN_CI = `name: CI
on: [pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm lint
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm typecheck
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test
  build:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm build
  e2e-smoke:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test:e2e:smoke
`;

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-detect-ci-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(STANDARD, dir, { recursive: true });
  return dir;
}

const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const tier = (dir, value) => write(dir, 'bytheslice.config.json', `{\n  // tier under test\n  "quality": { "tier": "${value}" },\n}\n`);

function leanProject(t) {
  const dir = project(t);
  tier(dir, 'lean');
  write(dir, '.github/workflows/ci.yml', LEAN_CI);
  fs.rmSync(path.join(dir, '.github/workflows/design-system-compliance.yml'));
  return dir;
}

function checklist(pies, extra = '') {
  const body = Array.from({ length: pies }, (_, i) => `## Pie ${i + 2}: Feature ${i + 2}\n\n### Slice ${i + 2}.1: Screen ${i + 2}\n`).join('\n');
  return `# Master Checklist\n\n## Prep (Pie 1 Foundations)\n\n- [ ] Slice 1.1: Display case built\n\n${body}\n${extra}`;
}

test('the standard fixture has all four markers and is ready', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', STANDARD], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ci_cd_ready, true);
  assert.equal(out.quality_tier, 'standard');
  assert.deepEqual(out.missing, []);
  assert.deepEqual(out.markers.ci_yml, { exists: true, has_typecheck_job: true, has_lint_job: true, has_test_job: true, has_build_job: true, has_smoke_job: false });
  assert.deepEqual(out.markers.husky_pre_push, { exists: true, looks_canonical: true, legacy_full_chain: false });
});

test('each missing marker is listed and the project is not ready', (t) => {
  const dir = project(t);
  fs.rmSync(path.join(dir, '.github/pull_request_template.md'));
  fs.rmSync(path.join(dir, '.husky/pre-push'));
  fs.rmSync(path.join(dir, '.github/workflows/design-system-compliance.yml'));
  const r = detect(dir);
  assert.equal(r.ci_cd_ready, false);
  assert.deepEqual(r.missing, ['design-system-compliance.yml', 'husky/pre-push', 'pull_request_template.md']);
  assert.deepEqual(r.missing_markers, r.missing);
});

test('a ci.yml with no test job is incomplete', (t) => {
  const dir = project(t);
  write(dir, '.github/workflows/ci.yml', 'name: CI\njobs:\n  typecheck:\n    steps:\n      - run: pnpm typecheck\n  lint:\n    steps:\n      - run: pnpm lint\n');
  const r = detect(dir);
  assert.equal(r.ci_cd_ready, false);
  assert.deepEqual(r.missing, ['ci.yml (no test job)']);
});

test('a hook that still runs the old full chain counts as present, flagged for the swap', (t) => {
  const dir = project(t);
  write(dir, '.husky/pre-push', '#!/usr/bin/env sh\npnpm check:design-system\npnpm lint\npnpm typecheck\npnpm test\npnpm test:e2e:feature\npnpm test:e2e:regression\n');
  const r = detect(dir);
  assert.equal(r.ci_cd_ready, true);
  assert.equal(r.markers.husky_pre_push.legacy_full_chain, true);
  assert.match(r.summary, /husky-installer can swap it/);
});

test('a hook whose only mentions of the gates are comments is not canonical', (t) => {
  const dir = project(t);
  write(dir, '.husky/pre-push', '#!/usr/bin/env sh\n# lint, typecheck, test, build run in CI\necho skip\n');
  assert.deepEqual(detect(dir).missing, ['husky/pre-push (does not run lint, typecheck, test and build)']);
});

test('lean: design-system-compliance.yml is not a marker without a design system', (t) => {
  const r = detect(leanProject(t));
  assert.equal(r.quality_tier, 'lean');
  assert.equal(r.design_system_present, false);
  assert.equal(r.markers.design_system_compliance_yml.required, false);
  assert.equal(r.ci_cd_ready, true);
});

test('lean: design-system-compliance.yml is required once docs/design-system.md exists', (t) => {
  const dir = leanProject(t);
  write(dir, 'docs/design-system.md', '# Design System\n');
  const r = detect(dir);
  assert.equal(r.design_system_present, true);
  assert.deepEqual(r.missing, ['design-system-compliance.yml']);
});

test('lean: a ticked display-case Prep row also counts as a design system', (t) => {
  const dir = leanProject(t);
  write(dir, 'docs/plans/00_master_checklist.md', checklist(1).replace('- [ ] Slice 1.1', '- [x] Slice 1.1'));
  assert.equal(detect(dir).design_system_present, true);
});

test('lean: ci.yml needs a build job and the smoke job, unless E2E was skipped', (t) => {
  const dir = leanProject(t);
  write(dir, '.github/workflows/ci.yml', LEAN_CI.replace(/ {2}build:[\s\S]*?pnpm build\n/, '').replace(/ {2}e2e-smoke:[\s\S]*$/, ''));
  write(dir, 'package.json', JSON.stringify({ scripts: { 'test:e2e:smoke': 'playwright test e2e/smoke.spec.ts' } }));
  assert.deepEqual(detect(dir).missing, ['ci.yml (no build, e2e-smoke job)']);
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
  const skipped = detect(dir);
  assert.deepEqual(skipped.missing, ['ci.yml (no build job)']);
  assert.match(skipped.summary, /no test:e2e:smoke script/);
});

test('standard never takes the lean shortcuts', (t) => {
  const dir = leanProject(t);
  tier(dir, 'standard');
  assert.deepEqual(detect(dir).missing, ['design-system-compliance.yml']);
});

test('auto resolves to lean for at most 3 feature pies and no payments work', (t) => {
  const dir = project(t);
  tier(dir, 'auto');
  write(dir, 'docs/plans/00_master_checklist.md', checklist(3));
  const r = detect(dir);
  assert.equal(r.quality_tier, 'lean');
  assert.equal(r.quality_tier_configured, 'auto');
  assert.equal(r.quality_tier_reason, 'auto: 3 feature pies, no payments');
});

test('auto resolves to standard for 4 feature pies, payments work, or no master checklist', (t) => {
  const dir = project(t);
  tier(dir, 'auto');
  assert.equal(detect(dir).quality_tier, 'standard', 'no master checklist');
  assert.equal(detect(dir).quality_tier_reason, 'auto: no master checklist');

  write(dir, 'docs/plans/00_master_checklist.md', checklist(4));
  assert.equal(detect(dir).quality_tier, 'standard', 'four feature pies');

  write(dir, 'docs/plans/00_master_checklist.md', checklist(2, '### Slice 3.2: Checkout flow\n'));
  assert.equal(detect(dir).quality_tier, 'standard', 'a checkout slice');

  write(dir, 'docs/plans/00_master_checklist.md', checklist(2));
  write(dir, 'apps/web/.env.example', 'STRIPE_SECRET_KEY=\n');
  assert.match(detect(dir).quality_tier_reason, /a payments key in apps\/web\/\.env\.example/);
  fs.rmSync(path.join(dir, 'apps'), { recursive: true });

  write(dir, 'docs/prd-shop.md', '# Shop: PRD\n\n## 4. Technical Architecture\n\nPayments run through Stripe Checkout.\n\n## 5. UX\n');
  assert.match(detect(dir).quality_tier_reason, /a payments provider in PRD Section 4/);
});

test('a missing or unreadable config reads as standard', (t) => {
  const dir = project(t);
  write(dir, 'bytheslice.config.json', '{ not json');
  const r = detect(dir);
  assert.equal(r.quality_tier, 'standard');
  assert.match(r.notes[0], /not valid JSONC/);
});
