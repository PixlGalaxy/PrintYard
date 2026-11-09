import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { useI18n } from '../i18n/I18nContext'
import { iconBadgeCls } from './styles'
import { IconButton } from './ui'

interface Props {
  title: ReactNode
  subtitle?: ReactNode
  icon?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  onClose: () => void
  children: ReactNode
  /** Buttons shown in the footer, right-aligned */
  footer?: ReactNode
  /** Close on backdrop click / Escape (turned off while saving) */
  dismissable?: boolean
}

const SIZES = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' }

export default function Modal({ title, subtitle, icon, size = 'md', onClose, children, footer, dismissable = true }: Props) {
  const { t } = useI18n()
  const titleId = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    // Focus the first field (or the dialog itself) for keyboard users
    const first = dialog.current?.querySelector<HTMLElement>('[data-autofocus], input, select, textarea')
    ;(first ?? dialog.current)?.focus()
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = overflow
      previous?.focus?.()
    }
  }, [])

  useEffect(() => {
    if (!dismissable) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismissable])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-2 backdrop-blur-sm animate-[fade-in_.15s_ease-out] sm:items-center sm:p-6">
      <div className="absolute inset-0" onClick={dismissable ? onClose : undefined} />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative flex max-h-[calc(100dvh-1rem)] w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl outline-none animate-[pop-in_.18s_ease-out] sm:max-h-full ${SIZES[size]}`}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3.5 sm:px-5">
          {icon && <div className={iconBadgeCls}>{icon}</div>}
          <div className="min-w-0">
            <h2 id={titleId} className="truncate font-semibold">
              {title}
            </h2>
            {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
          </div>
          <div className="ml-auto">
            <IconButton label={t('common.close')} onClick={onClose} disabled={!dismissable}>
              <X size={18} />
            </IconButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-5">{children}</div>
        {footer && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2/50 px-4 py-3 sm:px-5">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
