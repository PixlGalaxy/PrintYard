// Browser side of Web Push: support detection (incl. iOS rules), service worker registration and the
// subscribe/unsubscribe flow. In `npm run dev:mock` a fake subscription is used (no service worker, no push service).
import { ApiError, notifyApi } from '../../../api'

const MOCK = import.meta.env.DEV && import.meta.env.VITE_MOCK === '1'
const MOCK_KEY = 'sd:mock-push-endpoint'

export type PushBlocker = 'insecure' | 'ios-install' | 'ios-version' | 'unsupported' | 'dev-no-sw' | null

export interface PushEnvironment {
  ios: boolean
  /** Installed / launched from the home screen */
  standalone: boolean
  /** iOS major.minor from the UA, when iOS */
  iosVersion: number | null
  permission: NotificationPermission | 'unsupported'
  /** Why push cannot work here (null = it can) */
  blocker: PushBlocker
}

/** Service worker only in production builds, or in dev with ?sw=1. */
export function swEnabled(): boolean {
  if (MOCK) return false
  if (import.meta.env.PROD) return true
  try {
    return new URLSearchParams(window.location.search).get('sw') === '1'
  } catch {
    return false
  }
}

export function registerServiceWorker(): void {
  if (!swEnabled() || !('serviceWorker' in navigator)) return
  const register = () =>
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err: unknown) => console.warn('Service worker registration failed', err))
  if (document.readyState === 'complete') void register()
  else window.addEventListener('load', () => void register(), { once: true })
}

export function detectEnvironment(): PushEnvironment {
  const ua = navigator.userAgent
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  const m = ua.match(/OS (\d+)[._](\d+)/)
  const iosVersion = ios && m ? Number(m[1]) + Number(m[2]) / 100 : null
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches)
  const permission: PushEnvironment['permission'] = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission

  let blocker: PushBlocker = null
  if (MOCK) blocker = null
  else if (!window.isSecureContext) blocker = 'insecure'
  else if (ios && iosVersion !== null && iosVersion < 16.04) blocker = 'ios-version'
  else if (ios && !standalone) blocker = 'ios-install'
  else if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') blocker = 'unsupported'
  else if (!swEnabled()) blocker = 'dev-no-sw'
  return { ios, standalone, iosVersion, permission, blocker }
}

function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return ''
  let s = ''
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/')
  if (existing) return existing
  // registerServiceWorker may not have run yet (first visit): register now, then wait for activation
  await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  return navigator.serviceWorker.ready
}

/** Endpoint of this browser's current subscription, if any. */
export async function currentEndpoint(): Promise<string | null> {
  if (MOCK) {
    try {
      return localStorage.getItem(MOCK_KEY)
    } catch {
      return null
    }
  }
  if (detectEnvironment().blocker) return null
  const reg = await navigator.serviceWorker.getRegistration('/')
  const sub = await reg?.pushManager.getSubscription()
  return sub?.endpoint ?? null
}

async function askPermission(): Promise<void> {
  if (typeof Notification === 'undefined') {
    if (MOCK) return
    throw new ApiError(0, 'notify.unsupported', 'Push is not supported here')
  }
  const result = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (result !== 'granted') throw new ApiError(0, 'notify.permission_denied', 'Notification permission was not granted')
}

/** "Enable on this device": permission → push subscription → server. */
export async function enablePush(vapidPublicKey: string): Promise<void> {
  if (MOCK) {
    await askPermission()
    const endpoint = `https://fcm.googleapis.com/fcm/send/mock-${crypto.randomUUID()}`
    await notifyApi.subscribe({ endpoint, keys: { p256dh: `B${'A'.repeat(86)}`, auth: 'AAAAAAAAAAAAAAAAAAAAAA' } })
    try {
      localStorage.setItem(MOCK_KEY, endpoint)
    } catch {
      // ignore
    }
    return
  }
  await askPermission()
  const reg = await registration()
  const key = base64UrlToBytes(vapidPublicKey)
  let sub = await reg.pushManager.getSubscription()
  // A subscription made with another server key (keys regenerated) cannot receive our pushes: replace it
  if (sub && bytesToBase64Url(sub.options.applicationServerKey) !== bytesToBase64Url(key.buffer)) {
    await sub.unsubscribe().catch(() => undefined)
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  const json = sub.toJSON()
  await notifyApi.subscribe({
    endpoint: sub.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? bytesToBase64Url(sub.getKey('p256dh')), auth: json.keys?.auth ?? bytesToBase64Url(sub.getKey('auth')) },
    expirationTime: sub.expirationTime,
  })
}

/** "Disable on this device": server first (so no more pushes are sent), then the browser subscription. */
export async function disablePush(): Promise<void> {
  if (MOCK) {
    const endpoint = await currentEndpoint()
    if (endpoint) await notifyApi.unsubscribeEndpoint(endpoint)
    try {
      localStorage.removeItem(MOCK_KEY)
    } catch {
      // ignore
    }
    return
  }
  const reg = await navigator.serviceWorker.getRegistration('/')
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  await notifyApi.unsubscribeEndpoint(sub.endpoint)
  await sub.unsubscribe().catch(() => undefined)
}

/** Same as the server's `endpointHash` (first 16 hex chars of sha256), to spot this browser in the device list. */
export async function hashEndpoint(endpoint: string): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
  } catch {
    return null
  }
}

/** Short device label from a user agent: "Safari · iPhone", "Chrome · Windows"… */
export function deviceLabel(ua: string | null): { browser: string; os: string; mobile: boolean } {
  const s = ua ?? ''
  const os = /iPhone/.test(s)
    ? 'iPhone'
    : /iPad/.test(s)
      ? 'iPad'
      : /Android/.test(s)
        ? 'Android'
        : /Windows/.test(s)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(s)
            ? 'macOS'
            : /Linux/.test(s)
              ? 'Linux'
              : '?'
  const browser = /Edg\//.test(s)
    ? 'Edge'
    : /OPR\/|Opera/.test(s)
      ? 'Opera'
      : /Firefox\/|FxiOS/.test(s)
        ? 'Firefox'
        : /Chrome\/|CriOS/.test(s)
          ? 'Chrome'
          : /Safari\//.test(s)
            ? 'Safari'
            : '?'
  return { browser, os, mobile: /iPhone|Android|Mobile/.test(s) }
}
