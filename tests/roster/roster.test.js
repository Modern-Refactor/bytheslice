// tests/roster/roster.test.js
// Holds the agent roster and its legacy names together: every "Now" target in the legacy table's "Renamed in 7.0.0" section is a registered agent, every agent its "Planned, not yet" note names is still registered and still its own role in the Pass, and no skill or command dispatches a removed agent name outside the legacy pointer lines.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const loadPolicy = () => import(path.join(root, 'mod/policy.ts'));
const TABLE = 'skills/sell-slice/references/legacy-agent-names.md';

/** Every agent .claude-plugin/plugin.json registers, by its frontmatter name (which must match its file name). */
function registeredAgents() {
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'));
  const names = new Set();
  for (const rel of manifest.agents) {
    const text = read(rel);
    const name = /^name:\s*(\S+)\s*$/m.exec(text)?.[1];
    assert.ok(name, `${rel} has no name: line`);
    assert.equal(name, path.basename(rel, '.md'), `${rel} is registered under a name other than its file name`);
    names.add(name);
  }
  return names;
}

/** The text of one `## <title>` section of the legacy table, up to the next `## ` heading. */
function section(text, title) {
  const start = text.indexOf(`\n## ${title}\n`);
  assert.ok(start !== -1, `${TABLE} has no "## ${title}" section`);
  const rest = text.slice(start + title.length + 5);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The rows of the "Renamed in 7.0.0" table: old name, the agent it now is (null for "none"), and the link the row gives. */
function renamedRows() {
  const body = section(read(TABLE), 'Renamed in 7.0.0');
  const rows = [];
  for (const line of body.split('\n')) {
    const cells = line.split('|').map(cell => cell.trim());
    if (cells.length < 4 || !/^`[a-z0-9-]+`$/.test(cells[1] ?? '')) continue;
    const old = cells[1].slice(1, -1);
    const now = cells[2] ?? '';
    if (now === 'none') {
      rows.push({ old, agent: null, link: null });
      continue;
    }
    const match = /^\[`([a-z0-9-]+)`\]\(([^)]+)\)$/.exec(now);
    assert.ok(match, `${TABLE}: the Now cell of ${old} is neither "none" nor a linked agent: ${now}`);
    rows.push({ old, agent: match[1], link: match[2] });
  }
  return rows;
}

/** Every agent name the "Planned, not yet" note lists, from its bullet lines. */
function plannedNames() {
  const body = section(read(TABLE), 'Planned, not yet');
  const names = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('- ')) continue;
    const before = line.split(':')[0];
    for (const match of before.matchAll(/`([a-z0-9-]+)`/g)) names.push(match[1]);
  }
  return names;
}

test('every Now target of the renamed table is a registered agent whose link resolves, and no old name is still registered', async () => {
  const registered = registeredAgents();
  const { LEGACY_AGENT_ALIASES } = await loadPolicy();
  const rows = renamedRows();
  assert.ok(rows.length > 0, 'the renamed table has no rows');
  for (const row of rows) {
    assert.ok(!registered.has(row.old), `${row.old} is in the renamed table but still registered`);
    assert.ok(row.old in LEGACY_AGENT_ALIASES, `${row.old} is in the renamed table but not in LEGACY_AGENT_ALIASES`);
    assert.equal(LEGACY_AGENT_ALIASES[row.old].agent, row.agent, `${row.old}: the table and LEGACY_AGENT_ALIASES disagree`);
    if (row.agent === null) continue;
    assert.ok(registered.has(row.agent), `${row.old} now names ${row.agent}, which is not a registered agent`);
    const target = path.resolve(path.dirname(path.join(root, TABLE)), row.link);
    assert.ok(fs.existsSync(target), `${row.old}: the link ${row.link} does not resolve`);
    assert.equal(path.basename(target, '.md'), row.agent, `${row.old}: the link ${row.link} is not ${row.agent}'s file`);
  }
  // Every alias whose name left the roster has a row, so the table is complete.
  const listed = new Set(rows.map(row => row.old));
  for (const name of Object.keys(LEGACY_AGENT_ALIASES)) {
    if (!registered.has(name)) assert.ok(listed.has(name), `${name} left the roster but has no row in the renamed table`);
  }
});

test('every agent the "Planned, not yet" note names is still registered, and every registered alias is in that note', async () => {
  const registered = registeredAgents();
  const { LEGACY_AGENT_ALIASES } = await loadPolicy();
  const planned = plannedNames();
  assert.ok(planned.length > 0, 'the planned note names no agent');
  for (const name of planned) {
    assert.ok(registered.has(name), `${name} is in the planned note but is no longer registered: move it to the renamed table`);
    assert.ok(name in LEGACY_AGENT_ALIASES, `${name} is in the planned note but not in LEGACY_AGENT_ALIASES`);
  }
  for (const name of Object.keys(LEGACY_AGENT_ALIASES)) {
    if (registered.has(name)) assert.ok(planned.includes(name), `${name} is a registered alias the planned note does not list`);
  }
});

