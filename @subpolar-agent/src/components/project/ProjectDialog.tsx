import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useQuery } from '@tanstack/react-query'
import { getDefaultProjectDirectory, listProjectDirectories } from '@/api/projects'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { MultiSelect } from '@/components/ui/multi-select'
import { Folder, Loader2 } from 'lucide-react'

const projectFormSchema = z.object({
  name: z.string().min(1, 'Project name is required'),
  directory: z.string().optional(),
  agentNames: z.array(z.string()).optional(),
})

type ProjectFormValues = z.infer<typeof projectFormSchema>

interface ProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (values: ProjectFormValues) => void | Promise<void>
  availableAgents?: Array<{ name: string; description?: string }>
  userId?: string
  isSubmitting?: boolean
}

export function ProjectDialog({ open, onOpenChange, onSubmit, availableAgents = [], userId, isSubmitting = false }: ProjectDialogProps) {
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserPath, setBrowserPath] = useState<string | undefined>()
  const form = useForm<ProjectFormValues>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: {
      name: '',
      directory: '',
      agentNames: [],
    },
  })

  const name = form.watch('name')

  const { data: defaultDirectory } = useQuery({
    queryKey: ['project-default-directory', name, userId],
    queryFn: () => getDefaultProjectDirectory(name || 'project', userId),
    enabled: open,
  })

  const { data: directoryListing, isLoading: directoriesLoading } = useQuery({
    queryKey: ['project-directories', browserPath, userId],
    queryFn: () => listProjectDirectories(browserPath, userId),
    enabled: open && browserOpen,
  })

  useEffect(() => {
    if (!open) return
    const current = form.getValues('directory')
    if (!current && defaultDirectory) {
      form.setValue('directory', defaultDirectory, { shouldDirty: false })
    }
  }, [defaultDirectory, form, open])

  useEffect(() => {
    if (open) return
    form.reset({ name: '', directory: '', agentNames: [] })
    setBrowserOpen(false)
    setBrowserPath(undefined)
  }, [form, open])

  const agentOptions = useMemo(
    () => availableAgents.map((agent) => ({ value: agent.name, label: agent.name, description: agent.description })),
    [availableAgents],
  )

  const handleSubmit = async (values: ProjectFormValues) => {
    await onSubmit(values)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent mobileFullscreen mobileSwipeToClose className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Create Project</DialogTitle>
          <DialogDescription>Choose a workspace directory and optional project-specific agents.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-5">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder="My project"
                      disabled={isSubmitting}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="directory"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Directory</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Input {...field} placeholder="/path/to/project" disabled={isSubmitting} className="pr-10" />
                      <button
                        type="button"
                        onClick={() => {
                          setBrowserPath(field.value)
                          setBrowserOpen((value) => !value)
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                        aria-label="Browse directories"
                      >
                        <Folder className="h-4 w-4" />
                      </button>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {browserOpen && (
              <div className="rounded-md border bg-popover p-2">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setBrowserPath(directoryListing?.currentPath.split('/').slice(0, -1).join('/') || '/')}>
                    Up
                  </Button>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">{directoryListing?.currentPath || browserPath}</span>
                </div>
                <div className="max-h-52 overflow-y-auto">
                  {directoriesLoading ? (
                    <div className="px-3 py-4 text-sm text-muted-foreground">Loading directories...</div>
                  ) : (
                    directoryListing?.directories.map((directory) => (
                      <button
                        key={directory.path}
                        type="button"
                        onClick={() => {
                          form.setValue('directory', directory.path, { shouldDirty: true })
                          setBrowserPath(directory.path)
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
                      >
                        <Folder className="h-4 w-4 text-muted-foreground" />
                        <span className="truncate">{directory.name}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}

            <FormField
              control={form.control}
              name="agentNames"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Project Agents</FormLabel>
                  <p className="text-sm text-muted-foreground">If none are selected, this project inherits all global agents.</p>
                  <FormControl>
                    <MultiSelect
                      value={field.value ?? []}
                      onChange={field.onChange}
                      options={agentOptions}
                      placeholder="Select project agents..."
                      disabled={isSubmitting}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>Cancel</Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Project
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
