import { CircleAlert, Eye, EyeOff, Info, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useId, useState, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from 'react'
import { useI18n } from '../i18n/I18nContext'
import { inputCls } from './styles'

// ---------- Buttons ----------

type Variant = 'primary' | 'secondary' | 'warning' | 'update' | 'ghost' | 'danger'
type Size = 'xs' | 'sm' | 'md'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent-600 text-white shadow-sm shadow-accent-600/25 hover:bg-accent-500 focus-visible:outline-accent-500',
  secondary: 'border border-line bg-surface text-fg shadow-xs hover:bg-surface-2 focus-visible:outline-accent-500',
  update: 'bg-violet-600 text-white shadow-sm shadow-violet-600/25 hover:bg-violet-500 focus-visible:outline-violet-500',
  warning: 'bg-amber-500 text-white shadow-sm shadow-amber-500/25 hover:bg-amber-400 focus-visible:outline-amber-500',
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-accent-500',
  danger:
    'border border-red-500/30 bg-red-500/10 text-red-600 hover:bg-red-500/20 dark:text-red-400 focus-visible:outline-red-500',
}

const SIZES: Record<Size, string> = {
  xs: 'h-7 gap-1.5 px-2.5 text-xs',
  sm: 'h-8 gap-1.5 px-3 text-sm',
  md: 'h-9 gap-2 px-4 text-sm',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
  loading?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'sm',
  icon,
  loading,
  children,
  className = '',
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    >
      {loading ? <LoaderCircle size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  )
}

interface IconButtonProps extends ComponentProps<'button'> {
  label: string
  tone?: 'default' | 'danger' | 'success' | 'warning'
}

const ICON_TONES = {
  default: 'hover:text-fg',
  danger: 'hover:text-red-500',
  success: 'hover:text-emerald-500',
  warning: 'hover:text-amber-500',
}

export function IconButton({ label, tone = 'default', className = '', children, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent-500 disabled:pointer-events-none disabled:opacity-40 ${ICON_TONES[tone]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  disabled?: boolean
  id?: string
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:opacity-50 ${checked ? 'bg-accent-600' : 'bg-line'}`}
    >
      <span
        className={`size-4 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
      />
    </button>
  )
}

export function Meter({ value }: { value: number }) {
  const pct = Math.min(100, Math.max(0, value))
  const color = pct > 85 ? 'bg-red-500' : pct > 60 ? 'bg-amber-500' : 'bg-accent-500'
  return (
    <div
      role="meter"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2 ring-1 ring-line/60 ring-inset"
    >
      <div
        className={`h-full rounded-full transition-[width] duration-700 ease-out ${color}`}
        style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%` }}
      />
    </div>
  )
}

export function Chip({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted ${className}`}
    >
      {children}
    </span>
  )
}

const BADGE_TONES = {
  sky: 'bg-accent-500/15 text-accent-600 dark:text-accent-400',
  emerald: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  amber: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  red: 'bg-red-500/15 text-red-600 dark:text-red-400',
  violet: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  zinc: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
}

