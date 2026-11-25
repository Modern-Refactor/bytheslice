// tests/open-the-shop/env-inventory.test.js
// Covers env-inventory.js: the .env.example scan, the CI secrets list, the catalog-grouped checklist, the full placeholder list, and the verify pass that never prints a value.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const inv = require('../../skills/open-the-shop/scripts/env-inventory');

const SCRIPT = path.join(__dirname, '../../skills/open-the-shop/scripts/env-inventory.js');
const FIXTURE = path.join(__dirname, '../fixtures/env-inventory/repo');

// Values written into the .env.local files; none may ever reach stdout or stderr.
const SECRETS = {
  NEXT_PUBLIC_APP_URL: 'https://fixture-app.example.test',
  NEXT_PUBLIC_SUPABASE_URL: 'https://fixtureproj0123.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role-9f8e7d6c5b4a',
  RESEND_API_KEY: 're_fixture_5c4b3a2918',
  NEXT_PUBLIC_POSTHOG_KEY: 'phc_fixture_a1b2c3d4e5',
  DATABASE_URL: 'postgresql://fixture:pw-7a6b5c@db.example.test/app',
};

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-env-inventory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function writeLocals(dir, overrides = {}) {
  fs.writeFileSync(path.join(dir, '.env.local'), `NEXT_PUBLIC_APP_URL=${SECRETS.NEXT_PUBLIC_APP_URL}\n`);
  const web = {
    NEXT_PUBLIC_SUPABASE_URL: SECRETS.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: SECRETS.SUPABASE_SERVICE_ROLE_KEY,
    STRIPE_SECRET_KEY: 'sk_test_fixtureRealLooking0123',
    OPENAI_API_KEY: 'sk-fixtureopenai0123456789',
    MYSTERY_TOKEN: 'mystery-fixture-value-42',
    NEXT_PUBLIC_POSTHOG_KEY: SECRETS.NEXT_PUBLIC_POSTHOG_KEY,
    RESEND_API_KEY: SECRETS.RESEND_API_KEY,
    ...overrides,
  };
  const lines = Object.entries(web).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(path.join(dir, 'apps/web/.env.local'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'packages/api/.env.local'), `DATABASE_URL="${SECRETS.DATABASE_URL}"\n`);
}

function run(dir, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--root', dir], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, json: r.stdout ? JSON.parse(r.stdout) : null };
}

test('scan finds every .env.example at the root and under apps/ and packages/, keys only', (t) => {
  const dir = repo(t);
  fs.mkdirSync(path.join(dir, 'apps/web/node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps/web/node_modules/pkg/.env.example'), 'VENDOR_KEY=\n');
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tools/.env.example'), 'TOOLS_KEY=\n');
  const r = inv.scan(dir);
  assert.deepEqual(r.env_examples_found.map((f) => f.path), ['.env.example', 'apps/web/.env.example', 'packages/api/.env.example']);
  assert.deepEqual(r.env_examples_found.map((f) => f.expected_local_path), ['.env.local', 'apps/web/.env.local', 'packages/api/.env.local']);
  const web = r.env_examples_found[1].keys;
  assert.deepEqual(web.map((k) => k.name), ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY', 'OPENAI_API_KEY', 'MYSTERY_TOKEN', 'NEXT_PUBLIC_POSTHOG_KEY', 'RESEND_API_KEY']);
  assert.equal(web[0].docstring, 'Supabase Project URL from Project Settings, API');
  assert.equal(web[1].docstring, undefined, 'a key right after another key has no docstring');
  assert.equal(r.total_keys_unique, 9);
  assert.equal(r.no_env_examples_found, false);
  assert.ok(!JSON.stringify(r).includes('sk_test_xxx'), 'example values are never captured');
});

test('docstrings keep at most the 3 comment lines above a key', () => {
  const keys = inv.parseExample('# one\n# two\n# three\n# four\nKEY=1\n#COMMENTED=x\n\nOTHER\n');
  assert.deepEqual(keys, [{ name: 'KEY', docstring: 'two three four' }, { name: 'OTHER' }]);
});

test('scan reports no_env_examples_found on a repo with none', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-env-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = run(dir, 'scan');
  assert.equal(r.code, 0);
  assert.equal(r.json.no_env_examples_found, true);
  assert.deepEqual(r.json.env_examples_found, []);
});

