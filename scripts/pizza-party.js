#!/usr/bin/env node
// scripts/pizza-party.js
// /pizza-party's helper: `preflight` reports which tools and providers this machine has authorized (read-only, never a secret), `record` appends one run record to the machine-level run log, and `runs` prints the log as a table so runs of the same brief can be compared across models and plugin versions. Zero dependencies.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const HOME = process.env.BTS_HOME || path.join(os.homedir(), '.bytheslice');
const RUNS = path.join(HOME, 'pizza-party', 'runs.jsonl');
const TICKET = path.join('docs', 'pizza-party', 'order.md');

/**
 * Provider CLIs and the read-only command that succeeds only when one is
 * logged in. Order is alphabetical inside each kind: none is a default.
 */
const PROVIDERS = {
  hosts: [
    { name: 'cloudflare', bin: 'wrangler', args: ['whoami'] },
    { name: 'fly', bin: 'fly', args: ['auth', 'whoami'] },
    { name: 'netlify', bin: 'netlify', args: ['status'] },
    { name: 'railway', bin: 'railway', args: ['whoami'] },
    { name: 'render', bin: 'render', args: ['whoami'] },
    { name: 'vercel', bin: 'vercel', args: ['whoami'] },
  ],
  databases: [
    { name: 'neon', bin: 'neonctl', args: ['me'] },
    { name: 'supabase', bin: 'supabase', args: ['projects', 'list'] },
    { name: 'turso', bin: 'turso', args: ['auth', 'whoami'] },
  ],
};

/** True when a command exits 0 within the timeout; its output is never kept. */
function succeeds(bin, args, cwd) {
  const run = spawnSync(bin, args, { cwd, stdio: 'ignore', timeout: 8000, env: { ...process.env, CI: '1', NO_COLOR: '1' } });
  return run.status === 0;
}

function has(bin) {
  // `bin` is always one of this file's own constants, never input.
  return spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;
}

/** The folder itself, else its nearest existing parent: a check run in a missing folder fails before it starts. */
function existingDir(dir) {
  let at = dir;
  while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  return at;
}

/** What this machine can do for an unattended build, as JSON on stdout. */
function preflight(root) {
  const target = path.resolve(root || process.cwd());
  // A new app's folder does not exist yet: the provider checks run from its nearest parent.
  const cwd = existingDir(target);
  const tools = {};
  for (const bin of ['git', 'node', 'pnpm', 'npm', 'gh', 'npx']) tools[bin] = has(bin);
  const out = {
    root: target,
    tools,
    github: tools.gh && succeeds('gh', ['auth', 'status'], cwd),
    hosts: [],
    databases: [],
    folder: { exists: fs.existsSync(target), empty: !fs.existsSync(target) || fs.readdirSync(target).filter(n => n !== '.DS_Store').length === 0 },
    checklist: fs.existsSync(path.join(target, 'docs', 'plans', '00_master_checklist.md')),
    ticket: fs.existsSync(path.join(target, TICKET)),
  };
  for (const [kind, list] of Object.entries(PROVIDERS)) {
    for (const p of list) {
      const installed = has(p.bin);
      out[kind].push({ name: p.name, cli: installed, authorized: installed && succeeds(p.bin, p.args, cwd) });
    }
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([\w-]+)$/.exec(argv[i]);
    if (m) {
      out[m[1]] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
    } else if (out._ === undefined) out._ = argv[i];
  }
  return out;
}

/** The order ticket's sections the run record counts (skills/pizza-party/references/decision-routing.md); `legacy` is the pre-7.2.0 one. */
const SECTIONS = Object.freeze({
  yourCall: 'Your call',
  team: 'Decided by the team',
  waiting: 'Waiting on the stand-in',
  deferred: 'Deferred',
  legacy: 'Decisions made without you',
});

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Counts the list items under one `## <heading>` of the order ticket. The
 * heading must match whole (trailing spaces allowed), so a heading that only
 * starts with the name asked for (`## Your call later` for `Your call`) never
 * counts as it.
 */
