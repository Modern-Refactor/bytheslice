// tests/open-the-shop/env-inventory.test.js
// Covers env-inventory.js: the .env.example scan, the CI secrets list, the catalog-grouped checklist, the full placeholder list, the verify pass that never prints a value (unchanged_from_example and --confirmed included), and merge-env's use of the same rule.
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
    STRIPE_SECRET_KEY: 'sk_' + 'test_fixtureRealLooking0123',
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
  const keys = inv.parseExample('# one\n# two\n# three\n# four\nKEY=1\n#COMMENTED=x\nOTHER\n');
  assert.deepEqual(keys, [{ name: 'KEY', docstring: 'two three four' }, { name: 'OTHER' }], 'a commented-out KEY=value is never a docstring');
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

test('the wider placeholder shapes are caught: your_ words, _here, trailing dots, template braces, placeholder words', () => {
  for (const v of ['your_api_key_here', 'your-anon-key', 'YOUR_SUPABASE_URL', 'https://your-project.supabase.co', 'sk_test_...', 'pk_' + 'live_\u2026',
    'placeholder', 'example', 'dummy', 'changeme123', 'Example', 'sk_test_example', 'dummy-token', 'replace-me', 'REPLACEME', 'api_key_here',
    'Bearer <token>', 'https://{{PROJECT}}.supabase.co', 're_xxxx_123']) {
    assert.ok(inv.isPlaceholder(v), `${v} is a placeholder`);
  }
});

test('real-shaped keys stay accepted, even with a common word inside a random token', () => {
  for (const v of ['sk_' + 'live_51H8xYzAbCdEfGhIjKlMnOp', 'pk_' + 'live_51HexampleDummyX9aB', 'whsec_hereAbc123def456', 're_123_todoList', 'phc_youroKey9QwErTy',
    'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl', 'https://fixture-app.example.test', 'postgresql://app:pw-7a6b5c@db.example.test/app',
    'ghp_yourxexample1234567890abcdEFGH', 'https://abcdefghijklmnop.supabase.co', 'AKIAEXAMPLE0123456789', 'my-dummyproof-service']) {
    assert.ok(!inv.isPlaceholder(v), `${v} is not a placeholder`);
  }
});

test('a placeholder word fails only standing alone, never inside a longer identifier', () => {
  for (const v of ['example', 'your-example-here', 'sk_test_example', 'dummy-token', 'test_placeholder_key', 'changeme-42']) {
    assert.ok(inv.isPlaceholder(v), `${v} is a placeholder`);
  }
  for (const v of ['my-example-app', 're_example_real123', 'example-service-eu', 'acme_dummy_loader']) {
    assert.ok(!inv.isPlaceholder(v), `${v} is not a placeholder`);
  }
});

test('a value identical to the .env.example value is not a placeholder; sameAsExample marks it, a safe default excepted', () => {
  assert.ok(!inv.isPlaceholder('anon-key-goes-in-this-slot'));
  assert.ok(inv.sameAsExample('anon-key-goes-in-this-slot', 'anon-key-goes-in-this-slot'));
  assert.ok(!inv.sameAsExample('anon-key-goes-in-this-slot', 'something-else'));
  assert.ok(!inv.sameAsExample('anon-key-goes-in-this-slot', ''));
  for (const v of ['http://localhost:3000', 'http://127.0.0.1:54321/rest', '3000', 'true']) assert.ok(!inv.sameAsExample(v, v), `${v} is a safe default`);
});

// Legitimate defaults a copied .env.local keeps as is.
const DEFAULTS = {
  AWS_REGION: 'us-east-1',
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  COMPANY_NAME: 'Acme',
  REDIS_URL: 'redis://localhost:6379',
  LOCAL_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
};

function withDefaults(dir) {
  const lines = Object.entries(DEFAULTS).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.appendFileSync(path.join(dir, 'packages/api/.env.example'), `${lines}\n`);
  writeLocals(dir);
  fs.appendFileSync(path.join(dir, 'packages/api/.env.local'), `${lines}\n`);
}

test('verify passes legitimate defaults copied from .env.example and lists them under unchanged_from_example, key names only', (t) => {
  const dir = repo(t);
  withDefaults(dir);
  const r = run(dir, 'verify');
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'pass');
  assert.deepEqual(r.json.placeholder_keys, {});
  assert.deepEqual(r.json.unchanged_from_example, { 'packages/api/.env.local': Object.keys(DEFAULTS) });
  for (const v of Object.values(DEFAULTS)) assert.ok(!r.out.includes(v), `verify printed ${v}`);
});

test('verify --confirmed clears the confirmed keys from unchanged_from_example', (t) => {
  const dir = repo(t);
  withDefaults(dir);
  const all = run(dir, 'verify', '--confirmed', Object.keys(DEFAULTS).join(','));
  assert.equal(all.json.status, 'pass');
  assert.deepEqual(all.json.unchanged_from_example, {});
  assert.deepEqual(all.json.confirmed_keys, Object.keys(DEFAULTS));
  const some = run(dir, 'verify', '--confirmed', 'AWS_REGION,NODE_ENV');
  assert.deepEqual(some.json.unchanged_from_example, { 'packages/api/.env.local': ['LOG_LEVEL', 'COMPANY_NAME', 'REDIS_URL', 'LOCAL_DATABASE_URL'] });
});

test('identifier values with a placeholder word inside pass verify', (t) => {
  const dir = repo(t);
  writeLocals(dir, { MYSTERY_TOKEN: 'my-example-app', RESEND_API_KEY: 're_example_real123' });
  const r = run(dir, 'verify');
  assert.equal(r.json.status, 'pass');
  assert.deepEqual(r.json.placeholder_keys, {});
});

