// Option dependency rules (which settings are greyed out or hidden given the others), ported from
// Creality Print 7.3.1 / OrcaSlicer: `ConfigManipulation::toggle_print_fff_options` (process) and
// `TabFilament::toggle_options` + `update_filament_overrides_page` (filament).
//   toggle_field(key, on)  → `disabled` when off (shown greyed, like "Wipe speed" when role-based wipe is on)
//   toggle_line(key, on)   → `hidden` when off
// Pure functions over string values (bools "1"/"0", enums by their serialized key, percents "15%"), no React.
// Deliberately skipped rules are listed in SKIPPED at the bottom.

export type Get = (key: string) => string | undefined

/** Printer facts the rules need (from the machine preset). Defaults match the K2 SE. */
export interface DepContext {
  gcodeFlavor?: string
  /** single_extruder_multi_material */
  semm?: boolean
  /** Creality K2 series (flush into skeleton) */
  k2Series?: boolean
  /** Bambu printer (a few Orca-only rows are hidden on those) */
  bbl?: boolean
  /** Creality vendor (is_cx_vendor) */
  creality?: boolean
  auxiliaryFan?: boolean
  supportMultiBedTypes?: boolean
  /** machine `enable_long_retraction_when_cut` == EnableFilament (2) */
  longRetractionWhenCut?: boolean
  primeTowerToolchangeAtStart?: boolean
  /** true for the global process, false for per-object settings */
  global?: boolean
}

export interface DepResult {
  disabled: Set<string>
  hidden: Set<string>
}

export function contextFromMachine(machine: Record<string, string> | undefined, global = true): DepContext {
  const m = machine ?? {}
  const model = m.printer_model ?? ''
  return {
    gcodeFlavor: m.gcode_flavor ?? 'klipper',
    semm: bool(m.single_extruder_multi_material ?? '1'),
    k2Series: /\bK2\b/i.test(model) || model === '',
    bbl: false,
    creality: true,
    auxiliaryFan: bool(m.auxiliary_fan ?? '0'),
    supportMultiBedTypes: bool(m.support_multi_bed_types ?? '1'),
    longRetractionWhenCut: Number(m.enable_long_retraction_when_cut ?? 0) === 2,
    primeTowerToolchangeAtStart: bool(m.prime_tower_toolchange_at_start ?? '0'),
    global,
  }
}

// ---------- value helpers ----------

const first = (v: string | undefined) => (v ?? '').split(',')[0]!.trim().replace(/^"|"$/g, '')
const bool = (v: string | undefined) => {
  const s = first(v).toLowerCase()
  return s === '1' || s === 'true'
}
const num = (v: string | undefined) => {
  const n = parseFloat(first(v).replace(/%$/, ''))
  return Number.isFinite(n) ? n : 0
}
/** Enum value, tolerating C++-style "NoiseType::Classic" strings found in some presets. */
const en = (v: string | undefined) => first(v).replace(/^\w+::/, '').toLowerCase()

class Toggles implements DepResult {
  disabled = new Set<string>()
  hidden = new Set<string>()
  field(key: string, on: boolean) {
    if (on) this.disabled.delete(key)
    else this.disabled.add(key)
  }
  line(key: string, on: boolean) {
    if (on) this.hidden.delete(key)
    else this.hidden.add(key)
  }
  fields(keys: string[], on: boolean) {
    for (const k of keys) this.field(k, on)
  }
  lines(keys: string[], on: boolean) {
    for (const k of keys) this.line(k, on)
  }
}

const MULTILINE_PATTERNS = new Set([
  'gyroid', 'grid', 'zig-zag', 'tpmsd', 'tpmsfk', 'crosshatch', 'honeycomb', 'lateral-lattice', 'lateral-honeycomb',
  'cubic', 'tri-hexagon', 'alignedrectilinear', 'lightning', '3dhoneycomb', 'adaptivecubic', 'supportcubic',
])
const TREE_ORGANIC = 'organic'
const isTree = (supportType: string) => supportType.startsWith('tree')
const isAuto = (supportType: string) => supportType.includes('auto')