function ticketCount(text, heading) {
  const at = String(text).search(new RegExp(`^##[ \\t]+${escapeRegExp(heading)}[ \\t]*\\r?$`, 'mi'));
  if (at === -1) return 0;
  const section = String(text).slice(at).split(/\n(?=##\s)/)[0];
  return section
    .split('\n')
    .slice(1)
    .filter(line => /^\s*[-*]\s+\S/.test(line)).length;
}

/** Every decision count the run record keeps, from the ticket text; `decisions` is the total, legacy lines included. */
function ticketCounts(text) {
  const yourCall = ticketCount(text, SECTIONS.yourCall);
  const legacy = ticketCount(text, SECTIONS.legacy);
  const teamDecisions = ticketCount(text, SECTIONS.team) + legacy;
  return {
    decisions: yourCall + teamDecisions,
    yourCall,
    teamDecisions,
    waiting: ticketCount(text, SECTIONS.waiting),
    deferred: ticketCount(text, SECTIONS.deferred),
  };
}

const STAND_IN = 'stand-in-operator';
const ACTIVITY_DIR = path.join('.claude', '.bytheslice-state', 'kitchen');

/** An agent type as the repo counts it (mcp/kitchen-state.js roleOfType): plugin prefix dropped, a retired name resolved. */
const roleOfType = (() => {
  try {
    return require('../mcp/kitchen-state.js').roleOfType;
  } catch {
    return type => {
      const name = String(type || '');
      return name.slice(name.lastIndexOf(':') + 1);
    };
  }
})();

const readOrEmpty = file => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

/**
 * How many times the run dispatched the stand-in operator. Two records see
 * them: the kitchen activity log (every SubagentStart, phase boundaries
 * included, but it keeps only one rotation) and the ledger's slice.rollup
 * rows (per-role counts that survive rotation, but only inside a slice). Each
 * undercounts in its own way, so the larger of the two is the count.
 */
function standInDispatches(root) {
  const starts = new Set();
  for (const name of ['activity.1.jsonl', 'activity.jsonl']) {
    for (const line of readOrEmpty(path.join(root, ACTIVITY_DIR, name)).split('\n')) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row === null || typeof row !== 'object' || row.ev !== 'SubagentStart' || roleOfType(row.agent) !== STAND_IN) continue;
      starts.add(typeof row.aid === 'string' && row.aid !== '' ? row.aid : `${row.t}|${row.sid ?? ''}`);
    }
  }
  let rolled = 0;
  try {
    const ledger = require('./ledger-summary.js');
    const text = ledger.readLedgerText(ledger.ledgerFile(ledger.resolveRoot(root)));
    // A slice can be rolled up more than once: its newest rollup holds its totals.
    const latest = new Map();
    for (const row of ledger.parseRows(text ?? '')) {
      if (row.ev === 'slice.rollup' && row.slice && row.data && typeof row.data.agents === 'object') latest.set(row.slice, row.data.agents);
    }
    for (const agents of latest.values()) {
      for (const [role, totals] of Object.entries(agents ?? {})) {
        if (roleOfType(role) === STAND_IN && Number.isSafeInteger(totals?.count)) rolled += totals.count;
      }
    }
  } catch {
    // No ledger, or an unreadable one: the activity log alone.
  }
  return Math.max(starts.size, rolled);
}

/** The ledger totals for a project, through scripts/ledger-summary.js; null without a ledger. */
function ledgerTotals(root) {
  try {
    const json = execFileSync(process.execPath, [path.join(__dirname, 'ledger-summary.js'), '--root', root, '--format', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20000,
    });
    return JSON.parse(json).totals ?? null;
  } catch {
    return null;
  }
}

/** Appends one run record to ~/.bytheslice/pizza-party/runs.jsonl and prints it. */
function record(opts) {
  const root = path.resolve(opts.root || process.cwd());
  const ticket = fs.existsSync(path.join(root, TICKET)) ? fs.readFileSync(path.join(root, TICKET), 'utf8') : '';
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const startedAt = Number(opts.started) || null;
  const row = {
    v: 1,
    t: Date.now(),
    brief: opts.brief || path.basename(root),
    app: path.basename(root),
    plugin: pkg.version,
    model: opts.model || null,
    outcome: ['shipped', 'partial', 'failed'].includes(opts.outcome) ? opts.outcome : 'partial',
    url: typeof opts.url === 'string' ? opts.url : null,
    urlKind: ['deployed', 'artifact', 'localhost'].includes(opts['url-kind']) ? opts['url-kind'] : null,
    wallMs: startedAt ? Date.now() - startedAt : null,
    ...ticketCounts(ticket),
    standInDispatches: standInDispatches(root),
    acceptance: opts.acceptance || null,
    ledger: ledgerTotals(root),
  };
  fs.mkdirSync(path.dirname(RUNS), { recursive: true });
  fs.appendFileSync(RUNS, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
}

/** Prints the run log as a table, newest first; `--brief <id>` keeps one brief. */
function runs(opts) {
  const text = fs.existsSync(RUNS) ? fs.readFileSync(RUNS, 'utf8') : '';
  const rows = text
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    })
    .filter(row => opts.brief === undefined || row.brief === opts.brief)
    .sort((a, b) => b.t - a.t);
  if (rows.length === 0) return process.stdout.write(`No pizza-party runs recorded${opts.brief ? ` for ${opts.brief}` : ''} (${RUNS}).\n`);
  const hours = ms => (ms === null || ms === undefined ? '' : (ms / 3600000).toFixed(1));
  const lines = [
    '| Date | Brief | Plugin | Model | Outcome | Hours | Cost | Slices done | Fix loops | Decisions | Your call | Deferred | Acceptance | URL |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const l = r.ledger || {};
    lines.push(
      `| ${new Date(r.t).toISOString().slice(0, 10)} | ${r.brief} | ${r.plugin} | ${r.model ?? ''} | ${r.outcome} | ${hours(r.wallMs)} | ${
        l.costUsd === null || l.costUsd === undefined ? '' : `$${l.costUsd.toFixed(2)}`
      } | ${l.slicesDone ?? ''}/${l.slices ?? ''} | ${l.fixLoops ?? ''} | ${r.decisions} | ${r.yourCall ?? ''} | ${r.deferred} | ${r.acceptance ?? ''} | ${r.url ?? ''} |`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main(argv) {
  const [command, ...rest] = argv;
  const opts = args(rest);
  if (command === 'preflight') return preflight(opts._);
  if (command === 'record') return record({ ...opts, root: opts.root ?? opts._ });
  if (command === 'runs') return runs(opts);
  process.stderr.write(
    'usage: pizza-party.js preflight [root] | record [root] --brief <id> --outcome shipped|partial|failed [--url <u> --url-kind deployed|artifact|localhost --model <m> --started <ms> --acceptance <n/m>] | runs [--brief <id>]\n',
  );
  process.exitCode = 2;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { ticketCount, ticketCounts, standInDispatches, SECTIONS, PROVIDERS, RUNS };
