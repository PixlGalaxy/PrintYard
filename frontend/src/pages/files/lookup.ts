import { api } from '../../api'
import type { LibraryFile } from '../../types'

/** The contract has no GET /files/:id, so look the file up in the lists the user can see. */
export async function findLibraryFile(id: number, isAdmin: boolean): Promise<LibraryFile | null> {
  const scopes = isAdmin ? (['private', 'all'] as const) : (['private', 'shared'] as const)
  for (const scope of scopes) {
    const list = await api.files(scope)
    const hit = list.find((f) => f.id === id)
    if (hit) return hit
  }
  return null
}

/** Where "Open" goes for each kind (Workspace tabs, see status/f2-notes.md) */
export const openPath = (f: Pick<LibraryFile, 'id' | 'kind'>) =>
  f.kind === 'gcode' ? `/?tab=preview&file=${f.id}` : f.kind === 'project' ? `/?tab=prepare&project=${f.id}` : `/?tab=prepare&add=${f.id}`
