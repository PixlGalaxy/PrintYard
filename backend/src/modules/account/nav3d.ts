import { z } from 'zod';
import { NAV3D_BUTTONS, NAV3D_MODIFIERS, NAV3D_PRESETS, type Nav3dPrefs } from '../../types.js';

const binding = z.object({ button: z.enum(NAV3D_BUTTONS), modifier: z.enum(NAV3D_MODIFIERS) }).strict();
const same = (a: z.infer<typeof binding> | null, b: z.infer<typeof binding> | null) =>
  !!a && !!b && a.button === b.button && a.modifier === b.modifier;

/** Per-user 3D navigation preferences (`users.nav3d`, JSON). */
export const nav3dSchema = z
  .object({
    // `slicedock` was the default scheme's id before the rename
    preset: z.preprocess((v) => (v === 'slicedock' ? 'printyard' : v), z.enum(NAV3D_PRESETS)),
    custom: z
      .object({
        orbit: binding,
        pan: binding,
        zoom: binding.nullable(),
        zoomToCursor: z.boolean(),
      })
      .strict()
      .refine((c) => !same(c.orbit, c.pan) && !same(c.orbit, c.zoom) && !same(c.pan, c.zoom), {
        message: 'Orbit, pan and zoom need different mouse bindings',
      })
      .optional(),
    invertWheel: z.boolean().optional(),
    orbitSpeed: z.number().min(0.2).max(3).optional(),
    zoomSpeed: z.number().min(0.2).max(3).optional(),
    defaultView: z.enum(['iso', 'top', 'front']).optional(),
  })
  .strict()
  .refine((v) => v.preset !== 'custom' || v.custom !== undefined, { message: 'A custom preset needs a mapping', path: ['custom'] });

/** Stored JSON → prefs; anything unreadable is treated as "defaults" (null). */
export function parseNav3d(json: string | null | undefined): Nav3dPrefs | null {
  if (!json) return null;
  try {
    const r = nav3dSchema.safeParse(JSON.parse(json));
    return r.success ? (r.data as Nav3dPrefs) : null;
  } catch {
    return null;
  }
}