// ---------- process ----------

export function processDependencies(get: Get, ctx: DepContext = {}): DepResult {
  const t = new Toggles()
  const c = { gcodeFlavor: 'klipper', semm: true, k2Series: true, bbl: false, creality: true, global: true, ...ctx }

  const slope = num(get('max_volumetric_extrusion_rate_slope')) > 0
  t.lines(['max_volumetric_extrusion_rate_slope_segment_length', 'extrusion_rate_smoothing_external_perimeter_only'], slope)

  t.line('filter_out_gap_fill', en(get('gap_fill_target')) !== 'nowhere')

  const perimeters = num(get('wall_loops')) > 0
  t.fields(
    ['extra_perimeters_on_overhangs', 'ensure_vertical_shell_thickness', 'detect_thin_wall', 'detect_overhang_wall', 'seam_position', 'staggered_inner_seams',
      'wall_sequence', 'outer_wall_line_width', 'inner_wall_speed', 'outer_wall_speed', 'small_perimeter_speed', 'small_perimeter_threshold'],
    perimeters,
  )

  const pattern = en(get('sparse_infill_pattern'))
  const infill = num(get('sparse_infill_density')) > 0 || (pattern === 'field' && num(get('interior_coefficient')) > 0)
  const primeTower = bool(get('enable_prime_tower'))
  t.field('ai_infill', primeTower)
  t.lines(['sparse_infill_pattern', 'infill_combination', 'minimum_sparse_infill_area', 'sparse_infill_filament', 'infill_anchor_max', 'infill_shift_step', 'infill_rotate_step', 'symmetric_infill_y_axis'], infill)

  const multiline = !bool(get('ai_infill')) && MULTILINE_PATTERNS.has(pattern)
  t.line('fill_multiline', multiline)
  t.field('sparse_infill_density', pattern !== 'locked-zag')

  const anchors = infill && num(get('infill_anchor_max')) > 0
  t.fields(['infill_anchor', 'infill_anchor_max'], anchors)

  const crossZag = pattern === 'cross-zag'
  const lockedZag = pattern === 'locked-zag'
  const zigZag = pattern === 'zig-zag2'
  const flushIntoInfill = bool(get('flush_into_infill'))
  const flushIntoSkeleton = bool(get('flush_into_skeleton'))
  if (crossZag || zigZag) t.fields(['infill_anchor', 'infill_anchor_max'], false)
  t.line('infill_shift_step', crossZag)
  t.lines(['skin_infill_density', 'infill_lock_depth', 'skin_infill_depth', 'skin_infill_line_width', 'skeleton_infill_line_width', 'skeleton_wipe_line_width', 'locked_skin_infill_pattern', 'locked_skeleton_infill_pattern'], lockedZag)
  t.line('skeleton_infill_density', lockedZag && primeTower)
  t.line('minimum_skeleton_infill_density', lockedZag && !primeTower)
  t.field('skin_infill_depth', lockedZag && !flushIntoSkeleton)
  t.line('skeleton_wipe_line_width', false)
  t.line('infill_rotate_step', zigZag)
  t.line('symmetric_infill_y_axis', zigZag || crossZag || lockedZag)

  const top = num(get('top_shell_layers')) > 0
  const bottom = num(get('bottom_shell_layers')) > 0
  const solid = top || bottom
  t.fields(
    ['infill_direction', 'sparse_infill_line_width', 'fill_multiline', 'gap_fill_target', 'filter_out_gap_fill', 'infill_wall_overlap', 'sparse_infill_speed', 'bridge_speed',
      'internal_bridge_speed', 'bridge_angle', 'internal_bridge_angle', 'solid_infill_direction', 'internal_solid_infill_pattern', 'solid_infill_filament', 'rotate_solid_infill_direction'],
    infill || solid,
  )
  t.lines(['lateral_lattice_angle_1', 'lateral_lattice_angle_2'], pattern === 'lateral-lattice')
  t.line('infill_overhang_angle', pattern === 'lateral-honeycomb')

  const vase = bool(get('spiral_mode'))
  const zaa = bool(get('zaa_enabled'))
  t.lines(['zaa_wall_lowering_min_slope', 'zaa_slice_plane_offset', 'zaa_lock_top_surface_fill_direction'], zaa)
  t.line('spiral_mode_smooth', vase)
  t.line('spiral_mode_max_xy_smoothing', vase && bool(get('spiral_mode_smooth')))
  t.field('z_direction_outwall_speed_continuous', !vase)
  t.fields(['top_surface_pattern', 'bottom_surface_pattern', 'internal_solid_infill_pattern', 'solid_infill_filament'], solid)
  t.field('top_shell_thickness', !vase && top)
  t.field('bottom_shell_thickness', !vase && bottom)
  t.field('wall_direction', !vase)
  t.field('gap_infill_speed', perimeters)
  t.fields(['top_surface_line_width', 'top_surface_speed'], top || (vase && bottom))

  t.fields(
    ['outer_wall_acceleration', 'inner_wall_acceleration', 'initial_layer_acceleration', 'top_surface_acceleration', 'travel_acceleration', 'bridge_acceleration', 'sparse_infill_acceleration', 'internal_solid_infill_acceleration'],
    num(get('default_acceleration')) > 0,
  )
  t.fields(['outer_wall_jerk', 'inner_wall_jerk', 'initial_layer_jerk', 'top_surface_jerk', 'travel_jerk', 'infill_jerk'], num(get('default_jerk')) > 0)

  const skirt = num(get('skirt_loops')) > 0
  const draftShield = en(get('draft_shield'))
  t.field('skirt_height', skirt && draftShield !== 'enabled')
  t.fields(['skirt_distance', 'draft_shield'], skirt)

  const brimType = en(get('brim_type'))
  const brim = brimType !== 'no_brim'
  t.field('brim_object_gap', brim)
  t.field('brim_width', brim && brimType !== 'auto_brim')
  t.field('wall_filament', perimeters || brim)
  const brimWidth = num(get('brim_width'))
  t.fields(['brim_ears_max_angle', 'brim_ears_detection_length'], brimWidth > 0)
  t.lines(['brim_ears_max_angle', 'brim_ears_detection_length'], brimType === 'brim_ears')
  t.line('elefant_foot_compensation_layers', num(get('elefant_foot_compensation')) > 0)

  const raft = num(get('raft_layers')) > 0
  const support = bool(get('enable_support')) || raft
  const supportType = en(get('support_type'))
  const interfaceTop = num(get('support_interface_top_layers'))
  const supportInterface = interfaceTop > 0 || num(get('support_interface_bottom_layers')) > 0
  const soluble = support && num(get('support_top_z_distance')) === 0
  const style = en(get('support_style'))
  t.fields(
    ['support_style', 'support_base_pattern_spacing', 'support_expansion', 'support_angle', 'support_interface_pattern', 'support_interface_top_layers', 'support_interface_bottom_layers',
      'bridge_no_support', 'max_bridge_length', 'support_top_z_distance', 'support_bottom_z_distance', 'support_type', 'support_on_build_plate_only', 'support_critical_regions_only',
      'support_interface_not_for_body', 'support_object_xy_distance', 'independent_support_layer_height', 'minimum_support_area', 'support_xy_overrides_z', 'ironing_support_layer',
      'tree_hybrid_cross_height', 'support_object_first_layer_gap', 'raft_first_layer_density', 'raft_first_layer_expansion', 'tree_support_wall_count', 'tree_support_wall_count_tree',
      'support_remove_small_overhang', 'support_interface_min_area'],
    support,
  )
  const slimTrees = style === TREE_ORGANIC || style === 'tree_slim' || style === 'tree_strong'
  t.field('support_threshold_angle', support && isAuto(supportType))
  t.field('support_base_pattern_tree', support && isTree(supportType) && style !== TREE_ORGANIC)
  t.field('support_base_pattern', support && !slimTrees)
  t.field('tree_support_wall_count', support && !slimTrees)
  const tree = bool(get('enable_support')) && isTree(supportType)
  t.lines(['tree_support_branch_angle', 'tree_support_branch_distance', 'tree_support_branch_diameter', 'tree_support_branch_diameter_angle', 'max_bridge_length', 'support_base_pattern_tree', 'tree_support_wall_count_tree', 'tree_support_organic_validate_repair'], tree)
  t.line('support_critical_regions_only', isAuto(supportType) && tree)
  t.line('bridge_no_support', !isTree(supportType))
  t.fields(['support_interface_spacing', 'support_interface_filament', 'support_interface_loop_pattern', 'support_bottom_interface_spacing'], support && supportInterface)
  const canIronSupport = raft || (support && interfaceTop > 0)
  t.field('support_ironing', canIronSupport)
  const supportIroning = canIronSupport && bool(get('support_ironing'))
  t.lines(['support_ironing_pattern', 'support_ironing_flow', 'support_ironing_spacing'], supportIroning)
  t.field('support_interface_spacing', support && supportInterface && !supportIroning)
  const skirtHeight = skirt && (num(get('skirt_height')) > 1 || draftShield !== 'enabled')
  t.line('support_speed', support || skirtHeight)
  t.line('support_interface_speed', support && supportInterface)
  t.line('minimum_support_area', bool(get('support_remove_small_overhang')))
  t.line('tree_hybrid_cross_height', tree && style === 'tree_hybrid')
  t.line('ironing_support_layer', bool(get('enable_support')) && !isTree(supportType))
  t.field('inner_wall_line_width', perimeters || skirt || brim)
  t.field('support_filament', support || skirt)
  t.line('raft_contact_distance', raft && !soluble)

  t.lines(['ironing_pattern', 'ironing_flow', 'ironing_spacing', 'ironing_speed', 'ironing_angle'], en(get('ironing_type')) !== 'no ironing')
  t.field('print_order', en(get('print_sequence')) !== 'by object')
  t.field('single_extruder_multi_material', !c.bbl)

  t.line('ooze_prevention', !c.semm)
  const ooze = bool(get('ooze_prevention'))
  t.line('wait_for_temperature_after_toolchange', ooze && !c.semm)
  t.lines(['standby_temperature_delta', 'preheat_temperature_delta', 'preheat_time'], ooze)
  t.line('preheat_steps', ooze && num(get('preheat_steps')) > 0)

  t.lines(['flush_into_infill', 'flush_into_objects', 'flush_into_support'], !!c.semm)
  t.line('flush_into_skeleton', !!c.semm)

  const linkedNoTower = !primeTower && !!c.primeTowerToolchangeAtStart
  t.field('sparse_infill_pattern', !linkedNoTower)
  t.field('locked_skin_infill_pattern', !linkedNoTower)
  const crealityTower = !c.bbl && !!c.k2Series
  t.line('wipe_tower_filament', crealityTower)
  t.field('wipe_tower_filament', crealityTower && primeTower)
  t.line('flush_into_solid_skeleton', !primeTower)
  t.lines(['bottom_fill_flush_layers', 'top_fill_flush_layers', 'skeleton_flush_slowdown_speed'], linkedNoTower)
  const flushIntoObjects = bool(get('flush_into_objects'))
  t.lines(['prime_tower_width', 'prime_tower_brim_width', 'prime_tower_skip_points', 'prime_tower_rib_wall', 'prime_tower_enable_framework'], primeTower)
  const enhance = en(get('prime_tower_enhance_type'))
  const cornerRib = enhance === 'corner_rib'
  const ribWall = (bool(get('prime_tower_rib_wall')) || cornerRib) && primeTower
  t.field('prime_tower_width', !ribWall)
  t.field('prime_tower_rib_wall', primeTower && !cornerRib)
  t.lines(['wipe_tower_rotation_angle', 'wipe_tower_cone_angle', 'wipe_tower_max_purge_speed', 'wipe_tower_bridging', 'wipe_tower_extra_flow', 'wipe_tower_no_sparse_layers', 'wipe_tower_extra_spacing', 'prime_tower_start_ironing', 'prime_tower_start_offset'], primeTower && !c.bbl)
  t.line('single_extruder_multi_material_priming', false)
  t.line('prime_tower_corner_rib_length', false)
  t.line('prime_tower_enhance_type', false)
  if (primeTower && !c.bbl) {
    t.lines(['wipe_tower_cone_angle', 'prime_volume', 'wipe_tower_no_sparse_layers', 'prime_tower_width', 'prime_tower_brim_width', 'wipe_tower_rotation_angle', 'prime_tower_enhance_type'], true)
    t.line('prime_tower_corner_rib_length', cornerRib)
    if (enhance !== 'cone') t.line('wipe_tower_cone_angle', false)
    t.line('wipe_tower_bridging', false)
  }
  t.line('wipe_tower_extra_interlayer_wipe_layers', primeTower && !c.bbl && !bool(get('wipe_tower_no_sparse_layers')))
  const smoothTimelapse = !primeTower && en(get('timelapse_type')) === '1'
  const flushAvailable = primeTower || smoothTimelapse
  t.field('flush_into_infill', flushAvailable && !flushIntoSkeleton)
  t.field('flush_into_support', flushAvailable)
  t.field('flush_into_objects', flushAvailable && !flushIntoSkeleton)
  t.field('flush_into_skeleton', primeTower && !!c.k2Series && !flushIntoInfill && !flushIntoObjects)

  t.line('max_travel_detour_distance', bool(get('reduce_crossing_wall')))

  const overhangSpeed = bool(get('enable_overhang_speed'))
  const classic = bool(get('overhang_speed_classic'))
  t.lines(['overhang_speed_classic', 'overhang_1_4_speed', 'overhang_2_4_speed', 'overhang_3_4_speed', 'overhang_4_4_speed', 'overhang_totally_speed'], overhangSpeed)
  t.line('slowdown_for_curled_perimeters', !classic && overhangSpeed)
  t.line('smooth_speed_discontinuity_area', classic && overhangSpeed)
  t.line('smooth_coefficient', bool(get('smooth_speed_discontinuity_area')) && classic && overhangSpeed)
  const msao = bool(get('msao_recovery_enable'))
  t.lines(['msao_safe_accel', 'msao_safe_velocity'], msao)

  t.line('flush_into_objects', !c.global)
  t.line('support_interface_not_for_body', num(get('support_interface_filament')) > 0 && num(get('support_filament')) === 0)

  const noise = en(get('fuzzy_skin_noise_type')) || 'classic'
  t.line('fuzzy_skin_scale', noise !== 'classic')
  t.line('fuzzy_skin_octaves', noise !== 'classic' && noise !== 'voronoi')
  t.line('fuzzy_skin_persistence', noise === 'perlin' || noise === 'billow')

  const arachne = en(get('wall_generator')) === 'arachne'
  t.lines(['wall_transition_length', 'wall_transition_filter_deviation', 'wall_transition_angle', 'min_feature_size', 'min_length_factor', 'min_bead_width', 'wall_distribution_count', 'initial_layer_min_bead_width'], arachne)
  t.line('detect_thin_wall', !arachne)

  t.field('wipe_speed', !bool(get('role_based_wipe_speed')))
  const klipper = (c.gcodeFlavor ?? 'klipper') === 'klipper'
  t.lines(['accel_to_decel_enable', 'accel_to_decel_factor'], klipper)
  if (klipper) t.field('accel_to_decel_factor', bool(get('accel_to_decel_enable')))

  const printableOverhang = bool(get('make_overhang_printable'))
  t.lines(['make_overhang_printable_angle', 'make_overhang_printable_hole_size'], printableOverhang)
  t.line('min_width_top_surface', bool(get('only_one_wall_top')) || (num(get('min_length_factor')) > 0.5 && arachne))
  t.lines(['hole_to_polyhole_threshold', 'hole_to_polyhole_twisted'], bool(get('hole_to_polyhole')))

  const allowReverse = bool(get('detect_overhang_wall')) && !vase && (en(get('wall_direction')) || 'auto') === 'auto'
  const reverse = bool(get('overhang_reverse'))
  t.field('overhang_reverse', allowReverse)
  t.lines(['overhang_reverse_threshold', 'overhang_reverse_internal_only'], allowReverse && reverse)
  t.line('timelapse_type', !!(c.bbl || c.creality))
  t.line('small_area_infill_flow_compensation_model', bool(get('small_area_infill_flow_compensation')))

  t.field('seam_slope_type', !vase)
  const scarf = !vase && (en(get('seam_slope_type')) || 'none') !== 'none'
  t.lines(['seam_slope_conditional', 'seam_slope_start_height', 'seam_slope_entire_loop', 'seam_slope_min_length', 'seam_slope_steps', 'seam_slope_inner_walls', 'scarf_joint_speed', 'scarf_joint_flow_ratio'], scarf)
  t.field('seam_slope_min_length', !bool(get('seam_slope_entire_loop')))
  t.lines(['scarf_angle_threshold', 'scarf_overhang_threshold'], scarf && bool(get('seam_slope_conditional')))

  t.lines(['acceleration_limit_mess', 'speed_limit_to_height'], false)
  const beam = bool(get('interlocking_beam'))
  t.line('mmu_segmented_region_interlocking_depth', !beam)
  t.lines(['interlocking_beam_width', 'interlocking_orientation', 'interlocking_beam_layer_count', 'interlocking_depth', 'interlocking_boundary_avoidance'], beam)
  t.field('prime_tower_skip_points', true)
  return t
}

