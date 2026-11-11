// Dev-only mock for the Phase 4 notification endpoints (Admin → Notifications, Account → Notifications).
// Channel tests "fail" when the URL/topic/chat contains "fail"; a push test shows a real browser notification
// when the permission was granted (that is the simulated push).
import { ApiError } from '../api'
import {
  NOTIFY_CHANNELS,
  NOTIFY_EVENTS,
  type AccountNotifications,
  type AdminNotifications,
  type NotifyChannel,
  type NotifyChannelConfigs,
  type NotifyChannelStatus,
  type NotifyEvent,
  type PushDevice,
} from '../types'
import { mockCore } from './mock'
import { NOT_HANDLED } from './mockF2'

const KEY = 'sd:mock-notify'
const MASK = '********'
const SECRETS: Record<NotifyChannel, string[]> = { discord: ['webhookUrl'], telegram: ['botToken'], ntfy: ['token'], webhook: ['url', 'secret'] }
const USER_EVENTS: NotifyEvent[] = NOTIFY_EVENTS.filter((e) => !['approval.requested', 'printer.offline', 'printer.heaters_auto_off', 'engine.update_available', 'engine.updated', 'engine.update_failed'].includes(e))

interface MockDevice extends PushDevice {
  userId: number
  endpoint: string
}

interface NotifyState {
  channels: NotifyChannelConfigs
  status: Record<NotifyChannel, NotifyChannelStatus>
  devices: MockDevice[]
  prefs: Record<number, NotifyEvent[]>
  nextId: number
}

const emptyStatus = (): NotifyChannelStatus => ({ lastEvent: null, lastAttemptAt: null, lastSuccessAt: null, lastError: null, lastErrorAt: null })

function fresh(): NotifyState {
  const all = [...NOTIFY_EVENTS]
  return {
    channels: {
      discord: { enabled: false, webhookUrl: null, mention: null, events: all },
      telegram: { enabled: false, botToken: null, chatId: null, events: all },
      ntfy: { enabled: false, serverUrl: 'https://ntfy.sh', topic: null, token: null, localServer: false, events: all },
      webhook: { enabled: false, url: null, secret: null, events: all },
    },
    status: { discord: emptyStatus(), telegram: emptyStatus(), ntfy: emptyStatus(), webhook: emptyStatus() },
    devices: [],
    prefs: {},
    nextId: 1,
  }
}

function load(): NotifyState {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const saved = JSON.parse(raw) as NotifyState
      const base = fresh()
      return { ...base, ...saved, channels: { ...base.channels, ...saved.channels, ntfy: { ...base.channels.ntfy, ...saved.channels?.ntfy } } }
    }
  } catch {
    // ignore
  }
  return fresh()
}

let st = load()
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(st))
  } catch {
    // ignore
  }
}

export function resetNotify() {
  st = fresh()
  save()
}

const isChannel = (v: string): v is NotifyChannel => (NOTIFY_CHANNELS as readonly string[]).includes(v)

function masked(): NotifyChannelConfigs {
  const out = structuredClone(st.channels) as unknown as Record<NotifyChannel, Record<string, unknown>>
  for (const c of NOTIFY_CHANNELS) for (const k of SECRETS[c]) if (out[c][k]) out[c][k] = MASK
  return out as unknown as NotifyChannelConfigs
}

function adminView(): AdminNotifications {
  const email = mockCore.state.settings['admin.email']
  return {
    channels: masked(),
    status: st.status,
    events: [...NOTIFY_EVENTS],
    push: { subject: email ? `mailto:${email}` : 'mailto:admin@localhost', subjectFallback: !email, devices: st.devices.length },
    // Sample flood-protection state so the admin page shows the "held back" list in the mock
    rateLimit: {
      events: ['limit.blocked', 'approval.requested'],
      maxPerWindow: 5,
      windowMinutes: 60,
      heldTotal: 7,
      digestsSent: 1,
      active: [{ userId: 2, username: 'alice', event: 'limit.blocked', sent: 5, held: 7, digestAt: Date.now() + 25 * 60_000, lastHeldAt: Date.now() - 60_000 }],
    },
  }
}

const strip = ({ userId: _u, endpoint: _e, ...d }: MockDevice): PushDevice => d

