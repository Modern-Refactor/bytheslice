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

// A SKILL.md that links a file inside another skill (../<skill>/agents/<file>.md for an agent it
// dispatches, ../<skill>/references/<file>.md for a shared reference such as sell-slice's
// script-contract.md, or any other file there) needs that skill installed, or the link is dead
// in a skills-only install. Those links are the dependency map, followed transitively. A link
// to another skill's own SKILL.md names a peer workflow, not a file this one reads, so it is
// not a dependency (following those would pull in every skill). Each link is resolved from
// the SKILL.md's own folder and counts only when it lands on an existing file.
const RELATIVE_LINK = /\]\((\.\.\/[^)\s#]+)(?:#[^)\s]*)?\)/g;

function linkDependencies(repoRoot, skillPath, skillIndex) {
  const skillFile = path.join(repoRoot, skillPath, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    return [];
  }
  const content = fs.readFileSync(skillFile, "utf8");
  const skillsRoot = path.join(repoRoot, "skills");
  const found = new Set();
  for (const match of content.matchAll(RELATIVE_LINK)) {
    const target = path.resolve(path.dirname(skillFile), match[1]);
    const parts = path.relative(skillsRoot, target).split(path.sep);
    if (parts[0] === ".." || path.isAbsolute(parts[0]) || parts.length < 2) {
      continue;
    }
    if (parts.length === 2 && parts[1] === "SKILL.md") {
      continue;
    }
    const dependency = path.posix.join("skills", parts[0]);
    if (dependency === skillPath.split(path.sep).join("/") || !skillIndex.allSkillPaths.includes(dependency)) {
      continue;
    }
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      found.add(dependency);
    }
  }
  return [...found].sort();
}

/**
 * The selected skills plus every skill whose files (agents, references, scripts) their
 * SKILL.md links. `added` lists each dependency that was not selected, with the selected
 * skills that need it.
 */
function resolveSkillDependencies(repoRoot, skillPaths, skillIndex) {
  const all = [...skillPaths];
  const neededBy = new Map();
  for (let index = 0; index < all.length; index += 1) {
    for (const dependency of linkDependencies(repoRoot, all[index], skillIndex)) {
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
