// Admin → Printers: keep only the newest N SliceDock uploads on each printer's storage (the server deletes older
// SliceDock files after each upload; files it did not upload, and files in use, are never touched).
import { HardDrive } from 'lucide-react'
import { SettingRow } from '../../components/Card'
import { inputCls } from '../../components/styles'
import { Callout, ErrorState, Loading, Toggle } from '../../components/ui'
import { useI18n } from '../../i18n/I18nContext'
import SaveBar from './SaveBar'
import { Panel } from './shared'
import { useSettings } from './useSettings'

export default function PrinterRetentionPanel() {
  const { t } = useI18n()
  const s = useSettings()
  if (s.error && !s.saved) return <ErrorState error={s.error} onRetry={() => void s.reload()} />
  if (!s.saved) return <Loading />

  const enabled = s.value('printers.retention.enabled') ?? true
  const keep = s.value('printers.retention.keep') ?? 10
  const invalid = !Number.isInteger(keep) || keep < 1 || keep > 1000

  return (
    <>
      <Panel title={t('printers.retention.title')} description={t('printers.retention.desc')} icon={<HardDrive size={18} />}>
        <SettingRow label={t('printers.retention.enabled')} description={t('printers.retention.enabledHint')}>
          <Toggle checked={enabled} onChange={(v) => s.set('printers.retention.enabled', v)} label={t('printers.retention.enabled')} />
        </SettingRow>
        <SettingRow label={t('printers.retention.keep')} description={t('printers.retention.keepHint')}>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={1000}
              aria-label={t('printers.retention.keep')}
              aria-invalid={invalid}
              disabled={!enabled}
              className={`${inputCls} w-24! tabular-nums`}
              value={Number.isFinite(keep) ? keep : ''}
              onChange={(e) => s.set('printers.retention.keep', e.target.value.trim() === '' ? Number.NaN : Number(e.target.value))}
            />
            <span className="text-sm text-muted">{t('printers.retention.files')}</span>
          </div>
        </SettingRow>
        {enabled && !invalid && <Callout tone="info">{t('printers.retention.example', { n: keep })}</Callout>}
      </Panel>
      <SaveBar dirty={s.dirty} saving={s.saving} invalid={invalid} onSave={() => void s.save()} onDiscard={s.discard} />
    </>
  )
}
