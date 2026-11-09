// Printer icons used consistently across the Printer tab (panel, status strip, floating cards) and Prepare's
// printer card: nozzle/hotend = Flame (orange-rose), extruder = ArrowDownToLine (orange), bed = Grid3x3 (violet),
// light = Lightbulb (amber). Tinted with their colour (filled with a translucent tint where the shape allows).
import { forwardRef, type ReactNode, type SVGProps } from 'react'
import { ArrowDownToLine, Flame, Grid3x3, Lightbulb, LightbulbOff } from 'lucide-react'
import type { PrinterKinematics, PrinterModel } from '../types'

interface IconProps {
  size?: number
  className?: string
}

export function NozzleIcon({ size = 14, className = '' }: IconProps) {
  return <Flame size={size} aria-hidden className={`shrink-0 text-orange-500 dark:text-orange-400 ${className}`} fill="#f43f5e" fillOpacity={0.35} />
}

export function ExtruderIcon({ size = 14, className = '' }: IconProps) {
  return <ArrowDownToLine size={size} aria-hidden className={`shrink-0 text-orange-500 dark:text-orange-400 ${className}`} />
}

export function BedIcon({ size = 14, className = '' }: IconProps) {
  return <Grid3x3 size={size} aria-hidden className={`shrink-0 text-violet-500 dark:text-violet-400 ${className}`} fill="currentColor" fillOpacity={0.18} />
}

export function LightIcon({ on, size = 14, className = '' }: IconProps & { on: boolean | null | undefined }) {
  return on ? (
    <Lightbulb size={size} aria-hidden className={`shrink-0 text-amber-500 dark:text-amber-300 ${className}`} fill="currentColor" fillOpacity={0.35} />
  ) : (
    <LightbulbOff size={size} aria-hidden className={`shrink-0 text-muted ${className}`} />
  )
}

// ---------- 3D-printer glyphs (lucide-style: 24×24, stroke currentColor, width 2, round caps/joins) ----------
// They replace lucide's paper `Printer`. PrinterModelIcon stands for a specific printer (picked by kinematics);
// PrinterLayers also stands for "printing" in general (Print buttons, jobs, history, approvals).
// Same props as a lucide icon: size, strokeWidth, absoluteStrokeWidth, className, color; aria-hidden unless labelled.

export interface PrinterGlyphProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  size?: number | string
  strokeWidth?: number | string
  absoluteStrokeWidth?: boolean
}

const Glyph = forwardRef<SVGSVGElement, PrinterGlyphProps & { name: string; paths: ReactNode }>(function Glyph(
  { name, paths, size = 24, strokeWidth = 2, absoluteStrokeWidth, color = 'currentColor', className = '', children, ...rest },
  ref,
) {
  const labelled = rest['aria-label'] !== undefined || rest['aria-labelledby'] !== undefined || rest.role !== undefined
  const sw = absoluteStrokeWidth ? (Number(strokeWidth) * 24) / Number(size) : strokeWidth
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={labelled ? undefined : true}
      className={`lucide lucide-${name} ${className}`.trim()}
      {...rest}
    >
      {paths}
      {children}
    </svg>
  )
})

/** #1 "Marco CoreXY": closed frame, gantry bar, hotend, part on the bed. */
export const PrinterCoreXY = forwardRef<SVGSVGElement, PrinterGlyphProps>(function PrinterCoreXY(props, ref) {
  return (
    <Glyph
      ref={ref}
      name="printer-corexy"
      paths={
        <>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 8h18" />
          <path d="M10 8v2l2 2 2-2V8" />
          <path d="M9 17h6v-3H9z" />
          <path d="M6 18h12" />
        </>
      }
      {...props}
    />
  )
})

/** #2 "Pórtico": two uprights + crossbar printing a part (cartesian / bed slinger). */
export const PrinterGantry = forwardRef<SVGSVGElement, PrinterGlyphProps>(function PrinterGantry(props, ref) {
  return (
    <Glyph
      ref={ref}
      name="printer-gantry"
      paths={
        <>
          <path d="M4 21V4" />
          <path d="M20 21V4" />
          <path d="M4 7h16" />
          <path d="M10 7v3l2 2 2-2V7" />
          <path d="M9 18v-3h6v3" />
          <path d="M2 21h20" />
        </>
      }
      {...props}
    />
  )
})

/** #4 "Marco + pieza en capas": frame + layered part (generic printer / "3D print"). */
export const PrinterLayers = forwardRef<SVGSVGElement, PrinterGlyphProps>(function PrinterLayers(props, ref) {
  return (
    <Glyph
      ref={ref}
      name="printer-layers"
      paths={
        <>
          <path d="M4 22V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v18" />
          <path d="M4 7h16" />
          <path d="M11 7v2.5h2V7" />
          <path d="M12 9.5v1.5" />
          <path d="M9 14h6" />
          <path d="M8.5 17h7" />
          <path d="M2 22h20" />
        </>
      }
      {...props}
    />
  )
})

/** Kinematics of known models (fallback when the printer object carries no `kinematics`). */
const MODEL_KINEMATICS: Record<PrinterModel, PrinterKinematics> = {
  'creality-k2se': 'corexy',
}

export type PrinterModelIconProps = PrinterGlyphProps & {
  kinematics?: PrinterKinematics | 'bedslinger' | (string & {}) | null
  model?: PrinterModel | (string & {}) | null
}

/** A specific printer's glyph: corexy → PrinterCoreXY, cartesian/bedslinger → PrinterGantry, unknown → PrinterLayers. */
export const PrinterModelIcon = forwardRef<SVGSVGElement, PrinterModelIconProps>(function PrinterModelIcon({ kinematics, model, ...props }, ref) {
  const k = kinematics ?? (model ? (MODEL_KINEMATICS as Record<string, PrinterKinematics | undefined>)[model] : undefined) ?? 'unknown'
  if (k === 'corexy') return <PrinterCoreXY ref={ref} {...props} />
  if (k === 'cartesian' || k === 'bedslinger') return <PrinterGantry ref={ref} {...props} />
  return <PrinterLayers ref={ref} {...props} />
})
