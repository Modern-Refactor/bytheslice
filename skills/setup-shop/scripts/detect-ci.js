#!/usr/bin/env node
// skills/setup-shop/scripts/detect-ci.js
// /setup-shop Step 3: checks the ByTheSlice CI/CD baseline markers (ci.yml jobs, design-system-compliance.yml, the husky pre-push slice tier, the PR template) under the resolved quality tier. Detection only; never scaffolds.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readJsonc } = require('./jsonc');

const PAYMENTS_WORDS = /\b(payments?|checkout|billing|subscriptions?)\b/i;
const PAYMENTS_PROVIDERS = /\b(stripe|paddle|lemon ?squeezy|braintree|paypal|adyen|chargebee|recurly|revenuecat|polar\.sh)\b/i;
const PAYMENTS_ENV = /^(STRIPE|NEXT_PUBLIC_STRIPE|PADDLE|LEMONSQUEEZY|LEMON_SQUEEZY|BRAINTREE|PAYPAL|ADYEN|CHARGEBEE|RECURLY|REVENUECAT)_/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo']);

const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

// The job blocks under `jobs:`, keyed by job id. Simple indentation parse, no YAML schema.
function jobsOf(yml) {
  const lines = yml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return {};
  const jobs = {};
  let current = null;
  let indent = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^(\s+)([\w-]+):\s*$/.exec(line);
    if (m && (indent === null || m[1].length === indent)) {
      indent = m[1].length;
      current = m[2];
      jobs[current] = `${current}\n`;
      continue;
    }
    if (current) jobs[current] += `${line.replace(/\s+#.*$/, '')}\n`;
  }
  return jobs;
}

const anyJob = (jobs, re) => Object.values(jobs).some((text) => re.test(text));

function walkEnvExamples(dir, out, depth = 0) {
  if (depth > 5) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkEnvExamples(path.join(dir, e.name), out, depth + 1); }
    else if (e.name === '.env.example') out.push(path.join(dir, e.name));
  }
}

// PRD Section 4 (Technical Architecture) of docs/prd-*.md or docs/prd.md.
function prdSection4(root) {
  const docs = path.join(root, 'docs');
  let files = [];
  try { files = fs.readdirSync(docs).filter((f) => /^prd(-.*)?\.md$/i.test(f)).sort(); } catch { files = []; }
  return files.map((f) => {
    const text = read(path.join(docs, f)) ?? '';
    const m = /^##\s+(?:Section\s+)?4\b[^\n]*\n([\s\S]*?)(?=^##\s+(?:Section\s+)?\d|(?![\s\S]))/m.exec(text);
    return m ? m[1] : '';
  }).join('\n');
}

