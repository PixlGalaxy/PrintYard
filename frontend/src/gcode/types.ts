// G-code preview data model (shared by the worker, the renderer and the Preview UI)

/** Extrusion roles, in Orca/Creality Print order. Index = value stored per segment. */
export const FEATURES = [
  'outerWall',
  'innerWall',
  'overhangWall',
  'sparseInfill',
  'solidInfill',
  'topSurface',
  'bottomSurface',
  'bridge',
  'gapInfill',
  'skirt',
  'brim',
  'support',
  'supportInterface',
  'primeTower',
  'ironing',
  'custom',
] as const
export type Feature = (typeof FEATURES)[number]
export const FEATURE_COUNT = FEATURES.length

/** Orca/Bambu-like default colours per role */
export const FEATURE_COLORS: Record<Feature, string> = {
  outerWall: '#FF7D38',
  innerWall: '#FFE64D',
  overhangWall: '#1F1FFF',
  sparseInfill: '#B03029',
  solidInfill: '#9654CC',
  topSurface: '#F04040',
  bottomSurface: '#738CFF',
  bridge: '#4D80BA',
  gapInfill: '#E8E8E8',
  skirt: '#00876E',
  brim: '#00B386',
  support: '#00E000',
  supportInterface: '#008000',
  primeTower: '#B3E3AB',
  ironing: '#FF8C69',
  custom: '#5ED194',
}

export interface GcodeMeta {
  /** Seconds from the slicer's own estimate (header/footer), if present */
  estimatedSeconds: number | null
  filamentMm: number[]
  filamentGrams: number[]
  filamentColors: string[]
  filamentTypes: string[]
  filamentDensity: number[]
  layerCount: number | null
  printerModel: string | null
  slicer: string | null
  layerHeight: number | null
  nozzle: number | null
}

export interface GcodeObject {
  name: string
  center: [number, number] | null
  polygon: [number, number][]
}

export interface ParsedGcode {
  /** 8 floats per extrusion segment: x1 y1 z1 x2 y2 z2 width height */
  seg: Float32Array
  type: Uint8Array
  tool: Uint8Array
  fan: Uint8Array
  /** mm/s */
  speed: Float32Array
  temp: Uint16Array
  /** byte offset of the G-code line that produced each segment */
  offset: Uint32Array
  /** object index per segment (EXCLUDE_OBJECT_START/END; 255 = outside any object) */
  obj: Uint8Array
  /** objects defined in the file (EXCLUDE_OBJECT_DEFINE), index = value in `obj` */
  objects: GcodeObject[]
  count: number
  /** 6 floats per travel move */
  travel: Float32Array
  travelCount: number
  /** first segment of each layer (length = layers + 1, last = count) */
  layerStart: Uint32Array
  layerTravelStart: Uint32Array
  layerZ: Float32Array
  /** estimated seconds per layer (simple feedrate model) */
  layerTime: Float32Array
  layers: number
  /** seconds per feature (simple model, used for percentages) */
  featureTime: Float64Array
  /** which features appear at all */
  featureCount: Uint32Array
  /** extruded filament per tool in mm (from E) */
  toolMm: Float64Array
  bbox: [number, number, number, number, number, number]
  modelSeconds: number
  meta: GcodeMeta
  bytes: number
  lines: number
  parseMs: number
}

export type WorkerRequest = { type: 'parse'; blob: Blob }
export type WorkerResponse =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'done'; result: ParsedGcode }
  | { type: 'error'; message: string }
