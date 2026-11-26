// tests/install/skill-dependencies.test.js
// Holds the skills-only installer to the agents a skill dispatches from another skill: installing special-order also installs sell-slice and cook-pizzas, every ../<skill>/agents/ link in a SKILL.md resolves inside the installed set, and only the requested skills get command shims.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const {
  buildSkillIndex,
  resolveRequestedSkills,
  resolveSkillDependencies,
  resolveCommandsForSkills,
} = require(path.join(root, 'scripts/install/manifests.js'));
const { runInstallerCli } = require(path.join(root, 'scripts/install/index.js'));

const index = buildSkillIndex(root);
const resolve = (...names) => resolveSkillDependencies(root, resolveRequestedSkills(names, index), index);

test('special-order brings the sell-slice and cook-pizzas agents it dispatches', () => {
  const { skills, added } = resolve('special-order');
  assert.deepEqual(skills, ['skills/special-order', 'skills/cook-pizzas', 'skills/sell-slice']);
  assert.deepEqual(added, [
    { skill: 'skills/cook-pizzas', neededBy: ['skills/special-order'] },
    { skill: 'skills/sell-slice', neededBy: ['skills/special-order'] },
  ]);
});

test('a requested dependency is not reported as added, and a skill with no agent links adds nothing', () => {
  const both = resolve('special-order', 'sell-slice');
  assert.deepEqual(both.added.map(item => item.skill), ['skills/cook-pizzas']);
  assert.deepEqual(resolve('create-menu'), { skills: ['skills/create-menu'], added: [] });
});

test('every cross-skill agent link in a SKILL.md resolves inside the set installed for that skill alone', () => {
  const link = /\]\(\.\.\/([A-Za-z0-9_-]+)\/agents\/([^)\s]+)\)/g;
  for (const skillPath of index.allSkillPaths) {
    const { skills } = resolveSkillDependencies(root, [skillPath], index);
    const text = fs.readFileSync(path.join(root, skillPath, 'SKILL.md'), 'utf8');
    for (const match of text.matchAll(link)) {
      const target = path.posix.join(path.posix.dirname(skillPath), match[1]);
      assert.ok(skills.includes(target), `${skillPath} links ${target}/agents/${match[2]} but installing it alone leaves ${target} out`);
      assert.ok(fs.existsSync(path.join(root, target, 'agents', match[2])), `${skillPath} links a missing agent file ${target}/agents/${match[2]}`);
    }
  }
});

test('a skills-only install of special-order writes the dispatched agent files and only its own command shims', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-skills-'));
  const log = console.log;
  console.log = () => {};
  try {
    await runInstallerCli(['--mode', 'skills', '--skill', 'special-order', '--skills-dir', dir]);
  } finally {
    console.log = log;
  }
  try {
    for (const rel of ['skills/sell-slice/agents/code-explorer.md', 'skills/cook-pizzas/agents/stage-planner.md', 'skills/cook-pizzas/agents/phased-plan-writer.md']) {
      assert.ok(fs.existsSync(path.join(dir, rel)), `${rel} was not installed`);
    }
    const shims = fs.readdirSync(path.join(dir, 'commands')).sort();
    const own = resolveCommandsForSkills(root, ['skills/special-order']).map(rel => path.basename(rel)).sort();
    assert.deepEqual(shims, own);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
