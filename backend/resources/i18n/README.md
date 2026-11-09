# Creality Print option translations

`<lang>.json` maps Creality Print's English option strings (gettext msgids from `src/libslic3r/PrintConfig.cpp` and
`src/slic3r/GUI/Tab.cpp`) to the translation in Creality Print v7.3.1 `localization/i18n/<lang>/CrealityPrint_<lang>.po`.
Only the strings SliceDock shows are kept (option labels, tooltips, enum labels, categories, page and group names).
`../crealityprint-option-text.json` holds the English tooltips and enum labels from the same `PrintConfig.cpp`.

Regenerate with `node scripts/build-i18n.mjs <CrealityPrint clone> es` (the clone is only read).

License: AGPL-3.0. Strings © Shenzhen Creality 3D Technology Co., Ltd. and the Creality Print / OrcaSlicer /
Bambu Studio / PrusaSlicer translators; redistributed under the same terms as part of SliceDock (AGPL-3.0-only).
