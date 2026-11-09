import { useState, type KeyboardEvent } from 'react'

/** Compact numeric input: commits on Enter/blur, Esc reverts, ↑/↓ step (Shift ×10). */
export default function NumberField({
  value,
  onCommit,
  step = 1,
  digits = 2,
  min,
  max,
  label,
  prefix,
  prefixCls = 'text-muted',
  suffix,
  disabled,
  className = '',
}: {
  value: number
  onCommit: (v: number) => void
  step?: number
  digits?: number
  min?: number
  max?: number
  label: string
  prefix?: string
  prefixCls?: string
  suffix?: string
  disabled?: boolean
  className?: string
}) {
  const shown = Number.isFinite(value) ? Number(value.toFixed(digits)).toString() : ''
  const [draft, setDraft] = useState<string | null>(null)

  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))
  const commit = (text: string) => {
    setDraft(null)
    const v = Number(text.replace(',', '.'))
    if (text.trim() === '' || !Number.isFinite(v)) return
    const c = clamp(v)
    if (Math.abs(c - value) > 10 ** -(digits + 1)) onCommit(c)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
    else if (e.key === 'Escape') {
      setDraft(null)
      ;(e.target as HTMLInputElement).blur()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const base = Number((draft ?? shown).replace(',', '.')) || 0
      const next = clamp(base + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1))
      onCommit(next)
      setDraft(null)
    }
    e.stopPropagation()
  }

  return (
    <label
      className={`flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2 text-xs shadow-xs transition-colors focus-within:border-accent-500 focus-within:ring-2 focus-within:ring-accent-500/20 ${disabled ? 'opacity-50' : ''} ${className}`}
    >
      {prefix && <span className={`shrink-0 font-mono text-[11px] font-bold ${prefixCls}`}>{prefix}</span>}
      <input
        aria-label={label}
        inputMode="decimal"
        disabled={disabled}
        value={draft ?? shown}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={onKey}
        className="w-full min-w-0 bg-transparent text-right font-mono tabular-nums outline-none"
      />
      {suffix && <span className="shrink-0 text-[11px] text-muted">{suffix}</span>}
    </label>
  )
}
