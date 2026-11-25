#!/usr/bin/env node
// skills/set-display-case/scripts/token-check.js
// The /set-display-case token gate: `bundle` validates a Claude Design export (structure, token completeness, dark-mode parity, canonical paths) and `complete` runs the design-system gate against the written token files or the approved draft. The token names come from references/token-checklist.md.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CHECKLIST = path.join(__dirname, '..', 'references', 'token-checklist.md');
const LAYER_PAIRS = [['background', 'card'], ['card', 'popover'], ['background', 'muted'], ['background', 'sidebar']];
const MIN_LAYER_DELTA = 2;
const SKIP_DIRS = new Set(['node_modules', '.git']);

class UsageError extends Error {}
class NeedsHuman extends Error {
  constructor(question, context, extra) { super(question); this.question = question; this.context = context; this.extra = extra; }
}

// ---------------------------------------------------------------------------
// The checklist: token names per category, read from token-checklist.md.
// ---------------------------------------------------------------------------

function tableTokens(text) {
  const out = [];
  let head = null;
  for (const line of text.split('\n')) {
    if (!/^\s*\|/.test(line)) { head = null; continue; }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (!head) { head = cells.map((c) => c.toLowerCase()); continue; }
    const name = /`--([\w-]+)`/.exec(cells[0] ?? '')?.[1];
    if (!name) continue;
    const reqAt = head.indexOf('required');
    out.push({ name, required: reqAt < 0 ? true : !/optional/i.test(cells[reqAt] ?? '') });
  }
  return out;
}

