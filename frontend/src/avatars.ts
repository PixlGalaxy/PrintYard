import { useEffect, useSyncExternalStore } from 'react'
import { api } from './api'

/**
 * Who has a profile picture, for lists that only carry a user id + username (prints, audit log).
 * Loaded once per session on first use; kept in sync when you change your own picture or an admin removes one.
 */
let directory: Record<string, string> | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

function load() {
  loading ??= api
    .avatars()
    .then((r) => {
      directory = r.avatars
      emit()
    })
    .catch(() => {
      // No pictures is a fine fallback (initials); retry on the next mount
      loading = null
    })
}

/** `avatarUrl` of a user id from the directory (`enabled` = this caller needs it; avoids a fetch otherwise). */
export function useAvatarDirectory(enabled: boolean): Record<string, string> | null {
  const dir = useSyncExternalStore(subscribe, () => directory)
  useEffect(() => {
    if (enabled && !directory) load()
  }, [enabled])
  return dir
}

/** Keeps the directory in sync after an upload/removal (no refetch needed). */
export function setDirectoryAvatar(userId: number, url: string | null) {
  if (!directory) return
  const next = { ...directory }
  if (url) next[String(userId)] = url
  else delete next[String(userId)]
  directory = next
  emit()
}

/** Signed out: forget everything. */
export function resetAvatarDirectory() {
  directory = null
  loading = null
  emit()
}
