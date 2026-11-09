// Square crop + zoom for a new profile picture (approach from WebinCloud's AvatarCropModal). The crop is drawn on a
// canvas client-side and uploaded; the server still decodes and re-encodes it to a 256×256 WebP.
import { Crop, LoaderCircle, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useI18n } from '../i18n/I18nContext'
import Modal from './Modal'
import { Button, IconButton } from './ui'

interface Props {
  file: File
  onCancel: () => void
  onConfirm: (cropped: Blob) => Promise<void>
}

/** Crop centre (natural image pixels) and zoom relative to "the image covers the frame". */
interface View {
  zoom: number
  cx: number
  cy: number
}

const MIN_ZOOM = 1
const MAX_ZOOM = 5
/** Upload size; the server keeps 256 px, 512 leaves headroom for its resampling. */
const OUTPUT_SIZE = 512
const KEY_PAN_PX = 10

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

/** Keeps the square crop inside the image so the frame never shows empty space. */
function clampView(view: View, width: number, height: number): View {
  const zoom = clampZoom(view.zoom)
  const half = Math.min(width, height) / zoom / 2
  return {
    zoom,
    cx: Math.min(width - half, Math.max(half, view.cx)),
    cy: Math.min(height - half, Math.max(half, view.cy)),
  }
}

/** Pointer position relative to the element's centre. */
function fromCenter(el: HTMLElement, clientX: number, clientY: number) {
  const rect = el.getBoundingClientRect()
  return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 }
}

