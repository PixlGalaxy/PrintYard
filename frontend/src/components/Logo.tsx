import { useId } from 'react'

const LAYERS = [12, 21.94, 31.88, 41.81, 51.75, 61.69, 71.62, 81.56]

/**
 * SliceDock "Sliced S" app icon (same artwork as /icons/icon-512.png): the white mark on a rounded tile whose
 * gradient follows the active skin through the `--accent-400/600` CSS variables.
 */
export default function Logo({ size = 36, className = '' }: { size?: number; className?: string }) {
  const id = useId()
  const bg = `${id}-bg`
  const sheen = `${id}-sheen`
  const half = `${id}-half`
  const s = `${id}-s`
  return (
    <svg
      viewBox="0 0 512 512"
      width={size}
      height={size}
      role="img"
      aria-label="SliceDock"
      className={`shrink-0 select-none ${className}`}
    >
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--accent-400, #38bdf8)' }} />
          <stop offset="1" style={{ stopColor: 'var(--accent-600, #0284c7)' }} />
        </linearGradient>
        <linearGradient id={sheen} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".18" />
          <stop offset=".5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={half}>
          <path d="M58 12H76a12 12 0 0 1 12 12v52a12 12 0 0 1-12 12H24a12 12 0 0 1-12-12V58z" />
        </clipPath>
        <mask id={s} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <path
            d="M88 20.2H62L32.2 50H64.9a14.9 14.9 0 0 1 0 29.8H12"
            fill="none"
            stroke="#fff"
            strokeWidth="16.4"
            strokeLinejoin="round"
          />
        </mask>
      </defs>
      <rect width="512" height="512" rx="116" fill={`url(#${bg})`} />
      <rect width="512" height="512" rx="116" fill={`url(#${sheen})`} />
      <g transform="translate(76 76) scale(3.6)" fill="#fff">
        <path d="M12 24a12 12 0 0 1 12-12h18L12 42z" />
        <path d="M58 4 4 58" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
        <g clipPath={`url(#${half})`}>
          <g mask={`url(#${s})`} opacity=".86">
            {LAYERS.map((y) => (
              <rect key={y} x="0" y={y} width="100" height="6.44" />
            ))}
          </g>
        </g>
      </g>
    </svg>
  )
}
