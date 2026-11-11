import { Download, FilePlus, FolderOpen, Keyboard, Redo2, Save, Undo2 } from 'lucide-react'
import { useState } from 'react'
import ConfirmModal from '../../../components/ConfirmModal'
import Modal from '../../../components/Modal'
import { inputCls } from '../../../components/styles'
import { Button } from '../../../components/ui'
import { useToast } from '../../../context/ToastContext'
import { useI18n } from '../../../i18n/I18nContext'
import { hasPendingUploads, newProject, openProject } from '../../../workspace/projects'
import { useWs, workspace } from '../../../workspace/store'
import LibraryModal from './LibraryModal'
import { useProjectActions } from './useProjectActions'
import { MOD } from './styles'
import { setUi, usePrepareUi } from './uiState'
import { Tip } from './bits'

export default function ProjectBar() {
  const { t, errorMessage } = useI18n()
  const { toast } = useToast()
  const project = useWs((s) => s.project)
  const dirty = useWs((s) => s.dirty)
  const doc = useWs((s) => s.doc)
  const ui = usePrepareUi()
  const canUndo = useWs((s) => s.canUndo)
  const canRedo = useWs((s) => s.canRedo)
  const { save, download, busy } = useProjectActions()
  const pending = hasPendingUploads(doc)

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="hidden min-w-0 items-center gap-2 md:flex">
        <input
          value={project.name}
          placeholder={t('workspace.project.untitled')}
          aria-label={t('workspace.project.name')}
          onChange={(e) => workspace.setProjectName(e.target.value.slice(0, 120))}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className="h-8 w-44 min-w-0 rounded-lg border border-transparent bg-transparent px-2 text-sm font-medium transition-colors placeholder:text-muted hover:border-line focus:border-accent-500 focus:bg-surface focus:outline-none lg:w-56"
        />
        <span className={`inline-flex items-center gap-1.5 text-xs whitespace-nowrap ${dirty ? 'text-amber-600 dark:text-amber-400' : 'text-muted'}`}>
          <span className={`size-1.5 rounded-full ${dirty ? 'bg-amber-500' : 'bg-emerald-500'}`} />
          {dirty ? t('workspace.project.unsaved') : project.fileId ? t('workspace.project.savedState') : t('workspace.project.autosaved')}
        </span>
      </div>
      <span className="mx-1 hidden h-5 w-px bg-line md:block" />
      <Tip label={t('workspace.undo')} hotkey={`${MOD}+Z`}>
        <button type="button" aria-label={t('workspace.undo')} disabled={!canUndo} onClick={() => workspace.undo()} className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-35">
          <Undo2 size={16} />
        </button>
      </Tip>
      <Tip label={t('workspace.redo')} hotkey={`${MOD}+Y`}>
        <button type="button" aria-label={t('workspace.redo')} disabled={!canRedo} onClick={() => workspace.redo()} className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-35">
          <Redo2 size={16} />
        </button>
      </Tip>
      <Tip label={t('workspace.shortcuts.title')} hotkey="?">
        <button type="button" aria-label={t('workspace.shortcuts.title')} onClick={() => setUi({ help: true })} className="hidden size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg sm:inline-flex">
          <Keyboard size={16} />
        </button>
      </Tip>
      {/* Phones keep undo/redo only: the draft is kept in the browser, project files are a desktop task */}
      <span className="mx-1 h-5 w-px bg-line max-sm:hidden" />
      <Tip label={t('workspace.project.new')} className="max-sm:hidden">
        <button type="button" aria-label={t('workspace.project.new')} onClick={() => (doc.objects.length && dirty ? setUi({ newConfirm: true }) : newProject())} className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
          <FilePlus size={16} />
        </button>
      </Tip>
      <Tip label={t('workspace.project.open')} hotkey={`${MOD}+O`} className="max-sm:hidden">
        <button type="button" aria-label={t('workspace.project.open')} onClick={() => setUi({ library: 'project' })} className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
          <FolderOpen size={16} />
        </button>
      </Tip>
      <Tip label={pending ? t('workspace.project.waitUploads') : t('workspace.project.download')} className="max-sm:hidden">
        <button
          type="button"
          aria-label={t('workspace.project.download')}
          disabled={!doc.objects.length || pending || busy !== null}
          onClick={() => void download()}
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
        >
          <Download size={16} />
        </button>
      </Tip>
      <Tip label={pending ? t('workspace.project.waitUploads') : t('workspace.project.save')} hotkey={`${MOD}+S`} className="max-sm:hidden">
        <Button size="sm" variant={dirty ? 'primary' : 'secondary'} icon={<Save size={14} />} loading={busy === 'save'} disabled={pending || !doc.objects.length} onClick={() => void save().catch(() => undefined)}>
          <span className="hidden sm:inline">{t('workspace.project.save')}</span>
        </Button>
      </Tip>

      {ui.saveAs && <SaveAsModal initial={project.name} onSave={(name) => save(name)} onClose={() => setUi({ saveAs: false })} />}
      {ui.library === 'project' && (
        <LibraryModal
          kind="project"
          onClose={() => setUi({ library: null })}
          onPick={(f) => openProject(f.id, (name, err) => toast('error', `${name}: ${errorMessage(err)}`))}
        />
      )}
      {ui.newConfirm && (
        <ConfirmModal title={t('workspace.project.newTitle')} confirmLabel={t('workspace.project.discard')} onConfirm={async () => newProject()} onClose={() => setUi({ newConfirm: false })}>
          {t('workspace.project.newBody')}
        </ConfirmModal>
      )}
    </div>
  )
}

function SaveAsModal({ initial, onSave, onClose }: { initial: string; onSave: (name: string) => Promise<void>; onClose: () => void }) {
  const { t } = useI18n()
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      await onSave(name.trim())
      onClose()
    } catch {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={t('workspace.project.saveTitle')}
      subtitle={t('workspace.project.saveHint')}
      icon={<Save size={18} />}
      size="sm"
      onClose={onClose}
      dismissable={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void submit()}>
            {t('workspace.project.save')}
          </Button>
        </>
      }
    >
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">{t('workspace.project.name')}</span>
        <input
          data-autofocus
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') void submit()
          }}
          placeholder={t('workspace.project.untitled')}
          className={inputCls}
        />
      </label>
    </Modal>
  )
}
