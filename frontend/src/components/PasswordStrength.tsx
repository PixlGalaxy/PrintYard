import { useI18n } from '../i18n/I18nContext'
import { passwordScore } from '../validation'

const LEVELS = [
  { key: 'password.weak', bar: 'bg-red-500', text: 'text-red-600 dark:text-red-400' },
  { key: 'password.fair', bar: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  { key: 'password.good', bar: 'bg-accent-500', text: 'text-accent-600 dark:text-accent-400' },
  { key: 'password.strong', bar: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
] as const

/** Four-segment strength meter + hint. */
export default function PasswordStrength({ password }: { password: string }) {
  const { t } = useI18n()
  const score = passwordScore(password)
  const level = LEVELS[Math.max(0, score - 1)]
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-1" aria-hidden>
          {LEVELS.map((l, i) => (
            <span key={l.key} className={`h-1 flex-1 rounded-full transition-colors ${i < score ? level.bar : 'bg-line'}`} />
          ))}
        </div>
        {password && (
          <span className={`min-w-16 text-right text-xs font-medium ${level.text}`}>
            <span className="sr-only">{t('password.strength')}: </span>
            {t(level.key)}
          </span>
        )}
      </div>
      <p className="text-xs text-muted">{t('password.hint')}</p>
    </div>
  )
}
