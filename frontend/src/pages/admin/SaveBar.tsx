import { Save, Undo2 } from 'lucide-react'
import { Button } from '../../components/ui'
import { useI18n } from '../../i18n/I18nContext'

/** Sticky bar shown while a settings form has unsaved changes. */
export default function SaveBar({
  dirty,
  saving,
  invalid,
  onSave,
  onDiscard,
}: {
  dirty: boolean
  saving: boolean
  invalid?: boolean
  onSave: () => void
  onDiscard: () => void
}) {
  const { t } = useI18n()
  if (!dirty) return null
  return (
    <div className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-sky-500/30 bg-surface/90 px-4 py-3 shadow-lg shadow-black/10 backdrop-blur-md animate-[toast-in_.2s_ease-out]">
      <p className="text-sm font-medium">{t('settings.unsaved')}</p>
      <div className="flex gap-2">
        <Button icon={<Undo2 size={14} />} onClick={onDiscard} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" icon={<Save size={14} />} loading={saving} disabled={invalid} onClick={onSave}>
          {t('common.saveChanges')}
        </Button>
      </div>
    </div>
  )
}
