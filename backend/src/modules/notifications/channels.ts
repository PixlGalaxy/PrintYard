import { createHmac } from 'node:crypto';
import { EVENT_META } from './events.js';
import type { RenderedMessage } from './i18n.js';
import type { NotifyEventData } from './events.js';
import { postOutbound, type OutboundDeps, type OutboundRequest } from './outbound.js';
import type { ChannelName } from './settings.js';

export const APP_NAME = 'SliceDock';
export const SIGNATURE_HEADER = 'X-SliceDock-Signature';

export interface DiscordConfig {
  enabled: boolean;
  webhookUrl: string | null;
  mention: string | null;
  events: string[];
}
export interface TelegramConfig {
  enabled: boolean;
  botToken: string | null;
  chatId: string | null;
  events: string[];
}
export interface NtfyConfig {
  enabled: boolean;
  serverUrl: string;
  topic: string | null;
  token: string | null;
  events: string[];
}
export interface WebhookConfig {
  enabled: boolean;
  url: string | null;
  secret: string | null;
  events: string[];
}
export interface ChannelConfigs {
  discord: DiscordConfig;
  telegram: TelegramConfig;
  ntfy: NtfyConfig;
  webhook: WebhookConfig;
}

/** Context every payload gets: instance link and the raw event facts (generic webhook). */
export interface MessageContext {
  data: NotifyEventData;
  at: number;
}

// ------------------------------------------------------------------ payload builders (pure, unit-tested)

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
/** Discord markdown: neutralise mentions and formatting coming from file/user names. */
const escapeDiscord = (s: string) => s.replace(/([\\*_`~|>])/g, '\\$1').replace(/@/g, '@\u200b');

export function discordPayload(cfg: Pick<DiscordConfig, 'mention'>, msg: RenderedMessage, at = Date.now()) {
  const meta = EVENT_META[msg.event];
  const withMention = !!cfg.mention && msg.event !== 'test';
  return {
    username: APP_NAME,
    content: withMention ? cfg.mention : undefined,
    embeds: [
      {
        title: `${meta.emoji}  ${msg.title}`.slice(0, 256),
        description: escapeDiscord(msg.body).slice(0, 4000),
        color: meta.color,
        ...(msg.link && { url: msg.link }),
        fields: msg.fields.slice(0, 10).map((f) => ({ name: f.name.slice(0, 256), value: escapeDiscord(f.value).slice(0, 1024) || '\u200b', inline: true })),
        footer: { text: APP_NAME },
        timestamp: new Date(at).toISOString(),
      },
    ],
    // Only the configured mention may ping; names inside the message never do.
    allowed_mentions: withMention ? { parse: ['users', 'roles', 'everyone'] } : { parse: [] },
  };
}

export function telegramPayload(cfg: Pick<TelegramConfig, 'chatId'>, msg: RenderedMessage) {
  const meta = EVENT_META[msg.event];
  const lines = [`${meta.emoji} <b>${escapeHtml(msg.title)}</b>`, escapeHtml(msg.body)];
  if (msg.fields.length) {
    lines.push('');
    for (const f of msg.fields) lines.push(`• <b>${escapeHtml(f.name)}</b>: ${escapeHtml(f.value)}`);
  }
  if (msg.link) lines.push('', `<a href="${escapeHtml(msg.link).replace(/"/g, '&quot;')}">${APP_NAME}</a>`);
  return { chat_id: cfg.chatId, text: lines.join('\n').slice(0, 4096), parse_mode: 'HTML', disable_web_page_preview: true };
}

/** HTTP headers must be latin-1: ntfy decodes RFC 2047 encoded words for non-ASCII titles. */
export function headerSafe(v: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  return `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

export function ntfyRequest(cfg: Pick<NtfyConfig, 'serverUrl' | 'topic' | 'token'>, msg: RenderedMessage): OutboundRequest {
  const meta = EVENT_META[msg.event];
  const body = [msg.body, ...msg.fields.map((f) => `${f.name}: ${f.value}`)].join('\n');
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain; charset=utf-8',
    Title: headerSafe(`${APP_NAME}: ${msg.title}`),
    Tags: meta.tag,
    Priority: meta.priority,
  };
  if (msg.link) headers.Click = msg.link;
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  return { url: `${cfg.serverUrl.replace(/\/+$/, '')}/${encodeURIComponent(cfg.topic ?? '')}`, body, headers, allowHttpPrivate: true };
}

/** `sha256=<hex HMAC-SHA256 of the raw body>`; receivers recompute it with the shared secret. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function webhookRequest(cfg: Pick<WebhookConfig, 'url' | 'secret'>, msg: RenderedMessage, ctx: MessageContext): OutboundRequest {
  const body = JSON.stringify({
    event: msg.event,
    title: msg.title,
    message: msg.body,
    fields: msg.fields,
    language: msg.language,
    link: msg.link,
    data: ctx.data,
    timestamp: new Date(ctx.at).toISOString(),
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': APP_NAME,
    'X-SliceDock-Event': msg.event,
  };
  if (cfg.secret) headers[SIGNATURE_HEADER] = signBody(cfg.secret, body);
  return { url: cfg.url ?? '', body, headers };
}

// ------------------------------------------------------------------ senders

/** Whether a channel has everything it needs to send. */
export function isReady(name: ChannelName, cfgs: ChannelConfigs): boolean {
  switch (name) {
    case 'discord':
      return !!cfgs.discord.webhookUrl;
    case 'telegram':
      return !!cfgs.telegram.botToken && !!cfgs.telegram.chatId;
    case 'ntfy':
      return !!cfgs.ntfy.serverUrl && !!cfgs.ntfy.topic;
    case 'webhook':
      return !!cfgs.webhook.url;
  }
}

export function buildRequest(name: ChannelName, cfgs: ChannelConfigs, msg: RenderedMessage, ctx: MessageContext): OutboundRequest {
  switch (name) {
    case 'discord':
      return {
        url: cfgs.discord.webhookUrl ?? '',
        body: JSON.stringify(discordPayload(cfgs.discord, msg, ctx.at)),
        headers: { 'Content-Type': 'application/json', 'User-Agent': APP_NAME },
      };
    case 'telegram':
      return {
        url: `https://api.telegram.org/bot${cfgs.telegram.botToken ?? ''}/sendMessage`,
        body: JSON.stringify(telegramPayload(cfgs.telegram, msg)),
        headers: { 'Content-Type': 'application/json' },
      };
    case 'ntfy':
      return ntfyRequest(cfgs.ntfy, msg);
    case 'webhook':
      return webhookRequest(cfgs.webhook, msg, ctx);
  }
}

/** Secrets of a channel, to scrub them from error messages before they are logged or shown. */
export function secretsOf(name: ChannelName, cfgs: ChannelConfigs): string[] {
  const list =
    name === 'discord'
      ? [cfgs.discord.webhookUrl]
      : name === 'telegram'
        ? [cfgs.telegram.botToken]
        : name === 'ntfy'
          ? [cfgs.ntfy.token]
          : [cfgs.webhook.url, cfgs.webhook.secret];
  return list.filter((s): s is string => !!s && s.length >= 4);
}

export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('********');
  return out;
}

export async function sendChannel(name: ChannelName, cfgs: ChannelConfigs, msg: RenderedMessage, ctx: MessageContext, deps: OutboundDeps = {}): Promise<void> {
  await postOutbound(buildRequest(name, cfgs, msg, ctx), deps);
}
