import { Palette } from 'lucide-react'
import { useEffect } from 'react'
import { ModePicker, SkinGrid } from '../../components/AppearancePicker'
import { SettingRow } from '../../components/Card'
import { useTheme } from '../../context/ThemeContext'
import { useI18n } from '../../i18n/I18nContext'
import { DEFAULT_MODE, DEFAULT_SKIN, isSkin, isThemeMode } from '../../theme/skins'
import type { Settings } from '../../types'
import { Panel } from './shared'

interface SettingsDraft {
  saved: Settings | null | undefined
  value: <K extends keyof Settings>(key: K) => Settings[K] | undefined
  set: <K extends keyof Settings>(key: K, v: Settings[K]) => void
}

/** Admin → Settings → Appearance: default mode + accent skin for everyone who has not picked their own. */
export default function AppearanceSettingsPanel({ s }: { s: SettingsDraft }) {
  const { t } = useI18n()
  const { setDefaults } = useTheme()
  const mode = s.value('appearance.defaultMode') ?? DEFAULT_MODE
  const skin = s.value('appearance.defaultSkin') ?? DEFAULT_SKIN

  // Once saved, this tab follows the new defaults immediately (other tabs get the realtime push)
  const savedMode = s.saved?.['appearance.defaultMode']
  const savedSkin = s.saved?.['appearance.defaultSkin']
  useEffect(() => {
    if (isThemeMode(savedMode) && isSkin(savedSkin)) setDefaults({ defaultMode: savedMode, defaultSkin: savedSkin })
  }, [savedMode, savedSkin, setDefaults])

  return (
    <Panel title={t('appearance.adminTitle')} description={t('appearance.adminDesc')} icon={<Palette size={18} />}>
      <SettingRow label={t('appearance.defaultMode')} description={t('appearance.defaultModeHint')}>
        <ModePicker value={mode} onChange={(v) => v !== 'default' && s.set('appearance.defaultMode', v)} />
      </SettingRow>
      <div className="space-y-3">
        <div>
          <div className="text-sm font-medium">{t('appearance.defaultSkin')}</div>
          <div className="text-xs text-muted">{t('appearance.defaultSkinHint')}</div>
        </div>
        <SkinGrid value={skin} onChange={(v) => v !== 'default' && s.set('appearance.defaultSkin', v)} />
      </div>
    </Panel>
  )
}
