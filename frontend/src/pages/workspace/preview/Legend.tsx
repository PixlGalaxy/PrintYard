import { ChevronDown, Eye, EyeOff, Route } from 'lucide-react'
import { useState } from 'react'
import { selectCls } from '../../../components/styles'
import { COLOR_MODES, RANGE_STOPS, type ColorMode } from '../../../gcode/colors'
import { formatDuration } from '../../../gcode/format'
import { FEATURE_COLORS, FEATURES, type ParsedGcode } from '../../../gcode/types'
import { useI18n } from '../../../i18n/I18nContext'

export default function Legend({
  g,
  mode,
  onMode,
  mask,
  onMask,
  showTravel,
  onShowTravel,
  range,
  filamentColors,
}: {
  g: ParsedGcode
  mode: ColorMode
  onMode: (m: ColorMode) => void
  mask: number
  onMask: (m: number) => void
  showTravel: boolean
  onShowTravel: (v: boolean) => void
  range?: { min: number; max: number; unit: string; decimals: number }
  filamentColors: string[]
}) {
  const { t, formatNumber } = useI18n()
  // Starts collapsed on phones, where the expanded list would cover most of the model
  const [open, setOpen] = useState(() => typeof window === 'undefined' || !window.matchMedia('(max-width: 639px)').matches)
  const totalTime = g.featureTime.reduce((a, b) => a + b, 0) || 1
  const present = FEATURES.map((f, i) => ({ f, i })).filter(({ i }) => g.featureCount[i] > 0)
  const tools = Array.from(g.toolMm)
    .map((mm, i) => ({ mm, i }))
    .filter((x) => x.mm > 0)
  const allOn = present.every(({ i }) => mask & (1 << i))

  return (
    <div className="w-64 max-w-[calc(100vw-6rem)] overflow-hidden rounded-xl border border-line bg-surface/92 shadow-lg shadow-black/5 backdrop-blur-md">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <label className="sr-only" htmlFor="pv-mode">
          {t('preview.colorBy')}
        </label>
        <select id="pv-mode" value={mode} onChange={(e) => onMode(e.target.value as ColorMode)} className={`${selectCls} h-8! text-xs`}>
          {COLOR_MODES.map((m) => (
            <option key={m} value={m}>
              {t(`preview.mode.${m}`)}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={t(open ? 'preview.legendHide' : 'preview.legendShow')}
          title={t(open ? 'preview.legendHide' : 'preview.legendShow')}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-sky-500"
        >
          <ChevronDown size={16} className={`transition-transform ${open ? '' : '-rotate-90'}`} />
        </button>
      </div>

      {open && (
        <div className="max-h-[min(60vh,28rem)] overflow-auto p-1.5">
          {mode === 'feature' && (
            <>
              <div className="flex items-center justify-between px-1.5 pt-0.5 pb-1 text-[11px] font-medium text-muted">
                <span>{t('preview.lineType')}</span>
                <button
                  type="button"
                  className="rounded px-1 text-sky-600 hover:underline dark:text-sky-400"
                  onClick={() => onMask(allOn ? 0 : (1 << FEATURES.length) - 1)}
                >
                  {t(allOn ? 'preview.hideAll' : 'preview.showAll')}
                </button>
              </div>
              <ul>
                {present.map(({ f, i }) => {
                  const on = !!(mask & (1 << i))
                  const share = g.featureTime[i] / totalTime
                  return (
                    <li key={f}>
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => onMask(mask ^ (1 << i))}
                        className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-sky-500 ${on ? '' : 'opacity-45'}`}
                      >
                        <span className="size-3 shrink-0 rounded-[4px] ring-1 ring-black/10" style={{ background: FEATURE_COLORS[f] }} />
                        <span className="min-w-0 flex-1 truncate">{t(`preview.feature.${f}`)}</span>
                        <span className="font-mono text-[10px] text-muted tabular-nums">{formatDuration(g.featureTime[i])}</span>
                        <span className="w-9 text-right font-mono text-[10px] text-muted tabular-nums">{formatNumber(share * 100, { maximumFractionDigits: share < 0.1 ? 1 : 0 })}%</span>
                        {on ? <Eye size={12} className="text-muted" /> : <EyeOff size={12} className="text-muted" />}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          )}

          {mode === 'filament' && (
            <ul className="space-y-0.5 p-1">
              {tools.map(({ mm, i }) => (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <span className="size-3 rounded-[4px] ring-1 ring-black/10" style={{ background: filamentColors[i] ?? RANGE_STOPS[(i * 3) % RANGE_STOPS.length] }} />
                  <span className="flex-1">{t('preview.slot', { n: i + 1 })}</span>
                  <span className="font-mono text-[10px] text-muted tabular-nums">{formatNumber(mm / 1000, { maximumFractionDigits: 2 })} m</span>
                </li>
              ))}
            </ul>
          )}

          {range && (
            <div className="p-1.5">
              <div className="h-3 rounded-full ring-1 ring-black/10" style={{ background: `linear-gradient(90deg, ${RANGE_STOPS.join(',')})` }} />
              <div className="mt-1 flex justify-between font-mono text-[10px] text-muted tabular-nums">
                <span>
                  {formatNumber(range.min, { maximumFractionDigits: range.decimals })} {range.unit}
                </span>
                <span>
                  {formatNumber((range.min + range.max) / 2, { maximumFractionDigits: range.decimals })}
                </span>
                <span>
                  {formatNumber(range.max, { maximumFractionDigits: range.decimals })} {range.unit}
                </span>
              </div>
            </div>
          )}

          <div className="mt-1 border-t border-line pt-1">
            <button
              type="button"
              aria-pressed={showTravel}
              onClick={() => onShowTravel(!showTravel)}
              className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-sky-500 ${showTravel ? '' : 'opacity-60'}`}
            >
              <Route size={12} className="text-sky-500" />
              <span className="flex-1">{t('preview.travel')}</span>
              <span className="font-mono text-[10px] text-muted tabular-nums">{formatNumber(g.travelCount)}</span>
              {showTravel ? <Eye size={12} className="text-muted" /> : <EyeOff size={12} className="text-muted" />}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
