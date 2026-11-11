import { Camera, Pencil, Plus, Trash2 } from 'lucide-react'
import { PrinterLayers, PrinterModelIcon } from '../../components/printerIcons'
import { useEffect, useState, type FormEvent } from 'react'
import { adminApi, api } from '../../api'
import ConfirmModal from '../../components/ConfirmModal'
import Modal from '../../components/Modal'
import PrinterForm from '../../components/PrinterForm'
import { tdCls, thCls } from '../../components/styles'
import { Badge, Button, Chip, Empty, ErrorState, IconButton, Loading } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { printerModelName, timeAgo } from '../../format'
import { useLoader } from '../../hooks'
import { useI18n } from '../../i18n/I18nContext'
import type { Printer, PrinterModelInfo } from '../../types'
import { printerInput, validatePrinter, type PrinterDraft } from '../../validation'
import BedSurfacesPanel from './BedSurfacesPanel'
import PrinterRetentionPanel from './PrinterRetentionPanel'
import { Panel } from './shared'

type Dialog = { kind: 'create' } | { kind: 'edit'; printer: Printer } | { kind: 'delete'; printer: Printer }

export default function PrintersSection() {
  const { t } = useI18n()
  const { toast, onError } = useToast()
  const { data: printers, error, reload, setData } = useLoader(adminApi.printers)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [models, setModels] = useState<PrinterModelInfo[]>([])
  const [hostNetworkLikely, setHostNetworkLikely] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    api.printerModels().then(setModels, () => undefined)
    api.setupStatus().then((s) => setHostNetworkLikely(s.hostNetworkLikely), () => undefined)
  }, [])

  return (
    <div className="space-y-5">
      <Panel
        flush
        title={t('printers.title')}
        description={t('printers.desc')}
        icon={<PrinterModelIcon size={18} kinematics={printers?.[0]?.kinematics} model={printers?.[0]?.model} />}
        actions={
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setDialog({ kind: 'create' })}>
            {t('printers.add')}
          </Button>
        }
      >
        {error && !printers ? (
          <ErrorState error={error} onRetry={() => void reload()} />
        ) : !printers ? (
          <Loading />
        ) : printers.length === 0 ? (
          <Empty icon={<PrinterLayers size={20} />}>{t('printers.empty')}</Empty>
        ) : (
          <div className="relative overflow-x-auto px-4 sm:px-5">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className={`${thCls} pt-3`}>{t('printer.name')}</th>
                  <th className={`${thCls} pt-3`}>{t('printer.host')}</th>
                  <th className={`${thCls} pt-3`}>{t('printer.mac')}</th>
                  <th className={`${thCls} pt-3`}>{t('printer.lastSeen')}</th>
                  <th className={`${thCls} pt-3`}>
                    <span className="sr-only">{t('common.edit')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {printers.map((p) => (
                  <tr key={p.id}>
                    <td className={tdCls}>
                      <p className="font-medium">{p.name}</p>
                      <p className="text-xs text-muted">
                        {printerModelName(p.model)}
                        {p.firmware && <span className="font-mono"> · {p.firmware}</span>}
                      </p>
                    </td>
                    <td className={tdCls}>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{p.host}</span>
                        <Badge tone={p.staticIp ? 'sky' : 'violet'}>{t(p.staticIp ? 'printer.static' : 'printer.dynamic')}</Badge>
                      </div>
                    </td>
                    <td className={tdCls}>{p.mac ? <Chip>{p.mac}</Chip> : <span className="text-muted">—</span>}</td>
                    <td className={`${tdCls} text-muted`}>{timeAgo(t, p.lastSeenAt)}</td>
                    <td className={`${tdCls} pr-0 text-right`}>
                      <div className="inline-flex">
                        <IconButton label={t('common.edit')} onClick={() => setDialog({ kind: 'edit', printer: p })}>
                          <Pencil size={16} />
                        </IconButton>
                        <IconButton label={t('common.delete')} tone="danger" onClick={() => setDialog({ kind: 'delete', printer: p })}>
                          <Trash2 size={16} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {printers && <BedSurfacesPanel printers={printers} onSaved={(p) => setData((list) => (list ?? []).map((x) => (x.id === p.id ? p : x)))} />}

      <PrinterRetentionPanel />

      <Panel title={t('printers.camera')} description={t('printers.cameraDesc')} icon={<Camera size={18} />} actions={<Badge tone="sky">{t('common.comingSoon')}</Badge>}>
        <p className="text-sm text-muted">{t('printers.cameraSoon')}</p>
      </Panel>

      {(dialog?.kind === 'create' || dialog?.kind === 'edit') && (
        <PrinterModal
          printer={dialog.kind === 'edit' ? dialog.printer : undefined}
          models={models}
          hostNetworkLikely={hostNetworkLikely}
          onClose={() => setDialog(null)}
          onSaved={(p, created) => {
            setData((list) => (created ? [...(list ?? []), p] : (list ?? []).map((x) => (x.id === p.id ? p : x))))
            toast('success', t(created ? 'printers.created' : 'printers.updated', { name: p.name }))
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmModal
          title={t('printers.deleteTitle')}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const p = dialog.printer
            try {
              await adminApi.deletePrinter(p.id)
              setData((list) => (list ?? []).filter((x) => x.id !== p.id))
              toast('success', t('printers.deleted', { name: p.name }))
            } catch (err) {
              onError(err)
              throw err
            }
          }}
        >
          {t('printers.deleteText', { name: dialog.printer.name })}
        </ConfirmModal>
      )}
    </div>
  )
}

function PrinterModal({
  printer,
  models,
  hostNetworkLikely,
  onClose,
  onSaved,
}: {
  printer?: Printer
  models: PrinterModelInfo[]
  hostNetworkLikely?: boolean
  onClose: () => void
  onSaved: (printer: Printer, created: boolean) => void
}) {
  const { t } = useI18n()
  const { onError } = useToast()
  const [draft, setDraft] = useState<PrinterDraft>({
    name: printer?.name ?? 'K2 SE',
    model: printer?.model ?? 'creality-k2se',
    host: printer?.host ?? '',
    staticIp: printer?.staticIp ?? true,
    mac: printer?.mac ?? '',
  })
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const errors = validatePrinter(draft)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (Object.keys(errors).length) return
    setSaving(true)
    try {
      const body = printerInput(draft)
      const saved = printer ? await adminApi.updatePrinter(printer.id, body) : await adminApi.createPrinter(body)
      onSaved(saved, !printer)
      onClose()
    } catch (err) {
      onError(err)
      setSaving(false)
    }
  }

  return (
    <Modal
      title={printer ? t('printers.editTitle', { name: printer.name }) : t('printers.addTitle')}
      icon={<PrinterModelIcon size={18} kinematics={printer?.kinematics ?? models.find((m) => m.id === draft.model)?.kinematics} model={draft.model} />}
      onClose={onClose}
      dismissable={!saving}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="printer-form" variant="primary" loading={saving}>
            {printer ? t('common.saveChanges') : t('common.add')}
          </Button>
        </>
      }
    >
      <form id="printer-form" onSubmit={submit} noValidate>
        <PrinterForm
          value={draft}
          onChange={setDraft}
          models={models}
          errors={touched ? errors : {}}
          hostNetworkLikely={hostNetworkLikely}
          onTest={adminApi.testPrinter}
        />
      </form>
    </Modal>
  )
}
