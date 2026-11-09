// Printer icons used consistently across the Printer tab (panel, status strip, floating cards) and Prepare's
// printer card: nozzle/hotend = Flame (orange-rose), extruder = ArrowDownToLine (orange), bed = Grid3x3 (violet),
// light = Lightbulb (amber). Tinted with their colour (filled with a translucent tint where the shape allows).
import { ArrowDownToLine, Flame, Grid3x3, Lightbulb, LightbulbOff } from 'lucide-react'

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
