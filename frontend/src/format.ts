import type { Translate } from './i18n/I18nContext'
import type { PrinterModel } from './types'

const MODEL_NAMES: Record<PrinterModel, string> = { 'creality-k2se': 'Creality K2 SE' }

export const printerModelName = (id: string) => MODEL_NAMES[id as PrinterModel] ?? id

/** "3 min ago" */
export function timeAgo(t: Translate, ms: number | string | null | undefined): string {
  if (ms == null) return t('common.never')
  const diff = Math.max(0, (Date.now() - new Date(ms).getTime()) / 1000)
  if (diff < 10) return t('time.justNow')
  if (diff < 60) return t('time.secondsAgo', { n: Math.floor(diff) })
  if (diff < 3600) return t('time.minutesAgo', { n: Math.floor(diff / 60) })
  if (diff < 86400) return t('time.hoursAgo', { n: Math.floor(diff / 3600) })
  return t('time.daysAgo', { n: Math.floor(diff / 86400) })
}
