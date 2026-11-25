#!/usr/bin/env node
// skills/final-quality-check/scripts/run-gates.js
// Runs the /final-quality-check Phase 4 local verification gates (lint, typecheck, check:design-system, unit/integration, build, the e2e suites) with the detected package manager, writes each gate's full log to a file, generates the first visual baselines when none exist, and prints only a JSON summary. Replaces the local-gates-runner agent.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PMS = ['pnpm', 'npm', 'yarn', 'bun'];
const LOCKFILES = [['pnpm-lock.yaml', 'pnpm'], ['package-lock.json', 'npm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun']];

// Execution order. `tiers` lists where a gate applies; `optional` gates run only when the
// project defines the script (and are not_applicable otherwise); every other applicable gate
// is required, and a missing required script is a needs_human exit, never a silent skip.
const GATES = [
  { name: 'lint', script: 'lint', tiers: ['standard', 'lean'] },
  { name: 'typecheck', script: 'typecheck', tiers: ['standard', 'lean'] },
  { name: 'check_design_system', script: 'check:design-system', tiers: ['standard', 'lean'], leanNeedsDesignSystem: true },
  { name: 'unit_integration', script: 'test', tiers: ['standard', 'lean'] },
  { name: 'integration', script: 'test:integration', tiers: ['standard'], optional: true },
  { name: 'build', script: 'build', tiers: ['lean', 'standard'], optionalIn: ['standard'] },
  { name: 'feature_e2e', script: 'test:e2e:feature', tiers: ['standard'], e2e: true },
  { name: 'regression_core_e2e', script: 'test:e2e:regression', tiers: ['standard'], e2e: true },
  { name: 'visual_e2e', script: 'test:e2e:visual', tiers: ['standard'], e2e: true, visual: true },
  { name: 'smoke_e2e', script: 'test:e2e:smoke', tiers: ['lean'], e2e: true, optional: true },
];

class UsageError extends Error {}
class Done extends Error {}

const USAGE = 'usage: run-gates.js [--cwd <dir>] [--pm pnpm|npm|yarn|bun] [--tier standard|lean] [--design-system] [--skip-e2e] [--only <name,...>] [--log-dir <dir>] [--baselines-dir <dir>] [--first-run] [--tail-lines <n>] [--gate-timeout-ms <n>]';

function parseArgs(argv) {
  const out = { tier: 'standard', only: [], tailLines: 50, gateTimeoutMs: 0 };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--design-system') out.designSystem = true;
    else if (a === '--skip-e2e') out.skipE2e = true;
    else if (a === '--first-run') out.firstRun = true;
    else if (a === '--cwd') out.cwd = value(++i, a);
    else if (a === '--pm') out.pm = value(++i, a);
    else if (a === '--tier') out.tier = value(++i, a);
    else if (a === '--only') out.only.push(...value(++i, a).split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--log-dir') out.logDir = value(++i, a);
    else if (a === '--baselines-dir') out.baselinesDir = value(++i, a);
    else if (a === '--tail-lines') out.tailLines = Number(value(++i, a));
    else if (a === '--gate-timeout-ms') out.gateTimeoutMs = Number(value(++i, a));
    else throw new UsageError(`unknown argument ${a}`);
  }
  if (!['standard', 'lean'].includes(out.tier)) throw new UsageError('--tier must be standard or lean');
  if (out.pm && !PMS.includes(out.pm)) throw new UsageError(`--pm must be one of ${PMS.join(', ')}`);
  if (!Number.isInteger(out.tailLines) || out.tailLines < 0) throw new UsageError('--tail-lines must be a whole number');
  if (!Number.isInteger(out.gateTimeoutMs) || out.gateTimeoutMs < 0) throw new UsageError('--gate-timeout-ms must be a whole number');
  const known = new Set(GATES.flatMap((g) => [g.name, g.script]));
  for (const name of out.only) if (!known.has(name)) throw new UsageError(`--only: unknown gate ${name}`);
  return out;
}

