// Printer tab → Camera: the printer's camera (MJPEG), proxied by the server with the session cookie.
// - only connected while this tab is shown and the page is visible (each viewer costs uplink bandwidth);
// - the server ends a stream after 30 min: it reconnects every 25 min, and on "Try again";
// - snapshot (JPEG download) and full screen.
import { Camera, Download, Maximize2, Minimize2, RefreshCw, VideoOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../../api'
import { useI18n } from '../../../i18n/I18nContext'
import type { Printer } from '../../../types'

const RECONNECT_MS = 25 * 60_000

export default function CameraView({ printer, isAdmin }: { printer: Printer; isAdmin: boolean }) {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'live' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  const [full, setFull] = useState(false)

  const reconnect = () => {
    setState('loading')
    setAttempt((a) => a + 1)
  }

  useEffect(() => {
    const onVis = () => {
      const v = document.visibilityState !== 'hidden'
      setVisible(v)
      if (v) reconnect()
    }
    const onFull = () => setFull(document.fullscreenElement === box.current && box.current !== null)
    const timer = setInterval(reconnect, RECONNECT_MS)
    document.addEventListener('visibilitychange', onVis)
    document.addEventListener('fullscreenchange', onFull)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
      document.removeEventListener('fullscreenchange', onFull)
    }
  }, [])

  if (printer.camera.type === 'none') {
    return (
      <section className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line bg-surface-2/50 p-5 text-center">
        <span className="flex size-10 items-center justify-center rounded-2xl bg-surface text-muted shadow-xs">
          <VideoOff size={18} />
        </span>
        <p className="text-sm font-medium">{t('printerTab.noCamera')}</p>
        <p className="max-w-64 text-xs text-muted">{t(isAdmin ? 'printerTab.noCameraAdmin' : 'printerTab.noCameraDesc')}</p>
      </section>
    )
  }

  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void box.current?.requestFullscreen?.()
  }
  const btn =
    'inline-flex size-8 items-center justify-center rounded-lg bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/75 focus-visible:outline-2 focus-visible:outline-sky-400'

  return (
    <section className="space-y-2">
      <div
        ref={box}
        className={`group relative overflow-hidden bg-black ${full ? 'flex items-center justify-center' : 'aspect-video rounded-2xl border border-line shadow-sm'}`}
      >
        {visible && state !== 'error' && (
          <img
            key={attempt}
            src={api.cameraUrl(printer.id, 'stream', attempt)}
            alt={t('printerTab.camera.alt', { name: printer.name })}
            className={`size-full object-contain transition-opacity ${state === 'live' ? 'opacity-100' : 'opacity-0'}`}
            onLoad={() => setState('live')}
            onError={() => setState('error')}
          />
        )}
        {state === 'loading' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-white/70">
            <Camera size={20} className="animate-pulse" />
            {t('printerTab.camera.loading')}
          </div>
        )}
        {state === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-white">
            <VideoOff size={20} className="text-white/70" />
            <p className="text-sm font-medium">{t('printerTab.camera.error')}</p>
            <p className="max-w-64 text-xs text-white/60">{t('printerTab.camera.errorDesc')}</p>
            <button
              type="button"
              onClick={reconnect}
              className="mt-1 inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/15 px-3 text-xs font-semibold hover:bg-white/25 focus-visible:outline-2 focus-visible:outline-sky-400"
            >
              <RefreshCw size={13} />
              {t('common.retry')}
            </button>
          </div>
        )}
        {state === 'live' && (
          <>
            <span className="pointer-events-none absolute top-2 left-2 inline-flex items-center gap-1.5 rounded-md bg-black/55 px-2 py-1 text-[10px] font-bold tracking-wide text-white uppercase backdrop-blur-sm">
              <span className="size-1.5 animate-pulse rounded-full bg-rose-500" />
              {t('printerTab.camera.live')}
            </span>
            <div className="absolute top-2 right-2 flex gap-1.5">
              <a
                className={btn}
                href={api.cameraUrl(printer.id, 'snapshot')}
                download={`${printer.name}.jpg`}
                // Timestamped name, computed when clicked
                onClick={(e) => {
                  e.currentTarget.download = `${printer.name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`
                }}
                title={t('printerTab.camera.snapshot')}
                aria-label={t('printerTab.camera.snapshot')}
              >
                <Download size={15} />
              </a>
              <button type="button" className={btn} onClick={toggleFull} title={t(full ? 'printerTab.camera.exitFullscreen' : 'printerTab.camera.fullscreen')} aria-label={t(full ? 'printerTab.camera.exitFullscreen' : 'printerTab.camera.fullscreen')}>
                {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
