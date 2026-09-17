#!/usr/bin/env node
'use strict';

/* ============================================================================
 *  build-standalone.js
 *
 *  Inlines public/styles.css and the ES modules under public/js/ into a single,
 *  fully self-contained HTML file:  oscilloscope-standalone.html
 *
 *  Why not just use a bundler? Because this project ships zero dependencies on
 *  purpose ("no npm install"), and the module syntax used here is deliberately
 *  small enough that inlining it is ~60 lines instead of a dependency.
 *
 *  The dialect, enforced below (anything else is a hard error, never a guess):
 *
 *    import * as ns from './other.js';   the ONLY import form
 *    export function f() {}              export const x = 1;
 *    export { a, b };                    no export let/var, no default, no
 *                                        export *, no dynamic import()
 *
 *  `export let` is rejected on purpose: inlined modules share no scope, but a
 *  re-exported *binding* would still be snapshotted at definition time, so a
 *  mutable scalar exported that way would silently stop updating. Mutable
 *  state must live in an exported object (or behind a getter) instead.
 *
 *  Import cycles are rejected too — the DAG check keeps the whole thing
 *  acyclic, which is the property that makes evaluation order irrelevant.
 *
 *    node build-standalone.js
 * ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const ENTRY = 'js/main.js';
const OUT = path.join(ROOT, 'oscilloscope-standalone.html');

const read = (p) => fs.readFileSync(p, 'utf8');

/* ------------------------------------------------------------- module graph */

const IMPORT_RE = /^import \* as ([A-Za-z_$][\w$]*) from '(\.[^']+)';?\s*$/;
const ANY_IMPORT_RE = /^import\b/;
const EXPORT_FN_RE = /^export function ([A-Za-z_$][\w$]*)/;
const EXPORT_CONST_RE = /^export const ([A-Za-z_$][\w$]*)/;
const EXPORT_LIST_RE = /^export \{([^}]*)\};?\s*$/;
const ANY_EXPORT_RE = /^export\b/;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(/;

/** Module id = path relative to public/, posix separators. */
function resolveId(fromId, spec) {
  const dir = path.posix.dirname(fromId);
  return path.posix.normalize(path.posix.join(dir, spec));
}

/** Parse the names out of an `export { ... }` list (which may span lines),
 *  rejecting anything that is not a plain local name — `export { a as b }` and
 *  friends would need real module machinery to mean what they say. */
function exportNames(list, id, where) {
  return list
    .replace(/\/\/[^\n]*/g, '')          // line comments inside the list
    .replace(/\s+/g, ' ')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (!/^[A-Za-z_$][\w$]*$/.test(s)) {
        throw new Error(`${id}: only plain names may be re-exported (${where}):\n    ${s}`);
      }
      return s;
    });
}

function loadModule(id, seen) {
  if (seen.has(id)) return seen.get(id);
  const file = path.join(PUB, id);
  if (!fs.existsSync(file)) throw new Error(`cannot resolve module: ${id} (imported by graph root ${ENTRY})`);

  const src = read(file);
  const mod = { id, file, src, imports: [], exports: [], body: null };
  seen.set(id, mod);

  const out = [];
  const srcLines = src.split('\n');
  for (let i = 0; i < srcLines.length; i++) {
    const line = srcLines[i].replace(/\s+$/, '');
    const imp = line.match(IMPORT_RE);
    if (imp) {
      const target = resolveId(id, imp[2]);
      mod.imports.push({ ns: imp[1], target });
      out.push(`const ${imp[1]} = __req(${JSON.stringify(target)});`);
      continue;
    }
    if (ANY_IMPORT_RE.test(line)) {
      throw new Error(`${id}: unsupported import form (only \`import * as ns from './x.js';\` is allowed):\n    ${line}`);
    }
    const fn = line.match(EXPORT_FN_RE);
    if (fn) {
      mod.exports.push(fn[1]);
      out.push(line.replace(/^export /, ''));
      continue;
    }
    const cn = line.match(EXPORT_CONST_RE);
    if (cn) {
      mod.exports.push(cn[1]);
      out.push(line.replace(/^export /, ''));
      continue;
    }
    const list = line.match(EXPORT_LIST_RE);
    if (list) {
      for (const name of exportNames(list[1], id, 'single line')) mod.exports.push(name);
      continue;   // nothing to emit: the names already exist in this module
    }
    if (/^export \{/.test(line)) {                 // multi-line export list
      const collected = [line.slice(line.indexOf('{') + 1)];
      let closed = false;
      while (++i < srcLines.length) {
        const l = srcLines[i];
        if (/^\};?\s*$/.test(l)) { closed = true; break; }
        collected.push(l);
      }
      if (!closed) throw new Error(`${id}: unterminated \`export {\` list`);
      for (const name of exportNames(collected.join(' '), id, 'multi line')) mod.exports.push(name);
      continue;
    }
    if (ANY_EXPORT_RE.test(line)) {
      throw new Error(`${id}: unsupported export form (no default / no export let / no export *):\n    ${line}`);
    }
    if (DYNAMIC_IMPORT_RE.test(line)) {
      throw new Error(`${id}: dynamic import() cannot be inlined:\n    ${line}`);
    }
    out.push(line);
  }

  for (const { target } of mod.imports) loadModule(target, seen);
  mod.body = out.join('\n');
  mod.deps = seen;
  validateAliases(mod);
  return mod;
}

