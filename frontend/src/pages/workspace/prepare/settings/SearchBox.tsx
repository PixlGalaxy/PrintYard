import { Search, X } from 'lucide-react'
import { useI18n } from '../../../../i18n/I18nContext'

export default function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const { t } = useI18n()
  return (
    <label className="relative block">
      <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' && value) {
            e.preventDefault()
            onChange('')
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-8 w-full rounded-lg border border-line bg-surface pr-7 pl-8 text-xs shadow-xs placeholder:text-muted/70 focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
      />
      {value && (
        <button type="button" aria-label={t('common.close')} onClick={() => onChange('')} className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted hover:text-fg">
          <X size={14} />
        </button>
      )}
    </label>
  )
}
