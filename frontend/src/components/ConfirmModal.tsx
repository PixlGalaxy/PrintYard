import { TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useI18n } from '../i18n/I18nContext'
import Modal from './Modal'
import { Button } from './ui'

/** Confirmation dialog for destructive actions. Stays open (busy) until `onConfirm` settles. */
export default function ConfirmModal({
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: ReactNode
  children: ReactNode
  confirmLabel?: string
  /** Should report its own errors and re-throw to keep the dialog open */
  onConfirm: () => Promise<unknown>
  onClose: () => void
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)

  async function confirm() {
    setBusy(true)
    try {
      await onConfirm()
      onClose()
    } catch {
      setBusy(false)
    }
  }

  return (
    <Modal
      size="sm"
      title={title}
      icon={<TriangleAlert size={18} className="text-red-500" />}
      onClose={onClose}
      dismissable={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy} data-autofocus>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={confirm}>
            {confirmLabel ?? t('common.delete')}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-relaxed">{children}</div>
    </Modal>
  )
}
