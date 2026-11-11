// Dev-only mock for the printer-side presets: the printer's own filament list (`/printer-materials`, from the real
// K2 SE capture, already mapped like the server does) and the profiles backup on the printer
// (`/admin/profiles-backup*`). The restore preview is a fixed example; restoring only returns the import report.
import { ApiError } from '../api'
import type { PrinterMaterial, PrinterMaterialsView, ProfileImportReport, ProfilesBackupPreview, ProfilesBackupStatus } from '../types'
import { mockCore } from './mock'
import { NOT_HANDLED } from './mockF2'

const K2SE = '@Creality K2 SE 0.4 nozzle'
const mat = (id: string, name: string, brand: string, type: string, colors: string[], min: number, max: number, nozzle: number, bed: number, extra: Partial<PrinterMaterial> = {}): PrinterMaterial => ({
  id,
  name,
  brand,
  type,
  color: colors[0] ?? null,
  colors,
  minTemp: min,
  maxTemp: max,
  nozzleTemp: nozzle,
  bedTemp: bed,
  inherits: `${name} ${K2SE}`,
  systemPresetId: `${name} ${K2SE}`,
  differs: [],
  values: {},
  ...extra,
})

/** The real unit's list (20 Creality factory filaments; a subset here), Hyper PLA edited on the printer to show "Differs" */
const MATERIALS: PrinterMaterial[] = [
  mat('01001', 'Hyper PLA', 'Creality', 'PLA', ['#C12E1F', '#0A2989', '#FFFFFF', '#000000', '#B68601', '#9E007E'], 190, 240, 220, 60, {
    differs: [
      { key: 'nozzle_temperature', printer: '225', printyard: '220', kept: true },
      { key: 'pressure_advance', printer: '0.036', printyard: '0.04', kept: true },
    ],
    values: { nozzle_temperature: '225', pressure_advance: '0.036' },
  }),
  mat('02001', 'Hyper PLA-CF', 'Creality', 'PLA-CF', ['#000000', '#212721', '#74654F'], 190, 240, 220, 60),
  mat('06002', 'Hyper PETG', 'Creality', 'PETG', ['#FFFFFF', '#000000'], 220, 270, 250, 70),
  mat('04001', 'CR-PLA', 'Creality', 'PLA', ['#555685', '#2AB192', '#C6E86C'], 190, 240, 220, 60),
  mat('05001', 'CR-Silk', 'Creality', 'PLA', ['#FFC947', '#BB5A29', '#FF8143'], 190, 240, 220, 60),
  mat('00001', 'Generic PLA', 'Generic', 'PLA', ['#FFFFFF'], 190, 240, 220, 60),
  mat('00003', 'Generic PETG', 'Generic', 'PETG', ['#FFFFFF'], 220, 270, 250, 70),
  mat('00005', 'Generic TPU', 'Generic', 'TPU', ['#FFFFFF'], 210, 240, 230, 35),
  mat('19001', 'HP-ASA', 'Creality', 'ASA', ['#FFFFFF'], 240, 280, 260, 90),
  mat('01601', 'Soleyin Ultra PLA', 'Creality', 'PLA', ['#D9B8F1', '#FD7D36', '#F16D7A'], 190, 240, 220, 60),
]

const backup = {
  lastBackupAt: Date.now() - 4 * 60_000 as number | null,
  lastAttemptAt: Date.now() - 4 * 60_000 as number | null,
  lastError: null as string | null,
}

const PREVIEW_ITEMS: ProfilesBackupPreview['items'] = [
  { kind: 'process', name: 'Fast draft (club)', owner: 'maria', restoreOwner: 'maria', ownerKnown: true, shared: true, action: 'unchanged', finalName: 'Fast draft (club)' },
  { kind: 'process', name: 'Fine detail 0.12', owner: 'alex', restoreOwner: 'alex', ownerKnown: true, shared: false, action: 'create', finalName: 'Fine detail 0.12' },
  { kind: 'process', name: 'Vase mode', owner: 'pablo', restoreOwner: 'admin', ownerKnown: false, shared: false, action: 'create', finalName: 'Vase mode' },
  { kind: 'filament', name: 'Silk Gold (club)', owner: 'maria', restoreOwner: 'maria', ownerKnown: true, shared: true, action: 'unchanged', finalName: 'Silk Gold (club)' },
  { kind: 'filament', name: 'Generic PLA', owner: 'admin', restoreOwner: 'admin', ownerKnown: true, shared: false, action: 'create', finalName: 'Generic PLA (2)' },
  { kind: 'filament', name: 'PETG road', owner: 'pablo', restoreOwner: 'admin', ownerKnown: false, shared: false, action: 'create', finalName: 'PETG road' },
]

