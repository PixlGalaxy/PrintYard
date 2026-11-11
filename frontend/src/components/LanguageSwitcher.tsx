import { Languages } from 'lucide-react'
import { useToast } from '../context/ToastContext'
import { useI18n } from '../i18n/I18nContext'
import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES, isLanguage } from '../i18n/translations'
import { selectCls } from './styles'

/** Compact language picker (public pages and the account page). */
export default function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { t, language, setLanguage } = useI18n()
  const { onError } = useToast()
  return (
    <label className={`relative inline-flex items-center ${className}`}>
      <span className="sr-only">{t('language.label')}</span>
      <Languages size={16} className="pointer-events-none absolute left-2.5 text-muted" aria-hidden />
      <select
        value={language}
        onChange={(e) => {
          if (isLanguage(e.target.value)) setLanguage(e.target.value).catch(onError)
        }}
        className={`${selectCls} h-8! w-auto! pr-7! pl-8! text-xs`}
      >
        {SUPPORTED_LANGUAGES.map((l) => (
          <option key={l} value={l}>
            {LANGUAGE_NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  )
}
