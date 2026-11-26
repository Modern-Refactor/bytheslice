#!/usr/bin/env node
// skills/final-quality-check/scripts/run-gates.js
// Runs the /final-quality-check Phase 4 local verification gates (lint, typecheck, check:design-system, unit/integration, build, the e2e suites) with the detected package manager, writes each gate's full log to a file, generates the first visual baselines when none exist, and prints only a JSON summary. Replaces the local-gates-runner agent. Exit codes follow skills/sell-slice/references/script-contract.md: 0 ran (a failed gate is overall: fail in the JSON), 2 needs_human, 1 a real error (a usage error included).
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

const USAGE = 'usage: run-gates.js [--cwd <project-root>] [--pm pnpm|npm|yarn|bun] [--tier standard|lean] [--design-system] [--skip-e2e] [--only <name,...>] [--log-dir <dir>] [--baselines-dir <dir>[,<dir>...]]... [--first-run] [--tail-lines <n>] [--gate-timeout-ms <n>]';

// The default visual baselines folder (a single-app plan); a per-app E2E plan passes each app's folder.
const DEFAULT_BASELINES = path.join('tests', 'visual', 'baselines');

function parseArgs(argv) {
  const out = { tier: 'standard', only: [], baselinesDirs: [], tailLines: 50, gateTimeoutMs: 0 };
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
    else if (a === '--cwd' || a === '--root') out.cwd = value(++i, a);
    else if (a === '--pm') out.pm = value(++i, a);
    else if (a === '--tier') out.tier = value(++i, a);
    else if (a === '--only') out.only.push(...value(++i, a).split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--log-dir') out.logDir = value(++i, a);
    else if (a === '--baselines-dir') out.baselinesDirs.push(...value(++i, a).split(',').map((s) => s.trim()).filter(Boolean));
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
// Extra arguments go after `--`. npm, pnpm, bun and Yarn 1 drop that first `--` and hand the rest to the
// script; Yarn 2+ (berry) forwards everything after the script name as is, so it gets no `--` of its own.
function commandFor(pm, script, extra = [], { yarnBerry = false } = {}) {
  const args = ['run', script];
  if (extra.length) args.push(...(pm === 'yarn' && yarnBerry ? extra : ['--', ...extra]));
  return args;
}

// A script that runs a Turborepo pipeline (`turbo run test:e2e:visual`, `turbo test:e2e:visual`) takes its own
// flags first: the runner's flags must follow a second `--` so turbo passes them through to each task.
const isTurbo = (command) => /(?:^|[\s;&|(])(?:npx\s+|pnpm\s+(?:exec\s+)?|yarn\s+|bunx\s+)?turbo(?:\s|$)/.test(String(command || ''));

// The runner arguments for a script: turbo pipelines get the `--` passthrough.
function runnerArgs(scriptCommand, flags) {
  return isTurbo(scriptCommand) ? ['--', ...flags] : flags;
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

// The one needs_human shape every skill script prints (script-contract.md); extra facts sit beside it.
function needsHuman(category, question, context, extra = {}) {
  return { needs_human: { category, question, context }, ...extra };
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
  let emptyDirs = [];
  if (g.visual) {
    const perDir = ctx.baselinesDirs.map((d) => listFiles(d));
    baselinesBefore = perDir.flat();
    emptyDirs = ctx.baselinesDirs.filter((d, i) => perDir[i].length === 0);
    // Playwright fails a screenshot assertion that has no baseline, so the first run writes them. Only when every
    // baselines folder is empty: --update-snapshots would rewrite the baselines an app already has.
    generating = args.firstRun || emptyDirs.length === ctx.baselinesDirs.length;
    if (generating) extra = runnerArgs(ctx.scripts[g.script], ['--update-snapshots']);
  }
  const argv = commandFor(pm, g.script, extra, { yarnBerry: ctx.yarnBerry });
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
    out.new_baselines = ctx.baselinesDirs.flatMap((d) => listFiles(d)).filter((p) => !before.has(p)).map((p) => path.relative(cwd, p));
    out.baselines_dirs = ctx.baselinesDirs.map((d) => path.relative(cwd, d) || '.');
    if (passed && generating) out.status = 'baselines_generated';
    if (!generating && emptyDirs.length) {
      // Some apps have baselines and some do not: nothing is regenerated. Playwright's default mode writes the
      // missing ones and fails those tests once; the next run compares them.
      out.empty_baselines_dirs = emptyDirs.map((d) => path.relative(cwd, d) || '.');
    }
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
    process.exit(1);
  }
  const cwd = path.resolve(args.cwd || process.cwd());
  const logDir = path.resolve(cwd, args.logDir || path.join('.claude', '.bytheslice-state', 'gates'));
  // stdout carries this one JSON line and nothing else; exitCode (not exit()) lets it flush. summary.json always
  // holds the last result, needs_human included: the kitchen reads its time as the end of a background run.
  const emit = (obj, code) => {
    try {
      if (fs.existsSync(cwd)) {
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(path.join(logDir, 'summary.json'), `${JSON.stringify(obj, null, 2)}\n`);
      }
    } catch { /* The summary file is a convenience; stdout is the result. */ }
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
  const probe = spawnSync(pm, ['--version'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });
  if (probe.error || probe.status !== 0) {
    emit(needsHuman('external_credentials', `The ${pm} package manager is not installed or not on PATH, so the local gates cannot run. Install it (or name the right one) and rerun?`, `run-gates: ${pm} --version ${probe.error ? `failed: ${probe.error.code}` : `exited ${probe.status}`} (package manager from ${detected.source})`, { missing_tooling: [pm] }), 2);
  }

  const entries = plan(args, scripts);
  const missing = entries.filter((e) => e.gate && !e.defined).map((e) => e.script);
  if (missing.length) {
    emit(needsHuman('prd_ambiguity', `package.json has no ${missing.map((s) => `"${s}"`).join(', ')} script, so ${missing.length === 1 ? 'that gate' : 'those gates'} cannot run. Rerun sub-block A to add ${missing.length === 1 ? 'it' : 'them'}, or say which command to use?`, `run-gates: ${args.tier} tier requires ${missing.join(', ')}`, { missing_scripts: missing }), 2);
  }

  fs.mkdirSync(logDir, { recursive: true });
  const yarnBerry = pm === 'yarn' && Number(String(probe.stdout || '').trim().split('.')[0]) >= 2;
  const baselinesDirs = (args.baselinesDirs.length ? args.baselinesDirs : [DEFAULT_BASELINES]).map((d) => path.resolve(cwd, d));
  const ctx = { pm, cwd, logDir, args, scripts, yarnBerry, baselinesDirs };

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
  // Exit 0 either way: the gates ran, and a failed gate is overall: fail in the JSON. Exit 1 is a real error only.
  emit(summary, 0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    if (!(err instanceof Done)) throw err;
  }
}

module.exports = { GATES, parseArgs, commandFor, runnerArgs, isTurbo, detectPm, failedSpecs, plan, needsHuman };