test('secrets lists every secrets.NAME in the workflows, skips vars.*, and cross-references the scanned keys', (t) => {
  const r = run(repo(t), 'secrets');
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.github_secrets_referenced, [
    { name: 'OPENAI_API_KEY', referenced_in_workflows: ['.github/workflows/ci.yml'], also_in_env_local: true },
    { name: 'STRIPE_SECRET_KEY', referenced_in_workflows: ['.github/workflows/ci.yml', '.github/workflows/deploy.yml'], also_in_env_local: true },
    { name: 'VERCEL_TOKEN', referenced_in_workflows: ['.github/workflows/deploy.yml'], also_in_env_local: false },
  ]);
  assert.equal(r.json.total_secrets_unique, 3);
  assert.equal(r.json.no_workflows_found, false);
  assert.ok(!r.out.includes('FEATURE_FLAG'), 'vars.* references are not secrets');
});

test('secrets reports no_workflows_found when .github/workflows is absent', (t) => {
  const dir = repo(t);
  fs.rmSync(path.join(dir, '.github'), { recursive: true });
  const r = inv.secrets(dir);
  assert.equal(r.no_workflows_found, true);
  assert.deepEqual(r.github_secrets_referenced, []);
});

test('the catalog parses every service entry in file order and skips the entry template', () => {
  const catalog = inv.readCatalog();
  assert.deepEqual(catalog.map((s) => s.service).slice(0, 12), ['Supabase', 'Stripe', 'Resend', 'Clerk', 'Auth0', 'NextAuth', 'PostHog', 'Sentry', 'Vercel', 'GitHub', 'OpenAI', 'Anthropic']);
  assert.ok(!catalog.some((s) => s.service.includes('<')));
  assert.equal(catalog.find((s) => s.service === 'Supabase').url, 'https://supabase.com/dashboard');
  assert.equal(inv.serviceFor('STRIPE_WEBHOOK_SECRET', catalog).service, 'Stripe', 'direct match');
  assert.equal(inv.serviceFor('SUPABASE_DB_PASSWORD', catalog).service, 'Supabase', 'wildcard prefix');
  assert.equal(inv.serviceFor('NEXT_PUBLIC_CLERK_SIGN_IN_URL', catalog).service, 'Clerk', 'public wildcard');
  assert.equal(inv.serviceFor('NEXT_PUBLIC_SUPABASE_STORAGE_URL', catalog).service, 'Supabase', 'public prefix stripped');
  assert.equal(inv.serviceFor('MYSTERY_TOKEN', catalog), null);
});