function readChecklist(file = CHECKLIST) {
  const text = fs.readFileSync(file, 'utf8');
  const sections = new Map();
  for (const part of text.split(/^## /m).slice(1)) {
    const title = part.slice(0, part.indexOf('\n')).trim();
    sections.set(title, part);
  }
  const find = (re) => {
    for (const [title, body] of sections) if (re.test(title)) return body;
    throw new Error(`token checklist has no section matching ${re}`);
  };
  const names = (re, { required } = {}) => tableTokens(find(re)).filter((t) => required === undefined || t.required === required).map((t) => t.name);
  const typeBody = find(/^Typography .* Type Scale/i);
  const optA = typeBody.split(/\*\*Option B/)[0];
  const optB = typeBody.split(/\*\*Option B/)[1] ?? '';
  const list = {
    surface: names(/^Surface Colors/i),
    brand: names(/^Brand Colors/i),
    semanticRequired: names(/^Semantic Colors/i, { required: true }),
    semanticOptional: names(/^Semantic Colors/i, { required: false }),
    neutrals: names(/^Neutrals/i),
    charts: names(/^Charts/i),
    sidebar: names(/^Sidebar/i),
    fontsRequired: names(/^Typography .* Font Families/i, { required: true }),
    fontsOptional: names(/^Typography .* Font Families/i, { required: false }),
    typeA: tableTokens(optA).map((t) => t.name),
    typeB: tableTokens(optB).map((t) => t.name),
    radius: names(/^Radius/i),
    shadows: names(/^Shadows/i),
  };
  for (const [key, value] of Object.entries(list)) {
    if (value.length === 0 && !/Optional/.test(key)) throw new Error(`token checklist lists no tokens for ${key}`);
  }
  return list;
}

const requiredColorTokens = (cl, hasSidebar) => [
  ...cl.surface, ...cl.brand, ...cl.semanticRequired, ...cl.neutrals, ...cl.charts, ...(hasSidebar ? cl.sidebar : []),
];

// ---------------------------------------------------------------------------
// Token sources: a CSS entry file, or the approved markdown draft.
// ---------------------------------------------------------------------------

function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

const DARK_PRELUDE = /\.dark\b|\[data-theme\s*=\s*["']?dark["']?\s*\]|prefers-color-scheme\s*:\s*dark/;

// Custom properties by scope: light (:root), dark (.dark, [data-theme="dark"], a dark media query), theme (@theme), other (anywhere else).
function parseCss(raw) {
  const text = stripCssComments(raw);
  const scopes = { light: new Map(), dark: new Map(), theme: new Map(), other: [] };
  const stack = [];
  let seg = '';
  let paren = 0;
  let quote = null;
  const flush = () => {
    const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]*?)\s*$/.exec(seg);
    seg = '';
    if (!m || stack.length === 0) return;
    const name = m[1].slice(2);
    const chain = stack.join(' ');
    if (DARK_PRELUDE.test(chain)) scopes.dark.set(name, m[2]);
    else if (stack.some((p) => /^@theme\b/.test(p))) scopes.theme.set(name, m[2]);
    else if (/:root\b/.test(stack[stack.length - 1])) scopes.light.set(name, m[2]);
    else scopes.other.push({ name, selector: stack[stack.length - 1] });
  };
  for (const ch of text) {
    if (quote) { seg += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; seg += ch; continue; }
    if (ch === '(') paren += 1;
    if (ch === ')') paren = Math.max(0, paren - 1);
    if (paren > 0) { seg += ch; continue; }
    if (ch === '{') { stack.push(seg.trim()); seg = ''; continue; }
    if (ch === ';') { flush(); continue; }
    if (ch === '}') { flush(); stack.pop(); continue; }
    seg += ch;
  }
  const variant = /@custom-variant\s+dark\s*\(([^;{]*)\)/.exec(text)?.[1] ?? null;
  return { ...scopes, darkVariant: variant, hasTheme: /@theme\b/.test(text) };
}

// Tokens from the draft's markdown tables: a `--token` first cell, with Light / Dark (or Value) columns.
function parseDraft(text) {
  const light = new Map();
  const dark = new Map();
  let head = null;
  for (const line of text.split('\n')) {
    if (!/^\s*\|/.test(line)) { head = null; continue; }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (!head) { head = cells.map((c) => c.toLowerCase().replace(/[`*]/g, '')); continue; }
    const name = /`?--([\w-]+)`?/.exec(cells[0] ?? '')?.[1];
    if (!name) continue;
    const at = (label) => head.findIndex((h) => h === label || h.startsWith(`${label} `));
    const usable = (v) => v !== undefined && v !== '' && !/\bTBD\b/.test(v);
    const lightAt = at('light') >= 0 ? at('light') : at('value');
    const darkAt = at('dark');
    const lv = cells[lightAt]?.replace(/`/g, '').trim();
    const dv = cells[darkAt]?.replace(/`/g, '').trim();
    if (lightAt >= 0 && usable(lv)) light.set(name, lv);
    if (darkAt >= 0 && usable(dv)) dark.set(name, dv);
  }
  return { light, dark, theme: new Map(), other: [], darkVariant: null, hasTheme: false };
}

// ---------------------------------------------------------------------------
// Colors: classification and OKLCH lightness (0 to 100).
// ---------------------------------------------------------------------------

function resolveValue(value, maps, depth = 0) {
  const m = /^var\(\s*--([\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(String(value).trim());
  if (!m || depth > 8) return String(value).trim();
  for (const map of maps) if (map.has(m[1])) return resolveValue(map.get(m[1]), maps, depth + 1);
  return m[2] ? resolveValue(m[2], maps, depth + 1) : String(value).trim();
}

const BARE_HSL = /^-?[\d.]+(deg)?\s+[\d.]+%\s+[\d.]+%(\s*\/\s*[\d.]+%?)?$/;
const BARE_OKLCH = /^[\d.]+%?\s+[\d.]+\s+[\d.]+(deg)?(\s*\/\s*[\d.]+%?)?$/;
const COLOR_FN = /^(#[0-9a-f]{3,8}|(rgba?|hsla?|oklch|oklab|lab|lch|hwb|color|color-mix)\([\s\S]*\))$/i;

function isColorValue(value) {
  const v = value.trim();
  return COLOR_FN.test(v) || BARE_HSL.test(v) || BARE_OKLCH.test(v) || /^(white|black|transparent)$/i.test(v);
}

const num = (s, scale = 1) => (String(s).endsWith('%') ? parseFloat(s) / 100 : parseFloat(s) / scale);

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function rgbToOklchL([r, g, b]) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return (0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s) * 100;
}

// OKLCH lightness in points (0 to 100), or null when the value cannot be read.
function oklchLightness(value) {
  const v = value.trim().toLowerCase();
  const parts = (inner) => inner.replace(/\/.*$/, '').replace(/,/g, ' ').trim().split(/\s+/);
  let m;
  if (v === 'white') return 100;
  if (v === 'black') return 0;
  if ((m = /^oklch\(([^)]*)\)$/.exec(v)) || (m = /^oklab\(([^)]*)\)$/.exec(v))) {
    const p = parts(m[1])[0];
    return p.endsWith('%') ? parseFloat(p) : parseFloat(p) * 100;
  }
  if (BARE_OKLCH.test(v) && !BARE_HSL.test(v)) {
    const p = parts(v)[0];
    return p.endsWith('%') ? parseFloat(p) : parseFloat(p) * 100;
  }
  if ((m = /^#([0-9a-f]{3,8})$/.exec(v))) {
    let hex = m[1];
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((c) => c + c).join('');
    const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    return rgbToOklchL(rgb);
  }
  if ((m = /^rgba?\(([^)]*)\)$/.exec(v))) {
    const p = parts(m[1]).slice(0, 3).map((x) => num(x, 255));
    return p.some(Number.isNaN) ? null : rgbToOklchL(p);
  }
  let hsl = null;
  if ((m = /^hsla?\(([^)]*)\)$/.exec(v))) hsl = parts(m[1]);
  else if (BARE_HSL.test(v)) hsl = parts(v);
  if (hsl) {
    const [h, s, l] = [parseFloat(hsl[0]), num(hsl[1], 100), num(hsl[2], 100)];
    return [h, s, l].some(Number.isNaN) ? null : rgbToOklchL(hslToRgb(h, s, l));
  }
  return null;
}

// ---------------------------------------------------------------------------
// The design-system document: sections by heading, TBD slots.
// ---------------------------------------------------------------------------

function docSections(text) {
  const lines = text.split('\n');
  const heads = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) heads.push({ level: m[1].length, title: m[2].trim(), line: i });
  });
  // A whole document wrapped in a ```markdown fence (as the template is) still has headings.
  if (heads.length === 0 && text.includes('```')) return docSections(text.replace(/^\s*```.*$/gm, ''));
  return heads.map((h, idx) => {
    let end = lines.length;
    for (const next of heads.slice(idx + 1)) if (next.level <= h.level) { end = next.line; break; }
    return { ...h, body: lines.slice(h.line + 1, end).join('\n') };
  });
}

const sectionOf = (sections, re) => sections.find((s) => re.test(s.title)) ?? null;
const hasTbd = (text) => /\bTBD\b/.test(text);

function tbdSlots(text) {
  const out = [];
  let current = '(top)';
  text.split('\n').forEach((line, i) => {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) current = h[1].trim();
    if (hasTbd(line)) out.push({ line: i + 1, section: current });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Tailwind config: comment stripping and block extraction.
// ---------------------------------------------------------------------------

function stripJsComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 1; } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; }
    else if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; }
    else if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 1; }
    else out += ch;
  }
  return out;
}

function block(text, key) {
  const m = new RegExp(`(?:^|[\\s,{])["']?${key}["']?\\s*:\\s*\\{`).exec(text);
  if (!m) return null;
  let depth = 0;
  const start = m.index + m[0].length - 1;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(start + 1, i); }
  }
  return null;
}

// String values in an object block (`key: "value"`), never the quoted keys.
const literals = (text) => [...text.matchAll(/:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);
const RAW_COLOR = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/i;

function strategyOfDoc(text) {
  const hits = [
    ['attribute', text.search(/data-theme|attribute/i)],
    ['class', text.search(/\.dark\b|\bclass\b/i)],
    ['media', text.search(/prefers-color-scheme|\bmedia\b|\bsystem\b/i)],
  ].filter(([, at]) => at >= 0).sort((a, b) => a[1] - b[1]);
  return hits[0]?.[0] ?? null;
}

function strategyOfTailwind(config) {
  const single = /darkMode\s*:\s*(["'`])([^"'`]+)\1/.exec(config);
  if (single) return { class: 'class', selector: 'class', media: 'media' }[single[2]] ?? single[2];
  const arr = /darkMode\s*:\s*\[([^\]]*)\]/.exec(config)?.[1];
  if (arr) return /data-theme/.test(arr) ? 'attribute' : /\.dark|class|selector/.test(arr) ? 'class' : /media/.test(arr) ? 'media' : 'unknown';
  return null;
}

function strategyOfVariant(variant) {
  if (!variant) return 'media';
  return /data-theme/.test(variant) ? 'attribute' : /\.dark/.test(variant) ? 'class' : 'unknown';
}

// ---------------------------------------------------------------------------
// The category checks.
// ---------------------------------------------------------------------------

function pairCheck(tokens, scopes, { needDark }) {
  const missing = [];
  for (const t of tokens) {
    if (!scopes.light.has(t)) missing.push(`--${t}`);
    if (needDark && !scopes.dark.has(t)) missing.push(`--${t} (dark)`);
  }
  return missing;
}

function presentCheck(tokens, scopes) {
  return tokens.filter((t) => !scopes.light.has(t) && !scopes.theme.has(t)).map((t) => `--${t}`);
}

function colorTokens(scopes, cl) {
  const known = new Set([...cl.surface, ...cl.brand, ...cl.semanticRequired, ...cl.semanticOptional, ...cl.neutrals, ...cl.sidebar]);
  const out = [];
  for (const [name, value] of scopes.light) {
    if (known.has(name) || /^chart-\d+$/.test(name) || isColorValue(resolveValue(value, [scopes.light]))) out.push(name);
  }
  return out;
}

function layerContrast(scopes, hasSidebar) {
  const result = { light: [], dark: [], failures: [], unresolved: [], warnings: [] };
  for (const mode of ['light', 'dark']) {
    const maps = mode === 'dark' ? [scopes.dark, scopes.light] : [scopes.light];
    const L = (name) => {
      const map = mode === 'dark' ? scopes.dark : scopes.light;
      if (!map.has(name)) return undefined;
      const value = resolveValue(map.get(name), maps);
      const l = oklchLightness(value);
      if (l === null) result.unresolved.push(`--${name} (${mode})`);
      return l === null ? null : Math.round(l * 10) / 10;
    };
    for (const [a, b] of LAYER_PAIRS) {
      if (b === 'sidebar' && !hasSidebar && !scopes.light.has('sidebar')) continue;
      const la = L(a);
      const lb = L(b);
      if (la == null || lb == null) continue;
      const delta = Math.round(Math.abs(la - lb) * 10) / 10;
      result[mode].push({ pair: `${a}/${b}`, [a]: la, [b]: lb, delta });
      if (delta < MIN_LAYER_DELTA) result.failures.push(`${mode}: --${a} (L ${la}) and --${b} (L ${lb}) are ${delta} OKLCH lightness points apart, under ${MIN_LAYER_DELTA}`);
      if (mode === 'dark' && a === 'background' && lb < la) result.warnings.push(`dark: --${b} is darker than --background; a higher layer should be lighter in dark mode`);
    }
  }
  result.unresolved = [...new Set(result.unresolved)];
  return result;
}

const row = (category, missing, detail) => ({ category, status: missing.length ? 'FAIL' : 'PASS', missing, ...(detail ? { detail } : {}) });

function typeScale(scopes, cl, doc, sections, mode) {
  const fullA = cl.typeA.every((t) => scopes.light.has(t) || scopes.theme.has(t));
  const fullB = cl.typeB.every((t) => scopes.light.has(t) || scopes.theme.has(t));
  const inDoc = (list) => list.every((t) => doc.includes(`--${t}`));
  const section = sectionOf(sections, /type scale/i);
  const warnings = [];
  if (fullA && fullB) warnings.push('both type scale options are defined; pick one and do not mix');
  if (mode === 'bundle') {
    const approach = fullA || inDoc(cl.typeA) ? 'A' : fullB || inDoc(cl.typeB) ? 'B' : null;
    return { ...row('Type Scale', approach ? [] : ['no full Option A or Option B scale in the CSS or the reference document']), approach, warnings };
  }
  const gaps = [];
  if (!section) return { ...row('Type Scale', ['design-system.md has no Type Scale section']), approach: null, warnings };
  const chosenLine = /Approach chosen:\s*(.*)/i.exec(section.body)?.[1] ?? section.body;
  let approach = null;
  const aAt = chosenLine.search(/Option A|size tokens/i);
  const bAt = chosenLine.search(/Option B|semantic tokens/i);
  if (aAt >= 0 && (bAt < 0 || aAt < bAt)) approach = 'A';
  else if (bAt >= 0) approach = 'B';
  if (!approach || hasTbd(chosenLine)) gaps.push('the chosen approach (Option A or Option B) is not documented');
  const delegates = /tailwind(?:'s)? defaults?/i.test(section.body);
  if (approach && !delegates && !(approach === 'A' ? fullA : fullB)) {
    const list = approach === 'A' ? cl.typeA : cl.typeB;
    gaps.push(...presentCheck(list, scopes));
  }
  if (hasTbd(section.body)) gaps.push('TBD slots remain in the type scale section');
  return { ...row('Type Scale', gaps), approach, warnings };
}

function weights(sections, doc, mode) {
  const section = sectionOf(sections, /weights|leading|tracking/i);
  const text = section ? section.body : mode === 'bundle' ? doc : '';
  if (!text) return row('Weights/Leading/Tracking', ['design-system.md has no weights, leading and tracking section']);
  const sub = (re) => sections.find((s) => re.test(s.title) && section && s.line > section.line && s.line < section.line + section.body.split('\n').length + 1)?.body ?? text;
  const gaps = [];
  const w = sub(/weight/i);
  for (const [name, n] of [['regular', 400], ['medium', 500], ['semibold', 600], ['bold', 700]]) {
    if (!new RegExp(`\\b${n}\\b`).test(w) && !new RegExp(`\\b${name}\\b`, 'i').test(w)) gaps.push(`weight ${name} (${n})`);
  }
  const lead = sub(/leading|line height/i);
  for (const name of ['tight', 'normal', 'relaxed']) if (!new RegExp(`\\b${name}\\b`, 'i').test(lead)) gaps.push(`leading ${name}`);
  const track = sub(/tracking|letter spacing/i);
  for (const name of ['tight', 'normal', 'wide']) if (!new RegExp(`\\b${name}\\b`, 'i').test(track)) gaps.push(`tracking ${name}`);
  return row('Weights/Leading/Tracking', gaps);
}

function decision(category, sections, doc, mode, headingRe, test) {
  const section = sectionOf(sections, headingRe);
  if (!section) {
    if (mode === 'bundle' && test(doc)) return row(category, []);
    return row(category, [`no ${category.replace(/ Decision| Layers/, '').toLowerCase()} section in the design-system document`]);
  }
  const gaps = [];
  if (!test(section.body)) gaps.push(`the ${category.toLowerCase()} is not documented`);
  if (mode === 'complete' && hasTbd(section.body)) gaps.push(`TBD slots remain in the ${section.title} section`);
  return row(category, gaps);
}

const spacingDocumented = (mode) => (t) => (mode === 'complete' ? /Spacing Decision/i.test(t) : /tailwind|spacing (scale|decision)|\b\d+px\b/i.test(t));
const breakpointsDocumented = (t) => /tailwind(?:'s)? defaults?/i.test(t) || ['sm', 'md', 'lg', 'xl', '2xl'].every((n) => new RegExp(`\`?\\b${n}\\b\`?[^\\n]*\\d+(px|rem|em)`).test(t));
const zLayersDocumented = (t) => {
  const named = t.split('\n').filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l)).map((l) => l.trim().replace(/^\|/, '').split('|')[0].replace(/[`*]/g, '').trim());
  return named.slice(1).filter((n) => n && !/^\d+$/.test(n) && !/^layer$/i.test(n)).length >= 2
    || (t.match(/^\s*[-*]\s+`?[a-z][\w-]*`?\s*[:=(]/gim) ?? []).length >= 2;
};

function motion(scopes, sections, doc, mode) {
  const names = [...scopes.light.keys(), ...scopes.theme.keys()];
  const durations = ['fast', 'normal', 'slow'].filter((s) => !names.some((n) => new RegExp(`^(motion-)?duration-${s}$`).test(n)));
  const easing = names.some((n) => /^(ease|easing)(-[\w-]+)?$/.test(n));
  const viaCss = durations.length === 0 && easing;
  const section = sectionOf(sections, /motion/i);
  const viaTailwind = section ? /tailwind/i.test(section.body) && !/Motion Decision:[^\n]*CSS custom propert/i.test(section.body) : false;
  const docBundle = mode === 'bundle' && (section || /motion|duration|easing/i.test(doc));
  const gaps = [];
  if (!viaCss && !viaTailwind && !docBundle) {
    gaps.push(`motion is neither CSS custom properties (missing ${[...durations.map((d) => `--duration-${d}`), ...(easing ? [] : ['an --ease-* curve'])].join(', ')}) nor documented as Tailwind theme extensions`);
  }
  if (mode === 'complete' && section && hasTbd(section.body)) gaps.push('TBD slots remain in the motion section');
  return row('Motion Decision', gaps);
}

function tailwindBindings(scopes, cl, hasSidebar, tw) {
  const gaps = [];
  const warnings = [];
  const required = requiredColorTokens(cl, hasSidebar).filter((t) => scopes.light.has(t));
  if (tw.kind === 'config') {
    const config = stripJsComments(tw.text);
    const colors = block(config, 'colors');
    if (!colors) gaps.push('theme.extend.colors is missing');
    const colorText = colors ?? config;
    for (const t of required) if (!new RegExp(`var\\(\\s*--${t}\\s*[,)]`).test(colorText)) gaps.push(`color --${t} is not bound`);
    for (const lit of literals(colorText)) if (RAW_COLOR.test(lit) && !/var\(/.test(lit)) gaps.push(`hardcoded color value in colors: ${lit}`);
    const fonts = block(config, 'fontFamily');
    for (const f of ['sans', 'serif', 'mono']) if (!fonts || !new RegExp(`var\\(\\s*--font-${f}\\s*[,)]`).test(fonts)) gaps.push(`fontFamily.${f} is not bound to var(--font-${f})`);
    for (const key of ['borderRadius', 'boxShadow']) {
      const b = block(config, key);
      if (!b) { gaps.push(`${key} is missing`); continue; }
      for (const lit of literals(b)) if (!/var\(--/.test(lit)) gaps.push(`${key} entry "${lit}" does not reference a CSS custom property`);
    }
    return { ...row('Tailwind Config Bindings', gaps), strategy: strategyOfTailwind(config), warnings };
  }
  if (tw.kind === 'theme') {
    for (const t of required) {
      const v = scopes.theme.get(`color-${t}`);
      if (!v) gaps.push(`color --${t} has no --color-${t} in @theme`);
      else if (!/var\(--/.test(v)) gaps.push(`--color-${t} in @theme is a raw value, not a CSS variable reference`);
    }
    for (const [name, v] of scopes.theme) if (/^color-/.test(name) && RAW_COLOR.test(v) && !/var\(/.test(v)) warnings.push(`--${name} in @theme is a raw color`);
    const has = (n) => scopes.theme.has(n) || scopes.light.has(n);
    for (const f of ['sans', 'serif', 'mono']) if (!has(`font-${f}`)) gaps.push(`--font-${f} is not defined for the font-${f} utility`);
    for (const t of [...cl.radius.filter((r) => r !== 'radius'), ...cl.shadows]) if (!has(t)) gaps.push(`--${t} is not defined for its utility`);
    warnings.push('no tailwind.config: bindings were read from the CSS @theme block (Tailwind v4)');
    return { ...row('Tailwind Config Bindings', gaps), strategy: strategyOfVariant(scopes.darkVariant), warnings };
  }
  return { ...row('Tailwind Config Bindings', ['no tailwind.config and no @theme block maps the tokens']), strategy: null, warnings };
}

function evaluate({ scopes, doc, cl, hasSidebar, mode, tw, preWrite }) {
  const sections = docSections(doc);
  const results = [];
  const warnings = [];
  const needDark = true;

  const surface = row('Surface Colors', pairCheck(cl.surface, scopes, { needDark }));
  let contrast = null;
  if (mode === 'complete') {
    contrast = layerContrast(scopes, hasSidebar);
    if (contrast.failures.length) { surface.missing.push(...contrast.failures); surface.status = 'FAIL'; }
    for (const u of contrast.unresolved) warnings.push(`layer contrast: could not read ${u} as a color`);
    warnings.push(...contrast.warnings);
  }
  results.push(surface);
  results.push(row('Brand Colors', pairCheck(cl.brand, scopes, { needDark })));
  results.push(row('Semantic Colors (required subset)', pairCheck(cl.semanticRequired, scopes, { needDark })));
  results.push(row('Neutrals', pairCheck(cl.neutrals, scopes, { needDark })));
  results.push(row('Charts', pairCheck(cl.charts, scopes, { needDark })));
  results.push(hasSidebar ? row('Sidebar', pairCheck(cl.sidebar, scopes, { needDark })) : { category: 'Sidebar', status: 'N/A', missing: [] });
  results.push(row('Font Families', presentCheck(cl.fontsRequired, scopes)));
  const ts = typeScale(scopes, cl, doc, sections, mode);
  warnings.push(...ts.warnings);
  results.push({ category: ts.category, status: ts.status, missing: ts.missing, approach: ts.approach });
  results.push(weights(sections, doc, mode));
  results.push(row('Radius', presentCheck(cl.radius, scopes)));
  results.push(decision('Spacing Decision', sections, doc, mode, /^spacing/i, spacingDocumented(mode)));
  results.push(row('Shadows', presentCheck(cl.shadows, scopes)));
  results.push(motion(scopes, sections, doc, mode));
  results.push(decision('Breakpoints Decision', sections, doc, mode, /breakpoint/i, breakpointsDocumented));
  results.push(decision('Z-index Layers', sections, doc, mode, /z-?index/i, zLayersDocumented));

  // Dark mode parity, plus (complete) the documented strategy and the Tailwind darkMode match.
  const colors = colorTokens(scopes, cl);
  const noDark = colors.filter((t) => !scopes.dark.has(t));
  const orphaned = [...scopes.dark.keys()].filter((t) => !scopes.light.has(t) && !scopes.theme.has(t));
  for (const o of orphaned) warnings.push(`orphaned dark token --${o} has no :root definition`);
  const darkGaps = noDark.map((t) => `--${t}`);
  if (scopes.dark.size === 0) darkGaps.unshift('no .dark (or [data-theme="dark"]) block');
  let tailwind = null;
  if (mode === 'complete') {
    const darkSection = sectionOf(sections, /dark mode/i);
    const strategyLine = darkSection ? (/Dark Mode Strategy:\s*(.*)/i.exec(darkSection.body)?.[1] ?? darkSection.body) : '';
    const docStrategy = darkSection && !hasTbd(strategyLine) ? strategyOfDoc(strategyLine) : null;
    if (!docStrategy) darkGaps.push('design-system.md does not document the dark mode strategy');
    if (preWrite) {
      tailwind = { category: 'Tailwind Config Bindings', status: 'N/A', missing: [], detail: 'pre-write check on the draft; re-run `complete` on the written files' };
    } else {
      const tb = tailwindBindings(scopes, cl, hasSidebar, tw);
      warnings.push(...tb.warnings);
      if (!tb.strategy) darkGaps.push('tailwind darkMode is not set');
      else if (docStrategy && tb.strategy !== docStrategy) darkGaps.push(`tailwind darkMode (${tb.strategy}) does not match the documented strategy (${docStrategy})`);
      if (!tb.strategy) tb.missing.push('darkMode is not set');
      else if (docStrategy && tb.strategy !== docStrategy) tb.missing.push(`darkMode (${tb.strategy}) does not match design-system.md (${docStrategy})`);
      tb.status = tb.missing.length ? 'FAIL' : 'PASS';
      tailwind = { category: tb.category, status: tb.status, missing: tb.missing };
    }
  }
  results.push(row('Dark Mode Parity', darkGaps));
  if (tailwind) results.push(tailwind);

  for (const o of scopes.other) warnings.push(`--${o.name} is defined outside :root, .dark and @theme (in \`${o.selector}\`)`);

  const optional = [...cl.semanticOptional, ...cl.fontsOptional].filter((t) => scopes.light.has(t) || scopes.theme.has(t)).map((t) => `--${t}`);
  return { results, warnings, optional, contrast, noDark, orphaned };
}

// ---------------------------------------------------------------------------
// Subcommands.
// ---------------------------------------------------------------------------

function walk(dir, out, depth = 0) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out, depth + 1); } else out.push(p);
  }
}

const rank = (names) => (p) => { const i = names.indexOf(path.basename(p)); return i < 0 ? names.length : i; };
const pick = (files, names) => [...files].sort((a, b) => rank(names)(a) - rank(names)(b) || a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b))[0] ?? null;

function sidebarFlag(opt, scopes) {
  if (opt !== undefined) return { value: opt, source: 'flag' };
  return { value: [...scopes.light.keys()].some((k) => k.startsWith('sidebar')), source: 'auto (sidebar tokens defined)' };
}

function bundle(bundlePath, { hasSidebar, checklistFile = CHECKLIST } = {}) {
  const abs = path.resolve(bundlePath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new NeedsHuman("The bundle path provided doesn't exist. Can you confirm the correct path to the Claude Design export?", `token-check bundle: ${abs} is not a folder`);
  }
  const cl = readChecklist(checklistFile);
  const files = [];
  walk(abs, files);
  const cssFiles = files.filter((f) => f.endsWith('.css') && /:root\s*\{/.test(fs.readFileSync(f, 'utf8')));
  const css = pick(cssFiles, ['globals.css', 'variables.css', 'tokens.css']);
  let tailwind = pick(files.filter((f) => /^tailwind\.config\.(ts|js|mjs|cjs)$/.test(path.basename(f))), ['tailwind.config.ts', 'tailwind.config.js']);
  const mdFiles = files.filter((f) => f.endsWith('.md') && (path.dirname(f) === abs || path.basename(path.dirname(f)) === 'docs'));
  const doc = pick(mdFiles, ['design-system.md', 'design-tokens.md', 'README.md']);
  const warnings = [];
  const cssText = css ? fs.readFileSync(css, 'utf8') : '';
  if (!tailwind && css && /@theme\b/.test(cssText)) {
    tailwind = `${css} (@theme)`;
    warnings.push('no tailwind.config in the bundle; the CSS @theme block (Tailwind v4) maps the tokens');
  }
  const missing = [];
  if (!css) missing.push('CSS variables file (a .css file containing :root {)');
  if (!tailwind) missing.push('tailwind.config.ts or tailwind.config.js');
  if (!doc) missing.push('token reference document (.md in the bundle root or docs/)');
  const supplementary = files.filter((f) => ['tokens.json', 'theme.json'].includes(path.basename(f)));
  for (const d of ['components', 'assets']) if (fs.existsSync(path.join(abs, d))) supplementary.push(path.join(abs, d));
  const report = {
    bundle_path: abs,
    css_variables_file: css ?? 'not found',
    tailwind_config_file: tailwind ?? 'not found',
    token_reference_file: doc ?? 'not found',
    structural: { status: missing.length ? 'fail' : 'pass', missing_files: missing },
  };
  if (missing.length) {
    throw new NeedsHuman(
      `The Claude Design bundle at ${abs} is missing: ${missing.join('; ')}. Can you confirm the bundle path or re-export it with these files?`,
      'token-check bundle: structural check failed',
      { report: { ...report, status: 'fail' } },
    );
  }
  const scopes = parseCss(cssText);
  const sidebar = sidebarFlag(hasSidebar, scopes);
  const docText = fs.readFileSync(doc, 'utf8');
  const ev = evaluate({ scopes, doc: docText, cl, hasSidebar: sidebar.value, mode: 'bundle' });
  const tokenRows = ev.results.filter((r) => r.category !== 'Dark Mode Parity');
  const failed = tokenRows.filter((r) => r.status === 'FAIL');
  const tokenStatus = failed.length === 0 ? 'pass' : failed.length === tokenRows.filter((r) => r.status !== 'N/A').length ? 'fail' : 'partial';
  const parity = { status: ev.noDark.length || scopes.dark.size === 0 ? 'fail' : 'pass', tokens_missing_dark_override: ev.noDark.map((t) => `--${t}`), orphaned_dark_tokens: ev.orphaned.map((t) => `--${t}`) };
  const status = tokenStatus === 'pass' && parity.status === 'pass' ? 'pass' : 'fail';
  return {
    ...report,
    status,
    has_sidebar: sidebar.value,
    has_sidebar_source: sidebar.source,
    token_completeness: {
      status: tokenStatus,
      missing_categories: failed.map((r) => r.category),
      missing_tokens: [...new Set(failed.flatMap((r) => r.missing))],
      optional_tokens_present: ev.optional,
      type_scale_approach: tokenRows.find((r) => r.category === 'Type Scale')?.approach ?? null,
      categories: ev.results,
    },
    dark_mode_parity: parity,
    canonicalized_paths: { css_variables_file: css, tailwind_config_file: tailwind, token_reference_file: doc, supplementary_files: supplementary },
    warnings: [...warnings, ...ev.warnings],
  };
}

function readInput(label, file) {
  const abs = path.resolve(file);
  try { return { abs, text: fs.readFileSync(abs, 'utf8') }; } catch {
    throw new NeedsHuman(`I can't find ${file}. Can you confirm the correct path?`, `token-check complete: ${label} ${abs} could not be read`);
  }
}

function complete(inputs, { hasSidebar, checklistFile = CHECKLIST } = {}) {
  const cl = readChecklist(checklistFile);
  const preWrite = !inputs.css && Boolean(inputs.draft);
  if (!inputs.css && !inputs.draft) throw new UsageError('complete needs a CSS entry file (or --draft for the pre-write check)');
  const docFile = inputs.doc ?? inputs.draft;
  if (!docFile) throw new UsageError('complete needs the design-system document (--doc)');
  const doc = readInput('design-system document', docFile);
  let scopes;
  let css = null;
  if (preWrite) scopes = parseDraft(readInput('draft', inputs.draft).text);
  else { css = readInput('CSS entry', inputs.css); scopes = parseCss(css.text); }
  let tw = { kind: 'none' };
  let twPath = null;
  if (!preWrite) {
    if (inputs.tailwind) { const t = readInput('tailwind config', inputs.tailwind); tw = { kind: 'config', text: t.text }; twPath = t.abs; }
    else if (scopes.hasTheme) { tw = { kind: 'theme' }; twPath = `${css.abs} (@theme)`; }
  }
  const sidebar = sidebarFlag(hasSidebar, scopes);
  const ev = evaluate({ scopes, doc: doc.text, cl, hasSidebar: sidebar.value, mode: 'complete', tw, preWrite });
  const tbd = tbdSlots(doc.text);
  const pass = ev.results.every((r) => r.status !== 'FAIL') && tbd.length === 0;
  return {
    status: pass ? 'pass' : 'fail',
    gate: pass ? 'PASS' : 'FAIL',
    pre_write: preWrite,
    globals_css_path: css?.abs ?? null,
    draft_path: preWrite ? path.resolve(inputs.draft) : null,
    tailwind_config_path: twPath,
    design_system_md_path: doc.abs,
    has_sidebar: sidebar.value,
    has_sidebar_source: sidebar.source,
    categories: ev.results,
    failed_categories: ev.results.filter((r) => r.status === 'FAIL').map((r) => r.category),
    tbd_slots: tbd,
    layer_contrast: ev.contrast ? { light: ev.contrast.light, dark: ev.contrast.dark } : null,
    optional_tokens_present: ev.optional,
    warnings: ev.warnings,
  };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, positional: [], checklist: CHECKLIST };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--sidebar' || a === '--has-sidebar') opts.hasSidebar = true;
    else if (a === '--no-sidebar') opts.hasSidebar = false;
    else if (['--css', '--tailwind', '--doc', '--draft', '--checklist'].includes(a)) opts[a.slice(2)] = rest[++i];
    else if (a.startsWith('--')) throw new UsageError(`unknown argument ${a}`);
    else opts.positional.push(a);
  }
  if (!['bundle', 'complete'].includes(command)) throw new UsageError(`unknown command ${command ?? '(none)'}`);
  for (const p of opts.positional) {
    const base = path.basename(p);
    if (command === 'bundle') opts.bundle = opts.bundle ?? p;
    else if (base.endsWith('.css')) opts.css = opts.css ?? p;
    else if (/^tailwind\.config\./.test(base)) opts.tailwind = opts.tailwind ?? p;
    else if (/draft.*\.md$/.test(base)) opts.draft = opts.draft ?? p;
    else if (base.endsWith('.md')) opts.doc = opts.doc ?? p;
    else throw new UsageError(`cannot tell what ${p} is; pass it with --css, --tailwind, --doc or --draft`);
  }
  if (command === 'bundle' && !opts.bundle) throw new UsageError('bundle needs the bundle folder');
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    const shared = { hasSidebar: opts.hasSidebar, checklistFile: path.resolve(opts.checklist) };
    const result = opts.command === 'bundle'
      ? bundle(opts.bundle, shared)
      : complete({ css: opts.css, tailwind: opts.tailwind, doc: opts.doc, draft: opts.draft }, shared);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err) {
    if (err instanceof NeedsHuman) {
      process.stdout.write(`${JSON.stringify({ needs_human: { category: 'prd_ambiguity', question: err.question, context: err.context }, ...(err.extra ?? {}) })}\n`);
      process.exit(2);
    }
    process.stderr.write(`token-check: ${err.message}\n`);
    if (err instanceof UsageError) {
      process.stderr.write('usage: token-check.js bundle <dir> [--sidebar|--no-sidebar]\n       token-check.js complete <css> [tailwind.config.ts] <design-system.md> [--sidebar|--no-sidebar]\n       token-check.js complete --draft docs/design-system-draft.md [--sidebar|--no-sidebar]\n');
    }
    process.exit(1);
  }
}

module.exports = { readChecklist, parseCss, parseDraft, oklchLightness, isColorValue, docSections, bundle, complete, NeedsHuman };

if (require.main === module) main();
