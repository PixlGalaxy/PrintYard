import { Camera, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { adminApi, api } from '../../api'
import { Toggle } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { useI18n } from '../../i18n/I18nContext'
import type { Printer } from '../../types'
import { Panel } from './shared'

/** Admin → Printers: camera on/off per printer, with a snapshot to check it answers. */
export default function CameraPanel({ printers, onSaved }: { printers: Printer[]; onSaved: (p: Printer) => void }) {
  const { t } = useI18n()
  if (printers.length === 0) return null
  return (
    <Panel title={t('printers.camera')} description={t('printers.cameraDesc')} icon={<Camera size={18} />}>
      <div className="space-y-4">
        {printers.map((p) => (
          <PrinterCamera key={p.id} printer={p} onSaved={onSaved} />
        ))}
      </div>
    </Panel>
  )
}

function PrinterCamera({ printer, onSaved }: { printer: Printer; onSaved: (p: Printer) => void }) {
  const { t } = useI18n()
  const { toast, onError } = useToast()
  const [busy, setBusy] = useState(false)
  const [shot, setShot] = useState(0)
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const on = printer.camera.type !== 'none'

  async function set(next: boolean) {
    setBusy(true)
    try {
      onSaved(await adminApi.updatePrinter(printer.id, { camera: { type: next ? 'mjpeg' : 'none' } }))
      toast('success', t(next ? 'printers.cameraTurnedOn' : 'printers.cameraTurnedOff', { name: printer.name }))
      setState('loading')
      setShot((s) => s + 1)
    } catch (err) {
      onError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-3">
          <Toggle checked={on} disabled={busy} label={t('printers.cameraToggle', { name: printer.name })} onChange={(v) => void set(v)} />
          <p className="text-sm font-medium">{printer.name}</p>
        </div>
        <p className="text-xs text-muted">
          {!on ? t('printers.cameraOff') : state === 'error' ? t('printers.cameraNoAnswer') : t('printers.cameraOn')}
        </p>
      </div>
      {on && (
        <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-line bg-black sm:w-56">
          {state !== 'error' && (
            <img
              key={shot}
              src={api.cameraUrl(printer.id, 'snapshot', shot)}
              alt={t('printerTab.camera.alt', { name: printer.name })}
              className="size-full object-contain"
              onLoad={() => setState('ok')}
              onError={() => setState('error')}
            />
          )}
          <button
            type="button"
            onClick={() => {
              setState('loading')
              setShot((s) => s + 1)
            }}
            title={t('common.refresh')}
            aria-label={t('common.refresh')}
            className="absolute right-1.5 bottom-1.5 inline-flex size-7 items-center justify-center rounded-lg bg-black/55 text-white hover:bg-black/75 focus-visible:outline-2 focus-visible:outline-sky-400"
          >
            <RefreshCw size={13} className={state === 'loading' ? 'animate-spin' : ''} />
          </button>
        </div>
      )}
    </div>
  )
}
