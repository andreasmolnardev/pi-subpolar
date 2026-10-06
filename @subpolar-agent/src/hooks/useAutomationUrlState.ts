import { useCallback, useMemo } from 'react'
import { useUrlParams } from './useUrlParams'

export type AutomationTab = 'jobs' | 'detail' | 'runs' | 'prompts'
export type AutomationDialog = 'new' | 'edit' | 'delete' | null
export type PromptDialog = 'new' | 'edit' | 'delete' | 'import' | null
export type AutomationId = number | string

export interface UseAutomationUrlStateReturn {
  automationTab: AutomationTab
  setAutomationTab: (t: AutomationTab) => void
  dialog: AutomationDialog
  promptDialog: PromptDialog
  jobId: AutomationId | null
  runId: AutomationId | null
  templateId: AutomationId | null
  openNewJob: () => void
  openEditJob: (jobId: AutomationId) => void
  openDeleteJob: (jobId: AutomationId) => void
  openNewTemplate: () => void
  openEditTemplate: (templateId: AutomationId) => void
  openDeleteTemplate: (templateId: AutomationId) => void
  openImportTemplate: () => void
  closeDialog: () => void
  closePromptDialog: () => void
  selectRun: (runId: AutomationId | null) => void
  selectJobAndView: (jobId: AutomationId) => void
  selectJobAndCloseDialog: (jobId: AutomationId) => void
  replaceUrlParams: (updater: (params: URLSearchParams) => void) => void
}

function parseNullableIdentifier(value: string | null): AutomationId | null {
  if (value === null || value === '') return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : value
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

  const jobId = useMemo<AutomationId | null>(() => parseNullableIdentifier(searchParams.get('jobId')), [searchParams])
  const runId = useMemo<AutomationId | null>(() => parseNullableIdentifier(searchParams.get('runId')), [searchParams])
  const templateId = useMemo<AutomationId | null>(() => parseNullableIdentifier(searchParams.get('templateId')), [searchParams])

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
    entityId: AutomationId | null,
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

  const openEditJob = useCallback((id: AutomationId) => {
    openEntityDialog('automationDialog', 'edit', 'jobId', id)
  }, [openEntityDialog])

  const openDeleteJob = useCallback((id: AutomationId) => {
    openEntityDialog('automationDialog', 'delete', 'jobId', id)
  }, [openEntityDialog])

  const openNewTemplate = useCallback(() => {
    openEntityDialog('promptDialog', 'new', 'templateId', null)
  }, [openEntityDialog])

  const openEditTemplate = useCallback((id: AutomationId) => {
    openEntityDialog('promptDialog', 'edit', 'templateId', id)
  }, [openEntityDialog])

  const openDeleteTemplate = useCallback((id: AutomationId) => {
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

  const selectRun = useCallback((id: AutomationId | null) => {
    replaceUrlParams((p) => {
      if (id === null) {
        p.delete('runId')
      } else {
        p.set('runId', String(id))
      }
    })
  }, [replaceUrlParams])

  const selectJobAndView = useCallback((id: AutomationId) => {
    replaceUrlParams((p) => {
      p.set('jobId', String(id))
      p.set('automationTab', 'detail')
    })
  }, [replaceUrlParams])

  const selectJobAndCloseDialog = useCallback((id: AutomationId) => {
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
