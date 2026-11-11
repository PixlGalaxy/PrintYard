// Live "Sending to printer" state (PrintYard → printer G-code upload), shared by the print dialog and
// <PrinterUploadProgress/>. Fed by WS `print.upload` (progress, ≤4/s) and `print.update` (state `uploading` starts
// an entry before the first byte; `printing`/`failed`/`cancelled` ends it).
import { useSyncExternalStore } from 'react'
import type { PrintJob, PrintJobState, PrintUploadProgress } from '../types'
import { realtime } from './client'

export interface PrintUploadEntry {
  printId: number
  printerId: number
  fileName: string
  sentBytes: number
  totalBytes: number
  /** 0-100 */
  percent: number
  etaSec: number | null
  /** `starting`: every byte accepted by the printer, waiting for the print to start. */
  phase: 'uploading' | 'starting'
}

let entries: PrintUploadEntry[] = []
const subs = new Set<() => void>()
let off: (() => void) | null = null

const emit = () => {
  for (const s of subs) s()
}

function upsert(e: PrintUploadEntry) {
  const i = entries.findIndex((x) => x.printId === e.printId)
  entries = i < 0 ? [...entries, e] : entries.map((x, j) => (j === i ? e : x))
  emit()
}

function onProgress(p: PrintUploadProgress) {
  upsert({ ...p, phase: p.percent >= 100 ? 'starting' : 'uploading' })
}

function onJob(job: PrintJob) {
  const state = job.state as PrintJobState
  const cur = entries.find((x) => x.printId === job.id)
  if (state === 'uploading') {
    if (!cur) upsert({ printId: job.id, printerId: job.printerId, fileName: job.fileName, sentBytes: 0, totalBytes: 0, percent: 0, etaSec: null, phase: 'uploading' })
    return
  }
  if (cur) {
    entries = entries.filter((x) => x.printId !== job.id)
    emit()
  }
}

function start() {
  if (off) return
  off = realtime.listen((msg) => {
    if (msg.type === 'print.upload') onProgress(msg.data)
    else if (msg.type === 'print.update') onJob(msg.data)
  })
}

function subscribe(cb: () => void) {
  start()
  subs.add(cb)
  return () => {
    subs.delete(cb)
    if (!subs.size && off) {
      off()
      off = null
      entries = []
    }
  }
}

/** Uploads to printers in flight (optionally only for one printer). */
export function usePrintUploads(printerId?: number | null): PrintUploadEntry[] {
  const all = useSyncExternalStore(subscribe, () => entries)
  return printerId == null ? all : all.filter((e) => e.printerId === printerId)
}