test('a placeholder copied from .env.example still fails, as a placeholder not an unchanged value', (t) => {
  const dir = repo(t);
  writeLocals(dir, { STRIPE_SECRET_KEY: 'sk_test_xxx', NEXT_PUBLIC_SUPABASE_URL: 'https://your-project.supabase.co', MYSTERY_TOKEN: 'example' });
  const r = run(dir, 'verify', '--confirmed', 'STRIPE_SECRET_KEY,NEXT_PUBLIC_SUPABASE_URL,MYSTERY_TOKEN');
  assert.equal(r.json.status, 'fail');
  assert.deepEqual(r.json.placeholder_keys, { 'apps/web/.env.local': ['NEXT_PUBLIC_SUPABASE_URL', 'STRIPE_SECRET_KEY', 'MYSTERY_TOKEN'] });
  assert.deepEqual(r.json.unchanged_from_example, {});
});

test('verify lists a non-default value copied unchanged from the .env.example, by key name only', (t) => {
  const dir = repo(t);
  const same = 'copied-from-the-example-file-1234';
  fs.appendFileSync(path.join(dir, 'packages/api/.env.example'), `QUEUE_TOKEN=${same}\n`);
  writeLocals(dir);
  fs.appendFileSync(path.join(dir, 'packages/api/.env.local'), `QUEUE_TOKEN=${same}\n`);
  const r = run(dir, 'verify');
  assert.equal(r.json.status, 'pass');
  assert.deepEqual(r.json.placeholder_keys, {});
  assert.deepEqual(r.json.unchanged_from_example, { 'packages/api/.env.local': ['QUEUE_TOKEN'] });
  assert.ok(!r.out.includes(same));
});

test('a commented-out secret in .env.example never reaches a docstring, scan or checklist output', (t) => {
  const dir = repo(t);
  const live = 'sk_' + 'live_51HcommentedOutSecret0123456789';
  const bare = 'rk_' + 'live_51HbareCommentSecret9876543210';
  const hex = '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a';
  fs.writeFileSync(path.join(dir, 'apps/web/.env.example'), [
    '# Stripe secret key',
    `# STRIPE_SECRET_KEY=${live}`,
    `#   export  "STRIPE_OLD_KEY" = "${live}"`,
    `# ${bare}`,
    `# old value ${hex}`,
    'STRIPE_SECRET_KEY=',
    '',
  ].join('\n'));
  const keys = inv.parseExample(fs.readFileSync(path.join(dir, 'apps/web/.env.example'), 'utf8'));
  assert.deepEqual(keys, [{ name: 'STRIPE_SECRET_KEY', docstring: 'Stripe secret key' }]);
  for (const cmd of ['scan', 'checklist']) {
    const r = run(dir, cmd);
    assert.equal(r.code, 0);
    for (const value of [live, bare, hex, 'STRIPE_OLD_KEY']) assert.ok(!r.out.includes(value), `${cmd} printed ${value}`);
  }
});

test('docstrings keep ordinary notes, a colon or a URL included', () => {
  const keys = inv.parseExample('# Required: yes\n# From https://supabase.com/dashboard/project/_/settings/api\nKEY=\n');
  assert.deepEqual(keys, [{ name: 'KEY', docstring: 'Required: yes From https://supabase.com/dashboard/project/_/settings/api' }]);
});

test('a relative --catalog path resolves against --root', (t) => {
  const dir = repo(t);
  fs.copyFileSync(path.join(__dirname, '../../skills/open-the-shop/references/known-services-catalog.md'), path.join(dir, 'catalog.md'));
  const r = spawnSync(process.execPath, [SCRIPT, 'checklist', '--root', dir, '--catalog', 'catalog.md'], { encoding: 'utf8', cwd: os.tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).services_detected.includes('Supabase'));
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
  assert.deepEqual(r.json.unchanged_from_example, {});
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

test('merge-env fills a slot still holding the .env.example value, accepts a provider value equal to the example, and prints key names only', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-merge-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.env.example'), 'QUEUE_TOKEN=copied-example-token-1234\nREDIS_URL=redis://localhost:6379\nAWS_REGION=us-east-1\nAPI_KEY=\n');
  fs.writeFileSync(path.join(dir, '.env.local'), 'QUEUE_TOKEN=copied-example-token-1234\nAWS_REGION=us-east-1\nAPI_KEY=your_key_here\n');
  fs.writeFileSync(path.join(dir, 'src.env'), 'QUEUE_TOKEN=provider-queue-token-9876\nREDIS_URL=redis://localhost:6379\nAPI_KEY=example\n');
  const merge = path.join(__dirname, '../../skills/open-the-shop/scripts/merge-env.js');
  const r = spawnSync(process.execPath, [merge, '--root', dir, '--example', '.env.example', '--target', '.env.local', '--source', 'src.env'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.written, ['QUEUE_TOKEN', 'REDIS_URL']);
  assert.deepEqual(out.still_missing, ['API_KEY']);
  for (const v of ['provider-queue-token-9876', 'copied-example-token-1234', 'redis://localhost:6379', 'us-east-1']) assert.ok(!r.stdout.includes(v));
  const local = fs.readFileSync(path.join(dir, '.env.local'), 'utf8');
  assert.match(local, /^QUEUE_TOKEN=provider-queue-token-9876$/m);
  assert.match(local, /^AWS_REGION=us-east-1$/m);
});

test('verify on a root with no .env.example fails and says why, never a vacuous pass', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-env-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(__dirname, '../../skills/open-the-shop/scripts/env-inventory.js');
  const r = spawnSync(process.execPath, [script, 'verify', '--root', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'fail');
  assert.equal(out.no_env_examples_found, true);
  assert.deepEqual(out.files_checked, []);
});
