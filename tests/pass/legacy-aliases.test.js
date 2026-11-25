// tests/pass/legacy-aliases.test.js
// Holds the copies of the retired agent names (mcp/kitchen-state.js LEGACY_ROLES, hooks/shop-status.sh LEGACY_NAMES) equal to mod/policy.ts LEGACY_AGENT_ALIASES, and the alias table itself sound.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const load = () => import(path.join(root, 'mod/policy.ts'));

test('every retired name that is no longer registered resolves to a registered agent, a script or nothing', async () => {
  const { DEFAULT_ROLES, LEGACY_AGENT_ALIASES, canonicalRole } = await load();
  for (const [name, alias] of Object.entries(LEGACY_AGENT_ALIASES)) {
    assert.ok(alias.agent !== name, `${name} aliases itself`);
    if (name in DEFAULT_ROLES) {
      assert.equal(canonicalRole(name), name, `${name} is still registered, so it is still its own role`);
      continue;
    }
    if (alias.agent !== null) assert.ok(alias.agent in DEFAULT_ROLES, `${name} resolves to ${alias.agent}, which is not registered`);
    else if (alias.script) assert.ok(fs.existsSync(path.join(root, alias.script)), `${name} names ${alias.script}, which does not exist`);
    assert.equal(canonicalRole(`bytheslice:${name}`), alias.agent ?? name);
  }
});

test('the kitchen copy lists exactly the retired names that resolve to another agent today', async () => {
  const { LEGACY_AGENT_ALIASES, canonicalRole } = await load();
  const { LEGACY_ROLES } = require(path.join(root, 'mcp/kitchen-state.js'));
  const expected = Object.fromEntries(
    Object.keys(LEGACY_AGENT_ALIASES).filter(name => canonicalRole(name) !== name).map(name => [name, canonicalRole(name)]),
  );
  assert.deepEqual({ ...LEGACY_ROLES }, expected);
});

test('the shop-status hook greps for exactly the retired names no longer registered', async () => {
  const { DEFAULT_ROLES, LEGACY_AGENT_ALIASES } = await load();
  const script = fs.readFileSync(path.join(root, 'hooks/shop-status.sh'), 'utf8');
  const listed = /^LEGACY_NAMES='([^']*)'/m.exec(script)?.[1];
  assert.ok(listed, 'hooks/shop-status.sh has no LEGACY_NAMES list');
  const expected = Object.keys(LEGACY_AGENT_ALIASES).filter(name => !(name in DEFAULT_ROLES));
  assert.deepEqual(listed.split('|').sort(), expected.sort());
});