// ---------- filament ----------

export function filamentDependencies(get: Get, ctx: DepContext = {}): DepResult {
  const t = new Toggles()
  const c = { creality: true, bbl: false, auxiliaryFan: false, supportMultiBedTypes: true, ...ctx }

  // Cooling
  t.fields(['overhang_fan_speed', 'overhang_fan_threshold'], bool(get('enable_overhang_bridge_fan')))
  t.fields(['additional_cooling_fan_speed', 'enable_special_area_additional_cooling_fan'], !!c.auxiliaryFan)
  t.field('cool_special_cds_fan_speed', bool(get('enable_special_area_additional_cooling_fan')))
  const slowDown = bool(get('slow_down_for_layer_cooling'))
  t.fields(['slow_down_min_speed', 'cooling_slowdown_logic'], slowDown)
  t.field('cooling_perimeter_transition_distance', slowDown && en(get('cooling_slowdown_logic')).startsWith('consistent'))

  // Filament
  t.field('pressure_advance', bool(get('enable_pressure_advance')))
  const multiBed = !!(c.bbl || c.supportMultiBedTypes)
  t.lines(['cool_plate_temp_initial_layer', 'eng_plate_temp_initial_layer', 'textured_plate_temp_initial_layer', 'epoxy_resin_plate_temp_initial_layer', 'customized_plate_temp_initial_layer'], multiBed)
  if (c.creality) t.lines(['cool_plate_temp_initial_layer', 'eng_plate_temp_initial_layer'], false)
  else t.line('epoxy_resin_plate_temp_initial_layer', false)
  t.field('material_flow_temp_graph', bool(get('material_flow_dependent_temperature')))

  // Setting overrides (retraction): everything but the length needs retraction (unset = inherits the printer's)
  const len = get('filament_retraction_length')
  const retraction = len === undefined || len === '' || len === 'nil' || num(len) > 0
  t.fields(
    ['filament_z_hop', 'filament_z_hop_types', 'filament_retract_lift_above', 'filament_retract_lift_below', 'filament_retract_lift_enforce', 'filament_retraction_speed', 'filament_deretraction_speed',
      'filament_retract_restart_extra', 'filament_retraction_minimum_travel', 'filament_retract_when_changing_layer', 'filament_wipe', 'filament_wipe_distance', 'filament_retract_before_wipe',
      'filament_long_retractions_when_cut', 'filament_retraction_distances_when_cut', 'filament_retract_length_toolchange', 'filament_retract_restart_extra_toolchange'],
    retraction,
  )
  t.lines(['filament_long_retractions_when_cut', 'filament_retraction_distances_when_cut'], !!c.longRetractionWhenCut)
  if (!bool(get('filament_long_retractions_when_cut'))) t.field('filament_retraction_distances_when_cut', false)

  // Multimaterial: hidden for BBL printers only
  t.lines(['filament_minimal_purge_on_wipe_tower', 'filament_loading_speed_start', 'filament_loading_speed', 'filament_unloading_speed_start', 'filament_unloading_speed',
    'filament_toolchange_delay', 'filament_cooling_moves', 'filament_cooling_initial_speed', 'filament_cooling_final_speed'], !c.bbl)
  t.lines(['filament_shrink', 'filament_shrinkage_compensation_z'], true)
  return t
}

