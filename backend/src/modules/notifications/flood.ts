import type { Language } from '../../types.js';
import { CONTROL_CHARS } from '../../lib/sanitize.js';
import type { NotifyEventData, NotifyEventType } from './events.js';

/**
 * Flood protection for events a regular user can trigger at will (phase 3 review A #3): a refused print
 * (`limit.blocked`) or an approval request (`approval.requested`) used to reach every admin channel each time.
 *
 * Per user and event type, at most `max` deliveries per sliding `windowMs`. Further events are held back and
 * coalesced: when the window frees up, one digest delivery (the latest event + "N more…") goes out.
 */
export const USER_TRIGGERED_EVENTS: ReadonlySet<NotifyEventType> = new Set<NotifyEventType>(['limit.blocked', 'approval.requested']);
export const FLOOD_MAX_PER_WINDOW = 5;
export const FLOOD_WINDOW_MS = 60 * 60_000;

/** Longest user-controlled text (file, printer, user names, reasons) put into a notification. */
export const MAX_NOTIFY_TEXT = 80;
// Bidi overrides/isolates and zero-width characters can disguise text in chat clients.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Single line, no invisible/bidi characters, at most `max` code points (with an ellipsis). */
export function notifyText(v: string, max = MAX_NOTIFY_TEXT): string {
  const s = v.replace(CONTROL_CHARS, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

const TEXT_FIELDS = ['fileName', 'printerName', 'username', 'reason', 'error'] as const;

/** Copy of `data` with every user-controlled string cleaned and truncated (all channels and Web Push). */
export function sanitizeEventData(data: NotifyEventData): NotifyEventData {
  const out: NotifyEventData = { ...data };
  for (const k of TEXT_FIELDS) {
    const v = out[k];
    if (typeof v === 'string') out[k] = notifyText(v, k === 'error' ? 200 : MAX_NOTIFY_TEXT);
  }
  if (typeof out.code === 'string') out.code = notifyText(out.code, 64);
  return out;
}

/** "N more…" line appended to a digest delivery. */
export function heldBackText(n: number, language: Language): string {
  return language === 'es'
    ? `(+${n} ${n === 1 ? 'aviso similar' : 'avisos similares'} de este usuario en la última hora, agrupados para evitar spam)`
    : `(+${n} more like this from this user in the last hour, grouped to avoid flooding)`;
}

export interface FloodEntry {
  userId: number;
  event: NotifyEventType;
  /** Deliveries inside the current window. */
  sent: number;
  /** Events held back since the last delivery (sent later as one digest). */
  held: number;
  /** When the digest goes out (ms epoch), null when nothing is held. */
  digestAt: number | null;
  lastHeldAt: number | null;
}

export interface FloodStats {
  maxPerWindow: number;
  windowMs: number;
  /** Total events held back since the server started. */
  heldTotal: number;
  /** Digest deliveries since the server started. */
  digestsSent: number;
  /** Users currently rate-limited (held events waiting for their digest). */
  active: FloodEntry[];
}

interface Bucket {
  userId: number;
  event: NotifyEventType;
  sent: number[];
  held: number;
  lastData: NotifyEventData | null;
  lastHeldAt: number | null;
  digestAt: number | null;
  timer: NodeJS.Timeout | null;
}

export class FloodGuard {
  private readonly buckets = new Map<string, Bucket>();
  private heldTotal = 0;
  private digestsSent = 0;

  constructor(
    private readonly o: {
      max?: number;
      windowMs?: number;
      /** Sends the digest: the latest held event plus how many were held. */
      onDigest: (event: NotifyEventType, data: NotifyEventData, held: number, at: number) => void;
      now?: () => number;
    },
  ) {}

  private get max(): number {
    return this.o.max ?? FLOOD_MAX_PER_WINDOW;
  }
  private get windowMs(): number {
    return this.o.windowMs ?? FLOOD_WINDOW_MS;
  }

  /** true = deliver now; false = held back for the digest. Events that are not user-triggered always pass. */
  admit(event: NotifyEventType, data: NotifyEventData, at: number): boolean {
    if (!USER_TRIGGERED_EVENTS.has(event) || typeof data.userId !== 'number') return true;
    const key = `${data.userId}|${event}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { userId: data.userId, event, sent: [], held: 0, lastData: null, lastHeldAt: null, digestAt: null, timer: null };
      this.buckets.set(key, b);
    }
    b.sent = b.sent.filter((t) => at - t < this.windowMs);
    if (b.held === 0 && b.sent.length < this.max) {
      b.sent.push(at);
      return true;
    }
    b.held++;
    b.lastData = data;
    b.lastHeldAt = at;
    this.heldTotal++;
    if (!b.timer) {
      const oldest = b.sent[0] ?? at;
      const due = Math.max(oldest + this.windowMs, at + 1000);
      b.digestAt = due;
      b.timer = setTimeout(() => this.fire(key), due - at);
      b.timer.unref?.();
    }
    return false;
  }

  private fire(key: string): void {
    const b = this.buckets.get(key);
    if (!b) return;
    b.timer = null;
    b.digestAt = null;
    const held = b.held;
    const data = b.lastData;
    b.held = 0;
    b.lastData = null;
    if (held === 0 || !data) return;
    const at = (this.o.now ?? Date.now)();
    b.sent = b.sent.filter((t) => at - t < this.windowMs);
    b.sent.push(at);
    this.digestsSent++;
    this.o.onDigest(b.event, data, held, at);
  }

  /** Sends every pending digest now (tests and shutdown). */
  flushDigests(): void {
    for (const [key, b] of this.buckets) {
      if (b.timer) clearTimeout(b.timer);
      this.fire(key);
    }
  }

  stats(): FloodStats {
    const active: FloodEntry[] = [];
    for (const b of this.buckets.values()) {
      if (b.held === 0) continue;
      active.push({ userId: b.userId, event: b.event, sent: b.sent.length, held: b.held, digestAt: b.digestAt, lastHeldAt: b.lastHeldAt });
    }
    return { maxPerWindow: this.max, windowMs: this.windowMs, heldTotal: this.heldTotal, digestsSent: this.digestsSent, active };
  }

  stop(): void {
    for (const b of this.buckets.values()) if (b.timer) clearTimeout(b.timer);
    this.buckets.clear();
  }
}
