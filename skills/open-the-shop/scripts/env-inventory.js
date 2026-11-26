#!/usr/bin/env node
// skills/open-the-shop/scripts/env-inventory.js
// The /open-the-shop environment inventory: scans every .env.example, lists the CI secrets the workflows reference, renders the manual setup checklist from the known-services catalog, and verifies each .env.local. Prints key names and paths only, never a value.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CATALOG = path.join(__dirname, '..', 'references', 'known-services-catalog.md');

// Directories never searched for .env.example files.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);

// Placeholder shapes (case-insensitive), the full list the verify step checks.
// The literal list: xxx (only x's), your_key_here, your-key-here, <placeholder>, <your_xxx>,
// TODO, REPLACE_ME, changeme, insert_here, paste_here, sk-... (literal dots only),
// pk_test_xxx / sk_test_xxx / rk_test_xxx (Stripe stubs with an x suffix).
const PLACEHOLDERS = [
  /^x{3,}$/i,
  /your[_-]key[_-]here/i,
  /^<.*>$/,
  /^todo$/i,
  /^replace_me$/i,
  /^changeme$/i,
  /^insert_here$/i,
  /^paste_here$/i,
  /^sk-\.+$/i,
  /^(pk|sk|rk)_test_x+$/i,
];

// The wider shapes: a `your_` / `your-` word (your_api_key_here, YOUR_SUPABASE_URL,
// https://your-project.supabase.co), a value ending in `_here` / `-here`, a trailing
// `...` (sk_test_...), any <...> or {{...}} inside the value, and replace_me spelled
// any way. Each needs a word boundary, so a long random token that happens to hold
// the letters is not flagged.
const PLACEHOLDER_SHAPES = [
  /(?:^|[^A-Za-z0-9])your[_-][A-Za-z0-9]/i,
  /(?:^|[_\s-])here$/i,
  /(?:\.{3}|\u2026)$/,
  /<[^<>]+>/,
  /\{\{[^{}]*\}\}/,
  /(?:^|[^A-Za-z0-9])replace[_-]?me(?:$|[^A-Za-z0-9])/i,
];

// Placeholder words. A word fails the value only when it stands alone: it is the whole
// value, or it is one segment of a value whose every other segment is filler (digits, a key
// prefix such as sk, pk or re, or a credential noun such as test, live, key or token). So
// `example`, `changeme123`, `sk_test_example` and `dummy-token` fail, while `my-example-app`
// and `re_example_real123` pass: there the word is one part of a longer real identifier.
// Segments split on anything but letters, digits and dots, so a host such as db.example.test
// stays one segment. A segment of only x's (`re_xxxx_123`) is never real and fails anywhere.
// TODO stays a whole-value match only, so `todo-list-api` is a real value.
const PLACEHOLDER_WORD = /^(?:example|placeholder|dummy|changeme|replaceme)\d*$/i;
const X_RUN = /^x{3,}\d*$/i;
const FILLER_SEGMENT = /^(?:\d+|sk|pk|rk|re|whsec|phc|sb|test|live|api|key|keys|token|secret|value|id|url|uri|pass|password|pwd|dsn)$/i;

function hasPlaceholderWord(value) {
  const segments = value.split(/[^A-Za-z0-9.]+/).filter(Boolean);
  if (segments.some((s) => X_RUN.test(s))) return true;
  if (!segments.some((s) => PLACEHOLDER_WORD.test(s))) return false;
  return segments.every((s) => PLACEHOLDER_WORD.test(s) || FILLER_SEGMENT.test(s));
}

// An example value a copied .env.local may keep without a question: a localhost http(s)
// URL, a number or a boolean. Any other value equal to the .env.example value is reported
// under unchanged_from_example (a question, never a failure by itself).
const SAFE_DEFAULT = /^(?:https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/\S*)?|\d+(?:\.\d+)?|true|false)$/i;

// Prefixes that mark a key as browser-public; stripped for a second catalog lookup.
const PUBLIC_PREFIXES = ['NEXT_PUBLIC_', 'EXPO_PUBLIC_', 'VITE_', 'PUBLIC_'];

