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

type Strings = {
  titles: Record<DeliverableEvent, string>;
  bodies: Record<DeliverableEvent, (d: Required<Vars>) => string>;
  fields: { printer: string; file: string; user: string; duration: string; estimate: string; grams: string; reason: string; version: string };
  reasons: Record<string, string>;
  limits: Record<string, string>;
  unknownFile: string;
  unknownPrinter: string;
  removePrint: string;
  auto: string;
};

interface Vars {
  file: string;
  printer: string;
  user: string;
  version: string;
  code: string;
  error: string;
  limit: string;
  auto: string;
}

const EN: Strings = {
  titles: {
    'print.started': 'Print started',
    'print.finished': 'Print finished',
    'print.failed': 'Print failed',
    'print.cancelled': 'Print cancelled',
    'print.paused': 'Print paused',
    'approval.requested': 'Approval requested',
    'approval.approved': 'Print approved',
    'approval.rejected': 'Print request rejected',
    'limit.blocked': 'Print blocked by your limits',
    'printer.error': 'Printer error',
    'printer.offline': 'Printer offline',
    'engine.update_available': 'Slicer engine update available',
    'engine.updated': 'Slicer engine updated',
    'engine.update_failed': 'Slicer engine update failed',
    test: 'Test notification',
  },
  bodies: {
    'print.started': (v) => `${v.file} started on ${v.printer}.`,
    'print.finished': (v) => `${v.file} finished on ${v.printer}.`,
    'print.failed': (v) => `${v.file} failed on ${v.printer}.`,
    'print.cancelled': (v) => `${v.file} was cancelled on ${v.printer}.`,
    'print.paused': (v) => `${v.file} is paused on ${v.printer}.`,
    'approval.requested': (v) => `${v.user} wants to print ${v.file}.`,
    'approval.approved': (v) => `Your request to print ${v.file} was approved.`,
    'approval.rejected': (v) => `Your request to print ${v.file} was rejected.`,
    'limit.blocked': (v) => `${v.file} was not sent to the printer: ${v.limit}.`,
    'printer.error': (v) => `${v.printer} reported an error${v.code ? ` (code ${v.code})` : ''}.`,
    'printer.offline': (v) => `${v.printer} has been offline for more than 5 minutes during a print.`,
    'engine.update_available': (v) => `Creality Print ${v.version} is available.`,
    'engine.updated': (v) => `Creality Print ${v.version} was installed${v.auto}.`,
    'engine.update_failed': (v) => `Could not install Creality Print ${v.version}: ${v.error}`,
    test: () => 'SliceDock notifications are working.',
  },
  fields: { printer: 'Printer', file: 'File', user: 'User', duration: 'Duration', estimate: 'Estimated time', grams: 'Filament', reason: 'Reason', version: 'Version' },
  reasons: {
    cancelled_by: 'Cancelled by {0}',
    cancelled_on_printer: 'Cancelled on the printer',
    replaced_on_printer: 'Another print was started on the printer',
    printer_error: 'Printer error {0}',
    printer_failed: 'The printer reported a failure',
    printer_did_not_start: 'The printer did not start the job',
    file_changed: 'The file changed or was removed',
    file_missing: 'The file is missing',
    'prints.upload_failed': 'Upload to the printer failed',
  },
  limits: {
    'prints.limit_per_print': 'it uses more filament than your per-print limit',
    'prints.limit_month': 'it would exceed your monthly filament limit',
    'prints.limit_hours': 'it takes longer than your per-print time limit',
  },
  unknownFile: 'A print',
  unknownPrinter: 'the printer',
  removePrint: 'Remember to remove the print: the bed stays marked as occupied until someone confirms it is clear.',
  auto: ' automatically',
};

