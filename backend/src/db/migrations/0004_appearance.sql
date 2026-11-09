-- Appearance (theme mode + accent skin). NULL = follow the admin default (settings appearance.defaultMode/defaultSkin).
-- The legacy `theme` column stays (NOT NULL, kept in sync as theme_mode ?? 'system') for backward compatibility.
ALTER TABLE users ADD COLUMN theme_mode TEXT CHECK (theme_mode IS NULL OR theme_mode IN ('system','light','dark'));
ALTER TABLE users ADD COLUMN skin TEXT;

-- 'system' was the old column default, so it is treated as "never chosen" (inherit); light/dark were explicit.
UPDATE users SET theme_mode = theme WHERE theme IN ('light','dark');