// quality.tier from bytheslice.config.json, with auto resolved as /final-quality-check documents.
function resolveTier(root) {
  let configured = 'standard';
  const notes = [];
  try {
    const config = readJsonc(path.join(root, 'bytheslice.config.json'));
    const t = config?.quality?.tier;
    if (t !== undefined) {
      if (['standard', 'lean', 'auto'].includes(t)) configured = t;
      else notes.push(`quality.tier "${t}" is not standard, lean or auto; read as standard`);
    }
  } catch {
    notes.push('bytheslice.config.json is not valid JSONC; quality.tier read as standard');
  }
  const checklist = read(path.join(root, 'docs', 'plans', '00_master_checklist.md'));
  if (configured !== 'auto') return { configured, tier: configured, reason: configured, notes, checklist };
  if (!checklist) return { configured, tier: 'standard', reason: 'auto: no master checklist', notes, checklist };

  const pies = [...checklist.matchAll(/^##\s+Pie\s+(\d+)\b[^\n]*$/gm)].filter((m) => Number(m[1]) >= 2);
  const headings = [...checklist.matchAll(/^#{2,3}\s+(Pie|Slice)\s+[\d.]+\w*\b[^\n]*$/gm)].map((m) => m[0]);
  const payments = [];
  if (headings.some((h) => PAYMENTS_WORDS.test(h))) payments.push('a pie or slice about payments');
  if (PAYMENTS_PROVIDERS.test(prdSection4(root))) payments.push('a payments provider in PRD Section 4');
  const envs = [];
  walkEnvExamples(root, envs);
  for (const f of envs) {
    const keys = (read(f) ?? '').split(/\r?\n/).map((l) => /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=?/.exec(l)?.[1]).filter(Boolean);
    if (keys.some((k) => PAYMENTS_ENV.test(k))) { payments.push(`a payments key in ${path.relative(root, f)}`); break; }
  }
  const lean = pies.length <= 3 && payments.length === 0;
  const reason = lean
    ? `auto: ${pies.length} feature ${pies.length === 1 ? 'pie' : 'pies'}, no payments`
    : `auto: ${pies.length} feature pies${payments.length ? `, ${payments.join(', ')}` : ''}`;
  return { configured, tier: lean ? 'lean' : 'standard', reason, notes, checklist };
}

function designSystemPresent(root, checklist) {
  if (fs.existsSync(path.join(root, 'docs', 'design-system.md'))) return true;
  if (!checklist) return false;
  return checklist.split(/\r?\n/).some((l) => /^\s*-\s*\[x\]/i.test(l) && /(Slice\s+1\.1\b|display case)/i.test(l));
}

function detect(root) {
  const { configured, tier, reason, notes, checklist } = resolveTier(root);
  const lean = tier === 'lean';
  const ds = designSystemPresent(root, checklist);
  const summary = [];

  // 1. ci.yml with typecheck, lint and a test-style job; lean also needs build and the smoke job.
  const ciText = read(path.join(root, '.github', 'workflows', 'ci.yml'));
  const jobs = ciText ? jobsOf(ciText) : {};
  const pkg = (() => { try { return JSON.parse(read(path.join(root, 'package.json')) ?? '{}'); } catch { return {}; } })();
  const hasSmokeScript = Boolean(pkg.scripts && pkg.scripts['test:e2e:smoke']);
  const ci = {
    exists: ciText !== null,
    has_typecheck_job: anyJob(jobs, /typecheck|type-check|\btsc\b/i),
    has_lint_job: anyJob(jobs, /\blint\b/i),
    has_test_job: anyJob(jobs, /\b(test|unit|integration|e2e)/i),
    has_build_job: anyJob(jobs, /\bbuild\b/i),
    has_smoke_job: Object.keys(jobs).includes('e2e-smoke') || anyJob(jobs, /test:e2e:smoke/),
  };
  let ciComplete = ci.exists && ci.has_typecheck_job && ci.has_lint_job && ci.has_test_job;
  if (lean && ci.exists) {
    if (!ci.has_build_job) ciComplete = false;
    if (!ci.has_smoke_job) {
      if (hasSmokeScript) ciComplete = false;
      else summary.push('lean ci.yml has no smoke job and package.json has no test:e2e:smoke script (E2E was skipped for a non-browser app), so it still counts as complete');
    }
  }

  // 2. design-system-compliance.yml: existence; under lean only when a design system exists.
  const dsc = { exists: fs.existsSync(path.join(root, '.github', 'workflows', 'design-system-compliance.yml')), required: !lean || ds };

  // 3. .husky/pre-push running the slice tier; the old full chain also counts, flagged for the swap.
  const hookRaw = read(path.join(root, '.husky', 'pre-push'));
  const hook = (hookRaw ?? '').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  const legacy = /test:e2e:feature|test:e2e:regression|check:design-system/.test(hook);
  const sliceTier = /\blint\b/.test(hook) && /\btypecheck\b|type-check/.test(hook) && /\btest\b/.test(hook) && /\bbuild\b/.test(hook);
  const husky = { exists: hookRaw !== null, looks_canonical: hookRaw !== null && (sliceTier || legacy), legacy_full_chain: hookRaw !== null && legacy };

  // 4. The PR template: existence only.
  const prt = { exists: fs.existsSync(path.join(root, '.github', 'pull_request_template.md')) };

  const missing = [];
  if (!ci.exists) missing.push('ci.yml');
  else if (!ciComplete) {
    const gaps = [];
    if (!ci.has_typecheck_job) gaps.push('typecheck');
    if (!ci.has_lint_job) gaps.push('lint');
    if (!ci.has_test_job) gaps.push('test');
    if (lean && !ci.has_build_job) gaps.push('build');
    if (lean && !ci.has_smoke_job && hasSmokeScript) gaps.push('e2e-smoke');
    missing.push(`ci.yml (no ${gaps.join(', ')} job)`);
  }
  if (dsc.required && !dsc.exists) missing.push('design-system-compliance.yml');
  if (!husky.exists) missing.push('husky/pre-push');
  else if (!husky.looks_canonical) missing.push('husky/pre-push (does not run lint, typecheck, test and build)');
  if (!prt.exists) missing.push('pull_request_template.md');

  if (husky.legacy_full_chain) summary.push('.husky/pre-push still runs the old full chain; husky-installer can swap it for the slice tier');
  summary.unshift(`quality tier ${tier} (${reason}); design system ${ds ? 'present' : 'absent'}; ${missing.length ? `missing: ${missing.join(', ')}` : 'every required marker present'}`);

  return {
    ci_cd_ready: missing.length === 0,
    quality_tier: tier,
    quality_tier_configured: configured,
    quality_tier_reason: reason,
    design_system_present: ds,
    markers: { ci_yml: ci, design_system_compliance_yml: dsc, husky_pre_push: husky, pull_request_template_md: prt },
    missing,
    missing_markers: missing,
    summary: summary.join('. '),
    notes,
  };
}

function main() {
  const argv = process.argv.slice(2);
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = path.resolve(argv[++i] ?? '');
    else {
      process.stderr.write(`detect-ci: unknown argument ${argv[i]}\nusage: detect-ci.js [--root <project-root>]\n`);
      process.exit(1);
    }
  }
  if (!fs.existsSync(root)) {
    process.stderr.write(`detect-ci: ${root} does not exist\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(detect(root))}\n`);
}

module.exports = { jobsOf, resolveTier, designSystemPresent, detect };

if (require.main === module) main();
