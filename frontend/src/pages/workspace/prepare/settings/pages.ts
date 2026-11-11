// Setting page order and labels of the process and filament tabs (shared by Prepare and the Profiles tab).
import type { TranslationKey } from '../../../../i18n/translations'
import type { OptionDef } from '../../../../types'

export const PROCESS_PAGE_ORDER = ['Quality', 'Strength', 'Speed', 'Support', 'Multimaterial', 'Others']

export const PROCESS_PAGE_KEYS: Record<string, TranslationKey> = {
  Quality: 'slice.page.quality',
  Strength: 'slice.page.strength',
  Speed: 'slice.page.speed',
  Support: 'slice.page.support',
  Multimaterial: 'slice.page.multimaterial',
  Others: 'slice.page.others',
}

export const FILAMENT_PAGE_KEYS: Record<string, TranslationKey> = {
  Filament: 'workspace.filSet.page.filament',
  Cooling: 'workspace.filSet.page.cooling',
  'Setting Overrides': 'workspace.filSet.page.overrides',
  Advanced: 'workspace.filSet.page.advanced',
  Multimaterial: 'slice.page.multimaterial',
  Notes: 'workspace.filSet.page.notes',
}

/** Filament page whose rows override the printer's retraction values (`nil` = use the printer's) */
export const OVERRIDE_PAGE = 'Setting Overrides'

const BED_KEY = /^(\w+?_plate)_temp(_initial_layer)?$/

/** true when a filament settings group is the bed temperature group (rendered as BedTempTable) */
export const isBedGroup = (opts: OptionDef[]) => opts.length > 0 && opts.every((o) => BED_KEY.test(o.key))
