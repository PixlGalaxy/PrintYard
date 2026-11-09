// Admin → Files: retention (per user, private library; pinned and shared files are exempt) and upload limit.
import { Archive, HardDriveUpload } from 'lucide-react'
import { SettingRow } from '../../components/Card'
import { inputCls } from '../../components/styles'
import { Callout, ErrorState, Loading, Toggle } from '../../components/ui'
import { useI18n } from '../../i18n/I18nContext'
import SaveBar from './SaveBar'
import { Panel } from './shared'
import { useSettings } from './useSettings'

export default function FilesSection() {
  const { t } = useI18n()
  const s = useSettings()
  if (s.error && !s.saved) return <ErrorState error={s.error} onRetry={() => void s.reload()} />
  if (!s.saved) return <Loading />

  const enabled = s.value('files.retention.enabled') ?? true
  const keep = s.value('files.retention.keep') ?? 10
  const maxMb = s.value('files.maxUploadMb') ?? 200
  const keepInvalid = !Number.isInteger(keep) || keep < 1 || keep > 10_000
  const maxInvalid = !Number.isInteger(maxMb) || maxMb < 1 || maxMb > 4096
  const num = (v: string) => (v.trim() === '' ? Number.NaN : Number(v))

  return (
    <div className="space-y-5">
      <Panel title={t('library.admin.retention')} description={t('library.admin.retentionDesc')} icon={<Archive size={18} />}>
        <SettingRow label={t('library.admin.retentionEnabled')} description={t('library.admin.retentionEnabledHint')}>
          <Toggle checked={enabled} onChange={(v) => s.set('files.retention.enabled', v)} label={t('library.admin.retentionEnabled')} />
        </SettingRow>
        <SettingRow label={t('library.admin.keep')} description={t('library.admin.keepHint')}>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={10000}
              aria-label={t('library.admin.keep')}
              aria-invalid={keepInvalid}
              disabled={!enabled}
              className={`${inputCls} w-24! tabular-nums`}
              value={Number.isFinite(keep) ? keep : ''}
              onChange={(e) => s.set('files.retention.keep', num(e.target.value))}
            />
            <span className="text-sm text-muted">{t('library.admin.files')}</span>
          </div>
        </SettingRow>
        {enabled && !keepInvalid && <Callout tone="info">{t('library.admin.retentionExample', { n: keep })}</Callout>}
      </Panel>

      <Panel title={t('library.admin.uploads')} description={t('library.admin.uploadsDesc')} icon={<HardDriveUpload size={18} />}>
        <SettingRow label={t('library.admin.maxUpload')} description={t('library.admin.maxUploadHint')}>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={4096}
              aria-label={t('library.admin.maxUpload')}
              aria-invalid={maxInvalid}
              className={`${inputCls} w-24! tabular-nums`}
              value={Number.isFinite(maxMb) ? maxMb : ''}
              onChange={(e) => s.set('files.maxUploadMb', num(e.target.value))}
            />
            <span className="text-sm text-muted">MB</span>
          </div>
        </SettingRow>
      </Panel>

      <SaveBar dirty={s.dirty} saving={s.saving} invalid={keepInvalid || maxInvalid} onSave={() => void s.save()} onDiscard={s.discard} />
    </div>
  )
}