const OTHER = 'Other / Unknown';

class UsageError extends Error {}

// A placeholder value: one of the fixed shapes, or a placeholder word standing alone.
// Shape only: a value copied from .env.example is judged by sameAsExample, not here.
function isPlaceholder(value) {
  if (PLACEHOLDERS.some((re) => re.test(value))) return true;
  if (PLACEHOLDER_SHAPES.some((re) => re.test(value))) return true;
  return hasPlaceholderWord(value);
}

// A non-empty value identical to the same key's .env.example value (a safe default
// excepted). Often a legitimate default (us-east-1, development, a local database URL),
// so verify asks about it instead of failing it.
function sameAsExample(value, exampleValue) {
  return typeof exampleValue === 'string' && exampleValue !== '' && value === exampleValue && !SAFE_DEFAULT.test(value);
}

// A comment line never kept as a docstring: a commented-out assignment (`# KEY=value`,
// `# export KEY="value"`) or a line that holds something shaped like a credential.
const COMMENTED_ASSIGNMENT = /^(?:export\s+)?['"]?[A-Za-z_][A-Za-z0-9_]*['"]?\s*=/;
const CREDENTIAL_SHAPES = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}/,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{6,}/,
  /\b(?:whsec|re|phc|sb_secret|sb_publishable)_[A-Za-z0-9_-]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /:\/\/[^/\s:@]+:[^/\s@]+@/,
];
function unsafeComment(body) {
  if (COMMENTED_ASSIGNMENT.test(body)) return true;
  if (CREDENTIAL_SHAPES.some((re) => re.test(body))) return true;
  // A long token mixing letters and digits, outside a URL, reads as a key.
  return body.split(/\s+/).some((word) => !word.includes('://') && word.length >= 24 && /^[A-Za-z0-9_+/=.-]+$/.test(word) && /[A-Za-z]/.test(word) && /\d/.test(word));
}

const rel = (root, p) => path.relative(root, p).split(path.sep).join('/') || '.';

// One env line: the key and (for .env.local only) whether its value is usable.
// Lines of the form KEY=value, KEY= or KEY; `export ` prefixes and surrounding quotes handled.
function parseLine(raw) {
  const line = raw.replace(/^\s*export\s+/, '').trim();
  if (!line || line.startsWith('#')) return null;
  const eq = line.indexOf('=');
  const key = (eq === -1 ? line : line.slice(0, eq)).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let value = eq === -1 ? '' : line.slice(eq + 1).trim();
  // A quoted value ends at its closing quote; anything after it (an inline `# comment`) is dropped.
  const quoted = /^(['"])(.*?)\1(\s+#.*)?\s*$/.exec(value);
  if (quoted) value = quoted[2];
  else value = value.replace(/(^|\s+)#.*$/, '').trim();
  return { key, value };
}

// .env.example keys in file order, each with up to 3 comment lines directly above it as a docstring.
function parseExample(text) {
  const keys = [];
  const seen = new Set();
  let comments = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) { comments = []; continue; }
    if (trimmed.startsWith('#')) {
      const body = trimmed.replace(/^#+\s?/, '').trim();
      if (body && !unsafeComment(body)) comments.push(body);
      continue;
    }
    const parsed = parseLine(raw);
    if (parsed && !seen.has(parsed.key)) {
      seen.add(parsed.key);
      const doc = comments.slice(-3).join(' ');
      keys.push(doc ? { name: parsed.key, docstring: doc } : { name: parsed.key });
    }
    comments = [];
  }
  return keys;
}

// Key -> value of a .env.example, for the same-as-example check only. Never returned by a command.
function exampleValues(text) {
  const values = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const parsed = parseLine(raw);
    if (parsed && !values.has(parsed.key)) values.set(parsed.key, parsed.value);
  }
  return values;
}

// Key -> "usable" | "empty" | "placeholder" | "unchanged" for a .env.local. The value never
// leaves this function. `examples` (key -> .env.example value) marks a value copied over
// unchanged; a placeholder shape wins over "unchanged", so a copied `your_key_here` still fails.
function classifyLocal(text, examples = new Map()) {
  const status = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const parsed = parseLine(raw);
    if (!parsed) continue;
    if (parsed.value === '') status.set(parsed.key, 'empty');
    else if (isPlaceholder(parsed.value)) status.set(parsed.key, 'placeholder');
    else status.set(parsed.key, sameAsExample(parsed.value, examples.get(parsed.key)) ? 'unchanged' : 'usable');
  }
  return status;
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.name === '.env.example') out.push(path.join(dir, e.name));
  }
}