export function Badge({ tone = 'zinc', children }: { tone?: keyof typeof BADGE_TONES; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${BADGE_TONES[tone]}`}>
      {children}
    </span>
  )
}

// ---------- Callouts & states ----------

const CALLOUTS: Record<'info' | 'warning' | 'error', { icon: LucideIcon; cls: string }> = {
  info: { icon: Info, cls: 'border-accent-500/30 bg-accent-500/10 text-accent-800 dark:text-accent-200' },
  warning: { icon: TriangleAlert, cls: 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200' },
  error: { icon: CircleAlert, cls: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300' },
}

export function Callout({
  tone = 'info',
  title,
  children,
  className = '',
}: {
  tone?: 'info' | 'warning' | 'error'
  title?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const { icon: Icon, cls } = CALLOUTS[tone]
  return (
    <div role={tone === 'error' ? 'alert' : undefined} className={`flex gap-2.5 rounded-xl border px-3.5 py-3 text-sm ${cls} ${className}`}>
      <Icon size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 space-y-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="text-[13px] leading-relaxed opacity-90">{children}</div>}
      </div>
    </div>
  )
}

export function Loading({ label }: { label?: string }) {
  const { t } = useI18n()
  return (
    <div role="status" className="flex justify-center py-16 text-muted">
      <LoaderCircle className="animate-spin" aria-hidden />
      <span className="sr-only">{label ?? t('common.loading')}</span>
    </div>
  )
}

export function Empty({ icon, children, action }: { icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted">
      {icon && <div className="flex size-11 items-center justify-center rounded-2xl bg-surface-2 text-muted">{icon}</div>}
      <div>{children}</div>
      {action}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t, errorMessage } = useI18n()
  return (
    <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center text-sm">
      <div className="flex size-11 items-center justify-center rounded-2xl bg-red-500/10 text-red-500">
        <CircleAlert size={20} />
      </div>
      <div>
        <p className="font-medium">{t('common.loadError')}</p>
        <p className="text-muted">{errorMessage(error)}</p>
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  )
}

// ---------- Form fields ----------

/** Label + control + hint/error. The control receives `id` and aria props through the render function. */
export function Field({
  label,
  hint,
  error,
  optional,
  children,
  className = '',
}: {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  optional?: boolean
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => ReactNode
  className?: string
}) {
  const { t } = useI18n()
  const id = useId()
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  return (
    <div className={`space-y-1.5 ${className}`}>
      <label htmlFor={id} className="flex items-baseline gap-1.5 text-sm font-medium">
        {label}
        {optional && <span className="text-xs font-normal text-muted">({t('common.optional')})</span>}
      </label>
      {children({ id, 'aria-invalid': !!error, 'aria-describedby': describedBy })}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-xs text-muted">
            {hint}
          </p>
        )
      )}
    </div>
  )
}

export function PasswordInput({ className = '', ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  const { t } = useI18n()
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <input type={show ? 'text' : 'password'} className={`${inputCls} pr-10! ${className}`} {...props} />
      <button
        type="button"
        aria-label={show ? t('common.hidePassword') : t('common.showPassword')}
        title={show ? t('common.hidePassword') : t('common.showPassword')}
        onClick={() => setShow((s) => !s)}
        className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted hover:text-fg"
      >
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  )
}

/** Segmented control (theme picker etc.) */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  compactOnPhone = false,
}: {
  value: T
  options: { value: T; label: string; icon?: ReactNode }[]
  onChange: (value: T) => void
  label: string
  /** Phones: options with an icon show only the icon unless selected (for 3+ long options). */
  compactOnPhone?: boolean
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`relative inline-flex max-w-full overflow-x-auto rounded-lg border border-line bg-surface-2 p-0.5 [scrollbar-width:none] ${compactOnPhone ? 'max-sm:flex max-sm:w-full' : ''}`}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.label || undefined}
            onClick={() => onChange(o.value)}
            className={`inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors max-sm:h-8 ${compactOnPhone ? 'max-sm:flex-1' : ''} focus-visible:outline-2 focus-visible:outline-accent-500 ${
              active ? 'bg-surface text-fg shadow-xs' : 'text-muted hover:text-fg'
            }`}
          >
            {o.icon}
            {o.label && <span className={compactOnPhone && o.icon && !active ? 'max-sm:sr-only' : undefined}>{o.label}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Large selectable card used for exposure / engine choices. */
export function RadioCard({
  name,
  checked,
  onChange,
  icon,
  title,
  description,
  badge,
}: {
  name: string
  checked: boolean
  onChange: () => void
  icon: ReactNode
  title: ReactNode
  description: ReactNode
  badge?: ReactNode
}) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-2xl border p-4 transition-all has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent-500 ${
        checked
          ? 'border-accent-500/50 bg-accent-500/[0.07] shadow-sm ring-1 ring-accent-500/30'
          : 'border-line bg-surface hover:border-accent-500/30 hover:bg-surface-2/60'
      }`}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} className="sr-only" />
      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${checked ? 'bg-accent-500 text-white' : 'bg-accent-500/10 text-accent-500'}`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          {title}
          {badge}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted">{description}</span>
      </span>
      <span
        aria-hidden
        className={`mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border-2 ${checked ? 'border-accent-500' : 'border-line'}`}
      >
        {checked && <span className="size-1.5 rounded-full bg-accent-500" />}
      </span>
    </label>
  )
}

/** Small stat tile (icon badge + value + label). */
export function StatTile({
  icon,
  label,
  value,
  tone,
  hint,
  highlight,
}: {
  icon: ReactNode
  label: string
  value: ReactNode
  tone: string
  hint?: string
  highlight?: boolean
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-2xl border bg-surface p-3 shadow-sm sm:p-4 ${highlight ? 'border-amber-500/40' : 'border-line'}`}
      title={hint}
    >
      <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${tone}`}>{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-lg leading-none font-semibold tabular-nums sm:text-xl">{value}</span>
        <span className="mt-1 block text-xs text-muted">{label}</span>
      </span>
    </div>
  )
}
