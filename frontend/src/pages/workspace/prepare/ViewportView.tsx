import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useTheme } from '../../../context/ThemeContext'
import { useAccent } from '../../../theme/accent'
import { Viewport } from '../../../three/Viewport'
import { meshes } from '../../../workspace/meshes'
import { applyWorldMatrices, env, layOnFace } from '../../../workspace/ops'
import type { BedSize } from '../../../workspace/plates'
import { workspace, useWs } from '../../../workspace/store'
import type { ViewCubeHandle } from '../../../three/ViewCube'

/** Mounts the three.js viewport and keeps it in sync with the scene store, the mesh cache and the theme. */
export default function ViewportView({ bed, cube }: { bed: BedSize; cube: React.RefObject<ViewCubeHandle | null> }) {
  const host = useRef<HTMLDivElement>(null)
  const vpRef = useRef<Viewport | null>(null)
  const { resolved } = useTheme()
  const state = useWs((s) => s)
  const meshVersion = useSyncExternalStore(meshes.subscribe, () => meshes.version)
  // Accent colour of the current skin (CSS var), re-read when the skin attribute changes
  const palette = useAccent()
  const accent = palette[500]

  useEffect(() => {
    const vp = new Viewport(host.current!, {
      onPick: (id, { shift, ctrl }) => {
        if (!id) {
          if (!shift && !ctrl) workspace.select([])
          return
        }
        workspace.select([id], shift || ctrl ? 'toggle' : 'set')
      },
      onPlatePick: (plate) => workspace.setActivePlate(plate),
      onTransformEnd: (m) => applyWorldMatrices(m),
      onLayFace: (id, n) => layOnFace(id, n),
      onCamera: (view) => cube.current?.update(view),
    })
    vpRef.current = vp
    env.viewport = vp
    return () => {
      if (env.viewport === vp) env.viewport = null
      vp.dispose()
      vpRef.current = null
    }
  }, [cube])

  useEffect(() => {
    vpRef.current?.sync({
      doc: state.doc,
      selection: state.selection,
      hidden: state.hidden,
      activePlate: state.activePlate,
      tool: state.tool,
      bed,
      dark: resolved === 'dark',
      accent,
      mesh: (id) => meshes.info(id),
    })
  }, [state.doc, state.selection, state.hidden, state.activePlate, state.tool, bed, resolved, meshVersion, accent])

  // Shift held: snap the gizmo (5 mm / 15° / 5 %)
  useEffect(() => {
    const on = (e: KeyboardEvent) => vpRef.current?.setSnap(e.shiftKey)
    window.addEventListener('keydown', on)
    window.addEventListener('keyup', on)
    return () => {
      window.removeEventListener('keydown', on)
      window.removeEventListener('keyup', on)
    }
  }, [])

  return <div ref={host} className="absolute inset-0 touch-none" />
}