test('checklist groups keys by service in catalog order with Other / Unknown last, task-list boxes only', (t) => {
  const r = run(repo(t), 'checklist');
  assert.equal(r.code, 0);
  const md = r.json.checklist_markdown;
  const order = [...md.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(order, ['Supabase', 'Stripe', 'Resend', 'PostHog', 'OpenAI', 'PlanetScale', 'Other / Unknown']);
  assert.deepEqual(r.json.services_detected, ['Supabase', 'Stripe', 'Resend', 'PostHog', 'OpenAI', 'PlanetScale']);
  assert.deepEqual(r.json.unknown_keys, ['NEXT_PUBLIC_APP_URL', 'MYSTERY_TOKEN']);
  assert.match(md, /### Supabase\nConsole: https:\/\/supabase\.com\/dashboard\n- \[ \] NEXT_PUBLIC_SUPABASE_URL: apps\/web\/\.env\.local \(Supabase Project URL/);
  assert.match(md, /## GitHub Secrets \(CI workflows\)\nAdd these via Settings → Secrets and variables → Actions in the GitHub repo\./);
  assert.match(md, /- \[ \] VERCEL_TOKEN \(referenced in \.github\/workflows\/deploy\.yml; CI only/);
  for (const line of md.split('\n')) assert.ok(!/^\s*\[ \]/.test(line), `bare box: ${line}`);
  assert.equal(r.json.total_checklist_items, 12);
  assert.ok(!md.includes('sk_test_xxx') && !md.includes('re_xxx'), 'no example values in the checklist');
});

test('every placeholder shape the verifier lists is caught, and real-looking values pass', () => {
  for (const v of ['xxx', 'XXXXXXXXXX', 'your_key_here', 'YOUR-KEY-HERE', '<placeholder>', '<your_xxx>', 'TODO', 'todo', 'REPLACE_ME', 'changeme', 'insert_here', 'paste_here', 'sk-...', 'pk_test_xxx', 'sk_test_xxxx', 'rk_test_xxx']) {
    assert.ok(inv.isPlaceholder(v), `${v} is a placeholder`);
  }
  for (const v of ['sk_test_51Habc', 'https://abc.supabase.co', 'sk-proj-abc123', 'xx', 'todo-list-api', 'true']) {
    assert.ok(!inv.isPlaceholder(v), `${v} is not a placeholder`);
  }
});

test('verify passes when every .env.local holds every key with a real value', (t) => {
  const dir = repo(t);
  writeLocals(dir);
  const r = run(dir, 'verify');
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'pass');
  assert.deepEqual(r.json.missing_files, []);
  assert.deepEqual(r.json.missing_keys_per_file, {});
  assert.deepEqual(r.json.placeholder_keys, {});
});

test('verify reports missing files, missing or empty keys and placeholders by key name only', (t) => {
  const dir = repo(t);
  writeLocals(dir, { STRIPE_SECRET_KEY: 'sk_test_xxx', OPENAI_API_KEY: '', MYSTERY_TOKEN: 'your_key_here', NEXT_PUBLIC_POSTHOG_KEY: null, RESEND_API_KEY: '"<your_resend_key>"' });
  fs.rmSync(path.join(dir, 'packages/api/.env.local'));
  const r = run(dir, 'verify');
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'fail');
  assert.deepEqual(r.json.missing_files, ['packages/api/.env.local']);
  assert.deepEqual(r.json.missing_keys_per_file, { 'apps/web/.env.local': ['OPENAI_API_KEY', 'NEXT_PUBLIC_POSTHOG_KEY'] });
  assert.deepEqual(r.json.placeholder_keys, { 'apps/web/.env.local': ['STRIPE_SECRET_KEY', 'MYSTERY_TOKEN', 'RESEND_API_KEY'] });
});

test('verify skips excused keys, and a file whose every key is excused may be absent', (t) => {
  const dir = repo(t);
  writeLocals(dir, { NEXT_PUBLIC_POSTHOG_KEY: null });
  fs.rmSync(path.join(dir, 'packages/api/.env.local'));
  const r = run(dir, 'verify', '--excused', 'NEXT_PUBLIC_POSTHOG_KEY,DATABASE_URL');
  assert.equal(r.json.status, 'pass');
  assert.deepEqual(r.json.excused_keys, ['NEXT_PUBLIC_POSTHOG_KEY', 'DATABASE_URL']);
});

test('no subcommand ever prints a .env.local value, on stdout or stderr', (t) => {
  const dir = repo(t);
  writeLocals(dir, { STRIPE_SECRET_KEY: 'sk_test_xxx' });
  for (const cmd of ['scan', 'secrets', 'checklist', 'verify']) {
    const r = run(dir, cmd);
    for (const [key, value] of Object.entries(SECRETS)) {
      assert.ok(!r.out.includes(value) && !r.err.includes(value), `${cmd} printed the value of ${key}`);
    }
  }
});

test('an unknown subcommand is a usage error (exit 1)', (t) => {
  const r = run(repo(t), 'dump');
  assert.equal(r.code, 1);
  assert.match(r.err, /usage: env-inventory\.js/);
});
