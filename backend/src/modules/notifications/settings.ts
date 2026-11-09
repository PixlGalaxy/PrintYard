// Settings keys of the admin notification channels. Imported by db/settings.ts (spread into SETTING_DEFS), so this
// file must only depend on zod and types: no services.
import { isIP } from 'node:net';
import { z } from 'zod';
import type { SettingDef } from '../../db/settings.js';
import { NOTIFY_EVENTS, type NotifyEventType } from './events.js';

export const CHANNELS = ['discord', 'telegram', 'ntfy', 'webhook'] as const;
export type ChannelName = (typeof CHANNELS)[number];
export const isChannel = (v: unknown): v is ChannelName => typeof v === 'string' && (CHANNELS as readonly string[]).includes(v);

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const nullable = <T>(schema: z.ZodType<T>) => z.preprocess(emptyToNull, schema.nullable()) as unknown as z.ZodType<T | null>;

function parseUrl(v: string): URL | null {
  try {
    return new URL(v);
  } catch {
    return null;
  }
}

/** Discord webhooks only: https://(ptb.|canary.)discord(app).com/api/webhooks/<id>/<token>. */
export function isDiscordWebhookUrl(v: string): boolean {
  const u = parseUrl(v);
  return (
    u !== null &&
    u.protocol === 'https:' &&
    /^(?:(?:ptb|canary)\.)?discord(?:app)?\.com$/i.test(u.hostname) &&
    u.port === '' &&
    /^\/api\/(?:v\d+\/)?webhooks\/\d{5,25}\/[\w-]{20,200}\/?$/.test(u.pathname) &&
    u.username === '' &&
    u.password === ''
  );
}

/** https URL without credentials; ntfy may also use http (checked to be private at send time). */
export function isChannelUrl(v: string, allowHttp: boolean): boolean {
  const u = parseUrl(v);
  if (!u || u.hostname === '' || u.username !== '' || u.password !== '') return false;
  if (u.protocol === 'https:') return true;
  return allowHttp && u.protocol === 'http:';
}

const discordUrl = z.string().trim().max(512).refine(isDiscordWebhookUrl, 'Must be a Discord webhook URL (https://discord.com/api/webhooks/…)');
const httpsUrl = z.string().trim().max(2048).refine((v) => isChannelUrl(v, false), 'Must be an https URL');
const ntfyServer = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => isChannelUrl(v, true), 'Must be an http(s) URL')
  .refine((v) => {
    // A public IP literal over plain http is refused right away; hostnames are resolved at send time.
    const u = parseUrl(v)!;
    if (u.protocol !== 'http:') return true;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return isIP(host) === 0 || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|fc|fd|::1$)/i.test(host);
  }, 'Plain http is only allowed for a server on your private network')
  .transform((v) => v.replace(/\/+$/, ''));

const mention = z
  .string()
  .trim()
  .max(200)
  .regex(/^(?:(?:<@!?\d{5,25}>|<@&\d{5,25}>|@everyone|@here)\s*)+$/, 'Use <@userId>, <@&roleId>, @here or @everyone');

const events = z
  .array(z.enum(NOTIFY_EVENTS))
  .max(NOTIFY_EVENTS.length)
  .transform((list) => [...new Set(list)]);

const def = <T>(schema: z.ZodType<T>, defaultValue: T, secret = false): SettingDef<T> => ({ schema, default: defaultValue, secret });
const ALL_EVENTS = [...NOTIFY_EVENTS] as NotifyEventType[];

export const NOTIFY_SETTING_DEFS = {
  'notify.discord.enabled': def(z.boolean(), false),
  'notify.discord.webhookUrl': def(nullable(discordUrl), null as string | null, true),
  'notify.discord.mention': def(nullable(mention), null as string | null),
  'notify.discord.events': def(events, ALL_EVENTS),
  'notify.telegram.enabled': def(z.boolean(), false),
  'notify.telegram.botToken': def(
    nullable(z.string().trim().regex(/^\d{3,15}:[\w-]{20,80}$/, 'Bot token looks like 123456:ABC-…')),
    null as string | null,
    true,
  ),
  'notify.telegram.chatId': def(
    nullable(z.string().trim().regex(/^(?:-?\d{1,20}|@[A-Za-z][\w]{4,31})$/, 'Numeric chat id or @channelname')),
    null as string | null,
  ),
  'notify.telegram.events': def(events, ALL_EVENTS),
  'notify.ntfy.enabled': def(z.boolean(), false),
  'notify.ntfy.serverUrl': def(ntfyServer, 'https://ntfy.sh'),
  'notify.ntfy.topic': def(nullable(z.string().trim().regex(/^[\w-]{1,64}$/, 'Letters, digits, - and _ (max 64)')), null as string | null),
  'notify.ntfy.token': def(nullable(z.string().trim().max(256).regex(/^[\x21-\x7e]+$/, 'No spaces')), null as string | null, true),
  // Review 3A #4: private (RFC 1918) destinations only when the admin says the server is on the LAN.
  'notify.ntfy.localServer': def(z.boolean(), false),
  'notify.ntfy.events': def(events, ALL_EVENTS),
  'notify.webhook.enabled': def(z.boolean(), false),
  // The URL may embed a token, so it is a secret too.
  'notify.webhook.url': def(nullable(httpsUrl), null as string | null, true),
  'notify.webhook.secret': def(nullable(z.string().max(256)), null as string | null, true),
  'notify.webhook.events': def(events, ALL_EVENTS),
} satisfies Record<string, SettingDef<any>>;

export type NotifySettingKey = keyof typeof NOTIFY_SETTING_DEFS;

/** Fields of each channel as the admin API exposes them (`notify.<channel>.<field>`). */
export const CHANNEL_FIELDS = {
  discord: ['enabled', 'webhookUrl', 'mention', 'events'],
  telegram: ['enabled', 'botToken', 'chatId', 'events'],
  ntfy: ['enabled', 'serverUrl', 'topic', 'token', 'localServer', 'events'],
  webhook: ['enabled', 'url', 'secret', 'events'],
} as const satisfies Record<ChannelName, readonly string[]>;
