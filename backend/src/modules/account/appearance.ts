import type { AppContext } from '../../context.js';
import type { User } from '../../types.js';

/** Global defaults every user without an explicit choice follows. */
export function appearanceDefaults(ctx: Pick<AppContext, 'settings'>) {
  return {
    defaultMode: ctx.settings.get('appearance.defaultMode'),
    defaultSkin: ctx.settings.get('appearance.defaultSkin'),
  };
}

/** Adds effectiveThemeMode/effectiveSkin (user choice → admin default) for the signed-in user's own responses. */
export function withEffectiveAppearance(ctx: Pick<AppContext, 'settings'>, user: User): User {
  const d = appearanceDefaults(ctx);
  return { ...user, effectiveThemeMode: user.themeMode ?? d.defaultMode, effectiveSkin: user.skin ?? d.defaultSkin };
}
