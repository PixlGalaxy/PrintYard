import { useState } from 'react'
import { useAvatarDirectory } from '../avatars'

export interface AvatarUser {
  id?: number | null
  username: string | null
  /** `undefined` = unknown here (prints, audit…): looked up by `id` in the avatar directory. */
  avatarUrl?: string | null
}

/** Initials (1–2 letters) of a username: "maria" → "M", "jorge.lopez" / "Jorge Lopez" → "JL". */
function initials(name: string | null): string {
  if (!name) return '?'
  const parts = name.split(/[\s._-]+/).filter(Boolean)
  const letters = parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 1)
  return letters.toUpperCase()
}

/** Profile picture, or the user's initials on the accent skin gradient. */
export default function Avatar({ user, size = 28, className = '' }: { user: AvatarUser; size?: number; className?: string }) {
  const lookup = user.avatarUrl === undefined && user.id != null
  const dir = useAvatarDirectory(lookup)
  const url = lookup ? (dir?.[String(user.id)] ?? null) : (user.avatarUrl ?? null)
  const [failed, setFailed] = useState<string | null>(null)

  if (url && failed !== url) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        draggable={false}
        onError={() => setFailed(url)}
        style={{ width: size, height: size }}
        className={`shrink-0 rounded-full bg-surface-2 object-cover ${className}`}
      />
    )
  }
  const text = initials(user.username)
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * (text.length > 1 ? 0.36 : 0.42)) }}
      className={`flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent-400 to-accent-600 font-semibold text-white uppercase select-none ${className}`}
    >
      {text}
    </span>
  )
}