/** Rules intentionally not ported (UI-side value rewrites, dialogs or printer capabilities we don't model). */
export const SKIPPED = [
  'Value rewrites in toggle_print_fff_options (segment length < 0.5 → 1, fill_multiline → 1, overhang_reverse_threshold → 0): we never change values behind the user.',
  'update_print_fff_config dialogs (spiral vase, prime tower vs. sequential, arc fitting conflicts, temperature range warnings).',
  'retraction_distance_when_cut_override (SLIC3R_ENABLE_TIME_ANALYTICS_EXPORT builds only).',
  'Multi-nozzle filament mapping (support_filament_nozzle_mapping): K2 SE has one nozzle → flush options follow SEMM only.',
  'filament_shrink rows hidden on belt printers (no belt printers supported).',
  'Per-variant (multi-extruder) pressure_advance toggles: one slot = one value.',
]

// ---------- self-checks (run with `node --experimental-strip-types`, see status/fe-close-notes.md; also in dev) ----------

export function dependencySelfChecks(): string[] {
  const fails: string[] = []
  const check = (name: string, cond: boolean) => {
    if (!cond) fails.push(name)
  }
  const from = (o: Record<string, string>): Get => (k) => o[k]
  const k2 = contextFromMachine({ printer_model: 'Creality K2 SE', gcode_flavor: 'klipper', single_extruder_multi_material: '1', auxiliary_fan: '0' })

  let r = processDependencies(from({ role_based_wipe_speed: '1', wall_loops: '2', sparse_infill_density: '15%' }), k2)
  check('wipe_speed greyed when role-based wipe is on', r.disabled.has('wipe_speed'))
  r = processDependencies(from({ role_based_wipe_speed: '0' }), k2)
  check('wipe_speed enabled when role-based wipe is off', !r.disabled.has('wipe_speed'))
  r = processDependencies(from({ wall_loops: '0' }), k2)
  check('wall options greyed with 0 walls', r.disabled.has('outer_wall_speed') && r.disabled.has('seam_position'))
  r = processDependencies(from({ sparse_infill_density: '0%', top_shell_layers: '0', bottom_shell_layers: '0' }), k2)
  check('infill pattern hidden at 0 % infill', r.hidden.has('sparse_infill_pattern') && r.disabled.has('sparse_infill_speed'))
  r = processDependencies(from({ sparse_infill_density: '15%', sparse_infill_pattern: 'gyroid' }), k2)
  check('infill pattern visible at 15 %', !r.hidden.has('sparse_infill_pattern') && !r.hidden.has('fill_multiline'))
  r = processDependencies(from({ enable_support: '0', raft_layers: '0' }), k2)
  check('support options greyed when support is off', r.disabled.has('support_type') && r.disabled.has('support_top_z_distance'))
  r = processDependencies(from({ enable_support: '1', support_type: 'tree(auto)', support_style: 'default' }), k2)
  check('tree rows visible for tree supports', !r.hidden.has('tree_support_branch_angle') && r.hidden.has('bridge_no_support') && !r.disabled.has('support_threshold_angle'))
  r = processDependencies(from({ enable_support: '1', support_type: 'normal(manual)' }), k2)
  check('threshold greyed for manual support', r.disabled.has('support_threshold_angle') && r.hidden.has('tree_support_branch_angle'))
  r = processDependencies(from({ ironing_type: 'no ironing' }), k2)
  check('ironing rows hidden without ironing', r.hidden.has('ironing_speed'))
  r = processDependencies(from({ ironing_type: 'top' }), k2)
  check('ironing rows shown with ironing', !r.hidden.has('ironing_speed'))
  r = processDependencies(from({ wall_generator: 'classic' }), k2)
  check('arachne rows hidden for classic', r.hidden.has('min_bead_width') && !r.hidden.has('detect_thin_wall'))
  r = processDependencies(from({ brim_type: 'auto_brim' }), k2)
  check('brim width greyed for auto brim', r.disabled.has('brim_width') && !r.disabled.has('brim_object_gap'))
  r = processDependencies(from({ brim_type: 'no_brim' }), k2)
  check('brim gap greyed without brim', r.disabled.has('brim_object_gap'))
  r = processDependencies(from({ default_acceleration: '0', default_jerk: '0' }), k2)
  check('accel/jerk greyed at 0', r.disabled.has('outer_wall_acceleration') && r.disabled.has('travel_jerk'))
  r = processDependencies(from({ accel_to_decel_enable: '0' }), k2)
  check('accel_to_decel_factor greyed', r.disabled.has('accel_to_decel_factor') && !r.hidden.has('accel_to_decel_enable'))
  r = processDependencies(from({ accel_to_decel_enable: '1' }), { ...k2, gcodeFlavor: 'marlin2' })
  check('accel_to_decel hidden for non-Klipper', r.hidden.has('accel_to_decel_factor'))
  r = processDependencies(from({ spiral_mode: '1', top_shell_layers: '4' }), k2)
  check('vase mode greys top thickness and shows smoothing', r.disabled.has('top_shell_thickness') && !r.hidden.has('spiral_mode_smooth'))
  r = processDependencies(from({ fuzzy_skin_noise_type: 'NoiseType::Classic' }), k2)
  check('C++ enum strings are understood', r.hidden.has('fuzzy_skin_scale'))
  r = processDependencies(from({ enable_prime_tower: '0' }), k2)
  check('prime tower rows hidden without tower', r.hidden.has('prime_tower_width') && r.disabled.has('flush_into_support'))
  r = processDependencies(from({ seam_slope_type: 'external', seam_slope_entire_loop: '1' }), k2)
  check('scarf rows', !r.hidden.has('seam_slope_steps') && r.disabled.has('seam_slope_min_length'))
  r = processDependencies(from({}), { ...k2, global: false })
  check('flush_into_objects only per object', !r.hidden.has('flush_into_objects'))

  let f = filamentDependencies(from({ enable_pressure_advance: '0', slow_down_for_layer_cooling: '1', cooling_slowdown_logic: 'Uniform cooling' }), k2)
  check('PA greyed when disabled', f.disabled.has('pressure_advance'))
  check('transition distance greyed for uniform cooling', f.disabled.has('cooling_perimeter_transition_distance') && !f.disabled.has('slow_down_min_speed'))
  check('side fan greyed without auxiliary fan', f.disabled.has('additional_cooling_fan_speed'))
  check('Creality hides cool plate first layer', f.hidden.has('cool_plate_temp_initial_layer') && !f.hidden.has('epoxy_resin_plate_temp_initial_layer'))
  f = filamentDependencies(from({ slow_down_for_layer_cooling: '0' }), k2)
  check('slowdown rows greyed', f.disabled.has('slow_down_min_speed'))
  f = filamentDependencies(from({ filament_retraction_length: '0' }), k2)
  check('retraction overrides greyed at 0 length', f.disabled.has('filament_retraction_speed') && !f.disabled.has('filament_retraction_length'))
  f = filamentDependencies(from({}), k2)
  check('retraction overrides enabled when inheriting', !f.disabled.has('filament_retraction_speed') && f.hidden.has('filament_long_retractions_when_cut'))
  return fails
}
