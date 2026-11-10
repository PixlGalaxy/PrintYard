// The Preview tab's "current G-code": kept per user in localStorage (`sd:preview:file:<userId>`) so it survives
// tab switches and reloads. It is replaced by a new slice / an opened file, and cleared when the user prints it,
// closes it, or the file turns out to be deleted.
import { useSyncExternalStore } from 'react'

let userId: number | null = null
let current: number | null = null
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}
const keyOf = (uid: number) => `sd:preview:file:${uid}`

function read(uid: number): number | null {
  try {
    const n = Number(localStorage.getItem(keyOf(uid)))
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function write(uid: number, id: number | null) {
  try {
    if (id === null) localStorage.removeItem(keyOf(uid))
    else localStorage.setItem(keyOf(uid), String(id))
  } catch {
    /* storage blocked: memory only */
  }
}

export const previewFile = {
  /** `notify: false` when called during render (the hook reads the new value through its snapshot anyway). */
  bindUser(uid: number | null, notify = true) {
    if (uid === userId) return
    userId = uid
    current = uid === null ? null : read(uid)
    if (notify) emit()
  },
  get: () => current,
  set(id: number | null) {
    if (id === current) return
    current = id
    if (userId !== null) write(userId, id)
    emit()
  },
  /** Clears the current file if it is one of `ids` (deleted, printed…). */
  forget(ids: Iterable<number>) {
    if (current === null) return
    for (const id of ids) if (id === current) return previewFile.set(null)
  },
  subscribe(cb: () => void) {
    listeners.add(cb)
    return () => void listeners.delete(cb)
  },
}

/** Current preview file id for the signed-in user (binds the store to that user). */
export function usePreviewFile(uid: number | null): number | null {
  previewFile.bindUser(uid, false)
  return useSyncExternalStore(previewFile.subscribe, previewFile.get, previewFile.get)
}