async function sha16(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

function accountView(): AccountNotifications {
  const u = mockCore.requireUser()
  const events = u.role === 'admin' ? [...NOTIFY_EVENTS] : USER_EVENTS
  const prefs = st.prefs[u.id] ?? events
  return {
    vapidPublicKey: 'BMockVapidPublicKeyForTheDevMockOnly_000000000000000000000000000000000000000000000000000',
    events,
    prefs: { events: events.filter((e) => prefs.includes(e)) },
    devices: st.devices.filter((d) => d.userId === u.id).map(strip),
  }
}

function validate(channel: NotifyChannel, b: Record<string, unknown>) {
  const issues: { path: string; message: string }[] = []
  const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : null)
  if (channel === 'discord' && str('webhookUrl') && str('webhookUrl') !== MASK && !/^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\//.test(str('webhookUrl')!)) {
    issues.push({ path: 'webhookUrl', message: 'Must be a Discord webhook URL (https://discord.com/api/webhooks/…)' })
  }
  if (channel === 'webhook' && str('url') && str('url') !== MASK && !/^https:\/\//.test(str('url')!)) issues.push({ path: 'url', message: 'Must be an https URL' })
  if (channel === 'ntfy' && 'serverUrl' in b && !/^https?:\/\/.+/.test(str('serverUrl') ?? '')) issues.push({ path: 'serverUrl', message: 'Must be an http(s) URL' })
  if (issues.length) throw new ApiError(400, 'validation.failed', 'Request validation failed', issues)
}

export function handleNotify(method: string, p: string, b: Record<string, unknown>): unknown {
  // ---------- admin ----------
  if (p === '/admin/notifications' && method === 'GET') {
    mockCore.requireAdmin()
    return adminView()
  }
  const m = p.match(/^\/admin\/notifications\/(\w+)(\/test)?$/)
  if (m) {
    mockCore.requireAdmin()
    const channel = m[1]!
    if (!isChannel(channel)) throw new ApiError(404, 'common.not_found', 'Not found')
    const cfg = st.channels[channel] as unknown as Record<string, unknown>
    if (!m[2] && method === 'PATCH') {
      validate(channel, b)
      for (const [k, v] of Object.entries(b)) {
        if (!(k in cfg)) throw new ApiError(400, 'validation.failed', 'Unknown field', [{ path: k, message: 'Unknown field' }])
        if (v === MASK) continue
        cfg[k] = typeof v === 'string' && v.trim() === '' ? (k === 'serverUrl' ? cfg[k] : null) : v
      }
      mockCore.audit('notify.channel_update', channel, { fields: Object.keys(b) })
      save()
      return adminView()
    }
    if (m[2] && method === 'POST') {
      const ready =
        channel === 'discord' ? !!cfg.webhookUrl : channel === 'telegram' ? !!cfg.botToken && !!cfg.chatId : channel === 'ntfy' ? !!cfg.topic : !!cfg.url
      if (!ready) throw new ApiError(400, 'notify.channel_not_configured', 'Fill in and save this channel first')
      const now = Date.now()
      const status = st.status[channel]
      status.lastEvent = 'test'
      status.lastAttemptAt = now
      const target = Object.entries(cfg).filter(([k, v]) => k !== 'events' && typeof v === 'string').map(([, v]) => v).join(' ')
      if (target.includes('fail')) {
        status.lastError = 'HTTP 401'
        status.lastErrorAt = now
        save()
        throw new ApiError(502, 'notify.test_failed', `The channel rejected the message: ${status.lastError}`, { error: status.lastError, status: 401 })
      }
      status.lastSuccessAt = now
      save()
      return { ok: true, status }
    }
  }

  // ---------- account ----------
  if (p === '/account/notifications' && method === 'GET') return accountView()
  if (p === '/account/notifications/prefs' && method === 'PUT') {
    const u = mockCore.requireUser()
    st.prefs[u.id] = ((b.events as NotifyEvent[]) ?? []).filter((e) => NOTIFY_EVENTS.includes(e))
    save()
    return accountView()
  }
  if (p === '/account/notifications/subscriptions' && method === 'POST') {
    const u = mockCore.requireUser()
    const endpoint = String(b.endpoint ?? '')
    if (!/^https:\/\/(fcm\.googleapis\.com|[\w.-]*push\.apple\.com|[\w.-]*push\.services\.mozilla\.com)\//.test(endpoint)) {
      throw new ApiError(400, 'notify.push_endpoint_invalid', 'Unknown push service')
    }
    return sha16(endpoint).then((endpointHash) => {
      const existing = st.devices.find((d) => d.endpoint === endpoint)
      if (existing) {
        existing.userId = u.id
        save()
        return strip(existing)
      }
      const d: MockDevice = {
        id: st.nextId++,
        userId: u.id,
        endpoint,
        endpointHash,
        userAgent: navigator.userAgent,
        service: new URL(endpoint).hostname,
        createdAt: Date.now(),
        lastSuccessAt: null,
        failCount: 0,
      }
      st.devices.push(d)
      save()
      return strip(d)
    })
  }
  if (p === '/account/notifications/subscriptions/remove' && method === 'POST') {
    const u = mockCore.requireUser()
    st.devices = st.devices.filter((d) => !(d.userId === u.id && d.endpoint === b.endpoint))
    save()
    return undefined
  }
  const del = p.match(/^\/account\/notifications\/subscriptions\/(\d+)$/)
  if (del && method === 'DELETE') {
    const u = mockCore.requireUser()
    const before = st.devices.length
    st.devices = st.devices.filter((d) => !(d.id === Number(del[1]) && d.userId === u.id))
    if (st.devices.length === before) throw new ApiError(404, 'common.not_found', 'Not found')
    save()
    return undefined
  }
  if (p === '/account/notifications/test' && method === 'POST') {
    const u = mockCore.requireUser()
    const mine = st.devices.filter((d) => d.userId === u.id)
    if (mine.length === 0) throw new ApiError(400, 'notify.no_devices', 'Enable notifications on a device first')
    for (const d of mine) d.lastSuccessAt = Date.now()
    save()
    // The simulated push: a real notification when the browser allows it
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(u.language === 'es' ? 'Notificación de prueba' : 'Test notification', {
          body: u.language === 'es' ? 'Las notificaciones de PrintYard funcionan.' : 'PrintYard notifications are working.',
          icon: '/icons/icon-192.png',
        })
      } catch {
        // some browsers only allow notifications from a service worker
      }
    }
    return { sent: mine.length, failed: 0, removed: 0 }
  }
  return NOT_HANDLED
}