const ES: Strings = {
  titles: {
    'print.started': 'Impresión iniciada',
    'print.finished': 'Impresión terminada',
    'print.failed': 'La impresión falló',
    'print.cancelled': 'Impresión cancelada',
    'print.paused': 'Impresión en pausa',
    'approval.requested': 'Solicitud de aprobación',
    'approval.approved': 'Impresión aprobada',
    'approval.rejected': 'Solicitud de impresión rechazada',
    'limit.blocked': 'Impresión bloqueada por tus límites',
    'printer.error': 'Error de la impresora',
    'printer.offline': 'Impresora desconectada',
    'engine.update_available': 'Actualización del motor de laminado disponible',
    'engine.updated': 'Motor de laminado actualizado',
    'engine.update_failed': 'Falló la actualización del motor de laminado',
    test: 'Notificación de prueba',
  },
  bodies: {
    'print.started': (v) => `${v.file} empezó a imprimirse en ${v.printer}.`,
    'print.finished': (v) => `${v.file} terminó de imprimirse en ${v.printer}.`,
    'print.failed': (v) => `${v.file} falló en ${v.printer}.`,
    'print.cancelled': (v) => `Se canceló ${v.file} en ${v.printer}.`,
    'print.paused': (v) => `${v.file} está en pausa en ${v.printer}.`,
    'approval.requested': (v) => `${v.user} quiere imprimir ${v.file}.`,
    'approval.approved': (v) => `Se aprobó tu solicitud para imprimir ${v.file}.`,
    'approval.rejected': (v) => `Se rechazó tu solicitud para imprimir ${v.file}.`,
    'limit.blocked': (v) => `${v.file} no se envió a la impresora: ${v.limit}.`,
    'printer.error': (v) => `${v.printer} reportó un error${v.code ? ` (código ${v.code})` : ''}.`,
    'printer.offline': (v) => `${v.printer} lleva más de 5 minutos desconectada durante una impresión.`,
    'engine.update_available': (v) => `Creality Print ${v.version} está disponible.`,
    'engine.updated': (v) => `Se instaló Creality Print ${v.version}${v.auto}.`,
    'engine.update_failed': (v) => `No se pudo instalar Creality Print ${v.version}: ${v.error}`,
    test: () => 'Las notificaciones de SliceDock funcionan.',
  },
  fields: { printer: 'Impresora', file: 'Archivo', user: 'Usuario', duration: 'Duración', estimate: 'Tiempo estimado', grams: 'Filamento', reason: 'Motivo', version: 'Versión' },
  reasons: {
    cancelled_by: 'Cancelada por {0}',
    cancelled_on_printer: 'Cancelada desde la impresora',
    replaced_on_printer: 'Se inició otra impresión desde la impresora',
    printer_error: 'Error de la impresora {0}',
    printer_failed: 'La impresora reportó un fallo',
    printer_did_not_start: 'La impresora no inició el trabajo',
    file_changed: 'El archivo cambió o se eliminó',
    file_missing: 'Falta el archivo',
    'prints.upload_failed': 'Falló la subida a la impresora',
  },
  limits: {
    'prints.limit_per_print': 'usa más filamento que tu límite por impresión',
    'prints.limit_month': 'superaría tu límite mensual de filamento',
    'prints.limit_hours': 'tarda más que tu límite de tiempo por impresión',
  },
  unknownFile: 'Una impresión',
  unknownPrinter: 'la impresora',
  removePrint: 'Recuerda retirar la pieza: la cama queda marcada como ocupada hasta que alguien confirme que está libre.',
  auto: ' automáticamente',
};

const STRINGS: Record<Language, Strings> = { en: EN, es: ES };

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
  const vars: Required<Vars> = {
    file: clip(data.fileName?.trim() || s.unknownFile, 120),
    printer: clip(data.printerName?.trim() || s.unknownPrinter, 80),
    user: clip(data.username?.trim() || '?', 64),
    version: clip(data.version ?? '?', 40),
    code: data.code === null || data.code === undefined ? '' : String(data.code),
    error: clip(data.error ?? '', 300),
    limit: (typeof data.code === 'string' && s.limits[data.code]) || String(data.code ?? ''),
    auto: data.auto ? s.auto : '',
  };
  let body = s.bodies[event](vars);
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
