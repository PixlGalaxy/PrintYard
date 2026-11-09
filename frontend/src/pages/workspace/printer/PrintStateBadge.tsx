import { Badge } from '../../../components/ui'
import { useI18n } from '../../../i18n/I18nContext'
import type { PrintRequestState } from '../../../types'

const TONES: Record<PrintRequestState, 'sky' | 'emerald' | 'amber' | 'red' | 'zinc' | 'violet'> = {
  pending: 'amber',
  approved: 'violet',
  rejected: 'red',
  uploading: 'sky',
  printing: 'sky',
  done: 'emerald',
  failed: 'red',
  cancelled: 'zinc',
}

export function PrintStateBadge({ state }: { state: PrintRequestState }) {
  const { t } = useI18n()
  return <Badge tone={TONES[state]}>{t(`prints.state.${state}`)}</Badge>
}
