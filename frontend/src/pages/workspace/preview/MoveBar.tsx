import { Pause, Play } from 'lucide-react'
import type { ReactNode } from 'react'
import { useI18n } from '../../../i18n/I18nContext'

/** Horizontal slider through the moves of the top visible layer, with play/pause. */
export default function MoveBar({
  total,
  value,
  onChange,
  playing,
  onTogglePlay,
  children,
}: {
  total: number
  value: number
  onChange: (v: number) => void
  playing: boolean
  onTogglePlay: () => void
  children?: ReactNode
}) {
  const { t, formatNumber } = useI18n()
  return (
    <div className="pointer-events-auto w-full max-w-3xl rounded-xl border border-line bg-surface/92 px-3 py-2 shadow-lg shadow-black/5 backdrop-blur-md">
      {children}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onTogglePlay}
          aria-label={t(playing ? 'preview.pause' : 'preview.play')}
          title={t(playing ? 'preview.pause' : 'preview.play')}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-sky-600 text-white shadow-sm shadow-sky-600/25 hover:bg-sky-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
        >
          {playing ? <Pause size={14} /> : <Play size={14} className="translate-x-px" />}
        </button>
        <input
          type="range"
          min={0}
          max={total}
          value={Math.min(value, total)}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={t('preview.moves')}
          aria-valuetext={`${value} / ${total}`}
          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-sky-500"
        />
        <span className="w-28 shrink-0 text-right font-mono text-[11px] text-muted tabular-nums">
          {formatNumber(Math.min(value, total))} / {formatNumber(total)}
        </span>
      </div>
    </div>
  )
}
