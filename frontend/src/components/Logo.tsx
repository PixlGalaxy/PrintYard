import { LOGO_MARK, LOGO_MARK_TRANSFORM, LOGO_TILE } from '../theme/brand'

/**
 * PrintYard app icon. Light UI: ink tile + accent mark. Dark UI (the `dark` class on <html>): inverted, accent tile +
 * ink mark, so it stays visible on dark surfaces. The accent is the active skin's `--accent-400`, so it changes live.
 */
export default function Logo({ size = 36, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 256 256"
      width={size}
      height={size}
      role="img"
      aria-label="PrintYard"
      className={`shrink-0 select-none ${className}`}
    >
      <path d={LOGO_TILE} className="fill-[#0f172a] dark:fill-[var(--accent-400,#38bdf8)]" />
      <path
        d={LOGO_MARK}
        fillRule="evenodd"
        transform={LOGO_MARK_TRANSFORM}
        className="fill-[var(--accent-400,#38bdf8)] dark:fill-[#0f172a]"
      />
    </svg>
  )
}
