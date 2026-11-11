// Admin → Printers: a copy of every user's process profiles and custom filaments on the printer (one JSON file in
// Moonraker's config folder, written a few seconds after each change; never printer.cfg, safe while printing), its
// status, "Back up now" and "Restore from the printer" (preview first, then the profile import path).
import { ArchiveRestore, CloudUpload, DatabaseBackup, FlaskConical, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { adminApi } from '../../api'
import { SettingRow } from '../../components/Card'
import Modal from '../../components/Modal'
import { Badge, Button, Callout, ErrorState, Loading, Toggle } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { timeAgo } from '../../format'
import { useLoader } from '../../hooks'
import { isTranslationKey } from '../../i18n/translations'
import { useI18n } from '../../i18n/I18nContext'
import type { ProfileImportReport, ProfilesBackupPreview, ProfilesBackupStatus } from '../../types'
import ImportReportDialog from '../workspace/profiles/ImportReportDialog'
import { Panel } from './shared'

export default function ProfilesBackupPanel() {
  const { t, errorMessage } = useI18n()
  const { toast, onError } = useToast()
  const { data, error, reload, setData } = useLoader(adminApi.profilesBackup)
  const [busy, setBusy] = useState<'toggle' | 'run' | 'preview' | null>(null)
  const [preview, setPreview] = useState<ProfilesBackupPreview | null>(null)
  const [report, setReport] = useState<ProfileImportReport | null>(null)

  if (error && !data) return <ErrorState error={error} onRetry={() => void reload()} />
  if (!data) return <Loading />

  const setEnabled = async (on: boolean) => {
    setBusy('toggle')
    try {
      await adminApi.updateSettings({ 'printers.profilesBackup.enabled': on })
      setData({ ...data, enabled: on })
      toast('success', t('common.saved'))
      void reload()
    } catch (err) {
      onError(err)
    } finally {
      setBusy(null)
    }
  }
  const runNow = async () => {
    setBusy('run')
    try {
      const st: ProfilesBackupStatus = await adminApi.profilesBackupRun()
      setData(st)
      const failed = st.printers.find((p) => p.lastError)
      if (failed) toast('error', t('profilesBackup.failedToast', { printer: failed.name }))
      else toast('success', t('profilesBackup.doneToast'))
    } catch (err) {
      onError(err)
    } finally {
      setBusy(null)
    }
  }
  const openPreview = async (printerId: number) => {
    setBusy('preview')
    try {
      setPreview(await adminApi.profilesBackupPreview(printerId))
    } catch (err) {
      onError(err)
    } finally {
      setBusy(null)
    }
  }
  const errorText = (code: string) => {
    const key = `errors.${code}`
    return isTranslationKey(key) ? t(key) : code
  }

  return (
    <Panel title={t('profilesBackup.title')} description={t('profilesBackup.desc')} icon={<DatabaseBackup size={18} />}>
      <SettingRow label={t('profilesBackup.enabled')} description={t('profilesBackup.enabledHint', { path: data.path })}>
        <Toggle checked={data.enabled} disabled={busy === 'toggle'} onChange={(v) => void setEnabled(v)} label={t('profilesBackup.enabled')} />
      </SettingRow>
      {data.printers.length === 0 && <p className="text-sm text-muted">{t('profilesBackup.noPrinter')}</p>}
      {data.printers.map((p) => (
        <div key={p.printerId} className="space-y-3 rounded-xl border border-line p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{p.name}</span>
            <Badge tone={p.online ? 'emerald' : 'zinc'}>{t(p.online ? 'profilesBackup.online' : 'profilesBackup.offline')}</Badge>
            <span className="text-xs text-muted">{t('profilesBackup.counts', { process: p.process, filament: p.filament })}</span>
          </div>
          <p className="text-sm">
            {!data.enabled
              ? t('profilesBackup.off')
              : p.lastBackupAt
                ? t('profilesBackup.last', { when: timeAgo(t, p.lastBackupAt) })
                : t('profilesBackup.never')}
            {data.enabled && p.pending && <span className="text-muted"> · {t(p.online ? 'profilesBackup.pending' : 'profilesBackup.pendingOffline')}</span>}
          </p>
          {data.enabled && p.lastError && (
            <Callout tone="error" title={t('profilesBackup.errorTitle', { when: timeAgo(t, p.lastAttemptAt) })}>
              {errorText(p.lastError)}
            </Callout>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<CloudUpload size={14} />} disabled={!data.enabled || !p.online || busy !== null} loading={busy === 'run'} onClick={() => void runNow()}>
              {t('profilesBackup.runNow')}
            </Button>
            <Button size="sm" icon={<ArchiveRestore size={14} />} disabled={!p.online || busy !== null} loading={busy === 'preview'} onClick={() => void openPreview(p.printerId)}>
              {t('profilesBackup.restore')}
            </Button>
          </div>
        </div>
      ))}
      {preview && (
        <RestoreDialog
          preview={preview}
          onClose={() => setPreview(null)}
          onRestore={async () => {
            try {
              const r = await adminApi.profilesBackupRestore(preview.printerId)
              setPreview(null)
              setReport(r)
              void reload()
            } catch (err) {
              toast('error', errorMessage(err))
              throw err
            }
          }}
        />
      )}
      {report && <ImportReportDialog fileName="profiles-backup.json" report={report} onClose={() => setReport(null)} />}
    </Panel>
  )
}

function RestoreDialog({ preview, onClose, onRestore }: { preview: ProfilesBackupPreview; onClose: () => void; onRestore: () => Promise<void> }) {
  const { t, formatDate } = useI18n()
  const [busy, setBusy] = useState(false)
  const c = preview.counts
  return (
    <Modal
      size="lg"
      onClose={onClose}
      dismissable={!busy}
      icon={<ArchiveRestore size={18} />}
      title={t('profilesBackup.previewTitle')}
      subtitle={t('profilesBackup.previewFrom', { when: formatDate(preview.createdAt), version: preview.slicedockVersion })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<ArchiveRestore size={14} />}
            disabled={c.create === 0}
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onRestore()
              } catch {
                setBusy(false)
              }
            }}
          >
            {t('profilesBackup.restoreN', { n: c.create })}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>{t('profilesBackup.previewSummary', { process: c.process, filament: c.filament })}</p>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="sky">{t('profilesBackup.willCreate', { n: c.create })}</Badge>
          {c.unchanged > 0 && <Badge>{t('profilesBackup.unchanged', { n: c.unchanged })}</Badge>}
          {c.renamed > 0 && <Badge tone="amber">{t('profilesBackup.renamed', { n: c.renamed })}</Badge>}
          {c.ownerMapped > 0 && <Badge tone="violet">{t('profilesBackup.ownerMapped', { n: c.ownerMapped })}</Badge>}
        </div>
        <p className="text-xs text-muted">{t('profilesBackup.previewHint')}</p>
        <div className="max-h-80 overflow-auto rounded-lg border border-line">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-2 text-left text-muted">
              <tr>
                <th className="px-2.5 py-1.5 font-medium">{t('profilesBackup.colProfile')}</th>
                <th className="px-2.5 py-1.5 font-medium">{t('profilesBackup.colOwner')}</th>
                <th className="px-2.5 py-1.5 font-medium">{t('profilesBackup.colAction')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {preview.items.map((i, n) => (
                <tr key={n}>
                  <td className="px-2.5 py-1.5">
                    <span className="flex items-center gap-1.5">
                      {i.kind === 'process' ? <SlidersHorizontal size={12} className="shrink-0 text-muted" /> : <FlaskConical size={12} className="shrink-0 text-muted" />}
                      <span className="truncate">{i.name}</span>
                      {i.shared && <Badge tone="sky">{t('filaments.sharedBadge')}</Badge>}
                    </span>
                    {i.action === 'create' && i.finalName !== i.name && <span className="block text-[11px] text-amber-600 dark:text-amber-400">→ {i.finalName}</span>}
                  </td>
                  <td className="px-2.5 py-1.5">
                    {i.restoreOwner}
                    {!i.ownerKnown && <span className="block text-[11px] text-muted">{t('profilesBackup.ownerUnknown', { owner: i.owner })}</span>}
                  </td>
                  <td className="px-2.5 py-1.5">{i.action === 'create' ? <Badge tone="sky">{t('profilesBackup.actionCreate')}</Badge> : <Badge>{t('profilesBackup.actionUnchanged')}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  )
}