// Every .env.example at the repo root and anywhere under apps/ and packages/.
function findExamples(root) {
  const found = [];
  const top = path.join(root, '.env.example');
  if (fs.existsSync(top)) found.push(top);
  for (const sub of ['apps', 'packages']) walk(path.join(root, sub), found);
  return found.sort();
}

// Phase 0: the key inventory. Never opens a .env.local.
function scan(root) {
  const files = findExamples(root).map((file) => ({
    path: rel(root, file),
    expected_local_path: rel(root, path.join(path.dirname(file), '.env.local')),
    keys: parseExample(fs.readFileSync(file, 'utf8')),
  }));
  const unique = new Set(files.flatMap((f) => f.keys.map((k) => k.name)));
  return {
    env_examples_found: files,
    total_keys_unique: unique.size,
    no_env_examples_found: files.length === 0,
  };
}

// Phase 2: every secrets.NAME inside a ${{ }} expression in .github/workflows. vars.* is skipped.
function secrets(root, inventory = scan(root)) {
  const dir = path.join(root, '.github', 'workflows');
  let workflows = [];
  try {
    workflows = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch { workflows = []; }
  const envKeys = new Set(inventory.env_examples_found.flatMap((f) => f.keys.map((k) => k.name)));
  const byName = new Map();
  for (const file of workflows) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const expr of text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
      for (const m of expr[1].matchAll(/(?<![\w.])secrets\.([A-Za-z0-9_]+)/g)) {
        const name = m[1];
        if (!byName.has(name)) byName.set(name, new Set());
        byName.get(name).add(`.github/workflows/${file}`);
      }
    }
  }
  const list = [...byName.keys()].sort().map((name) => ({
    name,
    referenced_in_workflows: [...byName.get(name)].sort(),
    also_in_env_local: envKeys.has(name),
  }));
  return { github_secrets_referenced: list, total_secrets_unique: list.length, no_workflows_found: workflows.length === 0 };
}

// The catalog's yaml entries in file order: { service, exact, wildcards, url, ciSecrets }.
function readCatalog(file = CATALOG) {
  const text = fs.readFileSync(file, 'utf8');
  const services = [];
  for (const block of text.matchAll(/```yaml\n([\s\S]*?)```/g)) {
    const body = block[1];
    const service = /^service:\s*(.+?)\s*$/m.exec(body)?.[1];
    if (!service || service.includes('<')) continue;
    const prefixBlock = /^prefixes:\n((?:[ \t]+-.*\n?)+)/m.exec(body)?.[1] ?? '';
    const prefixes = [...prefixBlock.matchAll(/^[ \t]+-\s*([A-Z0-9_*]+)/gm)].map((m) => m[1]);
    services.push({
      service,
      exact: prefixes.filter((p) => !p.endsWith('*')),
      wildcards: prefixes.filter((p) => p.endsWith('*')).map((p) => p.slice(0, -1)),
      url: /^provisioning_url:\s*(\S+)/m.exec(body)?.[1] ?? null,
      ciSecrets: (/^ci_secrets_needed:\s*\[([^\]]*)\]/m.exec(body)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    });
  }
  if (services.length === 0) throw new Error(`no service entries in ${file}`);
  return services;
}

