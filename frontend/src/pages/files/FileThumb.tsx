import { Box, FileCode2, FolderKanban } from 'lucide-react'
import { useState } from 'react'
import type { FileKind, LibraryFile } from '../../types'
import { useThumbUrl } from '../../workspace/thumbnails'

const KIND_STYLE: Record<FileKind, { icon: typeof Box; cls: string }> = {
  model: { icon: Box, cls: 'bg-sky-500/10 text-sky-500' },
  project: { icon: FolderKanban, cls: 'bg-violet-500/10 text-violet-500' },
  gcode: { icon: FileCode2, cls: 'bg-emerald-500/10 text-emerald-500' },
}

export function KindIcon({ kind, size = 18 }: { kind: FileKind; size?: number }) {
  const { icon: Icon } = KIND_STYLE[kind]
  return <Icon size={size} />
}

/** Thumbnail with a kind icon fallback (missing or broken image). */
export default function FileThumb({ file, className = '', iconSize = 26 }: { file: LibraryFile; className?: string; iconSize?: number }) {
  // `thumbnailUrl`, or one rendered by the client in this session (models)
  const url = useThumbUrl(file)
  const [broken, setBroken] = useState<string | null>(null)
  const { icon: Icon, cls } = KIND_STYLE[file.kind]
  if (url && broken !== url) {
    return <img src={url} alt="" loading="lazy" draggable={false} onError={() => setBroken(url)} className={`${file.kind === 'model' ? 'object-contain p-1.5' : 'object-cover'} ${className}`} />
  }
  return (
    <span className={`flex items-center justify-center ${cls} ${className}`}>
      <Icon size={iconSize} />
    </span>
  )
}
