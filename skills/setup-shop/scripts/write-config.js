#!/usr/bin/env node
// skills/setup-shop/scripts/write-config.js
// Writes the /setup-shop JSONC config from the elicitation answers: ~/.bytheslice/defaults.json for Flow A, <project-root>/bytheslice.config.json for Flow B and C. The example config is the template; sections the operator did not customize stay as its commented-out hints, and gates.enforcement "fix" is always written.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseJsonc, readJsonc } = require('./jsonc');

const TEMPLATE = path.join(__dirname, '..', 'references', 'bytheslice.config.example.json');
const TIERS = new Set(['haiku', 'sonnet', 'opus', 'fable']);
// The gate classes quality-gates.md defines (tests/quality-gates keeps this list in step with it).
const GATE_CLASSES = ['lint', 'typecheck', 'build', 'tests', 'e2e', 'visual', 'design-system', 'accessibility', 'ci', 'declared'];
const MCP_KEYS = { shadcn: 'shadcn', magic: 'magic', 'magic (21st.dev)': 'magic', figma: 'figma', 'chrome devtools': 'chromeDevTools', chromedevtools: 'chromeDevTools', supabase: 'supabase' };
const SKIP = new Set(['defaults', 'default', 'none', 'skip', 'no']);

// Shapes of a pasted credential. A match refuses the write; the value itself is never printed.
const SECRET_SHAPES = [
  /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{16,}/,
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bsb_secret_[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /:\/\/[^/\s:@]+:[^/\s@]+@/,
  /[?&](token|api[_-]?key|access[_-]?token|secret|password)=[^&\s]+/i,
];

class UsageError extends Error {}
class NeedsHuman extends Error {
  constructor(category, question, context, extra) { super(question); Object.assign(this, { category, question, context, extra }); }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, over) {
  if (!isObject(base) || !isObject(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

// ---------------------------------------------------------------------------
// Answers to config sections.
// ---------------------------------------------------------------------------

const skipped = (v) => v === undefined || v === null || v === false || (typeof v === 'string' && SKIP.has(v.toLowerCase()));

function linesOf(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return null;
}

// The elicitation answers as config sections. Returns { config, ignored, notes }.
function normalize(answers, flow) {
  const config = {};
  const ignored = [];
  const notes = [];
  const a = { ...answers };
  // `flow` is the A/B/C selector only when it is a string; an object is the config's own flow section.
  if (!isObject(a.flow)) delete a.flow;
  delete a.projectRoot;

  // Q-modelTiers: "defaults" and "manual" both leave the commented hints; an object overrides.
  if (isObject(a.modelTiers)) {
    for (const [agent, tier] of Object.entries(a.modelTiers)) if (!TIERS.has(tier)) throw new UsageError(`modelTiers.${agent} must be haiku, sonnet, opus or fable`);
    config.modelTiers = a.modelTiers;
  } else if (a.modelTiers !== undefined && !skipped(a.modelTiers) && a.modelTiers !== 'manual') {
    throw new UsageError('modelTiers must be "defaults", "manual" or an object of agent tiers');
  }
  delete a.modelTiers;

  // Q-stages.
  if (isObject(a.stages)) {
    const { maxTasksPerStage: max, targetFeatureStages: band } = a.stages;
    if (max !== undefined && !(Number.isInteger(max) && max >= 1 && max <= 8)) throw new UsageError('stages.maxTasksPerStage must be an integer from 1 to 8');
    if (band !== undefined && !/^\d+-\d+$/.test(String(band))) throw new UsageError('stages.targetFeatureStages must look like "10-15"');
    config.stages = a.stages;
  }
  delete a.stages;

  // Q-mcps: the multi-select labels, "None", or an object of booleans.
  if (Array.isArray(a.mcps)) {
    const picked = new Set();
    for (const label of a.mcps) {
      const l = String(label).toLowerCase();
      if (l === 'none') continue;
      const key = MCP_KEYS[l];
      if (!key) throw new UsageError(`unknown MCP "${label}"`);
      picked.add(key);
    }
    config.mcps = Object.fromEntries(['shadcn', 'magic', 'figma', 'chromeDevTools', 'supabase'].map((k) => [k, picked.has(k)]));
  } else if (isObject(a.mcps)) config.mcps = a.mcps;
  else if (typeof a.mcps === 'string' && a.mcps.toLowerCase() === 'none') {
    config.mcps = { shadcn: false, magic: false, figma: false, chromeDevTools: false, supabase: false };
  }
  delete a.mcps;

  // Q-visualReview-tools and Q-visualReview-vizzly.
  if (isObject(a.visualReview)) {
    const vr = {};
    const tools = linesOf(a.visualReview.tools);
    if (tools && !skipped(a.visualReview.tools)) vr.tools = tools;
    if (typeof a.visualReview.vizzly === 'boolean') vr.vizzly = a.visualReview.vizzly;
    if (Object.keys(vr).length) config.visualReview = vr;
  }
  delete a.visualReview;

  // Q-hitl: "<name>: <prompt-hint>" lines or { name, promptHint } objects.
  const hitl = isObject(a.hitl) ? a.hitl.additionalCategories : a.hitl;
  if (!skipped(hitl)) {
    const cats = (linesOf(hitl) ?? []).map((entry) => {
      if (isObject(entry)) return entry;
      const m = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(String(entry));
      if (!m) throw new UsageError(`hitl category "${entry}" must read "<name>: <prompt-hint>"`);
      return { name: m[1], promptHint: m[2].trim() };
    });
    if (cats.length) config.hitl = { additionalCategories: cats };
  }
  delete a.hitl;

  // Q-rules: one URL per line.
  const rules = isObject(a.rules) ? a.rules.imports : a.rules;
  if (!skipped(rules)) {
    const imports = linesOf(rules) ?? [];
    if (imports.length) config.rules = { imports };
  }
  delete a.rules;

  // Q-bootstrap-defaults: Flow A only.
  if (isObject(a.bootstrap)) {
    if (flow === 'A') config.bootstrap = a.bootstrap;
    else ignored.push('bootstrap (Flow A only)');
  }
  delete a.bootstrap;

  // Q-gates and Q-gates-declared: enforcement is always "fix".
  const g = isObject(a.gates) ? a.gates : {};
  if (g.enforcement !== undefined && g.enforcement !== 'fix') notes.push(`gates.enforcement "${g.enforcement}" was given; "fix" is the only value and was written instead`);
  const gates = { enforcement: 'fix' };
  const advisory = linesOf(g.advisory) ?? [];
  for (const c of advisory) if (!GATE_CLASSES.includes(c)) throw new UsageError(`gates.advisory "${c}" is not a gate class (${GATE_CLASSES.join(', ')})`);
  if (advisory.length) gates.advisory = [...new Set(advisory)];
  const declared = (linesOf(g.declared) ?? []).map((entry) => {
    if (isObject(entry)) {
      if (typeof entry.command !== 'string' || !entry.command.trim()) throw new UsageError('a gates.declared object needs a command');
      return entry;
    }
    const m = /^([A-Za-z0-9_.-]+):\s+(\S.*)$/.exec(String(entry));
    return m ? { name: m[1], command: m[2].trim() } : String(entry);
  });
  if (declared.length) gates.declared = declared;
  config.gates = gates;
  delete a.gates;

  // Any other section (verification, flow, review, delivery, quality, ui, run, ...) passes through.
  for (const [k, v] of Object.entries(a)) {
    if (isObject(v)) config[k] = v;
    else if (v !== undefined) throw new UsageError(`section ${k} must be an object`);
  }
  return { config, ignored, notes };
}

// run.standIn (the /pizza-party stand-in operator): enabled a boolean, maxDispatches an integer from 0 to 50.
function checkStandIn(run) {
  if (!isObject(run) || run.standIn === undefined) return;
  const standIn = run.standIn;
  if (!isObject(standIn)) throw new UsageError('run.standIn must be an object');
  if (standIn.enabled !== undefined && typeof standIn.enabled !== 'boolean') throw new UsageError('run.standIn.enabled must be true or false');
  const max = standIn.maxDispatches;
  if (max !== undefined && !(Number.isInteger(max) && max >= 0 && max <= 50)) throw new UsageError('run.standIn.maxDispatches must be an integer from 0 to 50');
}

// Path of the first string that looks like a pasted credential, or null.
function findSecret(value, at = '') {
  if (typeof value === 'string') return SECRET_SHAPES.some((re) => re.test(value)) ? at || '(root)' : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) { const hit = findSecret(value[i], `${at}[${i}]`); if (hit) return hit; }
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) { const hit = findSecret(v, at ? `${at}.${k}` : k); if (hit) return hit; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering over the example template.
// ---------------------------------------------------------------------------

// Splits a line into its code and its `//` comment, outside strings.
function splitComment(line) {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) { if (ch === '\\') i += 1; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '/' && line[i + 1] === '/') return [line.slice(0, i), line.slice(i)];
  }
  return [line, ''];
}

const depthOf = (code) => (code.match(/[{[]/g) ?? []).length - (code.match(/[}\]]/g) ?? []).length;

function parseTemplate(text) {
  const lines = text.replace(/\n$/, '').split('\n');
  const open = lines.indexOf('{');
  const close = lines.lastIndexOf('}');
  if (open < 0 || close < 0) throw new Error('the example config has no top-level braces');
  const sections = [];
  let lead = [];
  for (let i = open + 1; i < close; i++) {
    const m = /^ {2}"(\w+)": \{\s*$/.exec(lines[i]);
    if (!m) { lead.push(lines[i]); continue; }
    const body = [];
    let j = i + 1;
    while (j < close && !/^ {2}\},?\s*$/.test(lines[j])) body.push(lines[j++]);
    sections.push({ key: m[1], lead, body });
    lead = [];
    i = j;
  }
  return { head: lines.slice(0, open), sections, tail: lead };
}

// Body items: real key lines (with their continuation) and commented hint groups, in order.
function bodyItems(body) {
  const items = [];
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    const real = /^\s*"(\w+)"\s*:/.exec(line);
    if (real) {
      const lines = [line];
      let depth = depthOf(splitComment(line)[0]);
      while (depth > 0 && i + 1 < body.length) { const next = body[++i]; lines.push(next); depth += depthOf(splitComment(next)[0]); }
      items.push({ kind: 'real', key: real[1], lines });
      continue;
    }
    const hint = /^\s*\/\/ "(\w+)"\s*:/.exec(line);
    if (hint || items.length === 0 || items[items.length - 1].kind === 'real') items.push({ kind: 'comment', key: hint ? hint[1] : null, lines: [line] });
    else items[items.length - 1].lines.push(line);
  }
  return items;
}

function fmt(value, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inline = JSON.stringify(value);
    if (value.every((v) => !isObject(v) && !Array.isArray(v)) && inline.length <= 72) return inline.replace(/","/g, '", "').replace(/,(?=\d|true|false|null)/g, ', ');
    return `[\n${value.map((v) => `${pad}  ${fmt(v, indent + 2)}`).join(',\n')}\n${pad}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return `{\n${keys.map((k) => `${pad}  ${JSON.stringify(k)}: ${fmt(value[k], indent + 2)}`).join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

// Commas between real items only; a comment after the code keeps its column.
function setComma(lines, want) {
  const out = [...lines];
  const last = out.length - 1;
  const [code, comment] = splitComment(out[last]);
  const bare = code.replace(/,\s*$/, '').trimEnd();
  const gap = code.slice(code.trimEnd().length);
  out[last] = comment ? `${bare}${want ? ',' : ''}${gap || ' '}${comment}` : `${bare}${want ? ',' : ''}`;
  return out;
}

function renderSection(section, value) {
  const items = bodyItems(section.body);
  const used = new Set();
  const out = [];
  const rendered = (key, v) => `    ${JSON.stringify(key)}: ${fmt(v, 4)}`.split('\n');
  for (const item of items) {
    if (item.key && Object.prototype.hasOwnProperty.call(value, item.key)) {
      used.add(item.key);
      let lines = rendered(item.key, value[item.key]);
      // A one-line template key keeps its trailing explanation.
      const comment = item.kind === 'real' && item.lines.length === 1 ? splitComment(item.lines[0])[1] : '';
      if (comment) {
        const code = splitComment(item.lines[0])[0];
        lines = [`${lines[0]}${' '.repeat(Math.max(1, code.length - lines[0].length))}${comment}`, ...lines.slice(1)];
      }
      out.push({ kind: 'real', lines });
    } else out.push(item);
  }
  for (const key of Object.keys(value)) if (!used.has(key)) out.push({ kind: 'real', lines: rendered(key, value[key]) });
  const reals = out.map((it, i) => (it.kind === 'real' ? i : -1)).filter((i) => i >= 0);
  return out.flatMap((it, i) => (it.kind === 'real' ? setComma(it.lines, i !== reals[reals.length - 1]) : it.lines));
}

function render(templateText, config) {
  const t = parseTemplate(templateText);
  const lines = [...t.head, '{'];
  const extra = Object.keys(config).filter((k) => !t.sections.some((s) => s.key === k));
  t.sections.forEach((s, idx) => {
    const isLast = idx === t.sections.length - 1 && extra.length === 0;
    lines.push(...s.lead, `  ${JSON.stringify(s.key)}: {`);
    lines.push(...(Object.prototype.hasOwnProperty.call(config, s.key) && isObject(config[s.key]) ? renderSection(s, config[s.key]) : s.body));
    lines.push(isLast ? '  }' : '  },');
  });
  extra.forEach((k, idx) => {
    const body = `  ${JSON.stringify(k)}: ${fmt(config[k], 2)}`;
    lines.push('', `${body}${idx === extra.length - 1 ? '' : ','}`);
  });
  lines.push(...t.tail, '}');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Writing.
// ---------------------------------------------------------------------------

function defaultsPath() {
  return process.env.BYTHESLICE_DEFAULTS_PATH || path.join(os.homedir(), '.bytheslice', 'defaults.json');
}

// The project root a relative path argument resolves against: --project-root (or --root), else the working directory.
const rootOf = (opts, answers = {}) => path.resolve(opts.projectRoot ?? answers.projectRoot ?? process.cwd());
const fromRoot = (opts, file, answers) => path.resolve(rootOf(opts, answers), file);

function targetFor(flow, opts, answers) {
  if (opts.target) return fromRoot(opts, opts.target, answers);
  if (flow === 'A') return path.resolve(defaultsPath());
  const root = rootOf(opts, answers);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new UsageError(`project root ${root} does not exist`);
  return path.join(root, 'bytheslice.config.json');
}

// Where the original goes before a merge or overwrite. Flow B and C: the project's gitignored
// state folder, .claude/.bytheslice-state/backups/, never the project root. Flow A: beside the
// defaults file (~/.bytheslice/), which no repository holds.
const BACKUP_DIR = path.join('.claude', '.bytheslice-state', 'backups');
function backupDirFor(flow, target, opts, answers) {
  return flow === 'A' ? path.dirname(target) : path.join(rootOf(opts, answers), BACKUP_DIR);
}

// A timestamped backup name that never replaces an earlier backup: <file>.<UTC stamp>.bak.
function backupPathIn(dir, target) {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
  const base = path.join(dir, `${path.basename(target)}.${stamp}`);
  let candidate = `${base}.bak`;
  for (let n = 2; fs.existsSync(candidate); n++) candidate = `${base}-${n}.bak`;
  return candidate;
}

// The project backup folder ignores itself, so it stays out of git even in a project whose
// .gitignore does not list .claude/ (Flow C).
function ensureBackupDir(dir, flow) {
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (flow !== 'A' && !fs.existsSync(ignore)) fs.writeFileSync(ignore, '# write-config.js backups: never committed\n*\n');
}

// The file is re-rendered from the template, so the operator's own comments do not survive a merge or overwrite.
const COMMENTS_NOTE = 'hand-written comments are not carried over (the file is re-rendered from the example template)';

function writeConfig(answers, opts = {}) {
  const flow = String(opts.flow ?? (typeof answers.flow === 'string' ? answers.flow : '')).toUpperCase();
  if (!['A', 'B', 'C'].includes(flow)) throw new UsageError('flow must be A, B or C (--flow or "flow" in the answers)');
  const target = targetFor(flow, opts, answers);
  const exists = fs.existsSync(target);
  const label = flow === 'A' ? path.basename(target) === 'defaults.json' ? '~/.bytheslice/defaults.json' : target : 'bytheslice.config.json';
  const backupDir = backupDirFor(flow, target, opts, answers);
  if (exists && !opts.overwrite && !opts.merge) {
    const lead = flow === 'A' ? `${label} already exists.` : `This project already has ${label}.`;
    const where = flow === 'A' ? `beside it in ${path.basename(backupDir) === '.bytheslice' ? '~/.bytheslice/' : backupDir}` : `under ${BACKUP_DIR.split(path.sep).join('/')}/`;
    throw new NeedsHuman(
      'destructive_operation',
      `${lead} Overwrite, merge, or cancel? Either way ${COMMENTS_NOTE.replace(/ \(.*\)$/, '')}; the original is saved ${where} first.`,
      `write-config: ${target} exists; rerun with --overwrite or --merge after the operator answers (the original is copied into ${backupDir} with a timestamped name before the write)`,
      { config_path: target, backup_dir: backupDir, flow, overwrite_conflict: true },
    );
  }

  const { config: fromAnswers, ignored, notes } = normalize(answers, flow);
  let config = {};
  if (exists && opts.merge) config = deepMerge(config, readJsonc(target) ?? {});
  if (opts.useDefaults) {
    const defaults = readJsonc(opts.defaultsFile ? fromRoot(opts, opts.defaultsFile, answers) : path.resolve(defaultsPath()));
    if (!defaults) throw new UsageError('--use-defaults was given but the defaults file does not exist');
    if (flow !== 'A' && defaults.bootstrap) { delete defaults.bootstrap; ignored.push('bootstrap from defaults (Flow A only)'); }
    config = deepMerge(config, defaults);
  }
  for (const base of opts.bases ?? []) config = deepMerge(config, readJsonc(fromRoot(opts, base, answers)) ?? {});
  config = deepMerge(config, fromAnswers);
  config.gates = { ...(isObject(config.gates) ? config.gates : {}), enforcement: 'fix' };
  for (const k of Object.keys(config.gates)) if (k !== 'enforcement' && Array.isArray(config.gates[k]) && config.gates[k].length === 0) delete config.gates[k];
  checkStandIn(config.run);

  const secretAt = findSecret(config);
  if (secretAt) {
    throw new NeedsHuman(
      'external_credentials',
      `An answer for ${secretAt} looks like a pasted credential. A config file never holds secrets: put the value in .env.local and give the answer again without it.`,
      `write-config: refused to write ${target}; the value at ${secretAt} matches a credential shape (not shown)`,
    );
  }

  const template = opts.template ? fromRoot(opts, opts.template, answers) : TEMPLATE;
  const text = render(fs.readFileSync(template, 'utf8'), config);
  let parsed;
  try { parsed = parseJsonc(text); } catch (err) { throw new Error(`rendered config is not valid JSONC (${err.message}); nothing was written`); }
  if (parsed.gates?.enforcement !== 'fix') throw new Error('rendered config lost gates.enforcement "fix"; nothing was written');

  if (flow === 'A') fs.mkdirSync(path.dirname(target), { recursive: true });
  // Merge and overwrite both replace the file: keep the operator's original first.
  let backup = null;
  if (exists) {
    ensureBackupDir(backupDir, flow);
    backup = backupPathIn(backupDir, target);
    fs.copyFileSync(target, backup);
    notes.push(`${path.basename(target)} was ${opts.merge ? 'merged' : 'overwritten'}: ${COMMENTS_NOTE}; the original is at ${backup}`);
  }
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);

  const templateKeys = parseTemplate(fs.readFileSync(template, 'utf8')).sections.map((s) => s.key);
  const customized = Object.keys(config);
  return {
    config_path: target,
    flow,
    sections_customized: customized,
    sections_left_default: templateKeys.filter((k) => !customized.includes(k)),
    parses_as_jsonc: true,
    overwrite_conflict: false,
    merged: Boolean(exists && opts.merge),
    overwrote: Boolean(exists && opts.overwrite && !opts.merge),
    backup_path: backup,
    ignored,
    notes,
  };
}

function parseArgs(argv) {
  const opts = { bases: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--overwrite') opts.overwrite = true;
    else if (a === '--merge') opts.merge = true;
    else if (a === '--use-defaults') opts.useDefaults = true;
    else if (a === '--base') opts.bases.push(argv[++i]);
    else if (a === '--answers') opts.answers = argv[++i];
    else if (a === '--flow') opts.flow = argv[++i];
    else if (a === '--target') opts.target = argv[++i];
    else if (a === '--project-root' || a === '--root') opts.projectRoot = argv[++i];
    else if (a === '--defaults-file') opts.defaultsFile = argv[++i];
    else if (a === '--template') opts.template = argv[++i];
    else if (!a.startsWith('--') && !opts.answers) opts.answers = a;
    else throw new UsageError(`unknown argument ${a}`);
  }
  return opts;
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const raw = !opts.answers || opts.answers === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(fromRoot(opts, opts.answers), 'utf8');
    const answers = raw.trim() ? JSON.parse(raw) : {};
    if (!isObject(answers)) throw new UsageError('the answers must be a JSON object');
    process.stdout.write(`${JSON.stringify(writeConfig(answers, opts))}\n`);
  } catch (err) {
    if (err instanceof NeedsHuman) {
      process.stdout.write(`${JSON.stringify({ needs_human: { category: err.category, question: err.question, context: err.context }, ...(err.extra ?? {}) })}\n`);
      process.exit(2);
    }
    process.stderr.write(`write-config: ${err.message}\n`);
    if (err instanceof UsageError) process.stderr.write('usage: write-config.js --flow A|B|C [--answers <file>|-] [--project-root <dir>] [--target <file>] [--overwrite|--merge] [--use-defaults] [--base <file> ...]\n(relative paths resolve against --project-root)\n');
    process.exit(1);
  }
}

module.exports = { GATE_CLASSES, normalize, findSecret, render, writeConfig, NeedsHuman };

if (require.main === module) main();
