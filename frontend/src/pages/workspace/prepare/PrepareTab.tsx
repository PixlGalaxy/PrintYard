import { Focus, Home, PanelLeftOpen, PanelRightOpen, Upload, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { api } from '../../../api'
import { ErrorState } from '../../../components/ui'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { useI18n } from '../../../i18n/I18nContext'
import { useUploads } from '../../files/uploads/UploadContext'
import { ACCEPT_ATTR } from '../../files/uploads/accept'
import type { ViewName } from '../../../three/Viewport'
import {
  addLibraryModel,
  arrange,
  autoOrient,
  centerSelected,
  completeUpload,
  deleteSelected,
  duplicateSelected,
  env,
  importFiles,
  pendingImportOf,
  nudgeSelected,
  selectAllOnPlate,
} from '../../../workspace/ops'
import { bedFromMachine } from '../../../workspace/plates'
import { applyBundleDefaults, useBundle, usePreset } from '../../../workspace/profiles'
import { loadSceneMeshes, openProject } from '../../../workspace/projects'
import { slicing, useSlicing } from '../../../workspace/slicing'
import { useWs, workspace } from '../../../workspace/store'
import { Tip } from './bits'
import { floatCls } from './styles'
import LeftPanel from './LeftPanel'
import LibraryModal from './LibraryModal'
import ObjectInfo from './ObjectInfo'
import PlateStrip from './PlateStrip'
import { useProjectActions } from './useProjectActions'
import RightPanel from './RightPanel'
import ShortcutsHelp from './ShortcutsHelp'
import SliceControls from './SliceControls'
import Toolbar from './Toolbar'
import TransformPanel from './TransformPanel'
import { setUi, usePrepareUi } from './uiState'
import ViewCube, { type ViewCubeHandle } from '../../../three/ViewCube'
import ViewportView from './ViewportView'

const VIEW_KEYS: Record<string, ViewName> = { '0': 'iso', '1': 'top', '2': 'bottom', '3': 'front', '4': 'back', '5': 'left', '6': 'right' }

export default function PrepareTab({ active }: { active: boolean }) {
  const { t, language, errorMessage } = useI18n()
  const { user } = useAuth()
  const { toast } = useToast()
  const uploads = useUploads()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const fileInput = useRef<HTMLInputElement>(null)
  const cube = useRef<ViewCubeHandle>(null)
  const [drawer, setDrawer] = useState<'left' | 'right' | null>(null)
  const [dragging, setDragging] = useState(false)
  const [scopeObject, setScopeObject] = useState<string | null>(null)
  const dragDepth = useRef(0)
  const ui = usePrepareUi()
  const { save } = useProjectActions()

  const doc = useWs((s) => s.doc)
  const selection = useWs((s) => s.selection)
  const { bundle, error: bundleError, retry } = useBundle(doc.printerModel, language)
  const machine = usePreset(doc.printerModel, 'machine', doc.machinePresetId || undefined)
  const bed = useMemo(() => bedFromMachine(machine?.values), [machine])
  useEffect(() => {
    env.bed = bed
  }, [bed])

  // Restore the user's autosaved scene once, and load its meshes
  const toastRef = useRef({ toast, errorMessage })
  useEffect(() => {
    toastRef.current = { toast, errorMessage }
  }, [toast, errorMessage])
  useEffect(() => {
    if (!user) return
    workspace.bindUser(user.id)
    loadSceneMeshes(workspace.state.doc, (name, err) => toastRef.current.toast('error', `${name}: ${toastRef.current.errorMessage(err)}`))
  }, [user])

  useEffect(() => {
    if (bundle) applyBundleDefaults(bundle)
  }, [bundle])

  // Object-scope settings follow the selection
  const scope = scopeObject ? (selection.includes(scopeObject) ? scopeObject : selection.length === 1 ? selection[0] : null) : null

  // Files page / links: `?add=<id>` adds a library model, `?project=<id>` opens a project
  useEffect(() => {
    const add = Number(params.get('add') ?? params.get('addFile'))
    const proj = Number(params.get('project'))
    if (!add && !proj) return
    const next = new URLSearchParams(params)
    next.delete('add')
    next.delete('addFile')
    next.delete('project')
    setParams(next, { replace: true })
    const onErr = (err: unknown) => toastRef.current.toast('error', toastRef.current.errorMessage(err))
    if (proj) void openProject(proj).catch(onErr)
    else
      void api
        .files('private', 'model')
        .then(async (list) => {
          const f = list.find((x) => x.id === add) ?? (await api.files('shared', 'model')).find((x) => x.id === add)
          if (!f) throw new Error(t('workspace.library.notFound'))
          await addLibraryModel(f)
        })
        .catch(onErr)
  }, [params, setParams, t])

  // A failed import upload retried later (tray or the Objects row) finishes here: map it back to its pending row
  useEffect(
    () =>
      uploads.onUploaded((file, itemId) => {
        const temp = pendingImportOf(itemId)
        if (temp !== null) completeUpload(temp, file)
      }),
    [uploads],
  )

  const runImport = (files: File[]) => {
    if (!files.length) return
    importFiles(files, {
      // Queued at once: the tray and the Objects list show "Uploading <name>" before the mesh is even parsed
      upload: (file) => {
        const [item] = uploads.add([file])
        return { itemId: item.id, done: uploads.waitFor(item.id) }
      },
      cancelUpload: (itemId) => uploads.cancel(itemId),
      onError: (name, err) => toast('error', `${name}: ${err instanceof Error && err.message.startsWith('mesh.') ? t('workspace.import.parseError') : errorMessage(err)}`),
      onUnsupported: (name) => toast('error', t('workspace.import.unsupported', { name })),
      onGcode: (f) => navigate(`/?tab=preview&file=${f.id}`),
    })
  }

  // Finished single-plate slice → straight to Preview
  const run = useSlicing()
  const openedRun = useRef(0)
  useEffect(() => {
    if (!run?.finished || openedRun.current === run.id || run.plates.length !== 1) return
    const job = run.jobs[run.plates[0]]
    if (job?.state === 'done' && job.result) {
      openedRun.current = run.id
      navigate(`/?tab=preview&file=${job.result.fileId}`)
    }
  }, [run, navigate])

  const onOriented = (n: number) => toast('info', n ? t('workspace.orient.done', { n }) : t('workspace.orient.none'))

  // ---------- keyboard ----------
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('[role="dialog"]')) return
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      const done = () => e.preventDefault()
      if (mod) {
        const act: Record<string, () => void> = {
          z: () => (e.shiftKey ? workspace.redo() : workspace.undo()),
          y: () => workspace.redo(),
          s: () => void save().catch(() => undefined),
          o: () => setUi({ library: 'project' }),
          i: () => fileInput.current?.click(),
          d: () => duplicateSelected(),
          a: () => selectAllOnPlate(),
        }
        if (act[k]) {
          act[k]()
          done()
        }
        if (k === 'enter') {
          const s = workspace.state
          if (s.doc.objects.some((o) => o.plate === s.activePlate)) void slicing.start(s.doc, [s.activePlate])
          done()
        }
        return
      }
      if (e.altKey) return
      if (VIEW_KEYS[e.key]) return env.viewport?.setView(VIEW_KEYS[e.key], true, workspace.state.selection.length ? 'selection' : 'plate')
      const nudge = e.shiftKey ? 10 : 1
      switch (e.key) {
        case 'Escape':
          if (workspace.state.tool !== 'select') workspace.setTool('select')
          else workspace.select([])
          return
        case 'Delete':
        case 'Backspace':
          deleteSelected()
          return done()
        case 'ArrowLeft':
          nudgeSelected(-nudge, 0)
          return done()
        case 'ArrowRight':
          nudgeSelected(nudge, 0)
          return done()
        case 'ArrowUp':
          nudgeSelected(0, nudge)
          return done()
        case 'ArrowDown':
          nudgeSelected(0, -nudge)
          return done()
        case '?':
          return setUi({ help: true })
      }
      switch (k) {
        case 'q':
          return workspace.setTool('select')
        case 't':
          return workspace.setTool('move')
        case 'r':
          return workspace.setTool('rotate')
        case 's':
          return workspace.setTool('scale')
        case 'f':
          return workspace.setTool('layFace')
        case 'a':
          return arrange(e.shiftKey ? 'plate' : 'all')
        case 'o':
          return onOriented(autoOrient())
        case 'c':
          return centerSelected()
        case 'z':
          return env.viewport?.zoomToFit(workspace.state.selection.length ? 'selection' : 'plate')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---------- drag & drop anywhere on the tab ----------
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files')
  const dropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth.current++
      setDragging(true)
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDragging(false)
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      runImport(Array.from(e.dataTransfer.files))
    },
  }

  const camBtn = 'inline-flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg'

  return (
    <div className="relative flex h-full min-h-0" {...dropHandlers}>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ACCEPT_ATTR}
        className="hidden"
        onChange={(e) => {
          runImport(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />

      {/* Left panel (drawer below xl) */}
      <aside
        className={`z-30 w-[284px] shrink-0 border-r border-line bg-surface max-xl:absolute max-xl:inset-y-0 max-xl:left-0 max-xl:shadow-2xl max-xl:transition-transform max-xl:duration-200 ${
          drawer === 'left' ? 'max-xl:translate-x-0' : 'max-xl:-translate-x-full max-xl:shadow-none'
        }`}
      >
        <LeftPanel
          bundle={bundle}
          onImport={() => fileInput.current?.click()}
          onLibrary={() => setUi({ library: 'model' })}
          onSettings={(id) => {
            workspace.select([id])
            setScopeObject(id)
            setDrawer((d) => (d === 'left' ? 'right' : d))
          }}
        />
      </aside>

      {/* Viewport */}
      <div className="relative min-w-0 flex-1 overflow-hidden bg-[radial-gradient(ellipse_at_50%_35%,var(--surface)_0%,var(--bg)_75%)]">
        <ViewportView bed={bed} cube={cube} />

        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start gap-2 p-3">
          <div className="pointer-events-auto flex flex-col gap-2">
            <button type="button" onClick={() => setDrawer('left')} className={`${floatCls} inline-flex size-9 items-center justify-center text-muted hover:text-fg xl:hidden`} aria-label={t('workspace.panels.left')}>
              <PanelLeftOpen size={17} />
            </button>
          </div>
          <div className="pointer-events-auto mx-auto flex min-w-0 flex-col items-center gap-2">
            <Toolbar onImport={() => fileInput.current?.click()} onLibrary={() => setUi({ library: 'model' })} onOriented={onOriented} />
          </div>
          <div className="pointer-events-auto flex flex-col items-end gap-2">
            <div className="flex items-start gap-2">
              <button type="button" onClick={() => setDrawer('right')} className={`${floatCls} inline-flex size-9 items-center justify-center text-muted hover:text-fg lg:hidden`} aria-label={t('workspace.panels.right')}>
                <PanelRightOpen size={17} />
              </button>
              <ViewCube ref={cube} camera={() => env.viewport} />
            </div>
            <div className={`${floatCls} flex flex-col gap-0.5 p-1`}>
              <Tip label={t('workspace.view.iso')} hotkey="0" side="left">
                <button type="button" className={camBtn} aria-label={t('workspace.view.iso')} onClick={() => env.viewport?.setView('iso', true, 'plate')}>
                  <Home size={15} />
                </button>
              </Tip>
              <Tip label={t('workspace.view.fit')} hotkey="Z" side="left">
                <button type="button" className={camBtn} aria-label={t('workspace.view.fit')} onClick={() => env.viewport?.zoomToFit(selection.length ? 'selection' : 'all')}>
                  <Focus size={15} />
                </button>
              </Tip>
              <Tip label={t('workspace.view.zoomIn')} side="left">
                <button type="button" className={camBtn} aria-label={t('workspace.view.zoomIn')} onClick={() => env.viewport?.zoomBy(0.75)}>
                  <ZoomIn size={15} />
                </button>
              </Tip>
              <Tip label={t('workspace.view.zoomOut')} side="left">
                <button type="button" className={camBtn} aria-label={t('workspace.view.zoomOut')} onClick={() => env.viewport?.zoomBy(1.33)}>
                  <ZoomOut size={15} />
                </button>
              </Tip>
            </div>
          </div>
        </div>

        <div className="absolute top-[68px] left-3 z-10">
          <TransformPanel />
        </div>

        {dragging && (
          <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-3xl border-2 border-dashed border-accent-500 bg-accent-500/10 backdrop-blur-[2px] animate-[fade-in_.12s_ease-out]">
            <div className="flex flex-col items-center gap-2 text-accent-600 dark:text-accent-300">
              <Upload size={32} />
              <p className="text-base font-semibold">{t('workspace.drop.title')}</p>
              <p className="text-xs opacity-80">{t('workspace.drop.body')}</p>
            </div>
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-3 p-3">
          <div className="pointer-events-auto hidden sm:block">
            <ObjectInfo />
          </div>
          <div className="pointer-events-auto mx-auto min-w-0">
            <PlateStrip />
          </div>
          <div className="pointer-events-auto mb-[var(--sd-tray-h,0px)] transition-[margin] duration-200">
            <SliceControls onOpenPreview={(id) => navigate(`/?tab=preview&file=${id}`)} />
          </div>
        </div>
      </div>

      {/* Right panel (drawer below lg) */}
      <aside
        className={`z-30 w-[344px] shrink-0 border-l border-line bg-surface max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:max-w-[92vw] max-lg:shadow-2xl max-lg:transition-transform max-lg:duration-200 ${
          drawer === 'right' ? 'max-lg:translate-x-0' : 'max-lg:translate-x-full max-lg:shadow-none'
        }`}
      >
        {bundleError ? <ErrorState error={bundleError} onRetry={retry} /> : <RightPanel bundle={bundle} scopeObject={scope} setScopeObject={setScopeObject} />}
      </aside>

      {drawer && (
        <div className="absolute inset-0 z-20 bg-black/30 backdrop-blur-[1px] animate-[fade-in_.15s_ease-out] xl:hidden" onClick={() => setDrawer(null)}>
          <button type="button" aria-label={t('common.close')} className={`${floatCls} absolute top-3 ${drawer === 'left' ? 'left-[296px]' : 'right-[356px] max-lg:right-3'} inline-flex size-9 items-center justify-center text-muted`}>
            <X size={16} />
          </button>
        </div>
      )}

      {ui.library === 'model' && <LibraryModal kind="model" onClose={() => setUi({ library: null })} onPick={addLibraryModel} />}
      {ui.help && <ShortcutsHelp onClose={() => setUi({ help: false })} />}
    </div>
  )
}
