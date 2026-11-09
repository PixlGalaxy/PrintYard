import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { useI18n } from '../i18n/I18nContext'

export type ToastTone = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  tone: ToastTone
  message: string
}

const TONES = {
  success: { icon: CircleCheck, cls: 'text-emerald-500' },
  error: { icon: CircleAlert, cls: 'text-red-500' },
  info: { icon: Info, cls: 'text-accent-500' },
}

export default function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  const { t } = useI18n()
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((toast) => {
        const { icon: Icon, cls } = TONES[toast.tone]
        return (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex items-start gap-3 rounded-xl border border-line bg-surface p-3 shadow-lg shadow-black/10 animate-[toast-in_.2s_ease-out]"
          >
            <Icon size={18} className={`mt-0.5 shrink-0 ${cls}`} />
            <p className="flex-1 text-sm break-words">{toast.message}</p>
            <button
              type="button"
              aria-label={t('common.dismiss')}
              onClick={() => onDismiss(toast.id)}
              className="text-muted hover:text-fg"
            >
              <X size={16} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