// Direct match wins (first entry in catalog order); then the longest wildcard prefix;
// then the same two lookups with a public prefix (NEXT_PUBLIC_ and the like) stripped.
function serviceFor(key, catalog) {
  const lookup = (name) => {
    const exact = catalog.find((s) => s.exact.includes(name));
    if (exact) return exact;
    let best = null;
    let bestLen = -1;
    for (const s of catalog) {
      for (const w of s.wildcards) if (name.startsWith(w) && w.length > bestLen) { best = s; bestLen = w.length; }
    }
    return best;
  };
  const direct = lookup(key);
  if (direct) return direct;
  for (const p of PUBLIC_PREFIXES) if (key.startsWith(p)) { const hit = lookup(key.slice(p.length)); if (hit) return hit; }
  return null;
}

// Phase 3: the manual setup checklist, grouped by service in catalog order, Other / Unknown last.
function checklist(root, catalogFile = CATALOG) {
  const catalog = readCatalog(catalogFile);
  const inventory = scan(root);
  const ci = secrets(root, inventory);

  const keys = new Map(); // name -> { files: [], docstring }
  for (const f of inventory.env_examples_found) {
    for (const k of f.keys) {
      if (!keys.has(k.name)) keys.set(k.name, { files: [], docstring: k.docstring });
      const entry = keys.get(k.name);
      entry.files.push(f.expected_local_path);
      if (!entry.docstring && k.docstring) entry.docstring = k.docstring;
    }
  }

  const groups = new Map(catalog.map((s) => [s.service, []]));
  groups.set(OTHER, []);
  const unknown = [];
  for (const [name, info] of keys) {
    const svc = serviceFor(name, catalog);
    if (!svc) unknown.push(name);
    groups.get(svc ? svc.service : OTHER).push({ name, ...info });
  }

  const lines = ['## External services to provision', ''];
  const services = [];
  let items = 0;
  for (const [service, entries] of groups) {
    if (entries.length === 0) continue;
    const meta = catalog.find((s) => s.service === service);
    services.push({ service, provisioning_url: meta?.url ?? null, keys: entries.map((e) => e.name) });
    lines.push(`### ${service}`);
    if (meta?.url) lines.push(`Console: ${meta.url}`);
    for (const e of entries) {
      lines.push(`- [ ] ${e.name}: ${e.files.join(', ')}${e.docstring ? ` (${e.docstring})` : ''}`);
      items += 1;
    }
    lines.push('');
  }
  if (services.length === 0) lines.push('No .env.example keys were found.', '');

  lines.push('## GitHub Secrets (CI workflows)');
  lines.push('Add these via Settings → Secrets and variables → Actions in the GitHub repo.');
  if (ci.github_secrets_referenced.length === 0) {
    lines.push(ci.no_workflows_found ? 'No CI workflows were found, so no GitHub secrets are needed yet.' : 'No CI workflow references a secret.');
  } else {
    for (const s of ci.github_secrets_referenced) {
      const where = s.referenced_in_workflows.join(', ');
      lines.push(`- [ ] ${s.name} (referenced in ${where}${s.also_in_env_local ? '' : '; CI only, not in any .env.example'})`);
      items += 1;
    }
    lines.push('- [ ] All GitHub repository secrets confirmed added');
  }
  lines.push('');
  lines.push('## Final Confirmation');
  lines.push('- [ ] All `.env.local` files created (one per app or package that has a `.env.example`)');
  lines.push('- [ ] All secret values are real (not placeholder strings like `xxx`, `your_key_here`, or `<placeholder>`)');
  lines.push('- [ ] `.env.local` is listed in `.gitignore` (never commit secrets)');
  lines.push('- [ ] GitHub repository secrets added for CI workflows (or confirmed not needed)');

  return {
    checklist_markdown: `${lines.join('\n')}\n`,
    services_detected: services.map((s) => s.service).filter((s) => s !== OTHER),
    services,
    unknown_keys: unknown,
    total_checklist_items: items,
    no_env_examples_found: inventory.no_env_examples_found,
  };
}

