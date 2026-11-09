import { Box, FolderOpen, Library, LoaderCircle, Search } from 'lucide-react'
import { useCallback, useState } from 'react'
import { api } from '../../../api'
import Modal from '../../../components/Modal'
import { Empty, ErrorState, Loading, Segmented } from '../../../components/ui'
import { useLoader } from '../../../hooks'
import { useI18n } from '../../../i18n/I18nContext'
import type { LibraryFile } from '../../../types'

const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** Picks a model (to add to the scene) or a project (to open) from the library. */
export default function LibraryModal({ kind, onPick, onClose }: { kind: 'model' | 'project'; onPick: (f: LibraryFile) => Promise<void>; onClose: () => void }) {
  const { t, formatDate, errorMessage } = useI18n()
  const [scope, setScope] = useState<'private' | 'shared'>('private')
  const load = useCallback(() => api.files(scope, kind), [scope, kind])
  const { data, error, reload } = useLoader(load)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<number | null>(null)
  const [pickError, setPickError] = useState<unknown>(null)
  const list = (data ?? []).filter((f) => f.name.toLowerCase().includes(q.trim().toLowerCase()))

  return (
    <Modal
      title={t(kind === 'project' ? 'workspace.library.openProject' : 'workspace.library.addModel')}
      subtitle={t(kind === 'project' ? 'workspace.library.projectHint' : 'workspace.library.modelHint')}
      icon={kind === 'project' ? <FolderOpen size={18} /> : <Library size={18} />}
      size="lg"
      onClose={onClose}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented
          label={t('workspace.library.scope')}
          value={scope}
          onChange={setScope}
          options={[
            { value: 'private', label: t('workspace.library.mine') },
            { value: 'shared', label: t('workspace.library.shared') },
          ]}
        />
        <label className="relative ml-auto min-w-48 flex-1 sm:flex-none">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('workspace.library.search')}
            aria-label={t('workspace.library.search')}
            className="h-8 w-full rounded-lg border border-line bg-surface pr-2 pl-8 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
          />
        </label>
      </div>
      {pickError != null && <p className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{errorMessage(pickError)}</p>}
      {error ? (
        <ErrorState error={error} onRetry={() => void reload()} />
      ) : !data ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty icon={<Box size={20} />}>{t(kind === 'project' ? 'workspace.library.noProjects' : 'workspace.library.noModels')}</Empty>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {list.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy(f.id)
                  setPickError(null)
                  try {
                    await onPick(f)
                    onClose()
                  } catch (err) {
                    setPickError(err)
                  } finally {
                    setBusy(null)
                  }
                }}
                className="group flex w-full flex-col overflow-hidden rounded-xl border border-line bg-surface text-left transition-all hover:-translate-y-0.5 hover:border-accent-500/50 hover:shadow-md disabled:opacity-60"
              >
                <span className="relative flex aspect-square items-center justify-center bg-surface-2">
                  {f.thumbnailUrl ? <img src={f.thumbnailUrl} alt="" className="size-full object-contain p-2" loading="lazy" /> : <Box size={28} className="text-muted" />}
                  {busy === f.id && (
                    <span className="absolute inset-0 flex items-center justify-center bg-surface/70">
                      <LoaderCircle className="animate-spin text-accent-500" />
                    </span>
                  )}
                  <span className="absolute top-1.5 right-1.5 rounded-md bg-surface/90 px-1.5 py-0.5 font-mono text-[10px] text-muted uppercase">{f.ext}</span>
                </span>
                <span className="block p-2">
                  <span className="block truncate text-xs font-medium" title={f.name}>
                    {f.name}
                  </span>
                  <span className="block truncate text-[11px] text-muted">
                    {fmtSize(f.size)} · {formatDate(f.updatedAt)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
