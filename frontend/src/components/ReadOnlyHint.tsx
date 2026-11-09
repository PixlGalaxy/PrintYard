import type { ReactNode } from 'react'
import { useI18n } from '../i18n/I18nContext'
import { useReadOnly } from '../readOnly'

/**
 * Wraps a printer-control button so its tooltip still shows when read-only mode disables it
 * (disabled buttons get no pointer events).
 */
export default function ReadOnlyHint({ children, className = 'inline-flex' }: { children: ReactNode; className?: string }) {
  const { t } = useI18n()
  const readOnly = useReadOnly()
  if (!readOnly) return <>{children}</>
  return (
    <span title={t('readOnly.tooltip')} className={`cursor-not-allowed ${className}`}>
      {children}
    </span>
  )
}
