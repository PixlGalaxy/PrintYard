import {
  ArrowDownToLine,
  ChevronDown,
  Compass,
  Copy,
  Crosshair,
  FilePlus2,
  FlipHorizontal2,
  LayoutGrid,
  Library,
  MousePointer2,
  Move,
  Rotate3d,
  Scaling,
  Trash2,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { useI18n } from '../../../i18n/I18nContext'
import { arrange, autoOrient, centerSelected, deleteSelected, duplicateSelected, env, mirrorSelected } from '../../../workspace/ops'
import { useWs, workspace, type Tool } from '../../../workspace/store'
import { Divider, ToolButton } from './bits'
import { floatCls, menuCls, menuItemCls, MOD, useDismiss } from './styles'

export default function Toolbar({
  onImport,
  onLibrary,
  onOriented,
}: {
  onImport: () => void
  onLibrary: () => void
  onOriented: (count: number) => void
}) {
  const { t } = useI18n()
  const tool = useWs((s) => s.tool)
  const hasSel = useWs((s) => s.selection.length > 0)
  const hasObjects = useWs((s) => s.doc.objects.length > 0)

  // Phones get the core tools only (one row); lay-on-face, duplicate and mirror stay on tablet/desktop
  const tools: { id: Tool; icon: typeof Move; label: string; key: string; phone?: false }[] = [
    { id: 'select', icon: MousePointer2, label: t('workspace.tool.select'), key: 'Q' },
    { id: 'move', icon: Move, label: t('workspace.tool.move'), key: 'T' },
    { id: 'rotate', icon: Rotate3d, label: t('workspace.tool.rotate'), key: 'R' },
    { id: 'scale', icon: Scaling, label: t('workspace.tool.scale'), key: 'S' },
    { id: 'layFace', icon: ArrowDownToLine, label: t('workspace.tool.layFace'), key: 'F', phone: false },
  ]

  return (
    <div className={`${floatCls} flex max-w-full flex-wrap items-center justify-center gap-0.5 p-1`} role="toolbar" aria-label={t('workspace.toolbar')}>
      <ToolButton label={t('workspace.tool.import')} hotkey={`${MOD}+I`} onClick={onImport}>
        <FilePlus2 size={18} />
      </ToolButton>
      <ToolButton label={t('workspace.tool.library')} onClick={onLibrary}>
        <Library size={18} />
      </ToolButton>
      <Divider />
      {tools.map(({ id, icon: Icon, label, key, phone }) => (
        <ToolButton key={id} label={label} hotkey={key} active={tool === id} className={phone === false ? 'max-sm:hidden' : ''} onClick={() => workspace.setTool(tool === id && id !== 'select' ? 'select' : id)}>
          <Icon size={18} />
        </ToolButton>
      ))}
      <Divider />
      <ToolButton label={t('workspace.tool.orient')} hotkey="O" disabled={!hasObjects} onClick={() => onOriented(autoOrient())}>
        <Compass size={18} />
      </ToolButton>
      <ArrangeButton disabled={!hasObjects} />
      <ToolButton label={t('workspace.tool.center')} hotkey="C" disabled={!hasSel} onClick={centerSelected}>
        <Crosshair size={18} />
      </ToolButton>
      <ToolButton label={t('workspace.tool.duplicate')} hotkey={`${MOD}+D`} disabled={!hasSel} className="max-sm:hidden" onClick={duplicateSelected}>
        <Copy size={18} />
      </ToolButton>
      <MirrorButton disabled={!hasSel} />
      <ToolButton label={t('workspace.tool.delete')} hotkey="Del" disabled={!hasSel} onClick={deleteSelected}>
        <Trash2 size={18} />
      </ToolButton>
    </div>
  )
}

function ArrangeButton({ disabled }: { disabled: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [spacing, setSpacing] = useState(env.spacing)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, open, () => setOpen(false))
  return (
    <div ref={ref} className="relative flex items-center">
      <ToolButton label={t('workspace.tool.arrange')} hotkey="A" disabled={disabled} onClick={() => arrange('all')}>
        <LayoutGrid size={18} />
      </ToolButton>
      <button
        type="button"
        aria-label={t('workspace.arrange.options')}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="-ml-1 inline-flex h-8 w-3.5 items-center justify-center rounded-md text-muted hover:text-fg disabled:opacity-35 max-sm:hidden"
      >
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className={`${menuCls} top-full left-0 mt-2 w-60`}>
          <button type="button" className={menuItemCls} onClick={() => (arrange('all'), setOpen(false))}>
            <LayoutGrid size={16} className="text-accent-500" />
            {t('workspace.arrange.all')}
          </button>
          <button type="button" className={menuItemCls} onClick={() => (arrange('plate'), setOpen(false))}>
            <LayoutGrid size={16} className="text-muted" />
            {t('workspace.arrange.plate')}
          </button>
          <label className="mt-1 flex items-center justify-between gap-3 border-t border-line px-2.5 pt-2.5 pb-1 text-xs text-muted">
            {t('workspace.arrange.spacing')}
            <span className="flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                max={50}
                step={1}
                value={spacing}
                onChange={(e) => {
                  const v = Math.max(0, Math.min(50, Number(e.target.value) || 0))
                  setSpacing(v)
                  env.spacing = v
                }}
                className="h-7 w-14 rounded-md border border-line bg-surface px-2 text-right font-mono text-xs text-fg focus:border-accent-500 focus:outline-none"
              />
              mm
            </span>
          </label>
        </div>
      )}
    </div>
  )
}

function MirrorButton({ disabled }: { disabled: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, open, () => setOpen(false))
  const axes = [
    ['x', 'text-red-500'],
    ['y', 'text-emerald-500'],
    ['z', 'text-accent-500'],
  ] as const
  return (
    <div ref={ref} className="relative max-sm:hidden">
      <ToolButton label={t('workspace.tool.mirror')} disabled={disabled} active={open} onClick={() => setOpen((o) => !o)}>
        <FlipHorizontal2 size={18} />
      </ToolButton>
      {open && (
        <div className={`${menuCls} top-full left-1/2 mt-2 -translate-x-1/2`}>
          {axes.map(([axis, cls]) => (
            <button key={axis} type="button" className={menuItemCls} onClick={() => (mirrorSelected(axis), setOpen(false))}>
              <span className={`w-4 font-mono text-xs font-bold uppercase ${cls}`}>{axis}</span>
              {t(`workspace.mirror.${axis}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
