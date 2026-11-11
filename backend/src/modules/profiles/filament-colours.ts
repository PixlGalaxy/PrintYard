// Default colours of the official filament presets. Creality's K2 SE filament JSON ship `default_filament_colour: ""`
// (every one of them in Creality Print 7.3.1), so a slot, a new custom filament or the preset list had no colour and
// each screen fell back to its own grey/blue. PrintYard fills the empty value with the first official colour the
// printer lists for that filament (`retMaterials[].base.colors[0]`, K2 SE firmware 2.3.6.57), else white.

/** Colour used when a filament's colour is unknown (also the frontend's fallback). */
export const FALLBACK_FILAMENT_COLOUR = '#FFFFFF';

/** Filament family ("Hyper PLA") → first official colour, from the K2 SE's own material list. */
export const OFFICIAL_FILAMENT_COLOURS: Readonly<Record<string, string>> = {
  'Hyper PLA': '#C12E1F',
  'Hyper PLA-CF': '#000000',
  'Hyper PETG': '#FFFFFF',
  'Hyper ABS': '#FFFFFF',
  'Hyper Stardust': '#A1877F',
  'Hyper Marble': '#D14124',
  'CR-PLA': '#555685',
  'CR-Silk': '#FFC947',
  'CR-PETG': '#FFFFFF',
  'CR-ABS': '#FFFFFF',
  'Soleyin Ultra PLA': '#D9B8F1',
  'HP-TPU': '#FFFFFF',
  'HP-ASA': '#FFFFFF',
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/** `#RRGGBB` (upper case) when `v` is one (quotes stripped), else null. */
export function hexColour(v: string | undefined | null): string | null {
  const s = (v ?? '').trim().replace(/^"+|"+$/g, '').trim();
  return HEX.test(s) ? s.toUpperCase() : null;
}

/** Default colour of a system filament preset ("Hyper PLA @Creality K2 SE 0.4 nozzle") whose own colour is empty. */
export function defaultFilamentColour(presetName: string): string {
  const family = (presetName.includes('@') ? presetName.slice(0, presetName.lastIndexOf('@')) : presetName).trim();
  return OFFICIAL_FILAMENT_COLOURS[family] ?? FALLBACK_FILAMENT_COLOUR;
}
