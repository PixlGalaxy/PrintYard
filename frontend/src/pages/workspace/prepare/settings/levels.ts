// Prepare settings levels (Basic / Advanced / Expert). Basic shows only the quick card, Expert every option.
import { Layers, SlidersHorizontal, Sparkles, type LucideIcon } from 'lucide-react'
import type { TranslationKey } from '../../../../i18n/translations'
import { PREPARE_LEVELS, type PrepareLevel } from '../../../../types'

/**
 * Process options listed at the Advanced level. Mirrors what Cura ("Advanced") and PrusaSlicer ("Advanced") show at
 * their middle level: shells, infill, seam, supports, adhesion, the main speeds and a few special modes.
 * Search still covers every option.
 */
export const ADVANCED_KEYS: ReadonlySet<string> = new Set([
  // quality + strength
  'layer_height',
  'initial_layer_print_height',
  'wall_loops',
  'top_shell_layers',
  'bottom_shell_layers',
  'sparse_infill_density',
  'sparse_infill_pattern',
  'top_surface_pattern',
  'seam_position',
  'ironing_type',
  // supports
  'enable_support',
  'support_type',
  'support_style',
  'support_threshold_angle',
  'support_on_build_plate_only',
  'support_top_z_distance',
  // adhesion
  'brim_type',
  'brim_width',
  'skirt_loops',
  // speeds
  'outer_wall_speed',
  'inner_wall_speed',
  'sparse_infill_speed',
  'top_surface_speed',
  'travel_speed',
  'initial_layer_speed',
  // special
  'print_sequence',
  'detect_thin_wall',
  'only_one_wall_top',
  'wall_generator',
  'fuzzy_skin',
  'spiral_mode',
  'elefant_foot_compensation',
  'raft_layers',
  'wall_sequence',
])

/** Process options of the Basic level in the Profiles editor: the settings of Prepare's quick card. */
export const BASIC_KEYS: ReadonlySet<string> = new Set([
  'layer_height',
  'wall_loops',
  'top_shell_layers',
  'bottom_shell_layers',
  'sparse_infill_density',
  'sparse_infill_pattern',
  'enable_support',
  'support_type',
  'support_on_build_plate_only',
  'brim_type',
  'skirt_loops',
])

/** Filament pages of the Advanced level (Expert adds the rest: advanced, multimaterial, notes). */
export const FILAMENT_ADVANCED_PAGES: ReadonlySet<string> = new Set(['Filament', 'Cooling', 'Setting Overrides'])

export const LEVEL_LABEL: Record<PrepareLevel, TranslationKey> = {
  basic: 'workspace.level.basic',
  advanced: 'workspace.level.advanced',
  expert: 'workspace.level.expert',
}

export const LEVEL_DESC: Record<PrepareLevel, TranslationKey> = {
  basic: 'workspace.level.basicDesc',
  advanced: 'workspace.level.advancedDesc',
  expert: 'workspace.level.expertDesc',
}

export const LEVEL_ICON: Record<PrepareLevel, LucideIcon> = {
  basic: Sparkles,
  advanced: SlidersHorizontal,
  expert: Layers,
}

export const isPrepareLevel = (v: unknown): v is PrepareLevel => PREPARE_LEVELS.includes(v as PrepareLevel)
