import { useState } from 'react'
import { useToast } from '../../../context/ToastContext'
import { useI18n } from '../../../i18n/I18nContext'
import { downloadProject, ProjectError, saveProject } from '../../../workspace/projects'
import { workspace } from '../../../workspace/store'
import { setUi } from './uiState'

/** Save with a toast; asks for a name the first time. */
export function useProjectActions() {
  const { t, errorMessage } = useI18n()
  const { toast } = useToast()
  const [busy, setBusy] = useState<'save' | 'download' | null>(null)

  const report = (err: unknown) => toast('error', err instanceof ProjectError ? t('workspace.project.waitUploads') : errorMessage(err))

  const save = async (name?: string) => {
    if (busy) return
    if (!name && !workspace.state.project.name.trim()) {
      setUi({ saveAs: true })
      return
    }
    setBusy('save')
    try {
      const f = await saveProject(name)
      toast('success', t('workspace.project.saved', { name: f.name.replace(/\.3mf$/i, '') }))
    } catch (err) {
      report(err)
      throw err
    } finally {
      setBusy(null)
    }
  }

  const download = async () => {
    if (busy) return
    if (!workspace.state.project.name.trim() && !workspace.state.project.fileId) {
      setUi({ saveAs: true })
      return
    }
    setBusy('download')
    try {
      await downloadProject()
    } catch (err) {
      report(err)
    } finally {
      setBusy(null)
    }
  }
  return { save, download, busy }
}

