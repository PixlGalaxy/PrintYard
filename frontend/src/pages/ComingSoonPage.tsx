import { Files, Slice } from 'lucide-react'
import { Badge } from '../components/ui'
import { useI18n } from '../i18n/I18nContext'

export default function ComingSoonPage({ kind }: { kind: 'files' | 'slicer' }) {
  const { t } = useI18n()
  const Icon = kind === 'files' ? Files : Slice
  return (
    <div className="flex justify-center py-10 sm:py-16">
      <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-8 text-center shadow-sm animate-[pop-in_.2s_ease-out]">
        <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-sky-500/10 text-sky-500">
          <Icon size={26} />
        </div>
        <div className="mt-4 flex items-center justify-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{t(kind === 'files' ? 'files.title' : 'slicer.title')}</h1>
          <Badge tone="sky">{t('common.comingSoon')}</Badge>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted">{t(kind === 'files' ? 'files.text' : 'slicer.text')}</p>
      </div>
    </div>
  )
}
