import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localesDir } from '../../lib/resources.js';
import type { Language } from '../../types.js';
import { EVENT_META, type DeliverableEvent, type NotifyEventData } from './events.js';

/** A localized notification, ready for any channel. */
export interface RenderedMessage {
  event: DeliverableEvent;
  language: Language;
  title: string;
  body: string;
  /** Extra facts (Discord fields, Telegram/ntfy lines). */
  fields: { name: string; value: string }[];
  /** SPA path to open (push) / absolute link when exposure.publicUrl is set. */
  path: string;
  link: string | null;
}

/** `locales/<lang>/notifications.json`. Bodies are templates: `{file}`, `{printer}`, `{user}`, `{version}`, `{code}`, `{codeSuffix}`, `{error}`, `{limit}`, `{auto}`. */
type Strings = {
  titles: Record<DeliverableEvent, string>;
  bodies: Record<DeliverableEvent, string>;
  fields: { printer: string; file: string; user: string; duration: string; estimate: string; grams: string; reason: string; version: string };
  reasons: Record<string, string>;
  limits: Record<string, string>;
  unknownFile: string;
  unknownPrinter: string;
  removePrint: string;
  auto: string;
  /** Appended to `printer.error` when there is a code (` (code {code})`). */
  codeSuffix: string;
};

type Vars = Record<'file' | 'printer' | 'user' | 'version' | 'code' | 'codeSuffix' | 'error' | 'limit' | 'auto', string>;

const load = (lang: Language): Strings => JSON.parse(readFileSync(join(localesDir(), lang, 'notifications.json'), 'utf8')) as Strings;

const STRINGS: Record<Language, Strings> = { en: load('en'), es: load('es') };
const EN = STRINGS.en;

/** `{name}` placeholders → values (single pass, so a value containing `{x}` is never re-expanded). */
const fill = (tpl: string, vars: Vars) => tpl.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? vars[k as keyof Vars] : m));

export function formatDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${Math.max(1, m)} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function formatGrams(g: number, lang: Language): string {
  const v = g >= 100 ? Math.round(g) : Math.round(g * 10) / 10;
  return `${v.toLocaleString(lang === 'es' ? 'es-ES' : 'en-US')} g`;
}

/** `cancelled_by:ana` → "Cancelled by ana"; unknown reasons are shown as they are. */
export function reasonText(reason: string, lang: Language): string {
  const s = STRINGS[lang];
  const i = reason.indexOf(':');
  const head = i > 0 && !reason.startsWith('prints.') ? reason.slice(0, i) : reason;
  const arg = i > 0 && !reason.startsWith('prints.') ? reason.slice(i + 1) : '';
  const tpl = s.reasons[head];
  return tpl ? tpl.replace('{0}', arg).trim() : reason;
}

const clip = (v: string, max: number) => (v.length > max ? `${v.slice(0, max - 1)}…` : v);

/** Renders an event in one language. `publicUrl` (exposure.publicUrl) turns the path into a clickable link. */
export function renderMessage(event: DeliverableEvent, data: NotifyEventData, language: Language, publicUrl: string | null = null): RenderedMessage {
  const s = STRINGS[language] ?? EN;
  const code = data.code === null || data.code === undefined ? '' : String(data.code);
  const vars: Vars = {
    file: clip(data.fileName?.trim() || s.unknownFile, 120),
    printer: clip(data.printerName?.trim() || s.unknownPrinter, 80),
    user: clip(data.username?.trim() || '?', 64),
    version: clip(data.version ?? '?', 40),
    code,
    codeSuffix: code ? s.codeSuffix.replace('{code}', code) : '',
    error: clip(data.error ?? '', 300),
    limit: (typeof data.code === 'string' && s.limits[data.code]) || String(data.code ?? ''),
    auto: data.auto ? s.auto : '',
  };
  let body = fill(s.bodies[event], vars);
  if (event === 'print.finished') body += `\n${s.removePrint}`;

  const fields: { name: string; value: string }[] = [];
  const f = s.fields;
  if (event.startsWith('print.') || event.startsWith('approval.') || event === 'limit.blocked') {
    if (data.printerName) fields.push({ name: f.printer, value: vars.printer });
    if (data.username && event !== 'limit.blocked') fields.push({ name: f.user, value: vars.user });
    if (data.durationSec != null && data.durationSec > 0) {
      fields.push({ name: event === 'print.started' || event.startsWith('approval.') ? f.estimate : f.duration, value: formatDuration(data.durationSec) });
    }
    if (data.grams != null && data.grams > 0) fields.push({ name: f.grams, value: formatGrams(data.grams, language) });
  }
  if (data.reason && event !== 'print.started' && event !== 'print.finished') {
    fields.push({ name: f.reason, value: clip(reasonText(data.reason, language), 300) });
  }

  const path = EVENT_META[event].url;
  const base = publicUrl?.replace(/\/+$/, '') ?? null;
  return { event, language, title: s.titles[event], body, fields, path, link: base ? `${base}${path}` : null };
}