/** Every `const { a, b } = ns;` an author writes must name something the target
 *  module actually exports. Real ESM fails this at link time; an inliner would
 *  quietly bind `undefined` and fail later, somewhere else. */
function validateAliases(mod) {
  const nsToId = new Map(mod.imports.map((i) => [i.ns, i.target]));
  const re = /const \{\n([\s\S]*?)\n\} = ([A-Za-z_$][\w$]*);/g;
  for (const m of mod.body.matchAll(re)) {
    const target = nsToId.get(m[2]);
    if (!target) continue;                       // not a module namespace
    const targetExports = new Set((mod.deps.get(target) || { exports: [] }).exports);
    for (const line of m[1].split('\n')) {
      const name = line.trim().replace(/,$/, '');
      if (!name) continue;
      if (!targetExports.has(name)) {
        throw new Error(`${mod.id}: \`${name}\` is not exported by ${target} — `
          + 'a stale alias would silently be undefined in the inlined build');
      }
    }
  }
}

/** Depth-first topological order, rejecting cycles outright. */
function topoSort(entry, seen) {
  const order = [];
  const done = new Set();
  const stack = [];
  (function visit(id) {
    if (done.has(id)) return;
    const at = stack.indexOf(id);
    if (at >= 0) {
      throw new Error(`import cycle: ${stack.slice(at).concat(id).join(' -> ')}\n`
        + '    (inlined modules would see a half-built namespace; break the cycle '
        + 'by passing the value in, or by inverting one dependency)');
    }
    stack.push(id);
    const mod = seen.get(id);
    if (!mod) throw new Error(`module not loaded: ${id}`);
    for (const { target } of mod.imports) visit(target);
    stack.pop();
    done.add(id);
    order.push(mod);
  })(entry);
  return order;
}

/* --------------------------------------------------------------- transform */

function bundle(entryId) {
  const seen = new Map();
  loadModule(entryId, seen);
  const order = topoSort(entryId, seen);

  const parts = [];
  for (const mod of order) {
    const tail = mod.exports.length
      ? '\n' + mod.exports.map((n) => `__exp.${n} = ${n};`).join('\n')
      : '';
    parts.push(`/* ---- ${mod.id} ${'-'.repeat(Math.max(0, 62 - mod.id.length))} */\n`
      + `__define(${JSON.stringify(mod.id)}, function (__exp, __req) {\n`
      + mod.body + tail + '\n});');
  }

  const runtime = `
/* Minimal module registry: each module body is a function that fills its own
   exports object and pulls its dependencies through __req. Exports objects are
   stable and filled before any caller runs (the graph is acyclic), so
   \`ns.name\` is always read at call time — no snapshotting of live values. */
(function () {
  'use strict';
  const registry = Object.create(null);
  function __define(id, body) { registry[id] = { body, exports: null }; }
  function __req(id) {
    const mod = registry[id];
    if (!mod) throw new Error('module not found: ' + id);
    if (!mod.exports) {
      mod.exports = {};
      mod.body(mod.exports, __req);
    }
    return mod.exports;
  }
`;

  const js = `${runtime}${parts.join('\n\n')}\n\n__req(${JSON.stringify(entryId)});\n})();\n`;
  return { js, count: order.length, ids: order.map((m) => m.id) };
}

/* ------------------------------------------------------------------- build */

let html = read(path.join(PUB, 'index.html'));
const css = read(path.join(PUB, 'styles.css'));

let js;
let count;
try {
  const built = bundle(ENTRY);
  js = built.js;
  count = built.count;
  if (process.env.DSH_BUILD_LIST) console.log('  modules: ' + built.ids.join(', '));
} catch (err) {
  console.error(`  ✗ ${err.message}`);
  process.exit(1);
}

if (js.includes('</script')) {
  console.error('  ✗ the bundle contains a literal "</script" — inline build would break.');
  process.exit(1);
}

/** Replace using a function so `$&`-style patterns in the payload are literal. */
function put(source, needle, payload, label) {
  if (!source.includes(needle)) {
    console.error(`  ✗ could not find ${label} placeholder: ${needle}`);
    process.exit(1);
  }
  return source.replace(needle, () => payload);
}

const banner = `<!--
  ===========================================================================
   Web Oscilloscope Music Player / Visualizer — SINGLE-FILE EDITION
   Generated by build-standalone.js — do not edit this file directly,
   edit public/index.html, public/styles.css and public/js/*.js instead.

   Left channel -> X axis, right channel -> Y axis.
   No retrace lines, no glow.  See README.md for the full explanation.
  ===========================================================================
-->
`;

html = put(html, '<link rel="stylesheet" href="styles.css" />', `<style>\n${css}\n</style>`, 'stylesheet');
html = put(html, '<script type="module" src="js/main.js"></script>', `<script>\n${js}\n</script>`, 'module entry');
html = html.replace('<!doctype html>', `<!doctype html>\n${banner}`);
html = html.replace(
  '<title>示波器音乐播放器 · Oscilloscope Music Player</title>',
  '<title>示波器音乐播放器 · Oscilloscope Music Player（单文件版）</title>'
);

fs.writeFileSync(OUT, html, 'utf8');

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`
  ✓ built ${path.relative(ROOT, OUT)}
      html ${kb(html.length)}  (css ${kb(css.length)} + js ${kb(js.length)} inlined)
      ${count} modules inlined
      open it directly in a browser, or serve it via:  node server.js  ->  /standalone
`);
