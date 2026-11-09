import type { Translate } from '../../../i18n/I18nContext'
import type { TranslationKey } from '../../../i18n/translations'
import type { NotifyEvent } from '../../../types'

/** Event toggles grouped for the account card and the admin channel cards. */
export const EVENT_GROUPS: { key: string; label: TranslationKey; events: NotifyEvent[] }[] = [
  { key: 'prints', label: 'notify.group.prints', events: ['print.started', 'print.paused', 'print.finished', 'print.failed', 'print.cancelled'] },
  { key: 'approvals', label: 'notify.group.approvals', events: ['approval.requested', 'approval.approved', 'approval.rejected', 'limit.blocked'] },
  { key: 'printer', label: 'notify.group.printer', events: ['printer.error', 'printer.offline', 'printer.heaters_auto_off'] },
  { key: 'engine', label: 'notify.group.engine', events: ['engine.update_available', 'engine.updated', 'engine.update_failed'] },
]

const LABELS: Record<NotifyEvent, TranslationKey> = {
  'print.started': 'notify.event.print.started',
  'print.finished': 'notify.event.print.finished',
  'print.failed': 'notify.event.print.failed',
  'print.cancelled': 'notify.event.print.cancelled',
  'print.paused': 'notify.event.print.paused',
  'approval.requested': 'notify.event.approval.requested',
  'approval.approved': 'notify.event.approval.approved',
  'approval.rejected': 'notify.event.approval.rejected',
  'limit.blocked': 'notify.event.limit.blocked',
  'printer.error': 'notify.event.printer.error',
  'printer.offline': 'notify.event.printer.offline',
  'printer.heaters_auto_off': 'notify.event.printer.heaters_auto_off',
  'engine.update_available': 'notify.event.engine.update_available',
  'engine.updated': 'notify.event.engine.updated',
  'engine.update_failed': 'notify.event.engine.update_failed',
}

export const eventLabel = (t: Translate, e: NotifyEvent) => t(LABELS[e])
