// Workspace scene store: the SceneDoc plus editor state (selection, active plate, tool, uploads),
// undo/redo (whole-document snapshots — the doc is small, meshes live in `meshes.ts`), a dirty flag and an
// autosave of the scene JSON to localStorage. Read it from React with `useWs(selector)`.
import { useSyncExternalStore } from 'react'
import type { SceneDoc, SceneObject } from '../types'

export type Tool = 'select' | 'move' | 'rotate' | 'scale' | 'layFace'

/**
 * A local model being imported (shown as a pending row in the Objects list until it is placed):
 * `uploading` (progress comes from the global upload queue item `itemId`), `processing` (uploaded, mesh still being
 * parsed/built), `error` (`errorKind` upload → retry/remove, parse → remove).
 */
export interface UploadInfo {
  name: string
  size: number
  /** Global upload queue item (UploadContext) carrying progress/speed. */
  itemId: number | null
  state: 'uploading' | 'processing' | 'error'
  error?: string
  errorKind?: 'upload' | 'parse'
}

export interface WorkspaceState {
  doc: SceneDoc
  selection: string[]
  /** 0-based index into doc.plates */
  activePlate: number
  hidden: string[]
  tool: Tool
  project: { fileId: number | null; name: string }
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  /** keyed by the temporary (negative) file id of a local file */
  uploads: Record<number, UploadInfo>
}

export const emptyDoc = (): SceneDoc => ({
  version: 1,
  printerModel: 'creality-k2se',
  machinePresetId: '',
  processPresetId: '',
  processOverrides: {},
  filaments: [],
  plates: [{ index: 0 }],
  objects: [],
})

const HISTORY = 100
const AUTOSAVE_MS = 600

interface Saved {
  doc: SceneDoc
  project: WorkspaceState['project']
  activePlate: number
  dirty: boolean
}

class WorkspaceStore {
  state: WorkspaceState = {
    doc: emptyDoc(),
    selection: [],
    activePlate: 0,
    hidden: [],
    tool: 'select',
    project: { fileId: null, name: '' },
    dirty: false,
    canUndo: false,
    canRedo: false,
    uploads: {},
  }
  private past: SceneDoc[] = []
  private future: SceneDoc[] = []
  private listeners = new Set<() => void>()
  private storageKey: string | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private nextTempId = -1

