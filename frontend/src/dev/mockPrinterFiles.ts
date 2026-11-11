// Dev-only: the G-code files stored on the mock K2 SE (Files → On the printer). Names and metadata mirror the
// user's real printer (Creality Print uploads, touchscreen samples) plus two files PrintYard uploaded.
import type { PrinterStoredFile } from '../types'

const DIR = '/usr/data/printer_data/gcodes'
const MIN = 60_000
const DAY = 24 * 60 * MIN

type Shape = 'box' | 'tower' | 'hex' | 'boat'

export interface MockPrinterFile extends Omit<PrinterStoredFile, 'path' | 'thumbnailUrl' | 'inUse' | 'filamentGrams'> {
  shape: Shape
  seed: number
  /** Demo: contains a dangerous command (SAVE_CONFIG) the scanner flags */
  dangerous?: boolean
}

const grams = (mm: number | null) => (mm == null ? null : Math.round(((mm * Math.PI * 0.875 * 0.875) / 1000) * 1.24 * 10) / 10)

export function seedPrinterFiles(now = Date.now()): MockPrinterFile[] {
  const f = (
    name: string,
    o: Partial<MockPrinterFile> & Pick<MockPrinterFile, 'size' | 'createdAt' | 'filamentMm' | 'estimatedSec' | 'shape' | 'seed'>,
  ): MockPrinterFile => ({
    name,
    layerHeight: 0.2,
    materials: ['PLA'],
    colors: ['#56df3d'],
    software: 'Creality',
    uploadedByPrintYard: false,
    libraryFileId: null,
    ...o,
  })
  return [
    f('plate_plate1.gcode', { size: 3_912_044, createdAt: now - 2 * DAY, layerHeight: 0.16, filamentMm: 14_210, estimatedSec: 5_420, colors: ['#f97316'], shape: 'box', seed: 1 }),
    f('PantherPaw_plate1.gcode', { size: 1_804_112, createdAt: now - 3 * DAY - 40 * MIN, filamentMm: 6_875, estimatedSec: 2_710, materials: ['PLA', 'PLA'], colors: ['#111111', '#ffffff'], shape: 'hex', seed: 6 }),
    f('Object_1_PLA_3h40m37s.gcode', { size: 5_117_963, createdAt: now - 1 * DAY - 5 * 60 * MIN, filamentMm: 35_888, estimatedSec: 13_237, shape: 'tower', seed: 2 }),
    f('4color_3DBenchy_PLA_1h0m.gcode', { size: 2_416_121, createdAt: 1583064866000, filamentMm: 5_237, estimatedSec: 3_602, materials: ['PLA', 'PLA', 'PLA', 'PLA'], colors: ['#ff0000', '#ffffff', '#0000ff', '#000000'], shape: 'boat', seed: 4 }),
    f('Spatula_PLA_32m19s.gcode', { size: 2_237_205, createdAt: 1583064866000, filamentMm: 6_258, estimatedSec: 1_939, colors: ['#ffffff'], shape: 'hex', seed: 7 }),
    f('3DBenchy_PLA_22m53s.gcode', { size: 2_132_294, createdAt: 1583064866000, filamentMm: 3_720, estimatedSec: 1_373, colors: ['#ff6a13'], shape: 'boat', seed: 1 }),
    f('Twisted_tower_PLA_0.2mm_p3.gcode', { size: 1_204_331, createdAt: now - 4 * DAY, filamentMm: 3_290, estimatedSec: 2_400, colors: ['#0ea5e9'], software: 'Creality Print 7.3.1.6378', uploadedByPrintYard: true, libraryFileId: 1, shape: 'tower', seed: 0 }),
    f('Gear_set_PETG_0.2mm_p5.gcode', { size: 988_120, createdAt: now - 2 * DAY - 3 * 60 * MIN, filamentMm: 7_740, estimatedSec: 4_500, materials: ['PETG'], colors: ['#f97316', '#0ea5e9'], software: 'Creality Print 7.3.1.6378', uploadedByPrintYard: true, libraryFileId: 4, shape: 'hex', seed: 3 }),
    f('usb_macro_test.gcode', { size: 18_220, createdAt: now - 9 * DAY, layerHeight: null, filamentMm: null, estimatedSec: null, materials: [], colors: [], software: null, shape: 'box', seed: 5, dangerous: true }),
  ]
}

export function toStoredFile(f: MockPrinterFile, thumb: (seed: number, shape: Shape) => string, inUse: boolean): PrinterStoredFile {
  const { shape, seed, dangerous: _d, ...rest } = f
  return {
    ...rest,
    path: `${DIR}/${f.name}`,
    filamentGrams: grams(f.filamentMm),
    thumbnailUrl: f.software === null ? null : thumb(seed, shape),
    inUse,
  }
}