export default function AvatarCropModal({ file, onCancel, onConfirm }: Props) {
  const { t } = useI18n()
  const [src, setSrc] = useState('')
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [broken, setBroken] = useState(false)
  const [view, setView] = useState<View>({ zoom: 1, cx: 0, cy: 0 })
  const [frame, setFrame] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [saving, setSaving] = useState(false)

  const frameRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())

  // A data URL (not an object URL): survives StrictMode's mount/unmount/mount without a revoke race
  useEffect(() => {
    const reader = new FileReader()
    reader.onload = () => setSrc(String(reader.result))
    reader.onerror = () => setBroken(true)
    reader.readAsDataURL(file)
    return () => reader.abort()
  }, [file])

  // The frame is as wide as the dialog allows: track it for the px <-> image mapping
  useLayoutEffect(() => {
    const el = frameRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setFrame(el.clientWidth))
    observer.observe(el)
    setFrame(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  /** Screen pixels per image pixel at `zoom`. */
  const scaleFor = useCallback(
    (zoom: number) => (natural && frame ? (frame / Math.min(natural.width, natural.height)) * zoom : 1),
    [natural, frame],
  )

  const update = useCallback(
    (fn: (prev: View) => View) => {
      if (natural) setView((prev) => clampView(fn(prev), natural.width, natural.height))
    },
    [natural],
  )

  const pan = useCallback(
    (dx: number, dy: number) =>
      update((prev) => {
        const scale = scaleFor(prev.zoom)
        return { ...prev, cx: prev.cx - dx / scale, cy: prev.cy - dy / scale }
      }),
    [update, scaleFor],
  )

  /** Zooms keeping the image point under (px, py) (offsets from the frame centre) in place. */
  const zoomAt = useCallback(
    (next: number | ((zoom: number) => number), px = 0, py = 0) =>
      update((prev) => {
        const zoom = clampZoom(typeof next === 'function' ? next(prev.zoom) : next)
        const before = scaleFor(prev.zoom)
        const after = scaleFor(zoom)
        return { zoom, cx: prev.cx + px / before - px / after, cy: prev.cy + py / before - py / after }
      }),
    [update, scaleFor],
  )

  // React's wheel listeners are passive, so preventDefault needs a native one
  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const { x, y } = fromCenter(el, e.clientX, e.clientY)
      zoomAt((zoom) => zoom * Math.exp(-e.deltaY * 0.0015), x, y)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    setDragging(true)
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const map = pointers.current
    const prev = map.get(e.pointerId)
    if (!prev) return
    if (map.size === 1) {
      map.set(e.pointerId, { x: e.clientX, y: e.clientY })
      pan(e.clientX - prev.x, e.clientY - prev.y)
      return
    }
    // Pinch: zoom by the change in finger distance around the midpoint, pan with the midpoint
    const [a, b] = [...map.values()]
    const beforeDist = Math.hypot(a.x - b.x, a.y - b.y)
    const beforeMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    map.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const [c, d] = [...map.values()]
    const afterDist = Math.hypot(c.x - d.x, c.y - d.y)
    const afterMid = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 }
    if (beforeDist > 0) {
      const { x, y } = fromCenter(e.currentTarget, afterMid.x, afterMid.y)
      zoomAt((zoom) => zoom * (afterDist / beforeDist), x, y)
    }
    pan(afterMid.x - beforeMid.x, afterMid.y - beforeMid.y)
  }

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size === 0) setDragging(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [KEY_PAN_PX, 0],
      ArrowRight: [-KEY_PAN_PX, 0],
      ArrowUp: [0, KEY_PAN_PX],
      ArrowDown: [0, -KEY_PAN_PX],
    }
    if (moves[e.key]) {
      e.preventDefault()
      pan(...moves[e.key])
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault()
      zoomAt((zoom) => zoom * 1.1)
    } else if (e.key === '-') {
      e.preventDefault()
      zoomAt((zoom) => zoom / 1.1)
    }
  }

  const reset = () => {
    if (natural) setView({ zoom: 1, cx: natural.width / 2, cy: natural.height / 2 })
  }

  const confirm = async () => {
    const img = imgRef.current
    if (!img || !natural) return
    setSaving(true)
    try {
      const crop = Math.min(natural.width, natural.height) / view.zoom
      // Never upscale a small crop: it only adds bytes, not detail
      const size = Math.max(1, Math.round(Math.min(OUTPUT_SIZE, crop)))
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')!
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, view.cx - crop / 2, view.cy - crop / 2, crop, crop, 0, 0, size, size)
      // WebP where the browser can encode it (falls back to PNG otherwise, e.g. older Safari)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.92))
      if (!blob) throw new Error('Canvas export failed')
      await onConfirm(blob)
    } finally {
      setSaving(false)
    }
  }

  const scale = scaleFor(view.zoom)

  return (
    <Modal
      title={t('avatar.cropTitle')}
      icon={<Crop size={18} />}
      size="sm"
      onClose={onCancel}
      dismissable={!saving}
      footer={
        <>
          <Button onClick={onCancel} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void confirm()} loading={saving} disabled={!natural}>
            {t('avatar.save')}
          </Button>
        </>
      }
    >
      <p className="mb-4 text-center text-sm text-muted">{t('avatar.cropHint')}</p>
      <div
        ref={frameRef}
        tabIndex={0}
        data-autofocus
        role="application"
        aria-label={t('avatar.cropArea')}
        className={`relative mx-auto aspect-square w-full max-w-80 touch-none overflow-hidden rounded-xl bg-zinc-900 outline-none select-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
          dragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onDoubleClick={reset}
      >
        {src && (
          <img
            ref={imgRef}
            src={src}
            alt=""
            draggable={false}
            onLoad={(e) => {
              const { naturalWidth: width, naturalHeight: height } = e.currentTarget
              setNatural({ width, height })
              setView({ zoom: 1, cx: width / 2, cy: height / 2 })
            }}
            onError={() => setBroken(true)}
            className={`pointer-events-none absolute top-0 left-0 max-w-none origin-top-left ${natural ? '' : 'invisible'}`}
            style={
              natural
                ? {
                    width: natural.width * scale,
                    height: natural.height * scale,
                    transform: `translate(${frame / 2 - view.cx * scale}px, ${frame / 2 - view.cy * scale}px)`,
                  }
                : undefined
            }
          />
        )}
        {!natural && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-zinc-300">
            {broken ? t('avatar.unreadable') : <LoaderCircle className="animate-spin" size={24} />}
          </div>
        )}
        {/* Dims everything outside the circle the avatar is shown in */}
        <div className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_rgba(9,9,11,0.6)]" />
        {/* Rule-of-thirds grid, brighter while dragging */}
        <div className={`pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3 transition-opacity ${dragging ? 'opacity-90' : 'opacity-35'}`}>
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className={`border-white/70 ${i % 3 !== 2 ? 'border-r' : ''} ${i < 6 ? 'border-b' : ''}`} />
          ))}
        </div>
        <div className="pointer-events-none absolute inset-0 rounded-full border-2 border-white/80" />
      </div>

      <div className="mx-auto mt-4 flex max-w-80 items-center gap-2">
        <IconButton label={t('avatar.zoomOut')} onClick={() => zoomAt((zoom) => zoom / 1.2)} disabled={!natural || view.zoom <= MIN_ZOOM}>
          <ZoomOut size={18} />
        </IconButton>
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.01}
          value={view.zoom}
          disabled={!natural}
          onChange={(e) => zoomAt(Number(e.target.value))}
          aria-label={t('avatar.zoom')}
          className="h-1.5 flex-1 cursor-pointer accent-accent-600"
        />
        <IconButton label={t('avatar.zoomIn')} onClick={() => zoomAt((zoom) => zoom * 1.2)} disabled={!natural || view.zoom >= MAX_ZOOM}>
          <ZoomIn size={18} />
        </IconButton>
        <IconButton label={t('avatar.resetCrop')} onClick={reset} disabled={!natural}>
          <RotateCcw size={16} />
        </IconButton>
      </div>
    </Modal>
  )
}
