import type { Language, Role } from '../../types.js';

/** Every event the notification system can deliver (contract: status/notify-notes.md). */
export const NOTIFY_EVENTS = [
  'print.started',
  'print.finished',
  'print.failed',
  'print.cancelled',
  'print.paused',
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'limit.blocked',
  'printer.error',
  'printer.offline',
  'engine.update_available',
  'engine.updated',
  'engine.update_failed',
] as const;

export type NotifyEventType = (typeof NOTIFY_EVENTS)[number];
/** `test` is only sent by the Test buttons. */
export type DeliverableEvent = NotifyEventType | 'test';

export const isNotifyEvent = (v: unknown): v is NotifyEventType =>
  typeof v === 'string' && (NOTIFY_EVENTS as readonly string[]).includes(v);

/** Facts carried by an event; renderers pick what they need. */
export interface NotifyEventData {
  printId?: number | null;
  printerId?: number | null;
  printerName?: string | null;
  fileName?: string | null;
  /** Owner / requester of the print (or the refused user). */
  userId?: number | null;
  username?: string | null;
  /** Real duration (finished/failed/cancelled) or the estimate (started). */
  durationSec?: number | null;
  grams?: number | null;
  reason?: string | null;
  /** Limit code (`prints.limit_*`) or printer error code. */
  code?: string | number | null;
  version?: string | null;
  error?: string | null;
  auto?: boolean;
}

export interface NotifyEvent {
  type: NotifyEventType;
  data: NotifyEventData;
  at: number;
}

/** Who receives an event (Web Push). Channels ignore this: they always go to the admin's destinations. */
export type Audience = 'owner+admins' | 'admins' | 'owner';

export interface EventMeta {
  audience: Audience;
  /** Discord embed colour. */
  color: number;
  emoji: string;
  /** ntfy tag (emoji shortcode) and priority. */
  tag: string;
  priority: 'min' | 'low' | 'default' | 'high' | 'urgent';
  /** Path in the SPA the push notification opens. */
  url: string;
  /** Regular users may receive (and toggle) it; admins get every event. */
  forUsers: boolean;
}

export const EVENT_META: Record<DeliverableEvent, EventMeta> = {
  'print.started': { audience: 'owner+admins', color: 0x0ea5e9, emoji: '🖨️', tag: 'printer', priority: 'default', url: '/', forUsers: true },
  'print.finished': { audience: 'owner+admins', color: 0x22c55e, emoji: '✅', tag: 'white_check_mark', priority: 'high', url: '/', forUsers: true },
  'print.failed': { audience: 'owner+admins', color: 0xef4444, emoji: '❌', tag: 'x', priority: 'high', url: '/', forUsers: true },
  'print.cancelled': { audience: 'owner+admins', color: 0x71717a, emoji: '⏹️', tag: 'stop_button', priority: 'default', url: '/', forUsers: true },
  'print.paused': { audience: 'owner+admins', color: 0xf59e0b, emoji: '⏸️', tag: 'pause_button', priority: 'default', url: '/', forUsers: true },
  'approval.requested': { audience: 'admins', color: 0x8b5cf6, emoji: '📝', tag: 'memo', priority: 'default', url: '/admin?section=prints', forUsers: false },
  'approval.approved': { audience: 'owner', color: 0x22c55e, emoji: '👍', tag: 'thumbsup', priority: 'default', url: '/', forUsers: true },
  'approval.rejected': { audience: 'owner', color: 0xef4444, emoji: '👎', tag: 'thumbsdown', priority: 'default', url: '/', forUsers: true },
  'limit.blocked': { audience: 'owner', color: 0xf97316, emoji: '⛔', tag: 'no_entry', priority: 'default', url: '/', forUsers: true },
  'printer.error': { audience: 'owner+admins', color: 0xdc2626, emoji: '⚠️', tag: 'warning', priority: 'urgent', url: '/', forUsers: true },
  'printer.offline': { audience: 'admins', color: 0x64748b, emoji: '📴', tag: 'electric_plug', priority: 'high', url: '/', forUsers: false },
  'engine.update_available': { audience: 'admins', color: 0x0ea5e9, emoji: '🔔', tag: 'bell', priority: 'low', url: '/admin?section=engine', forUsers: false },
  'engine.updated': { audience: 'admins', color: 0x22c55e, emoji: '⬆️', tag: 'arrow_up', priority: 'low', url: '/admin?section=engine', forUsers: false },
  'engine.update_failed': { audience: 'admins', color: 0xef4444, emoji: '❌', tag: 'x', priority: 'high', url: '/admin?section=engine', forUsers: false },
  test: { audience: 'owner', color: 0x0284c7, emoji: '🔔', tag: 'bell', priority: 'default', url: '/account#notifications', forUsers: true },
};

/** Events a user of this role may receive by Web Push (and toggle in Account → Notifications). */
export function eventsForRole(role: Role): NotifyEventType[] {
  return NOTIFY_EVENTS.filter((e) => role === 'admin' || EVENT_META[e].forUsers);
}

export interface Recipient {
  id: number;
  role: Role;
  language: Language;
}

/** Push recipients of an event among the active users. */
export function recipientsFor(event: NotifyEvent, users: readonly Recipient[]): Recipient[] {
  const audience = EVENT_META[event.type].audience;
  const owner = event.data.userId ?? null;
  return users.filter((u) => {
    if (audience === 'admins') return u.role === 'admin';
    if (audience === 'owner') return owner !== null && u.id === owner;
    return u.role === 'admin' || (owner !== null && u.id === owner);
  });
}

/** Two events with the same key within the dedupe window are delivered once. */
export function dedupeKey(event: NotifyEvent): string {
  const d = event.data;
  const subject = d.printId ?? (d.printerId != null ? `printer:${d.printerId}` : null) ?? d.version ?? (d.userId != null ? `user:${d.userId}` : '');
  return `${event.type}|${subject}|${event.type === 'limit.blocked' ? (d.fileName ?? '') : ''}`;
}