  subscribe = (cb: () => void) => {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  private set(patch: Partial<WorkspaceState>) {
    this.state = { ...this.state, ...patch, canUndo: this.past.length > 0, canRedo: this.future.length > 0 }
    for (const l of this.listeners) l()
    if ('doc' in patch || 'project' in patch || 'activePlate' in patch) this.scheduleSave()
  }

  // ---------- persistence ----------

  /** Binds autosave to a user and restores their last scene (objects still uploading are dropped). */
  bindUser(userId: number) {
    const key = `sd:ws:${userId}`
    if (this.storageKey === key) return
    this.storageKey = key
    this.past = []
    this.future = []
    let saved: Saved | null = null
    try {
      const raw = localStorage.getItem(key)
      if (raw) saved = JSON.parse(raw) as Saved
    } catch {
      saved = null
    }
    if (saved?.doc?.version === 1) {
      const doc = { ...emptyDoc(), ...saved.doc, objects: (saved.doc.objects ?? []).filter((o) => o.fileId > 0) }
      if (!doc.plates.length) doc.plates = [{ index: 0 }]
      this.set({
        doc,
        project: saved.project ?? { fileId: null, name: '' },
        activePlate: Math.min(saved.activePlate ?? 0, doc.plates.length - 1),
        dirty: !!saved.dirty,
        selection: [],
        hidden: [],
        uploads: {},
      })
    } else {
      this.set({ doc: emptyDoc(), project: { fileId: null, name: '' }, activePlate: 0, dirty: false, selection: [], hidden: [], uploads: {} })
    }
  }

  private scheduleSave() {
    if (!this.storageKey) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      const { doc, project, activePlate, dirty } = this.state
      try {
        localStorage.setItem(this.storageKey!, JSON.stringify({ doc, project, activePlate, dirty } satisfies Saved))
      } catch {
        // storage full or blocked: autosave is best effort
      }
    }, AUTOSAVE_MS)
  }

  // ---------- document edits ----------

  /** Applies an edit. `history: false` for edits that must not be undoable (profile defaults, id remaps). */
  update(fn: (doc: SceneDoc) => SceneDoc, opts: { history?: boolean; dirty?: boolean } = {}) {
    const prev = this.state.doc
    const next = fn(prev)
    if (next === prev) return
    if (opts.history !== false) {
      this.past.push(prev)
      if (this.past.length > HISTORY) this.past.shift()
      this.future = []
    }
    const ids = new Set(next.objects.map((o) => o.id))
    const selection = this.state.selection.filter((id) => ids.has(id))
    const activePlate = Math.min(this.state.activePlate, next.plates.length - 1)
    this.set({ doc: next, selection, activePlate, dirty: opts.dirty === false ? this.state.dirty : true })
  }

  updateObjects(changes: Record<string, Partial<SceneObject>>, opts?: { history?: boolean }) {
    this.update((d) => ({ ...d, objects: d.objects.map((o) => (changes[o.id] ? { ...o, ...changes[o.id] } : o)) }), opts)
  }

  undo() {
    const prev = this.past.pop()
    if (!prev) return
    this.future.push(this.state.doc)
    this.applyHistory(prev)
  }

  redo() {
    const next = this.future.pop()
    if (!next) return
    this.past.push(this.state.doc)
    this.applyHistory(next)
  }

  private applyHistory(doc: SceneDoc) {
    const ids = new Set(doc.objects.map((o) => o.id))
    this.set({
      doc,
      dirty: true,
      selection: this.state.selection.filter((id) => ids.has(id)),
      activePlate: Math.min(this.state.activePlate, doc.plates.length - 1),
    })
  }

  /** Replaces the whole scene (open project / new project). Clears history. */
  load(doc: SceneDoc, project: WorkspaceState['project'], dirty = false) {
    this.past = []
    this.future = []
    this.set({ doc, project, dirty, selection: [], hidden: [], activePlate: 0, tool: 'select', uploads: {} })
  }

  markSaved(project: WorkspaceState['project']) {
    this.set({ project, dirty: false })
  }

  setProjectName(name: string) {
    this.set({ project: { ...this.state.project, name }, dirty: true })
  }

  /** A local file finished uploading: swap its temporary id everywhere (including undo history). */
  remapFileId(from: number, to: number) {
    const fix = (d: SceneDoc): SceneDoc =>
      d.objects.some((o) => o.fileId === from) ? { ...d, objects: d.objects.map((o) => (o.fileId === from ? { ...o, fileId: to } : o)) } : d
    this.past = this.past.map(fix)
    this.future = this.future.map(fix)
    const uploads = { ...this.state.uploads }
    delete uploads[from]
    this.set({ doc: fix(this.state.doc), uploads })
  }

  // ---------- editor state ----------

  tempFileId() {
    return this.nextTempId--
  }

  setUpload(tempId: number, info: UploadInfo | null) {
    const uploads = { ...this.state.uploads }
    if (info) uploads[tempId] = info
    else delete uploads[tempId]
    this.set({ uploads })
  }

  select(ids: string[], mode: 'set' | 'toggle' | 'add' = 'set') {
    let selection: string[]
    if (mode === 'set') selection = ids
    else if (mode === 'add') selection = [...new Set([...this.state.selection, ...ids])]
    else {
      const cur = new Set(this.state.selection)
      for (const id of ids) {
        if (cur.has(id)) cur.delete(id)
        else cur.add(id)
      }
      selection = [...cur]
    }
    const first = this.state.doc.objects.find((o) => o.id === selection[selection.length - 1])
    this.set({ selection, activePlate: first ? first.plate : this.state.activePlate })
  }

  setTool(tool: Tool) {
    this.set({ tool })
  }

  setActivePlate(index: number) {
    this.set({ activePlate: Math.max(0, Math.min(index, this.state.doc.plates.length - 1)) })
  }

  toggleHidden(id: string) {
    const hidden = this.state.hidden.includes(id) ? this.state.hidden.filter((x) => x !== id) : [...this.state.hidden, id]
    this.set({ hidden })
  }
}

export const workspace = new WorkspaceStore()

/** Subscribes a component to a slice of the workspace state (return existing references, not new objects). */
export function useWs<T>(selector: (s: WorkspaceState) => T): T {
  return useSyncExternalStore(workspace.subscribe, () => selector(workspace.state))
}

export const newObjectId = () => `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
