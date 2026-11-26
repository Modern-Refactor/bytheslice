// tests/install/skill-dependencies.test.js
// Holds the skills-only installer to the files a skill links inside another skill: installing special-order also installs sell-slice, cook-pizzas and setup-shop, open-the-shop brings sell-slice for its script-contract.md reference, every ../<skill>/<file> link in a SKILL.md (a peer's SKILL.md aside) resolves inside the installed set, and only the requested skills get command shims.
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

test('special-order brings the sell-slice and cook-pizzas agents it dispatches, and the references they link', () => {
  const { skills, added } = resolve('special-order');
  assert.deepEqual(skills, ['skills/special-order', 'skills/cook-pizzas', 'skills/sell-slice', 'skills/setup-shop']);
  assert.deepEqual(added, [
    { skill: 'skills/cook-pizzas', neededBy: ['skills/special-order', 'skills/sell-slice'] },
    { skill: 'skills/sell-slice', neededBy: ['skills/special-order', 'skills/cook-pizzas', 'skills/setup-shop'] },
    { skill: 'skills/setup-shop', neededBy: ['skills/special-order', 'skills/cook-pizzas', 'skills/sell-slice'] },
  ]);
});

test('a ../<skill>/references/ link is a dependency: open-the-shop brings sell-slice for script-contract.md', () => {
  const { skills, added } = resolve('open-the-shop');
  assert.ok(skills.includes('skills/sell-slice'), skills.join(', '));
  assert.equal(added.find(item => item.skill === 'skills/sell-slice').neededBy[0], 'skills/open-the-shop');
});

test('a link to a peer skill\'s own SKILL.md is not a dependency', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-skill-links-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  write('skills/a/SKILL.md', 'See [b](../b/SKILL.md), the [contract](../c/references/contract.md), [a script](../d/scripts/run.js#usage) and [a dead link](../e/references/missing.md).\n');
  for (const name of ['b', 'c', 'd', 'e']) write(`skills/${name}/SKILL.md`, `# ${name}\n`);
  write('skills/c/references/contract.md', '# contract\n');
  write('skills/d/scripts/run.js', '\n');
  const idx = buildSkillIndex(repo);
  assert.deepEqual(resolveSkillDependencies(repo, ['skills/a'], idx).skills, ['skills/a', 'skills/c', 'skills/d']);
});

test('a requested dependency is not reported as added, and a skill with no cross-skill links adds nothing', () => {
  const both = resolve('special-order', 'sell-slice');
  assert.deepEqual(both.added.map(item => item.skill), ['skills/cook-pizzas', 'skills/setup-shop']);
  assert.deepEqual(resolve('create-menu'), { skills: ['skills/create-menu'], added: [] });
});

test('every cross-skill file link in a SKILL.md exists and resolves inside the set installed for that skill alone', () => {
  const link = /\]\((\.\.\/[^)\s#]+)(?:#[^)\s]*)?\)/g;
  const skillsRoot = path.join(root, 'skills');
  for (const skillPath of index.allSkillPaths) {
    const { skills } = resolveSkillDependencies(root, [skillPath], index);
    const file = path.join(root, skillPath, 'SKILL.md');
    for (const match of fs.readFileSync(file, 'utf8').matchAll(link)) {
      const abs = path.resolve(path.dirname(file), match[1]);
      const parts = path.relative(skillsRoot, abs).split(path.sep);
      if (parts[0] === '..' || parts.length < 2 || parts[0] === path.basename(skillPath)) continue;
      assert.ok(fs.existsSync(abs), `${skillPath} links a missing file ${match[1]}`);
      if (parts.length === 2 && parts[1] === 'SKILL.md') continue;
      const target = `skills/${parts[0]}`;
      assert.ok(skills.includes(target), `${skillPath} links ${match[1]} but installing it alone leaves ${target} out`);
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
    for (const rel of ['skills/sell-slice/agents/code-explorer.md', 'skills/cook-pizzas/agents/stage-planner.md', 'skills/cook-pizzas/agents/phased-plan-writer.md', 'skills/sell-slice/references/script-contract.md']) {
      assert.ok(fs.existsSync(path.join(dir, rel)), `${rel} was not installed`);
    }
    const shims = fs.readdirSync(path.join(dir, 'commands')).sort();
    const own = resolveCommandsForSkills(root, ['skills/special-order']).map(rel => path.basename(rel)).sort();
    assert.deepEqual(shims, own);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
