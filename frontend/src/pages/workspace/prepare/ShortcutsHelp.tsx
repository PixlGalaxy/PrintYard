import { Keyboard } from 'lucide-react'
import Modal from '../../../components/Modal'
import { useI18n } from '../../../i18n/I18nContext'
import type { TranslationKey } from '../../../i18n/translations'
import { Kbd } from './bits'
import { MOD } from './styles'

const GROUPS: { title: TranslationKey; items: [string[], TranslationKey][] }[] = [
  {
    title: 'workspace.shortcuts.tools',
    items: [
      [['Q', 'Esc'], 'workspace.tool.select'],
      [['T'], 'workspace.tool.move'],
      [['R'], 'workspace.tool.rotate'],
      [['S'], 'workspace.tool.scale'],
      [['F'], 'workspace.tool.layFace'],
      [['Shift'], 'workspace.shortcuts.snap'],
    ],
  },
  {
    title: 'workspace.shortcuts.objects',
    items: [
      [[MOD, 'I'], 'workspace.tool.import'],
      [[MOD, 'A'], 'workspace.shortcuts.selectAll'],
      [[MOD, 'D'], 'workspace.tool.duplicate'],
      [['Del'], 'workspace.tool.delete'],
      [['A'], 'workspace.tool.arrange'],
      [['O'], 'workspace.tool.orient'],
      [['C'], 'workspace.tool.center'],
      [['←', '→', '↑', '↓'], 'workspace.shortcuts.nudge'],
    ],
  },
  {
    title: 'workspace.shortcuts.view',
    items: [
      [['0'], 'workspace.view.iso'],
      [['1'], 'workspace.view.top'],
      [['2'], 'workspace.view.bottom'],
      [['3'], 'workspace.view.front'],
      [['4'], 'workspace.view.back'],
      [['5'], 'workspace.view.left'],
      [['6'], 'workspace.view.right'],
      [['Z'], 'workspace.view.fit'],
    ],
  },
  {
    title: 'workspace.shortcuts.project',
    items: [
      [[MOD, 'Z'], 'workspace.undo'],
      [[MOD, 'Y'], 'workspace.redo'],
      [[MOD, 'S'], 'workspace.project.save'],
      [[MOD, 'O'], 'workspace.project.open'],
      [[MOD, 'Enter'], 'workspace.shortcuts.slice'],
      [['?'], 'workspace.shortcuts.title'],
    ],
  },
]

export default function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  return (
    <Modal title={t('workspace.shortcuts.title')} subtitle={t('workspace.shortcuts.mouse')} icon={<Keyboard size={18} />} size="lg" onClose={onClose}>
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-muted uppercase">{t(g.title)}</h3>
            <ul className="space-y-1.5">
              {g.items.map(([keys, label]) => (
                <li key={label + keys.join()} className="flex items-center justify-between gap-3 text-sm">
                  <span>{t(label)}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  )
}