test('an alias for an agent that is still registered stays inert in the Pass: its own role, its own config key, no legacy reach', async () => {
  const registered = registeredAgents();
  const { LEGACY_AGENT_ALIASES, DEFAULT_ROLES, DEFAULT_WATCHDOG, budgetMs, canonicalRole, legacyNamesOf, policyFrom } = await loadPolicy();
  const inert = Object.keys(LEGACY_AGENT_ALIASES).filter(name => registered.has(name));
  assert.ok(inert.length > 0, 'expected the planned agents to still be registered');
  const camel = name => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  for (const name of inert) {
    assert.ok(name in DEFAULT_ROLES, `${name} is registered but has no default role`);
    assert.equal(canonicalRole(name), name);
    assert.equal(canonicalRole(`bytheslice:${name}`), name);
    const target = LEGACY_AGENT_ALIASES[name].agent;
    if (target !== null) assert.ok(!legacyNamesOf(target).includes(name), `${name} reaches ${target} while still registered`);
    assert.equal(budgetMs(name, DEFAULT_WATCHDOG), DEFAULT_WATCHDOG.budgetsMs.default);
    // A modelTiers key under its name sets its own role, not as a legacy key.
    const tier = DEFAULT_ROLES[name][0] === 'opus' ? 'sonnet' : 'opus';
    const read = policyFrom({ modelTiers: { [camel(name)]: tier } });
    assert.deepEqual(read.policy.roles[name], [tier], `modelTiers.${camel(name)} does not set ${name}`);
    assert.deepEqual(read.overrides, [{ setting: `roles.${name}`, value: [tier], default: [...DEFAULT_ROLES[name]] }]);
  }
  // scaffold-writer does not exist yet, and framework-detector does not reach scaffold-discovery.
  assert.ok(!registered.has('scaffold-writer'));
  assert.deepEqual(legacyNamesOf('scaffold-discovery'), []);
});

/**
 * A line names `name` as a dispatch target when it spells it as an agent: a
 * code span of the bare name, a `bytheslice:` agent type, an agent file
 * path, or a subagent_type value. Plain prose ("route discovery") is not.
 */
function dispatchPattern(names) {
  const alt = names.map(name => name.replace(/-/g, '\\-')).join('|');
  return new RegExp(
    `(\`(${alt})\`|bytheslice:(${alt})(?![a-z0-9-])|agents/(?:[a-z]+/)?(${alt})\\.md|subagent_type["']?\\s*:\\s*["']?(${alt})(?![a-z0-9-]))`,
  );
}

/** Lines that point at the legacy table on purpose: the conductors' old-name pointer lines and any row linking the table. */
const POINTER = /Older agent names|Old agent names|legacy-agent-names\.md/;

test('no skill or command names a removed agent as a dispatch target outside the legacy pointer lines', async () => {
  const registered = registeredAgents();
  const { LEGACY_AGENT_ALIASES } = await loadPolicy();
  const removed = Object.keys(LEGACY_AGENT_ALIASES).filter(name => !registered.has(name));
  assert.ok(removed.length > 0);
  const pattern = dispatchPattern(removed);
  // The detector itself: dispatch shapes hit, prose and new names do not.
  assert.match('dispatch `spec-reviewer` once', pattern);
  assert.match('subagent_type: "bytheslice:discovery"', pattern);
  assert.match('[definition](agents/frontend/block-composer.md)', pattern);
  assert.doesNotMatch('route discovery, browser driving', pattern);
  assert.doesNotMatch('dispatch `code-reviewer` once', pattern);
  assert.doesNotMatch('`scaffold-discovery` returns', pattern);
  const files = [
    ...fs.readdirSync(path.join(root, 'skills')).map(dir => `skills/${dir}/SKILL.md`),
    ...fs.readdirSync(path.join(root, 'commands')).filter(file => file.endsWith('.md')).map(file => `commands/${file}`),
  ].filter(rel => fs.existsSync(path.join(root, rel)));
  assert.ok(files.length > 10, 'expected the skills and commands');
  const hits = [];
  for (const rel of files) {
    read(rel)
      .split('\n')
      .forEach((line, index) => {
        if (POINTER.test(line)) return;
        const match = pattern.exec(line);
        if (match) hits.push(`${rel}:${index + 1}: ${match[0]}`);
      });
  }
  assert.deepEqual(hits, [], `removed agents named as dispatch targets:\n${hits.join('\n')}`);
});
