import { useCallback, useMemo } from 'react'
import { useUrlParams } from './useUrlParams'

export type AutomationTab = 'jobs' | 'detail' | 'runs' | 'prompts'
export type AutomationDialog = 'new' | 'edit' | 'delete' | null
export type PromptDialog = 'new' | 'edit' | 'delete' | 'import' | null

export interface UseAutomationUrlStateReturn {
  automationTab: AutomationTab
  setAutomationTab: (t: AutomationTab) => void
  dialog: AutomationDialog
  promptDialog: PromptDialog
  jobId: number | null
  runId: number | null
  templateId: number | null
  openNewJob: () => void
  openEditJob: (jobId: number) => void
  openDeleteJob: (jobId: number) => void
  openNewTemplate: () => void
  openEditTemplate: (templateId: number) => void
  openDeleteTemplate: (templateId: number) => void
  openImportTemplate: () => void
  closeDialog: () => void
  closePromptDialog: () => void
  selectRun: (runId: number | null) => void
  selectJobAndView: (jobId: number) => void
  selectJobAndCloseDialog: (jobId: number) => void
  replaceUrlParams: (updater: (params: URLSearchParams) => void) => void
}

function parseNullableInt(value: string | null): number | null {
  if (value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function useAutomationUrlState(): UseAutomationUrlStateReturn {
  const { searchParams, updateParams } = useUrlParams()

  const automationTab = useMemo<AutomationTab>(() => {
    const tabParam = searchParams.get('automationTab')
    if (tabParam === 'detail' || tabParam === 'runs' || tabParam === 'prompts') {
      return tabParam
    }
    return 'jobs'
  }, [searchParams])

  const dialog = useMemo<AutomationDialog>(() => {
    const d = searchParams.get('automationDialog')
    if (d === 'new' || d === 'edit' || d === 'delete') {
      return d
    }
    return null
  }, [searchParams])

  const promptDialog = useMemo<PromptDialog>(() => {
    const d = searchParams.get('promptDialog')
    if (d === 'new' || d === 'edit' || d === 'delete' || d === 'import') {
      return d
    }
    return null
  }, [searchParams])

  const jobId = useMemo<number | null>(() => parseNullableInt(searchParams.get('jobId')), [searchParams])
  const runId = useMemo<number | null>(() => parseNullableInt(searchParams.get('runId')), [searchParams])
  const templateId = useMemo<number | null>(() => parseNullableInt(searchParams.get('templateId')), [searchParams])

  type AutomationDialogParam = 'automationDialog' | 'promptDialog'
  type AutomationEntityParam = 'jobId' | 'templateId'

  const replaceUrlParams = useCallback(
    (updater: (params: URLSearchParams) => void) => updateParams(updater, 'replace'),
    [updateParams],
  )

  const openEntityDialog = useCallback((
    dialogParam: AutomationDialogParam,
    dialogValue: Exclude<AutomationDialog, null> | Exclude<PromptDialog, null>,
    entityParam: AutomationEntityParam,
    entityId: number | null,
  ) => {
    const otherEntityParam = entityParam === 'jobId' ? 'templateId' : 'jobId'
    updateParams((p) => {
      p.set(dialogParam, dialogValue)
      p.delete(entityParam)
      p.delete(otherEntityParam)
      if (entityId !== null) {
        p.set(entityParam, String(entityId))
      }
    }, 'push')
  }, [updateParams])

  const setAutomationTab = useCallback((tab: AutomationTab) => {
    replaceUrlParams((p) => {
      if (tab === 'jobs') {
        p.delete('automationTab')
      } else {
        p.set('automationTab', tab)
      }
    })
  }, [replaceUrlParams])

  const openNewJob = useCallback(() => {
    openEntityDialog('automationDialog', 'new', 'jobId', null)
  }, [openEntityDialog])

  const openEditJob = useCallback((id: number) => {
    openEntityDialog('automationDialog', 'edit', 'jobId', id)
  }, [openEntityDialog])

  const openDeleteJob = useCallback((id: number) => {
    openEntityDialog('automationDialog', 'delete', 'jobId', id)
  }, [openEntityDialog])

  const openNewTemplate = useCallback(() => {
    openEntityDialog('promptDialog', 'new', 'templateId', null)
  }, [openEntityDialog])

  const openEditTemplate = useCallback((id: number) => {
    openEntityDialog('promptDialog', 'edit', 'templateId', id)
  }, [openEntityDialog])

  const openDeleteTemplate = useCallback((id: number) => {
    openEntityDialog('promptDialog', 'delete', 'templateId', id)
  }, [openEntityDialog])

  const openImportTemplate = useCallback(() => {
    openEntityDialog('promptDialog', 'import', 'templateId', null)
  }, [openEntityDialog])

  const closeDialog = useCallback(() => {
    replaceUrlParams((p) => {
      p.delete('automationDialog')
    })
  }, [replaceUrlParams])

  const closePromptDialog = useCallback(() => {
    replaceUrlParams((p) => {
      p.delete('promptDialog')
      p.delete('templateId')
    })
  }, [replaceUrlParams])

  const selectRun = useCallback((id: number | null) => {
    replaceUrlParams((p) => {
      if (id === null) {
        p.delete('runId')
      } else {
        p.set('runId', String(id))
      }
    })
  }, [replaceUrlParams])

  const selectJobAndView = useCallback((id: number) => {
    replaceUrlParams((p) => {
      p.set('jobId', String(id))
      p.set('automationTab', 'detail')
    })
  }, [replaceUrlParams])

  const selectJobAndCloseDialog = useCallback((id: number) => {
    replaceUrlParams((p) => {
      p.delete('automationDialog')
      p.set('jobId', String(id))
    })
  }, [replaceUrlParams])

  return {
    automationTab,
    setAutomationTab,
    dialog,
    promptDialog,
    jobId,
    runId,
    templateId,
    openNewJob,
    openEditJob,
    openDeleteJob,
    openNewTemplate,
    openEditTemplate,
    openDeleteTemplate,
    openImportTemplate,
    closeDialog,
    closePromptDialog,
    selectRun,
    selectJobAndView,
    selectJobAndCloseDialog,
    replaceUrlParams,
  }
}
