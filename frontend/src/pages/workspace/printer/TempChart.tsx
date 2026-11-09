// Temperatures tab: dependency-free SVG time-series of nozzle (orange-rose) and bed (violet) temperatures.
// Actual = solid line, target = dashed step line. Window 10/30/60 min, hover/touch tooltip (nearest sample),
// theme-aware colours. Data: GET /printers/:id/temps (server ring buffer, every 2 s) + live WS samples.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from '../../../context/ThemeContext'
import { useI18n } from '../../../i18n/I18nContext'
import type { TempSample } from '../../../types'

/** Break a line when two samples are further apart than this (printer offline, page asleep…) */
const GAP_MS = 15_000
const PAD = { l: 34, r: 10, t: 10, b: 22 }

interface Props {
  samples: TempSample[]
  minutes: number
}

const COLORS = {
  light: { nozzle: '#e11d48', bed: '#7c3aed', grid: 'rgba(100,116,139,.18)', axis: '#64748b' },
  dark: { nozzle: '#fb7185', bed: '#a78bfa', grid: 'rgba(148,163,184,.14)', axis: '#94a3b8' },
}

export default function TempChart({ samples, minutes }: Props) {
  const { t, formatNumber } = useI18n()
  const { resolved } = useTheme()
  const c = COLORS[resolved === 'dark' ? 'dark' : 'light']
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 360, h: 220 })
  const [hover, setHover] = useState<number | null>(null)
  // Re-evaluated with every new sample (that is when the window should slide)
  const end = samples.length ? Math.max(samples[samples.length - 1].t, 0) : 0

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: Math.max(200, el.clientWidth), h: Math.max(150, el.clientHeight) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const start = end - minutes * 60_000
  const pts = useMemo(() => samples.filter((s) => s.t >= start), [samples, start])
  const { w, h } = size
  const iw = w - PAD.l - PAD.r
  const ih = h - PAD.t - PAD.b

  const yMax = useMemo(() => {
    let m = 60
    for (const p of pts) m = Math.max(m, p.nozzle ?? 0, p.nozzleTarget ?? 0, p.bed ?? 0, p.bedTarget ?? 0)
    return Math.ceil((m + 10) / 50) * 50
  }, [pts])
  const x = (tm: number) => PAD.l + ((tm - start) / (end - start || 1)) * iw
  const y = (v: number) => PAD.t + ih - (v / yMax) * ih

  const line = (key: keyof Omit<TempSample, 't'>, stepped: boolean) => {
    let d = ''
    let prev: TempSample | null = null
    for (const p of pts) {
      const v = p[key]
      if (v == null) {
        prev = null
        continue
      }
      const X = x(p.t).toFixed(1)
      const Y = y(v).toFixed(1)
      if (!prev || p.t - prev.t > GAP_MS || prev[key] == null) d += `M${X} ${Y}`
      else d += stepped ? `H${X}V${Y}` : `L${X} ${Y}`
      prev = p
    }
    return d
  }

  const yTicks = Array.from({ length: yMax / 50 + 1 }, (_, i) => i * 50)
  const tickEvery = minutes <= 10 ? 2 : minutes <= 30 ? 5 : 10
  const xTicks = Array.from({ length: Math.floor(minutes / tickEvery) + 1 }, (_, i) => end - i * tickEvery * 60_000)

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!pts.length) return
    const r = e.currentTarget.getBoundingClientRect()
    const tm = start + ((e.clientX - r.left - PAD.l) / iw) * (end - start)
    let lo = 0
    let hi = pts.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (pts[mid].t < tm) lo = mid + 1
      else hi = mid
    }
    const i = lo > 0 && Math.abs(pts[lo - 1].t - tm) < Math.abs(pts[lo].t - tm) ? lo - 1 : lo
    setHover(i)
  }
  const hp = hover !== null ? pts[hover] : null
  const hhmmss = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const deg = (v: number | null) => (v == null ? '—' : `${formatNumber(v, { maximumFractionDigits: 1 })} °C`)

  return (
    <div ref={box} className="relative h-full min-h-44 w-full">
      {pts.length < 2 ? (
        <div className="flex h-full items-center justify-center text-xs text-muted">{t('tempChart.collecting')}</div>
      ) : (
        <svg
          width={w}
          height={h}
          className="block touch-none select-none"
          role="img"
          aria-label={t('printerTab.tempHistory')}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={w - PAD.r} y1={y(v)} y2={y(v)} stroke={c.grid} />
              <text x={PAD.l - 6} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill={c.axis} className="tabular-nums">
                {v}°
              </text>
            </g>
          ))}
          {xTicks.map((tm, i) => (
            <text key={tm} x={x(tm)} y={h - 6} textAnchor={i === 0 ? 'end' : 'middle'} fontSize="10" fill={c.axis} className="tabular-nums">
              {i === 0 ? t('tempChart.now') : `−${i * tickEvery} min`}
            </text>
          ))}
          <path d={line('bedTarget', true)} fill="none" stroke={c.bed} strokeWidth="1.4" strokeDasharray="5 4" opacity="0.8" />
          <path d={line('nozzleTarget', true)} fill="none" stroke={c.nozzle} strokeWidth="1.4" strokeDasharray="5 4" opacity="0.8" />
          <path d={line('bed', false)} fill="none" stroke={c.bed} strokeWidth="2" strokeLinejoin="round" />
          <path d={line('nozzle', false)} fill="none" stroke={c.nozzle} strokeWidth="2" strokeLinejoin="round" />
          {hp && (
            <g pointerEvents="none">
              <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD.t} y2={PAD.t + ih} stroke={c.axis} strokeDasharray="2 3" />
              {hp.nozzle != null && <circle cx={x(hp.t)} cy={y(hp.nozzle)} r="3.5" fill={c.nozzle} stroke="var(--surface)" strokeWidth="1.5" />}
              {hp.bed != null && <circle cx={x(hp.t)} cy={y(hp.bed)} r="3.5" fill={c.bed} stroke="var(--surface)" strokeWidth="1.5" />}
            </g>
          )}
        </svg>
      )}
      {hp && (
        <div
          className="pointer-events-none absolute top-2 z-10 w-56 rounded-lg border border-line bg-surface/95 px-2.5 py-2 text-[11px] shadow-lg backdrop-blur-sm"
          style={x(hp.t) > w / 2 ? { left: Math.max(4, x(hp.t) - 234) } : { left: Math.max(4, Math.min(w - 228, x(hp.t) + 10)) }}
        >
          <p className="mb-1 font-medium text-muted tabular-nums">{hhmmss(hp.t)}</p>
          <TipRow color={c.nozzle} label={t('printerTab.nozzle')} value={deg(hp.nozzle)} target={hp.nozzleTarget ? `${hp.nozzleTarget} °C` : t('printerTab.off')} />
          <TipRow color={c.bed} label={t('printerTab.bed')} value={deg(hp.bed)} target={hp.bedTarget ? `${hp.bedTarget} °C` : t('printerTab.off')} />
        </div>
      )}
    </div>
  )
}

function TipRow({ color, label, value, target }: { color: string; label: string; value: string; target: string }) {
  return (
    <p className="flex items-center gap-1.5 whitespace-nowrap tabular-nums">
      <span className="h-0.5 w-3 rounded-full" style={{ background: color }} />
      <span className="mr-auto">{label}</span>
      <span className="font-semibold">{value}</span>
      <span className="text-muted">/ {target}</span>
    </p>
  )
}

/** Legend swatch: solid (actual) or dashed (target) line in the series colour. */
export function SeriesKey({ series, dashed }: { series: 'nozzle' | 'bed'; dashed?: boolean }) {
  const { resolved } = useTheme()
  const color = COLORS[resolved === 'dark' ? 'dark' : 'light'][series]
  return (
    <svg width="18" height="6" aria-hidden className="shrink-0">
      <line x1="1" x2="17" y1="3" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dashed ? '4 3' : undefined} strokeLinecap="round" />
    </svg>
  )
}
