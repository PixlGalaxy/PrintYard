import { Camera, ImageUp, Trash2 } from 'lucide-react'
import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import { api } from '../../api'
import { setDirectoryAvatar } from '../../avatars'
import Avatar from '../../components/Avatar'
import AvatarCropModal from '../../components/AvatarCropModal'
import { Button } from '../../components/ui'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import { useI18n } from '../../i18n/I18nContext'
import type { User } from '../../types'

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_BYTES = 5 * 1024 * 1024

/** Profile picture: current avatar (drop target), "Upload photo" → crop dialog → upload, "Remove photo". */
export default function AvatarEditor({ user, children }: { user: User; children?: ReactNode }) {
  const { setUser } = useAuth()
  const { t } = useI18n()
  const { toast, onError } = useToast()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [over, setOver] = useState(false)
  const [removing, setRemoving] = useState(false)

  function pick(f: File | undefined) {
    if (!f) return
    if (!ACCEPT.includes(f.type)) return toast('error', t('avatar.badType'))
    if (f.size > MAX_BYTES) return toast('error', t('errors.avatar.too_large'))
    setFile(f)
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setOver(false)
    pick(e.dataTransfer.files[0])
  }

  async function upload(blob: Blob) {
    try {
      const { user: next } = await api.uploadAvatar(blob)
      setUser(next)
      setDirectoryAvatar(next.id, next.avatarUrl)
      setFile(null)
      toast('success', t('avatar.updated'))
    } catch (err) {
      onError(err)
    }
  }

  async function remove() {
    setRemoving(true)
    try {
      const { user: next } = await api.removeAvatar()
      setUser(next)
      setDirectoryAvatar(next.id, null)
      toast('success', t('avatar.removed'))
    } catch (err) {
      onError(err)
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        aria-label={t('avatar.upload')}
        title={t('avatar.dropHint')}
        className={`group relative size-20 shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 ${
          over ? 'ring-4 ring-accent-500/60 ring-offset-2 ring-offset-surface' : ''
        }`}
      >
        <Avatar user={user} size={80} />
        <span
          className={`absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white transition-opacity ${
            over ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
          }`}
        >
          <Camera size={22} />
        </span>
      </button>
      <div className="min-w-0 flex-1 space-y-2.5">
        {children}
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<ImageUp size={16} />} onClick={() => input.current?.click()}>
            {t('avatar.upload')}
          </Button>
          {user.avatarUrl && (
            <Button variant="ghost" icon={<Trash2 size={16} />} onClick={() => void remove()} loading={removing}>
              {t('avatar.remove')}
            </Button>
          )}
          <span className="text-xs text-muted">{t('avatar.hint')}</span>
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept={ACCEPT.join(',')}
        className="hidden"
        onChange={(e) => {
          pick(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      {file && <AvatarCropModal file={file} onCancel={() => setFile(null)} onConfirm={upload} />}
    </div>
  )
}
