import { FolderInput, Gauge, KeyRound, Pencil, Trash2, UserPlus, Users } from 'lucide-react'
import { useState } from 'react'
import { adminApi } from '../../api'
import ConfirmModal from '../../components/ConfirmModal'
import { Avatar } from '../../components/Header'
import { tdCls, thCls } from '../../components/styles'
import { Badge, Button, Empty, ErrorState, IconButton, Loading, RadioCard } from '../../components/ui'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import { timeAgo } from '../../format'
import { useLoader } from '../../hooks'
import { useI18n } from '../../i18n/I18nContext'
import { LANGUAGE_NAMES } from '../../i18n/translations'
import type { AdminUser } from '../../types'
import { Panel } from './shared'
import { LimitsModal, ResetPasswordModal, UserFormModal } from './UserModals'

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; user: AdminUser }
  | { kind: 'limits'; user: AdminUser }
  | { kind: 'password'; user: AdminUser }
  | { kind: 'delete'; user: AdminUser }

export default function UsersSection() {
  const { t, formatDate } = useI18n()
  const { user: me } = useAuth()
  const { toast } = useToast()
  const { data: users, error, reload, setData } = useLoader(adminApi.users)
  const [dialog, setDialog] = useState<Dialog | null>(null)

  const replace = (u: AdminUser) => setData((list) => (list ? list.map((x) => (x.id === u.id ? u : x)) : list))

  return (
    <>
      <Panel
        flush
        title={t('users.title')}
        description={t('users.desc')}
        icon={<Users size={18} />}
        actions={
          <Button variant="primary" icon={<UserPlus size={14} />} onClick={() => setDialog({ kind: 'create' })}>
            {t('users.create')}
          </Button>
        }
      >
        {error && !users ? (
          <ErrorState error={error} onRetry={() => void reload()} />
        ) : !users ? (
          <Loading />
        ) : users.length === 0 ? (
          <Empty icon={<Users size={20} />}>{t('users.empty')}</Empty>
        ) : (
          <div className="overflow-x-auto px-4 sm:px-5">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className={`${thCls} pt-3`}>{t('users.username')}</th>
                  <th className={`${thCls} pt-3`}>{t('users.role')}</th>
                  <th className={`${thCls} pt-3`}>{t('users.status')}</th>
                  <th className={`${thCls} pt-3`}>{t('users.limits')}</th>
                  <th className={`${thCls} pt-3`}>{t('users.lastLogin')}</th>
                  <th className={`${thCls} pt-3`}>
                    <span className="sr-only">{t('common.edit')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {users.map((u) => {
                  const self = u.id === me?.id
                  return (
                    <tr key={u.id} className={u.isActive ? '' : 'opacity-60'}>
                      <td className={tdCls}>
                        <div className="flex items-center gap-2.5">
                          <Avatar user={u} size={30} />
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 font-medium">
                              {u.username}
                              {self && <Badge tone="sky">{t('users.you')}</Badge>}
                            </p>
                            <p className="truncate text-xs text-muted">
                              {u.email ?? '—'} · {LANGUAGE_NAMES[u.language] ?? u.language}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className={tdCls}>
                        <Badge tone={u.role === 'admin' ? 'violet' : 'zinc'}>{t(u.role === 'admin' ? 'role.admin' : 'role.user')}</Badge>
                      </td>
                      <td className={tdCls}>
                        <span className="flex flex-wrap gap-1">
                          <Badge tone={u.isActive ? 'emerald' : 'red'}>{t(u.isActive ? 'users.active' : 'users.inactive')}</Badge>
                          {u.role !== 'admin' && u.canPrintUploadedGcode && (
                            <Badge tone="amber">
                              {t('users.uploadedGcodeBadge')}
                            </Badge>
                          )}
                          {u.role !== 'admin' && u.canControlPrinter && <Badge tone="sky">{t('users.controlBadge')}</Badge>}
                        </span>
                      </td>
                      <td className={tdCls}>
                        <button
                          type="button"
                          onClick={() => setDialog({ kind: 'limits', user: u })}
                          className="rounded-full focus-visible:outline-2 focus-visible:outline-sky-500"
                          title={t('users.editLimits')}
                        >
                          <Badge tone={u.limits.enabled ? 'amber' : 'zinc'}>{t(u.limits.enabled ? 'users.limitsOn' : 'users.noLimits')}</Badge>
                        </button>
                      </td>
                      <td className={`${tdCls} text-muted`} title={u.lastLoginAt ? formatDate(u.lastLoginAt) : undefined}>
                        {timeAgo(t, u.lastLoginAt)}
                      </td>
                      <td className={`${tdCls} pr-0 text-right`}>
                        <div className="inline-flex items-center">
                          <IconButton label={t('common.edit')} onClick={() => setDialog({ kind: 'edit', user: u })}>
                            <Pencil size={15} />
                          </IconButton>
                          <IconButton label={t('users.editLimits')} onClick={() => setDialog({ kind: 'limits', user: u })}>
                            <Gauge size={15} />
                          </IconButton>
                          <IconButton label={t('users.resetPassword')} tone="warning" onClick={() => setDialog({ kind: 'password', user: u })}>
                            <KeyRound size={15} />
                          </IconButton>
                          <IconButton
                            label={t('common.delete')}
                            tone="danger"
                            disabled={self}
                            title={self ? t('users.selfNote') : t('common.delete')}
                            onClick={() => setDialog({ kind: 'delete', user: u })}
                          >
                            <Trash2 size={15} />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {dialog?.kind === 'create' && (
        <UserFormModal
          onClose={() => setDialog(null)}
          onSaved={(u) => {
            setData((list) => (list ? [...list, u] : [u]))
            toast('success', t('users.created', { name: u.username }))
          }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <UserFormModal
          user={dialog.user}
          self={dialog.user.id === me?.id}
          onClose={() => setDialog(null)}
          onSaved={(u) => {
            replace(u)
            toast('success', t('users.updated', { name: u.username }))
          }}
        />
      )}
      {dialog?.kind === 'limits' && (
        <LimitsModal
          user={dialog.user}
          onClose={() => setDialog(null)}
          onSaved={(u) => {
            replace(u)
            toast('success', t('limits.saved', { name: u.username }))
          }}
        />
      )}
      {dialog?.kind === 'password' && (
        <ResetPasswordModal
          user={dialog.user}
          onClose={() => setDialog(null)}
          onSaved={() => toast('success', t('users.passwordReset', { name: dialog.user.username }))}
        />
      )}
      {dialog?.kind === 'delete' && <DeleteUserDialog user={dialog.user} me={me?.username ?? ''} onClose={() => setDialog(null)} onDeleted={(id) => setData((list) => (list ? list.filter((x) => x.id !== id) : list))} />}
    </>
  )
}

/** Delete a user, choosing what happens to their library (the server requires the choice). */
function DeleteUserDialog({ user, me, onClose, onDeleted }: { user: AdminUser; me: string; onClose: () => void; onDeleted: (id: number) => void }) {
  const { t } = useI18n()
  const { toast, onError } = useToast()
  const [files, setFiles] = useState<'transfer' | 'delete'>('transfer')
  return (
    <ConfirmModal
      title={t('users.deleteTitle')}
      confirmLabel={t(files === 'delete' ? 'users.deleteWithFiles' : 'users.deleteKeepFiles')}
      onClose={onClose}
      onConfirm={async () => {
        try {
          await adminApi.deleteUser(user.id, files)
          onDeleted(user.id)
          toast('success', t(files === 'delete' ? 'users.deleted' : 'users.deletedTransferred', { name: user.username, me }))
        } catch (err) {
          onError(err)
          throw err
        }
      }}
    >
      <p>{t('users.deleteText', { name: user.username })}</p>
      <fieldset className="mt-4 space-y-2">
        <legend className="mb-2 text-sm font-medium text-fg">{t('users.deleteFilesQuestion', { name: user.username })}</legend>
        <RadioCard
          name="delete-files"
          checked={files === 'transfer'}
          onChange={() => setFiles('transfer')}
          icon={<FolderInput size={17} />}
          title={t('users.filesTransfer')}
          description={t('users.filesTransferDesc', { me })}
        />
        <RadioCard
          name="delete-files"
          checked={files === 'delete'}
          onChange={() => setFiles('delete')}
          icon={<Trash2 size={17} />}
          title={t('users.filesDelete')}
          description={t('users.filesDeleteDesc')}
        />
      </fieldset>
    </ConfirmModal>
  )
}
