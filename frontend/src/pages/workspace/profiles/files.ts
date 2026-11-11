// Profile files in the browser: read an upload as base64, save an exported file.
import type { ProfileExportFile } from '../../../types'

/** Largest import the server accepts (checked here first so a big file is not uploaded for nothing) */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024
export const IMPORT_ACCEPT = '.json,.zip,.creality_filament,.creality_printer'

export function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

export function saveExport(file: ProfileExportFile) {
  const bin = atob(file.data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const url = URL.createObjectURL(new Blob([bytes], { type: file.contentType }))
  const a = document.createElement('a')
  a.href = url
  a.download = file.fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
