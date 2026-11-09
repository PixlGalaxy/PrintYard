// Client-side checks for quick feedback. The backend validates again (zod).

export const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i
const IPV6_RE = /^\[?[0-9a-f:]+\]?$/i
const CIDR_RE = /^[0-9a-f:.]+(\/\d{1,3})?$/i

export const PASSWORD_MIN = 10
export const PASSWORD_MAX = 256

export const isHost = (v: string) => IPV4_RE.test(v) || HOSTNAME_RE.test(v) || (v.includes(':') && IPV6_RE.test(v))
export const isMac = (v: string) => MAC_RE.test(v)
export const isCidr = (v: string) => CIDR_RE.test(v)
export const isEmail = (v: string) => EMAIL_RE.test(v)
export const isUsername = (v: string) => USERNAME_RE.test(v)

export function isUrl(v: string) {
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/** AA:BB:CC:DD:EE:FF — upper case, colon separated */
export const normalizeMac = (v: string) => v.trim().replace(/-/g, ':').toUpperCase()

/** 0 (empty) to 4 (strong). Length matters most. */
export function passwordScore(pw: string): number {
  if (!pw) return 0
  if (pw.length < PASSWORD_MIN) return 1
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw)).length
  let score = 2
  if (pw.length >= 14 || classes >= 3) score = 3
  if ((pw.length >= 16 && classes >= 2) || (pw.length >= 12 && classes === 4)) score = 4
  return score
}

/** i18n key of the first problem, or null. */
export function passwordProblem(pw: string, confirm?: string) {
  if (pw.length < PASSWORD_MIN) return 'password.tooShort' as const
  if (pw.length > PASSWORD_MAX) return 'password.tooLong' as const
  if (confirm !== undefined && pw !== confirm) return 'password.mismatch' as const
  return null
}

/** Optional non-negative number input: '' → null, invalid → NaN */
export function parseOptionalNumber(v: string): number | null {
  const s = v.trim().replace(',', '.')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

// ---------- Printer form ----------

export interface PrinterDraft {
  name: string
  model: 'creality-k2se'
  host: string
  staticIp: boolean
  mac: string
}

export type PrinterErrors = Partial<Record<'name' | 'host' | 'mac', 'validation.required' | 'validation.host' | 'validation.mac'>>

export function validatePrinter(d: PrinterDraft): PrinterErrors {
  const errors: PrinterErrors = {}
  if (!d.name.trim()) errors.name = 'validation.required'
  if (!d.host.trim()) errors.host = 'validation.required'
  else if (!isHost(d.host.trim())) errors.host = 'validation.host'
  const mac = d.mac.trim()
  if (!d.staticIp && !mac) errors.mac = 'validation.required'
  else if (mac && !isMac(mac)) errors.mac = 'validation.mac'
  return errors
}

export const printerInput = (d: PrinterDraft) => ({
  name: d.name.trim(),
  model: d.model,
  host: d.host.trim(),
  staticIp: d.staticIp,
  mac: d.mac.trim() ? normalizeMac(d.mac) : null,
})
