// scripts/install/manifests.js
// Reads ByTheSlice plugin metadata and resolves installable skill paths.

const fs = require("fs");
const path = require("path");

function readPluginMetadata(repoRoot) {
  const cursorManifestPath = path.join(repoRoot, ".cursor-plugin", "plugin.json");
  const claudeManifestPath = path.join(repoRoot, ".claude-plugin", "plugin.json");

  return {
    cursor: readJson(cursorManifestPath),
    claude: readJson(claudeManifestPath),
    cursorManifestPath,
    claudeManifestPath,
  };
}

function buildSkillIndex(repoRoot) {
  const skillsRoot = path.join(repoRoot, "skills");
  const skillDirs = listSkillDirectories(skillsRoot);
  const index = new Map();

  for (const relativeSkillDir of skillDirs) {
    const basename = path.basename(relativeSkillDir);
    const skillPath = path.join("skills", relativeSkillDir);

    if (!index.has(relativeSkillDir)) {
      index.set(relativeSkillDir, skillPath);
    }

    if (!index.has(basename)) {
      index.set(basename, skillPath);
    }
  }

  return {
    allSkillPaths: skillDirs.map((dir) => path.join("skills", dir)),
    map: index,
  };
}

function resolveRequestedSkills(requestedSkills, skillIndex) {
  if (!requestedSkills || requestedSkills.length === 0) {
    return skillIndex.allSkillPaths;
  }

  const resolved = new Set();
  for (const rawSkill of requestedSkills) {
    const skill = String(rawSkill).trim();
    if (!skill) {
      continue;
    }

    if (skillIndex.map.has(skill)) {
      resolved.add(skillIndex.map.get(skill));
      continue;
    }

    const normalized = skill.startsWith("skills/") ? skill : `skills/${skill}`;
    if (skillIndex.allSkillPaths.includes(normalized)) {
      resolved.add(normalized);
      continue;
    }

    throw new Error(`Unknown skill "${skill}".`);
  }

  if (resolved.size === 0) {
    throw new Error("No valid skills selected.");
  }

  return [...resolved];
}

// A skill that dispatches another skill's agent links it as ../<skill>/agents/<file>.md
// (special-order runs sell-slice's code-explorer and cook-pizzas' stage-planner and
// phased-plan-writer). Those links are the dependency map: installing a skill also
// installs every skill whose agents it dispatches, transitively, so the link resolves.
const AGENT_LINK = /\]\(\.\.\/([A-Za-z0-9_-]+)\/agents\/[^)\s]+\)/g;

function agentDependencies(repoRoot, skillPath, skillIndex) {
  const skillFile = path.join(repoRoot, skillPath, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    return [];
  }
  const content = fs.readFileSync(skillFile, "utf8");
  const found = new Set();
  for (const match of content.matchAll(AGENT_LINK)) {
    const dependency = path.join(path.dirname(skillPath), match[1]).split(path.sep).join("/");
    if (dependency !== skillPath && skillIndex.allSkillPaths.includes(dependency)) {
      found.add(dependency);
    }
  }
  return [...found].sort();
}

/**
 * The selected skills plus every skill whose agents they dispatch. `added` lists
 * each dependency that was not selected, with the selected skills that need it.
 */
function resolveSkillDependencies(repoRoot, skillPaths, skillIndex) {
  const all = [...skillPaths];
  const neededBy = new Map();
  for (let index = 0; index < all.length; index += 1) {
    for (const dependency of agentDependencies(repoRoot, all[index], skillIndex)) {
      if (!all.includes(dependency)) {
        all.push(dependency);
      }
      if (!skillPaths.includes(dependency)) {
        const needers = neededBy.get(dependency) || [];
        if (!needers.includes(all[index])) {
          needers.push(all[index]);
        }
        neededBy.set(dependency, needers);
      }
    }
  }
  const added = [...neededBy.entries()].map(([skill, needed]) => ({ skill, neededBy: needed }));
  return { skills: all, added };
}

function resolveCommandsForSkills(repoRoot, skillPaths) {
  const commandsDir = path.join(repoRoot, "commands");
  const files = fs.readdirSync(commandsDir, { withFileTypes: true });
  const selected = [];

  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const absolutePath = path.join(commandsDir, entry.name);
    const content = fs.readFileSync(absolutePath, "utf8");

    if (skillPaths.some((skillPath) => content.includes(`../${skillPath}/SKILL.md`))) {
      selected.push(path.join("commands", entry.name));
    }
  }

  return selected;
}

function listSkillDirectories(skillsRoot) {
  const results = [];
  walk(skillsRoot, skillsRoot, results);
  return results.sort();
}

function walk(root, current, results) {
  const entries = fs.readdirSync(current, { withFileTypes: true });
  const hasSkillFile = entries.some((entry) => entry.isFile() && entry.name === "SKILL.md");

  if (hasSkillFile) {
    results.push(path.relative(root, current));
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    walk(root, path.join(current, entry.name), results);
  }
}

function readJson(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return JSON.parse(content);
}

module.exports = {
  readPluginMetadata,
  buildSkillIndex,
  resolveRequestedSkills,
  resolveSkillDependencies,
  resolveCommandsForSkills,
};
