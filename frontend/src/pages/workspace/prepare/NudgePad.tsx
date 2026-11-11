// Touch-friendly position pad for phones: move the selection by a few millimetres or centre it on its plate.
// Desktop uses the arrow keys and the move gizmo instead, so this only renders below `sm`.
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Crosshair } from 'lucide-react'
import type { ReactNode } from 'react'
import { useStoredState } from '../../../hooks'
import { useI18n } from '../../../i18n/I18nContext'
import { centerSelected, nudgeSelected } from '../../../workspace/ops'
import { useWs } from '../../../workspace/store'
import { floatCls } from './styles'

const STEPS = [1, 5, 10] as const

export default function NudgePad() {
  const { t } = useI18n()
  const hasSel = useWs((s) => s.selection.length > 0)
  const [step, setStep] = useStoredState<number>('sd:ws:nudgeStep', 5)
  if (!hasSel) return null

  const pad = (label: string, onClick: () => void, icon: ReactNode, accent = false) => (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`inline-flex size-10 items-center justify-center rounded-xl transition-colors active:scale-95 ${
        accent ? 'bg-accent-500/10 text-accent-600 dark:text-accent-300' : 'text-fg hover:bg-surface-2 active:bg-surface-2'
      }`}
    >
      {icon}
    </button>
  )

  return (
    <div className={`${floatCls} flex items-center gap-1.5 p-1.5 sm:hidden`} role="group" aria-label={t('workspace.nudge.title')}>
      <div className="grid grid-cols-3 gap-0.5">
        <span />
        {pad(t('workspace.nudge.back'), () => nudgeSelected(0, step), <ChevronUp size={20} />)}
        <span />
        {pad(t('workspace.nudge.left'), () => nudgeSelected(-step, 0), <ChevronLeft size={20} />)}
        {pad(t('workspace.tool.center'), centerSelected, <Crosshair size={18} />, true)}
        {pad(t('workspace.nudge.right'), () => nudgeSelected(step, 0), <ChevronRight size={20} />)}
        <span />
        {pad(t('workspace.nudge.front'), () => nudgeSelected(0, -step), <ChevronDown size={20} />)}
        <span />
      </div>
      <div className="flex flex-col gap-1 border-l border-line pl-1.5" role="radiogroup" aria-label={t('workspace.nudge.step')}>
        {STEPS.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={step === s}
            onClick={() => setStep(s)}
            className={`h-9 min-w-12 rounded-lg px-2 font-mono text-xs font-semibold tabular-nums transition-colors ${
              step === s ? 'bg-accent-500 text-white' : 'text-muted hover:bg-surface-2 hover:text-fg'
            }`}
          >
            {s} mm
          </button>
        ))}
      </div>
    </div>
  )
}
