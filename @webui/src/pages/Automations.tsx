import { useEffect, useMemo } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import type { CreateAutomationJobRequest, AutomationJob } from '@subpolar/shared/types'
import {
  useCancelRepoAutomationRun,
  useCreateRepoAutomation,
  useDeleteRepoAutomation,
  useRepoAutomation,
  useRepoAutomationRun,
  useRepoAutomationRuns,
  useRepoAutomations,
  useRunRepoAutomation,
  useUpdateRepoAutomation,
} from '@/hooks/useAutomations'
import { useProjectActivity } from '@/hooks/useProjectActivity'
import { useAutomationTarget } from '@/hooks/useAutomationTarget'
import { useAutomationUrlState } from '@/hooks/useAutomationUrlState'
import { AutomationJobDialog, JobsTab, JobDetailTab, RunHistoryTab, AutomationTabMenu } from '@/components/automations'
import { toUpdateautomationRequest } from '@/components/automations/automation-utils'
import { Header } from '@/components/ui/header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DeleteDialog } from '@/components/ui/delete-dialog'
import { getReturnToPath } from '@/lib/navigation'
import { CalendarClock, Loader2, Plus } from 'lucide-react'

export function Automations() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const repoId = id ? Number(id) : undefined

  const {
    automationTab,
    setAutomationTab,
    dialog,
    jobId,
    runId,
    openNewJob,
    openEditJob,
    openDeleteJob,
    closeDialog,
    selectRun,
    selectJobAndView,
    selectJobAndCloseDialog,
    replaceUrlParams,
  } = useAutomationUrlState()

  const repoAutomationTab = automationTab === 'prompts' ? 'jobs' : automationTab

  const { automationTarget, isLoading: automationTargetLoading } = useAutomationTarget(repoId)

  useProjectActivity(repoId ?? 0, Boolean(automationTarget) && automationTarget?.kind === 'project')

  const { data: jobs, isLoading: jobsLoading } = useRepoAutomations(repoId)
  const { data: selectedJob, isFetching: isJobFetching } = useRepoAutomation(repoId, jobId)
  const { data: runs, isLoading: runsLoading } = useRepoAutomationRuns(repoId, jobId, 30)
  const { data: selectedRunDetails, isLoading: selectedRunLoading } = useRepoAutomationRun(repoId, jobId, runId)

  const createMutation = useCreateRepoAutomation()
  const updateMutation = useUpdateRepoAutomation()
  const deleteMutation = useDeleteRepoAutomation()
  const runMutation = useRunRepoAutomation()
  const cancelRunMutation = useCancelRepoAutomationRun()

  useEffect(() => {
    if (automationTab === 'prompts') {
      setAutomationTab('jobs')
    }
  }, [automationTab, setAutomationTab])

  const editingJob = useMemo<AutomationJob | undefined>(
    () => (dialog === 'edit' && jobId !== null ? jobs?.find((j) => j.id === jobId) : undefined),
    [dialog, jobId, jobs],
  )

  useEffect(() => {
    if (jobs === undefined) return

    if (!jobs.length) {
      if (jobId !== null || automationTab !== 'jobs') {
        replaceUrlParams((p) => {
          p.delete('jobId')
          p.delete('automationTab')
        })
      }
      return
    }

    const stillExists = jobId !== null && jobs.some((job) => job.id === jobId)
    if (!stillExists) {
      const newId = jobs[0]?.id ?? null
      if (newId !== jobId || automationTab !== 'jobs') {
        replaceUrlParams((p) => {
          if (newId === null) p.delete('jobId')
          else p.set('jobId', String(newId))
          p.delete('automationTab')
        })
      }
    }
  }, [jobs, jobId, automationTab, replaceUrlParams])

  useEffect(() => {
    if (runs === undefined) return

    if (!runs.length) {
      if (runId !== null) selectRun(null)
      return
    }

    const stillExists = runId !== null && runs.some((run) => run.id === runId)
    if (!stillExists) {
      const newRunId = runs[0]?.id ?? null
      if (newRunId !== runId) selectRun(newRunId)
    }
  }, [runs, runId, selectRun])

  const activeRunSummary = useMemo(() => runs?.find((run) => run.id === runId) ?? null, [runs, runId])
  const activeRun = selectedRunDetails ?? activeRunSummary
  const runningRun = useMemo(() => runs?.find((run) => run.status === 'running') ?? null, [runs])

  if (automationTargetLoading || jobsLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!automationTarget || repoId === undefined) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <p className="text-muted-foreground">
          {repoId === 0 ? 'General Chat not found' : 'Repository not found'}
        </p>
      </div>
    )
  }
  const hasJobs = (jobs?.length ?? 0) > 0
  const backHref = getReturnToPath(location.search, automationTarget.backHref)

  const handleCreate = (data: CreateAutomationJobRequest) => {
    createMutation.mutate({ repoId: repoId!, data }, {
      onSuccess: (job) => {
        selectJobAndCloseDialog(job.id)
      },
    })
  }

  const handleUpdate = (data: CreateAutomationJobRequest) => {
    if (dialog !== 'edit' || jobId === null) {
      return
    }

    updateMutation.mutate({
      repoId: repoId!,
      jobId,
      data: toUpdateautomationRequest(data),
    }, {
      onSuccess: () => {
        closeDialog()
      },
    })
  }

  const handleDelete = () => {
    if (dialog !== 'delete' || jobId === null) {
      return
    }

    const deletedJobId = jobId
    deleteMutation.mutate({ repoId: repoId!, jobId: deletedJobId }, {
      onSuccess: () => {
        closeDialog()
      },
    })
  }

  const handleToggleEnabled = () => {
    if (!selectedJob) {
      return
    }

    updateMutation.mutate({
      repoId: repoId!,
      jobId: selectedJob.id,
      data: { enabled: !selectedJob.enabled },
    })
  }

  const handleRunNow = () => {
    if (!selectedJob) {
      return
    }

    runMutation.mutate({ repoId: repoId!, jobId: selectedJob.id }, {
      onSuccess: (run) => {
        selectRun(run.id)
      },
    })
  }

  const handleCancelRun = () => {
    if (!activeRun || activeRun.status !== 'running') {
      return
    }

    cancelRunMutation.mutate({
      repoId: repoId!,
      jobId: activeRun.jobId,
      runId: activeRun.id,
    }, {
      onSuccess: (run) => {
        selectRun(run.id)
      },
    })
  }

  const handleSelectJob = (id: number) => {
    selectJobAndView(id)
  }

  return (
    <div className="h-dvh max-h-dvh overflow-hidden bg-background flex flex-col pb-[calc(env(safe-area-inset-bottom)+56px)] sm:pb-0">
      <Header>
        <Header.BackButton to={backHref} />
        <div className="min-w-0 flex-1 px-3">
          <Header.Title className="truncate">{automationTarget.name}</Header.Title>
          <p className="text-xs text-muted-foreground truncate">{automationTarget.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <Header.Actions>
              <Button onClick={openNewJob} size="sm" className="hidden sm:flex">
                <Plus className="w-4 h-4 mr-2" />
                New Automation
              </Button>
            <Button onClick={openNewJob} size="sm" className="sm:hidden h-10 w-10 p-0">
              <Plus className="w-5 h-5" />
            </Button>
          </Header.Actions>
        </div>
      </Header>

      <div className="flex flex-1 min-h-0 flex-col overflow-hidden px-2 md:px-6">
        {!hasJobs ? (
          <div className="flex min-h-0 flex-1 h-full items-start">
            <Card className="max-w-3xl border-dashed border-border/70">
              <CardContent className="flex flex-col items-start gap-4 p-8 sm:p-10">
                <div className="rounded-full border border-border bg-muted/40 p-3">
                  <CalendarClock className="h-6 w-6 text-muted-foreground" />
                </div>
                <div className="space-y-2">
                  <p className="text-xl font-semibold tracking-tight">No automations yet</p>
                  <p className="text-sm text-muted-foreground">Create an automation for this repo to automate recurring agent work, then inspect runs, logs, and sessions here.</p>
                </div>
                <Button onClick={openNewJob}>
                  <Plus className="w-4 h-4 mr-2" />
                  Create First Automation
                </Button>
              </CardContent>
            </Card>
          </div>
        ) : (
          <>
            {repoAutomationTab === 'jobs' && (
              <JobsTab
                jobs={jobs ?? []}
                selectedJobId={jobId}
                onSelectJob={handleSelectJob}
              />
            )}
            {repoAutomationTab === 'detail' && (
              <JobDetailTab
                selectedJob={selectedJob}
                onEdit={(job) => openEditJob(job.id)}
                onDelete={openDeleteJob}
                onToggleEnabled={handleToggleEnabled}
                onRunNow={handleRunNow}
                updatePending={updateMutation.isPending}
                runPending={runMutation.isPending}
                runningRun={Boolean(runningRun)}
                isJobFetching={isJobFetching}
              />
            )}
            {repoAutomationTab === 'runs' && (
              <RunHistoryTab
                repoId={repoId}
                selectedJob={selectedJob}
                runs={runs}
                runsLoading={runsLoading}
                onSelectRun={selectRun}
                activeRun={activeRun}
                selectedRunLoading={selectedRunLoading}
                onCancelRun={handleCancelRun}
                cancelRunPending={cancelRunMutation.isPending}
              />
            )}
          </>
        )}
      </div>

      {hasJobs && (
        <div className="sm:block hidden">
          <AutomationTabMenu
            activeTab={repoAutomationTab as 'jobs' | 'detail' | 'runs'}
            onTabChange={(tab) => setAutomationTab(tab)}
          />
        </div>
      )}

      <AutomationJobDialog
        open={dialog === 'new' || dialog === 'edit'}
        onOpenChange={(open) => {
          if (!open) closeDialog()
        }}
        job={editingJob}
        isSaving={createMutation.isPending || updateMutation.isPending}
        onSubmit={dialog === 'edit' ? handleUpdate : handleCreate}
      />

      <DeleteDialog
        open={dialog === 'delete'}
        onOpenChange={(open) => !open && closeDialog()}
        onConfirm={handleDelete}
        onCancel={() => closeDialog()}
        title="Delete Automation"
        description="This removes the job definition and all recorded run history for it."
        isDeleting={deleteMutation.isPending}
      />
    </div>
  )
}
