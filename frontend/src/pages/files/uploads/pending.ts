import { useUploads, type UploadItem } from './UploadContext'

/**
 * Queue items to show for a Files scope (private / shared / all). A finished upload stays (as "Processing…") until
 * the reloaded list contains it (or the tray clears it), so the card never blinks out between the upload and the refresh.
 */
export function usePendingUploads(scope: 'private' | 'shared' | 'all', files: { id: number }[] | null): UploadItem[] {
  const { items } = useUploads()
  const known = new Set((files ?? []).map((f) => f.id))
  return items.filter(
    (i) =>
      (scope === 'all' || i.visibility === scope) &&
      (i.status === 'queued' || i.status === 'uploading' || i.status === 'error' || (i.status === 'done' && !!i.result && files !== null && !known.has(i.result.id))),
  )
}