// Phase 5: every .env.local has each .env.example key with a non-empty, non-placeholder value.
// Reports key names and paths only. A file whose every key is excused may be absent.
// A key still holding its .env.example value is listed under unchanged_from_example, which
// never fails status by itself; `confirmed` keys (the operator said the value is intended)
// leave that list.
function verify(root, excused = [], confirmed = []) {
  const excusedSet = new Set(excused);
  const confirmedSet = new Set(confirmed);
  const inventory = scan(root);
  const missingFiles = [];
  const missingKeys = {};
  const placeholderKeys = {};
  const unchangedKeys = {};
  for (const f of inventory.env_examples_found) {
    const required = f.keys.map((k) => k.name).filter((k) => !excusedSet.has(k));
    const localPath = path.join(root, f.expected_local_path);
    if (!fs.existsSync(localPath)) {
      if (required.length > 0) missingFiles.push(f.expected_local_path);
      continue;
    }
    const examples = exampleValues(fs.readFileSync(path.join(root, f.path), 'utf8'));
    const status = classifyLocal(fs.readFileSync(localPath, 'utf8'), examples);
    const missing = required.filter((k) => !status.has(k) || status.get(k) === 'empty');
    const placeholder = required.filter((k) => status.get(k) === 'placeholder');
    const unchanged = required.filter((k) => status.get(k) === 'unchanged' && !confirmedSet.has(k));
    if (missing.length) missingKeys[f.expected_local_path] = missing;
    if (placeholder.length) placeholderKeys[f.expected_local_path] = placeholder;
    if (unchanged.length) unchangedKeys[f.expected_local_path] = unchanged;
  }
  const noExamples = inventory.env_examples_found.length === 0;
  const pass = !noExamples && missingFiles.length === 0 && Object.keys(missingKeys).length === 0 && Object.keys(placeholderKeys).length === 0;
  const out = {
    status: pass ? 'pass' : 'fail',
    no_env_examples_found: noExamples,
    missing_files: missingFiles,
    missing_keys_per_file: missingKeys,
    placeholder_keys: placeholderKeys,
    unchanged_from_example: unchangedKeys,
    files_checked: inventory.env_examples_found.map((f) => f.expected_local_path),
  };
  if (excused.length) out.excused_keys = [...excusedSet];
  if (confirmed.length) out.confirmed_keys = [...confirmedSet];
  return out;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, root: process.cwd(), excused: [], confirmed: [], catalog: CATALOG };
  const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  let catalog = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--root' || a === '--cwd') opts.root = path.resolve(rest[++i] ?? '');
    else if (a === '--catalog') catalog = rest[++i] ?? '';
    else if (a === '--excused') opts.excused = list(rest[++i]);
    else if (a === '--confirmed') opts.confirmed = list(rest[++i]);
    else throw new UsageError(`unknown argument ${a}`);
  }
  if (!['scan', 'secrets', 'checklist', 'verify'].includes(command)) throw new UsageError(`unknown command ${command ?? '(none)'}`);
  // A relative path argument is project-relative: resolved against --root.
  if (catalog !== null) opts.catalog = path.resolve(opts.root, catalog);
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`env-inventory: ${err.message}\n`);
    process.stderr.write('usage: env-inventory.js scan|secrets|checklist|verify [--root <dir>] [--catalog <file>] [--excused K1,K2] [--confirmed K1,K2]\n');
    process.exit(1);
  }
  let result;
  try {
    if (opts.command === 'scan') result = scan(opts.root);
    else if (opts.command === 'secrets') result = secrets(opts.root);
    else if (opts.command === 'checklist') result = checklist(opts.root, opts.catalog);
    else result = verify(opts.root, opts.excused, opts.confirmed);
  } catch (err) {
    // Messages name a file, never a value.
    process.stderr.write(`env-inventory: ${err.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { PLACEHOLDERS, PLACEHOLDER_SHAPES, isPlaceholder, sameAsExample, unsafeComment, parseExample, exampleValues, classifyLocal, scan, secrets, readCatalog, serviceFor, checklist, verify };

if (require.main === module) main();
