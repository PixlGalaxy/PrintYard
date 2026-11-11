# PrintYard locales

Every translation lives here, one folder per language:

| File | Used by | Contents |
|---|---|---|
| `<lang>/ui.json` | frontend (`src/i18n/translations.ts`) | Interface strings. `en/ui.json` is the reference: a key missing from another language fails `tsc`. |
| `<lang>/notifications.json` | backend (`modules/notifications/i18n.ts`) | Discord / Telegram / ntfy / webhook / push messages. Bodies are `{placeholder}` templates. |
| `<lang>/slicer.json` | backend (`modules/profiles/i18n.ts`) | Creality Print option texts (see below). |

To add a language, copy the `en/` folder, translate it, and register the code in `frontend/src/i18n/translations.ts`
and the backend `Language` type.

## Creality Print option texts (`slicer.json`)

`en/slicer.json` holds the English tooltips and enum labels from Creality Print's `PrintConfig.cpp`.
`<lang>/slicer.json` (other languages) maps Creality Print's English option strings (gettext msgids from `src/libslic3r/PrintConfig.cpp` and
`src/slic3r/GUI/Tab.cpp`) to the translation in Creality Print v7.3.1 `localization/i18n/<lang>/CrealityPrint_<lang>.po`.
Only the strings PrintYard shows are kept (option labels, tooltips, enum labels, categories, page and group names).
Regenerate with `cd backend && node scripts/build-i18n.mjs <CrealityPrint clone> es` (the clone is only read).

License: AGPL-3.0. Strings © Shenzhen Creality 3D Technology Co., Ltd. and the Creality Print / OrcaSlicer /
Bambu Studio / PrusaSlicer translators; redistributed under the same terms as part of PrintYard (AGPL-3.0-only).
