// skills/setup-shop/scripts/jsonc.js
// JSONC reader shared by write-config.js and detect-ci.js: the same comment and trailing-comma stripping mod/jsonc.ts does, in plain JS so a skill script can require it.
'use strict';

const fs = require('node:fs');

// Strips `//` and `/* */` comments outside strings, then trailing commas, so JSON.parse reads JSONC.
function stripJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    const next = text[i + 1] ?? '';
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next;
        i += 1;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

const parseJsonc = (text) => JSON.parse(stripJsonc(text));

// The parsed file, or null when it does not exist. Throws on a file that is not valid JSONC.
function readJsonc(file) {
  if (!fs.existsSync(file)) return null;
  return parseJsonc(fs.readFileSync(file, 'utf8'));
}

module.exports = { stripJsonc, parseJsonc, readJsonc };
