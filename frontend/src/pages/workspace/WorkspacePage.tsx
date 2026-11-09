// Workspace shell (`/?tab=prepare|preview|printer`): full-height editor below the header. Prepare stays mounted
// (its 3D scene and WebGL context survive tab switches); Preview and Printer mount on first visit.
import { Box, Layers, LoaderCircle } from 'lucide-react'
import { forwardRef, lazy, Suspense, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { PrinterModelIcon } from '../../components/printerIcons'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import PrepareTab from './prepare/PrepareTab'
import ProjectBar from './prepare/ProjectBar'
import { useWs } from '../../workspace/store'

const PreviewTab = lazy(() => import('./preview/PreviewTab'))
const PrinterTab = lazy(() => import('./printer/PrinterTab'))

type TabId = 'prepare' | 'preview' | 'printer'
// The Printer tab shows the target printer's glyph (by the workspace's printer model)
const PrinterTabIcon: typeof Box = forwardRef((props, ref) => <PrinterModelIcon ref={ref} model={useWs((s) => s.doc.printerModel)} {...props} />)
PrinterTabIcon.displayName = 'PrinterTabIcon'
const TABS: { id: TabId; label: TranslationKey; icon: typeof Box }[] = [
  { id: 'prepare', label: 'workspace.tab.prepare', icon: Box },
  { id: 'preview', label: 'workspace.tab.preview', icon: Layers },
  { id: 'printer', label: 'workspace.tab.printer', icon: PrinterTabIcon },
]
const isTab = (v: string | null): v is TabId => v === 'prepare' || v === 'preview' || v === 'printer'

const spinner = (
  <div className="flex h-full items-center justify-center text-muted">
    <LoaderCircle className="animate-spin" aria-hidden />
  </div>
)

export default function WorkspacePage() {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: TabId = isTab(raw) ? raw : 'prepare'
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set([tab]))
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]))

  const go = (id: TabId) => {
    const next = new URLSearchParams(params)
    next.set('tab', id)
    if (id !== 'preview') next.delete('file')
    setParams(next)
  }

  const panel = (id: TabId, node: ReactNode) => (
    <div role="tabpanel" id={`ws-${id}`} aria-labelledby={`ws-tab-${id}`} hidden={tab !== id} className="absolute inset-0">
      {node}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-4">
        <div role="tablist" aria-label={t('workspace.title')} className="flex h-full items-stretch gap-0.5">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = id === tab
            return (
              <button
                key={id}
                id={`ws-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`ws-${id}`}
                onClick={() => go(id)}
                className={`relative inline-flex items-center gap-2 px-3 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500 ${
                  active ? 'text-fg' : 'text-muted hover:text-fg'
                }`}
              >
                <Icon size={16} className={active ? 'text-accent-500' : ''} aria-hidden />
                {t(label)}
                {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent-500" />}
              </button>
            )
          })}
        </div>
        <div className="ml-auto flex min-w-0 items-center">{tab === 'prepare' && <ProjectBar />}</div>
      </div>
      <div className="relative min-h-0 flex-1">
        {panel('prepare', <PrepareTab active={tab === 'prepare'} />)}
        {visited.has('preview') && panel('preview', <Suspense fallback={spinner}>{<PreviewTab />}</Suspense>)}
        {visited.has('printer') && panel('printer', <Suspense fallback={spinner}>{<PrinterTab />}</Suspense>)}
      </div>
    </div>
  )
}