function detectPm(cwd) {
  for (const [file, pm] of LOCKFILES) if (fs.existsSync(path.join(cwd, file))) return { pm, source: file };
  return { pm: 'npm', source: 'default (no lockfile)' };
}

// `<pm> run <script>` for every manager: bare `bun test` is bun's own runner, and bare `npm lint` is not a script call.
function commandFor(pm, script, extra = []) {
  const args = ['run', script];
  if (extra.length) args.push(...(pm === 'npm' ? ['--', ...extra] : extra));
  return args;
}

function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name !== '.gitkeep') out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function tailOf(file, n) {
  if (!n) return '';
  const lines = fs.readFileSync(file, 'utf8').replace(/\n+$/, '').split('\n');
  return lines.slice(-n).join('\n');
}

// Best effort over Playwright's list/line reporter: "  1) [feature] › e2e/feature/smoke.spec.ts:4:3 › ...".
function failedSpecs(file) {
  const specs = new Set();
  const re = /^\s*\d+\)\s+(?:\[[^\]]*\]\s+›\s+)?(\S+?\.(?:spec|test)\.[cm]?[jt]sx?):\d+/;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(re);
    if (m) specs.add(m[1]);
  }
  return [...specs];
}

function needsHuman(category, question, context, extra = {}) {
  return { needs_human: { hitl_category: category, hitl_question: question, hitl_context: context, ...extra } };
}

function plan(args, scripts) {
  return GATES.map((g) => {
    const selected = !args.only.length || args.only.includes(g.name) || args.only.includes(g.script);
    if (!selected) return null;
    const base = { name: g.name, script: g.script };
    if (!g.tiers.includes(args.tier)) return { ...base, status: 'not_applicable', reason: `not in the ${args.tier} tier` };
    if (args.tier === 'lean' && g.leanNeedsDesignSystem && !args.designSystem) return { ...base, status: 'not_applicable', reason: 'no design system' };
    if (g.e2e && args.skipE2e) return { ...base, status: 'not_applicable', reason: 'E2E skipped' };
    const optional = g.optional || (g.optionalIn || []).includes(args.tier);
    const defined = Object.prototype.hasOwnProperty.call(scripts, g.script);
    if (!defined && optional) return { ...base, status: 'not_applicable', reason: 'script not defined' };
    return { ...base, gate: g, defined };
  }).filter(Boolean);
}

