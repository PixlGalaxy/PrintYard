#!/usr/bin/env node
/**
 * Builds SliceDock's option texts and translations from a Creality Print source checkout (AGPL-3.0).
 *
 *   node scripts/build-i18n.mjs <path to CrealityPrint clone> [lang ...]     (default langs: es)
 *
 * Reads (from the working tree, or `git show HEAD:<path>` when the checkout is incomplete):
 *   - src/libslic3r/PrintConfig.cpp: per option `def->tooltip = L("…")` and `def->enum_labels.*(L("…"))`
 *   - localization/i18n/<lang>/CrealityPrint_<lang>.po: gettext catalog (msgid = the English string)
 * Writes:
 *   - ../locales/en/slicer.json: { options: { key: { tooltip?, enumLabels? } } } (English)
 *   - ../locales/<lang>/slicer.json: { messages: { english: translated } } restricted to the strings SliceDock shows
 *     (option labels, tooltips, enum labels, categories, page and group names). Empty and fuzzy entries are skipped.
 * The clone is only read; nothing in it is built or executed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = join(dirname(fileURLToPath(import.meta.url)), '..');
const locales = join(backend, '..', 'locales');
const [clone, ...langsArg] = process.argv.slice(2);
if (!clone) {
  console.error('usage: node scripts/build-i18n.mjs <CrealityPrint clone> [lang ...]');
  process.exit(2);
}
const langs = langsArg.length ? langsArg : ['es'];

function readSource(rel) {
  const p = join(clone, rel);
  if (existsSync(p)) return readFileSync(p, 'utf8');
  return execFileSync('git', ['-C', clone, 'show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** C string literal body → text (\n, \t, \", \\, \', octal/hex are rare in labels). */
function unescapeC(s) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|[0-7]{1,3}|.)/g, (_m, e) => {
    if (e === 'n') return '\n';
    if (e === 't') return '\t';
    if (e === 'r') return '\r';
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return e;
  });
}

/** Concatenated string literals starting at `pos` ("a" "b" ...), up to the closing paren. */
function readLiterals(src, pos) {
  let out = '';
  const re = /\s*"((?:[^"\\]|\\.)*)"/y;
  re.lastIndex = pos;
  let m;
  let any = false;
  while ((m = re.exec(src))) {
    out += unescapeC(m[1]);
    any = true;
  }
  return any ? out : null;
}

// ---- PrintConfig.cpp: tooltips and enum labels per option ----
const cfg = readSource('src/libslic3r/PrintConfig.cpp');
const options = {};
const addRe = /def\s*=\s*this->add(?:_nullable)?\(\s*"([a-z0-9_]+)"/g;
const starts = [];
for (let m = addRe.exec(cfg); m; m = addRe.exec(cfg)) starts.push({ key: m[1], at: m.index });
starts.forEach((s, i) => {
  const block = cfg.slice(s.at, starts[i + 1]?.at ?? cfg.length);
  const entry = {};
  const tip = /def->tooltip\s*=\s*_?L\(/.exec(block);
  if (tip) {
    const text = readLiterals(block, tip.index + tip[0].length);
    if (text && text.trim()) entry.tooltip = text.trim();
  }
  const labels = [];
  const labRe = /def->enum_labels\.(?:push_back|emplace_back)\(\s*_?L\(/g;
  for (let m = labRe.exec(block); m; m = labRe.exec(block)) {
    const text = readLiterals(block, m.index + m[0].length);
    if (text !== null) labels.push(text);
  }
  if (labels.length) entry.enumLabels = labels;
  if (Object.keys(entry).length && !options[s.key]) options[s.key] = entry;
});

const optionModes = JSON.parse(readFileSync(join(backend, 'resources', 'crealityprint-option-modes.json'), 'utf8'));
mkdirSync(join(locales, 'en'), { recursive: true });
writeFileSync(
  join(locales, 'en', 'slicer.json'),
  JSON.stringify({ source: 'CrealityPrint v7.3.1 src/libslic3r/PrintConfig.cpp (AGPL-3.0)', options }, null, 1) + '\n',
);

// Strings SliceDock shows.
const wanted = new Set();
for (const o of optionModes.options) {
  for (const s of [o.label, o.category]) if (s) wanted.add(s.trim());
  for (const u of o.ui ?? []) {
    wanted.add(u.page);
    wanted.add(u.group);
  }
}
for (const e of Object.values(options)) {
  if (e.tooltip) wanted.add(e.tooltip);
  for (const l of e.enumLabels ?? []) wanted.add(l);
}
for (const extra of ['Setting Overrides', 'Retraction', 'Filament', 'Cooling', 'Advanced', 'Multimaterial', 'Notes']) wanted.add(extra);

// ---- .po parsing ----
function parsePo(text) {
  const out = new Map();
  let cur = null;
  let field = null;
  const flush = () => {
    if (cur && !cur.fuzzy && cur.msgid && cur.msgstr && !cur.plural) out.set(cur.msgid, cur.msgstr);
    cur = { msgid: '', msgstr: '', fuzzy: false, plural: false };
    field = null;
  };
  flush();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('#,') && line.includes('fuzzy')) cur.fuzzy = true;
    if (line.startsWith('#')) continue;
    let m;
    if ((m = /^msgctxt\s+"(.*)"$/.exec(line))) field = 'ctx';
    else if ((m = /^msgid_plural\s+"(.*)"$/.exec(line))) ((cur.plural = true), (field = 'plural'));
    else if ((m = /^msgid\s+"(.*)"$/.exec(line))) {
      if (cur.msgid || cur.msgstr) flush();
      field = 'msgid';
      cur.msgid = unescapeC(m[1]);
    } else if ((m = /^msgstr(?:\[0\])?\s+"(.*)"$/.exec(line))) {
      field = 'msgstr';
      cur.msgstr = unescapeC(m[1]);
    } else if ((m = /^"(.*)"$/.exec(line))) {
      if (field === 'msgid') cur.msgid += unescapeC(m[1]);
      else if (field === 'msgstr') cur.msgstr += unescapeC(m[1]);
    }
  }
  flush();
  return out;
}

for (const lang of langs) {
  const catalog = parsePo(readSource(`localization/i18n/${lang}/CrealityPrint_${lang}.po`));
  const messages = {};
  let missing = 0;
  for (const s of [...wanted].sort()) {
    const t = catalog.get(s) ?? catalog.get(s.trim());
    if (t && t !== s) messages[s] = t;
    else if (!t) missing++;
  }
  mkdirSync(join(locales, lang), { recursive: true });
  writeFileSync(
    join(locales, lang, 'slicer.json'),
    JSON.stringify(
      {
        source: `CrealityPrint v7.3.1 localization/i18n/${lang}/CrealityPrint_${lang}.po`,
        license: 'AGPL-3.0; translations © Creality and the Creality Print / OrcaSlicer / Bambu Studio translators',
        messages,
      },
      null,
      1,
    ) + '\n',
  );
  console.log(`${lang}: ${Object.keys(messages).length} translated, ${missing} without translation (English fallback), catalog ${catalog.size}`);
}
console.log(`option texts: ${Object.keys(options).length} options with tooltip/enum labels`);
