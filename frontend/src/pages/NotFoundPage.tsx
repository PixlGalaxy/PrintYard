import { SearchX } from 'lucide-react'
import { Link } from 'react-router'
import { useI18n } from '../i18n/I18nContext'

export default function NotFoundPage() {
  const { t } = useI18n()
  return (
    <div className="flex flex-col items-center gap-3 py-20 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-surface-2 text-muted">
        <SearchX size={26} />
      </div>
      <h1 className="text-xl font-semibold">{t('common.notFoundTitle')}</h1>
      <p className="text-sm text-muted">{t('common.notFoundText')}</p>
      <Link
        to="/"
        className="mt-2 inline-flex h-9 items-center rounded-lg bg-sky-600 px-4 text-sm font-medium text-white shadow-sm shadow-sky-600/25 hover:bg-sky-500"
      >
        {t('common.goHome')}
      </Link>
    </div>
  )
}