function runGate(entry, ctx) {
  const { pm, cwd, logDir, args } = ctx;
  const g = entry.gate;
  const log = path.join(logDir, `${g.name}.log`);
  let extra = [];
  let baselinesBefore = null;
  let generating = false;
  if (g.visual) {
    baselinesBefore = listFiles(ctx.baselinesDir);
    generating = args.firstRun || baselinesBefore.length === 0;
    // Playwright fails a screenshot assertion that has no baseline, so the first run writes them.
    if (generating) extra = ['--update-snapshots'];
  }
  const argv = commandFor(pm, g.script, extra);
  const fd = fs.openSync(log, 'w');
  const started = Date.now();
  const res = spawnSync(pm, argv, {
    cwd,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, FORCE_COLOR: '0' },
    shell: process.platform === 'win32',
    timeout: args.gateTimeoutMs || undefined,
    killSignal: 'SIGTERM',
  });
  const duration = Date.now() - started;
  fs.closeSync(fd);
  const timedOut = Boolean(res.error && res.error.code === 'ETIMEDOUT');
  if (res.error && !timedOut) fs.appendFileSync(log, `\nrun-gates: could not start ${pm}: ${res.error.message}\n`);
  if (timedOut) fs.appendFileSync(log, `\nrun-gates: killed after ${args.gateTimeoutMs} ms (--gate-timeout-ms)\n`);
  const exitCode = typeof res.status === 'number' ? res.status : null;
  const passed = exitCode === 0 && !timedOut;
  const out = {
    name: g.name,
    script: g.script,
    command: [pm, ...argv].join(' '),
    status: passed ? 'pass' : 'fail',
    exit_code: exitCode,
    duration_ms: duration,
    log: path.relative(cwd, log) || log,
    tail: passed ? null : tailOf(log, args.tailLines),
  };
  if (timedOut) out.timed_out = true;
  if (res.signal && !passed) out.signal = res.signal;
  if (g.e2e && !passed) out.failed_specs = failedSpecs(log);
  if (g.visual) {
    const before = new Set(baselinesBefore);
    out.new_baselines = listFiles(ctx.baselinesDir).filter((p) => !before.has(p)).map((p) => path.relative(cwd, p));
    if (passed && generating) out.status = 'baselines_generated';
  }
  return out;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`run-gates: ${err.message}\n${USAGE}\n`);
    process.exit(64);
  }
  const cwd = path.resolve(args.cwd || process.cwd());
  // stdout carries this one JSON line and nothing else; exitCode (not exit()) lets it flush.
  const emit = (obj, code) => {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
    process.exitCode = code;
    throw new Done();
  };

  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    emit(needsHuman('prd_ambiguity', 'There is no package.json at the project root, so no gate can run. Where does the app live?', `run-gates looked in ${cwd}`), 2);
  }
  let scripts;
  try {
    scripts = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts || {};
  } catch (err) {
    emit(needsHuman('prd_ambiguity', 'package.json does not parse, so the gate scripts cannot be read. Fix it before the local gates run?', `run-gates: ${err.message}`), 2);
  }

  const detected = args.pm ? { pm: args.pm, source: '--pm' } : detectPm(cwd);
  const pm = detected.pm;
  const probe = spawnSync(pm, ['--version'], { cwd, stdio: 'ignore', shell: process.platform === 'win32' });
  if (probe.error || probe.status !== 0) {
    emit(needsHuman('external_credentials', `The ${pm} package manager is not installed or not on PATH, so the local gates cannot run. Install it (or name the right one) and rerun?`, `run-gates: ${pm} --version ${probe.error ? `failed: ${probe.error.code}` : `exited ${probe.status}`} (package manager from ${detected.source})`, { missing_tooling: [pm] }), 2);
  }

  const entries = plan(args, scripts);
  const missing = entries.filter((e) => e.gate && !e.defined).map((e) => e.script);
  if (missing.length) {
    emit(needsHuman('prd_ambiguity', `package.json has no ${missing.map((s) => `"${s}"`).join(', ')} script, so ${missing.length === 1 ? 'that gate' : 'those gates'} cannot run. Rerun sub-block A to add ${missing.length === 1 ? 'it' : 'them'}, or say which command to use?`, `run-gates: ${args.tier} tier requires ${missing.join(', ')}`, { missing_scripts: missing }), 2);
  }

  const logDir = path.resolve(cwd, args.logDir || path.join('.claude', '.bytheslice-state', 'gates'));
  fs.mkdirSync(logDir, { recursive: true });
  const ctx = { pm, cwd, logDir, args, baselinesDir: path.resolve(cwd, args.baselinesDir || path.join('tests', 'visual', 'baselines')) };

  // Every gate runs, even after an earlier failure, so the conductor gets the full picture.
  const gates = entries.map((e) => (e.gate ? runGate(e, ctx) : { name: e.name, script: e.script, status: e.status, reason: e.reason }));
  const overall = gates.some((g) => g.status === 'fail') ? 'fail' : 'pass';
  const summary = {
    overall,
    tier: args.tier,
    package_manager: pm,
    log_dir: path.relative(cwd, logDir) || logDir,
    new_baselines: gates.flatMap((g) => g.new_baselines || []),
    gates,
  };
  fs.writeFileSync(path.join(logDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  emit(summary, overall === 'pass' ? 0 : 1);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    if (!(err instanceof Done)) throw err;
  }
}

module.exports = { GATES, parseArgs, commandFor, detectPm, failedSpecs, plan };
