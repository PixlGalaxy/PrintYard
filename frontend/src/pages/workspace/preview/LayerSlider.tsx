import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { useI18n } from '../../../i18n/I18nContext'

/**
 * Vertical dual-handle layer slider (top handle = highest visible layer, bottom = lowest).
 * Keyboard: ↑/↓ ±1, PageUp/PageDown ±10, Home/End.
 */
export default function LayerSlider({
  layers,
  lo,
  hi,
  zOf,
  onChange,
}: {
  layers: number
  lo: number
  hi: number
  zOf: (layer: number) => number
  onChange: (lo: number, hi: number) => void
}) {
  const { t } = useI18n()
  const track = useRef<HTMLDivElement>(null)
  const drag = useRef<'lo' | 'hi' | null>(null)
  const max = Math.max(0, layers - 1)
  const pct = (l: number) => (max ? (l / max) * 100 : 0)

  const layerAt = (clientY: number) => {
    const r = track.current!.getBoundingClientRect()
    const f = 1 - (clientY - r.top) / r.height
    return Math.round(Math.min(1, Math.max(0, f)) * max)
  }

  const set = (which: 'lo' | 'hi', v: number) => {
    const c = Math.max(0, Math.min(max, v))
    if (which === 'hi') onChange(Math.min(lo, c), c)
    else onChange(c, Math.max(hi, c))
  }

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    const l = layerAt(e.clientY)
    const which = (e.target as HTMLElement).dataset.thumb as 'lo' | 'hi' | undefined
    drag.current = which ?? (Math.abs(l - hi) <= Math.abs(l - lo) ? 'hi' : 'lo')
    e.currentTarget.setPointerCapture(e.pointerId)
    if (!which) set(drag.current, l)
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) set(drag.current, layerAt(e.clientY))
  }
  const onUp = () => {
    drag.current = null
  }

  const onKey = (which: 'lo' | 'hi') => (e: KeyboardEvent) => {
    const cur = which === 'hi' ? hi : lo
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key]
    if (step) set(which, cur + step)
    else if (e.key === 'Home') set(which, 0)
    else if (e.key === 'End') set(which, max)
    else return
    e.preventDefault()
  }

  const thumb = (which: 'lo' | 'hi') => {
    const v = which === 'hi' ? hi : lo
    return (
      <div
        role="slider"
        tabIndex={0}
        data-thumb={which}
        aria-label={t(which === 'hi' ? 'preview.layerTop' : 'preview.layerBottom')}
        aria-orientation="vertical"
        aria-valuemin={1}
        aria-valuemax={layers}
        aria-valuenow={v + 1}
        aria-valuetext={`${v + 1} / ${layers} · Z ${zOf(v).toFixed(2)} mm`}
        onKeyDown={onKey(which)}
        style={{ bottom: `${pct(v)}%` }}
        className={`absolute left-1/2 z-10 size-4 -translate-x-1/2 translate-y-1/2 cursor-grab rounded-full border-2 bg-surface shadow-md transition-[box-shadow] focus-visible:ring-4 focus-visible:ring-sky-500/30 focus-visible:outline-none active:cursor-grabbing ${
          which === 'hi' ? 'border-sky-500' : 'border-sky-300 dark:border-sky-700'
        }`}
      />
    )
  }

  return (
    <div className="flex h-full flex-col items-center gap-2 select-none">
      <div className="min-w-14 rounded-lg border border-line bg-surface/90 px-2 py-1 text-center shadow-sm backdrop-blur-sm">
        <div className="font-mono text-xs font-semibold tabular-nums">{hi + 1}</div>
        <div className="font-mono text-[10px] text-muted tabular-nums">{zOf(hi).toFixed(2)}</div>
      </div>
      <div
        ref={track}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        className="relative w-8 flex-1 cursor-pointer touch-none"
      >
        <div className="absolute inset-y-0 left-1/2 w-1.5 -translate-x-1/2 rounded-full bg-line" />
        <div
          className="absolute left-1/2 w-1.5 -translate-x-1/2 rounded-full bg-sky-500"
          style={{ bottom: `${pct(lo)}%`, top: `${100 - pct(hi)}%` }}
        />
        {thumb('lo')}
        {thumb('hi')}
      </div>
      <div className="min-w-14 rounded-lg border border-line bg-surface/90 px-2 py-1 text-center shadow-sm backdrop-blur-sm">
        <div className="font-mono text-xs tabular-nums">{lo + 1}</div>
        <div className="font-mono text-[10px] text-muted tabular-nums">{zOf(lo).toFixed(2)}</div>
      </div>
    </div>
  )
}