function status(): ProfilesBackupStatus {
  const s = mockCore.state
  const offline = s.flags.printerOffline
  return {
    enabled: s.settings['printers.profilesBackup.enabled'] ?? true,
    path: 'printyard/profiles-backup.json',
    printers: s.printers.map((p, i) => ({
      printerId: p.id,
      name: p.name,
      online: !offline && i === 0,
      lastBackupAt: i === 0 ? backup.lastBackupAt : null,
      lastAttemptAt: i === 0 ? backup.lastAttemptAt : null,
      lastError: i === 0 ? backup.lastError : null,
      pending: offline,
      process: 2,
      filament: 3,
    })),
  }
}

export function handlePrinterPresets(method: string, p: string, url: URL): unknown {
  if (p === '/printer-materials' && method === 'GET') {
    const u = mockCore.requireUser()
    const printer = mockCore.state.printers[0]
    const online = !mockCore.state.flags.printerOffline
    const view: PrinterMaterialsView = {
      enabled: !!u.showPrinterFilaments,
      printerId: printer?.id ?? null,
      online,
      fetchedAt: u.showPrinterFilaments ? Date.now() - (url.searchParams.get('refresh') ? 0 : 90_000) : null,
      materials: u.showPrinterFilaments ? MATERIALS : [],
    }
    return view
  }
  if (!p.startsWith('/admin/profiles-backup')) return NOT_HANDLED
  mockCore.requireAdmin()
  if (p === '/admin/profiles-backup' && method === 'GET') return status()
  if (p === '/admin/profiles-backup/run' && method === 'POST') {
    if (!(mockCore.state.settings['printers.profilesBackup.enabled'] ?? true)) throw new ApiError(409, 'profiles_backup.disabled', 'Off')
    if (mockCore.state.flags.printerOffline) {
      backup.lastAttemptAt = Date.now()
      backup.lastError = 'prints.printer_offline'
    } else {
      backup.lastBackupAt = backup.lastAttemptAt = Date.now()
      backup.lastError = null
    }
    mockCore.audit('profiles_backup.run')
    return status()
  }
  if (p === '/admin/profiles-backup/preview' && method === 'GET') {
    if (mockCore.state.flags.printerOffline) throw new ApiError(409, 'prints.printer_offline', 'Printer offline')
    const create = PREVIEW_ITEMS.filter((i) => i.action === 'create')
    return {
      printerId: Number(url.searchParams.get('printerId')),
      createdAt: new Date(backup.lastBackupAt ?? Date.now()).toISOString(),
      printyardVersion: 'dev',
      counts: {
        process: PREVIEW_ITEMS.filter((i) => i.kind === 'process').length,
        filament: PREVIEW_ITEMS.filter((i) => i.kind === 'filament').length,
        create: create.length,
        unchanged: PREVIEW_ITEMS.length - create.length,
        renamed: create.filter((i) => i.finalName !== i.name).length,
        ownerMapped: PREVIEW_ITEMS.filter((i) => !i.ownerKnown).length,
      },
      items: PREVIEW_ITEMS,
    } satisfies ProfilesBackupPreview
  }
  if (p === '/admin/profiles-backup/restore' && method === 'POST') {
    const create = PREVIEW_ITEMS.filter((i) => i.action === 'create')
    const report: ProfileImportReport = {
      created: create.map((i, n) => ({ kind: i.kind, id: 900 + n, presetId: `custom:${900 + n}`, name: i.finalName, inherits: i.kind === 'process' ? `0.20mm Standard ${K2SE}` : `Generic PLA ${K2SE}`, keys: 3 })),
      skipped: [],
      dropped: [{ profile: 'Vase mode', key: 'machine_start_gcode', reason: 'unsafe' }],
      remapped: [],
      renamed: create.filter((i) => i.finalName !== i.name).map((i) => ({ from: i.name, to: i.finalName })),
    }
    mockCore.audit('profiles_backup.restore', null, { created: report.created.length })
    return report
  }
  return NOT_HANDLED
}
