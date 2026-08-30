import { useEffect, useRef, useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { useAutomationUrlState } from '../useAutomationUrlState'
import { renderHookWithRouterAndLocation } from '@/test/test-utils'

describe('useAutomationUrlState', () => {
  it('defaults to jobs tab, null dialog, and null ids when URL is empty', () => {
    const { result } = renderHookWithRouterAndLocation(() => useAutomationUrlState())
    expect(result.current.automationTab).toBe('jobs')
    expect(result.current.dialog).toBeNull()
    expect(result.current.jobId).toBeNull()
    expect(result.current.runId).toBeNull()
    expect(result.current.templateId).toBeNull()
  })

  it('setautomationTab updates tab and removes param when set to jobs', () => {
    const { result } = renderHookWithRouterAndLocation(() => useAutomationUrlState())
    act(() => {
      result.current.setautomationTab('prompts')
    })
    expect(result.current.automationTab).toBe('prompts')

    act(() => {
      result.current.setautomationTab('jobs')
    })
    expect(result.current.automationTab).toBe('jobs')
  })

  it('openEditJob sets dialog to edit and sets jobId', () => {
    const { result, capturedSearch } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), )
    act(() => {
      result.current.openEditJob(12)
    })
    expect(result.current.dialog).toBe('edit')
    expect(result.current.jobId).toBe(12)
    expect(result.current.templateId).toBeNull()
    expect(capturedSearch.current).toContain('automationDialog=edit')
    expect(capturedSearch.current).toContain('jobId=12')
  })

  it('openDeleteTemplate sets promptDialog to delete and sets templateId', () => {
    const { result } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), )
    act(() => {
      result.current.openDeleteTemplate(5)
    })
    expect(result.current.promptDialog).toBe('delete')
    expect(result.current.templateId).toBe(5)
    expect(result.current.jobId).toBeNull()
  })

  it('openImportTemplate sets promptDialog to import and clears templateId', () => {
    const { result } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), ['/?templateId=3&jobId=7'])
    act(() => {
      result.current.openImportTemplate()
    })
    expect(result.current.promptDialog).toBe('import')
    expect(result.current.templateId).toBeNull()
    expect(result.current.jobId).toBeNull()
  })

  it('closeDialog after edit preserves automationDialog and jobId', () => {
    const { result, capturedSearch } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), )
    act(() => {
      result.current.openEditJob(12)
    })
    expect(result.current.dialog).toBe('edit')
    expect(result.current.jobId).toBe(12)

    act(() => {
      result.current.closeDialog()
    })
    expect(result.current.dialog).toBeNull()
    expect(result.current.jobId).toBe(12)
    expect(result.current.templateId).toBeNull()
    expect(capturedSearch.current).not.toContain('automationDialog')
    expect(capturedSearch.current).toContain('jobId=12')
  })

  it('closeDialog after delete preserves jobId when canceling', () => {
    const { result, capturedSearch } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), )
    act(() => {
      result.current.openDeleteJob(42)
    })
    expect(result.current.dialog).toBe('delete')
    expect(result.current.jobId).toBe(42)

    act(() => {
      result.current.closeDialog()
    })
    expect(result.current.dialog).toBeNull()
    expect(result.current.jobId).toBe(42)
    expect(capturedSearch.current).not.toContain('automationDialog')
    expect(capturedSearch.current).toContain('jobId=42')
  })

  it('closePromptDialog after openNewTemplate clears promptDialog and templateId', () => {
    const { result } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), )
    // Open new template
    act(() => {
      result.current.openNewTemplate()
    })
    expect(result.current.promptDialog).toBe('new')
    expect(result.current.templateId).toBeNull()

    // Close prompt dialog
    act(() => {
      result.current.closePromptDialog()
    })
    expect(result.current.promptDialog).toBeNull()
    expect(result.current.templateId).toBeNull()
  })

  it('parses jobId=abc as null (NaN) and runId=44 as 44', () => {
    const { result } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), ['/?jobId=abc&runId=44'])
    expect(result.current.jobId).toBeNull()
    expect(result.current.runId).toBe(44)
  })

  it('preserves unrelated params across setautomationTab and openEditJob and closeDialog', () => {
    const { result, capturedSearch } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), ['/?assistant=1'])

    // setautomationTab preserves assistant param
    act(() => {
      result.current.setautomationTab('runs')
    })
    expect(capturedSearch.current).toContain('assistant=1')
    expect(capturedSearch.current).toContain('automationTab=runs')

    // openEditJob preserves assistant param
    act(() => {
      result.current.openEditJob(3)
    })
    expect(capturedSearch.current).toContain('assistant=1')
    expect(capturedSearch.current).toContain('automationDialog=edit')

    // closeDialog preserves assistant param
    act(() => {
      result.current.closeDialog()
    })
    expect(capturedSearch.current).toContain('assistant=1')
    expect(capturedSearch.current).not.toContain('automationDialog')
  })

  it('openNewJob sets dialog to new and clears jobId and templateId', () => {
    const { result } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), ['/?templateId=2&jobId=5'])
    act(() => {
      result.current.openNewJob()
    })
    expect(result.current.dialog).toBe('new')
    expect(result.current.jobId).toBeNull()
    expect(result.current.templateId).toBeNull()
  })

  it('openDeleteJob sets dialog to delete and sets jobId', () => {
    const { result } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), )
    act(() => {
      result.current.openDeleteJob(42)
    })
    expect(result.current.dialog).toBe('delete')
    expect(result.current.jobId).toBe(42)
    expect(result.current.templateId).toBeNull()
  })

  it('openEditTemplate sets promptDialog to edit and sets templateId', () => {
    const { result } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), )
    act(() => {
      result.current.openEditTemplate(99)
    })
    expect(result.current.promptDialog).toBe('edit')
    expect(result.current.templateId).toBe(99)
    expect(result.current.jobId).toBeNull()
  })

  it('selectRun sets and clears runId', () => {
    const { result } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), )
    act(() => {
      result.current.selectRun(20)
    })
    expect(result.current.runId).toBe(20)

    act(() => {
      result.current.selectRun(null)
    })
    expect(result.current.runId).toBeNull()
  })

  it('reads valid automationTab from URL', () => {
    const { result } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), ['/?automationTab=detail'])
    expect(result.current.automationTab).toBe('detail')
  })

  it('reads valid automationDialog from URL', () => {
    const { result } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), ['/?automationDialog=edit'])
    expect(result.current.dialog).toBe('edit')
  })

  it('reads valid promptDialog from URL', () => {
    const { result } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), ['/?promptDialog=import'])
    expect(result.current.promptDialog).toBe('import')
  })

  it('resolves invalid tab values to jobs', () => {
    const { result } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), ['/?automationTab=invalid'])
    expect(result.current.automationTab).toBe('jobs')
  })

  it('resolves invalid dialog values to null', () => {
    const { result } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), ['/?automationDialog=invalid'])
    expect(result.current.dialog).toBeNull()
  })

  it('closeDialog for new dialog does not affect jobId', () => {
    const { result, capturedSearch } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), ['/?automationDialog=new&jobId=7'])
    expect(result.current.dialog).toBe('new')
    expect(result.current.jobId).toBe(7)

    act(() => {
      result.current.closeDialog()
    })
    expect(result.current.dialog).toBeNull()
    expect(result.current.jobId).toBe(7)
    expect(capturedSearch.current).not.toContain('automationDialog')
    expect(capturedSearch.current).toContain('jobId=7')
  })

  it('closePromptDialog for import clears promptDialog but preserves jobId', () => {
    const { result } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), ['/?jobId=7&promptDialog=import'])
    act(() => {
      result.current.closePromptDialog()
    })
    expect(result.current.promptDialog).toBeNull()
    // closePromptDialog does not touch jobId
    expect(result.current.jobId).toBe(7)
  })

  it('returns stable function references across rerenders', () => {
    const { result, rerender } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), )
    const firstSetautomationTab = result.current.setautomationTab
    const firstOpenEditJob = result.current.openEditJob
    const firstCloseDialog = result.current.closeDialog
    const firstClosePromptDialog = result.current.closePromptDialog
    const firstSelectJobAndView = result.current.selectJobAndView
    const firstSelectJobAndCloseDialog = result.current.selectJobAndCloseDialog
    const firstReplaceUrlParams = result.current.replaceUrlParams

    rerender()

    expect(result.current.setautomationTab).toBe(firstSetautomationTab)
    expect(result.current.openEditJob).toBe(firstOpenEditJob)
    expect(result.current.closeDialog).toBe(firstCloseDialog)
    expect(result.current.closePromptDialog).toBe(firstClosePromptDialog)
    expect(result.current.selectJobAndView).toBe(firstSelectJobAndView)
    expect(result.current.selectJobAndCloseDialog).toBe(firstSelectJobAndCloseDialog)
    expect(result.current.replaceUrlParams).toBe(firstReplaceUrlParams)
  })

  describe('combined atomic URL mutations', () => {
    it('selectJobAndView sets jobId and automationTab in a single navigation', () => {
      const { result, capturedSearch } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), )
      act(() => {
        result.current.selectJobAndView(42)
      })
      expect(result.current.jobId).toBe(42)
      expect(result.current.automationTab).toBe('detail')
      expect(capturedSearch.current).toContain('jobId=42')
      expect(capturedSearch.current).toContain('automationTab=detail')
    })

    it('selectJobAndView preserves unrelated params', () => {
      const { result, capturedSearch } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), ['/?assistant=1'])
      act(() => {
        result.current.selectJobAndView(99)
      })
      expect(capturedSearch.current).toContain('assistant=1')
      expect(capturedSearch.current).toContain('jobId=99')
      expect(capturedSearch.current).toContain('automationTab=detail')
    })

    it('selectJobAndCloseDialog sets jobId and removes automationDialog', () => {
      const { result, capturedSearch } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), ['/?automationDialog=new'])
      act(() => {
        result.current.selectJobAndCloseDialog(7)
      })
      expect(result.current.jobId).toBe(7)
      expect(result.current.dialog).toBeNull()
      expect(capturedSearch.current).not.toContain('automationDialog')
      expect(capturedSearch.current).toContain('jobId=7')
    })

    it('selectJobAndCloseDialog from edit preserves jobId and removes dialog', () => {
      const { result, capturedSearch } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), ['/?automationDialog=edit&jobId=3'])
      act(() => {
        result.current.selectJobAndCloseDialog(3)
      })
      expect(result.current.jobId).toBe(3)
      expect(result.current.dialog).toBeNull()
      expect(capturedSearch.current).not.toContain('automationDialog')
      expect(capturedSearch.current).toContain('jobId=3')
    })

    it('selectJobAndCloseDialog preserves unrelated params', () => {
      const { result, capturedSearch } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), ['/?automationDialog=edit&assistant=1'])
      act(() => {
        result.current.selectJobAndCloseDialog(5)
      })
      expect(capturedSearch.current).toContain('assistant=1')
      expect(capturedSearch.current).not.toContain('automationDialog')
      expect(capturedSearch.current).toContain('jobId=5')
    })

    it('replaceUrlParams can set and delete multiple params atomically', () => {
      const { result, capturedSearch } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), ['/?foo=1&bar=2'])
      act(() => {
        result.current.replaceUrlParams((p) => {
          p.set('jobId', '10')
          p.set('automationTab', 'runs')
          p.delete('foo')
        })
      })
      expect(result.current.jobId).toBe(10)
      expect(result.current.automationTab).toBe('runs')
      expect(capturedSearch.current).toContain('jobId=10')
      expect(capturedSearch.current).toContain('automationTab=runs')
      expect(capturedSearch.current).not.toContain('foo=')
      expect(capturedSearch.current).toContain('bar=2')
    })

    it('replaceUrlParams preserves all params when no modifications are made', () => {
      const { result, capturedSearch } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), ['/?jobId=5&automationTab=detail'])
      act(() => {
        result.current.replaceUrlParams((_p) => {
          // No modifications
        })
      })
      expect(result.current.jobId).toBe(5)
      expect(result.current.automationTab).toBe('detail')
      expect(capturedSearch.current).toContain('jobId=5')
      expect(capturedSearch.current).toContain('automationTab=detail')
    })
  })

  describe('push/replace history mode', () => {
    it('openNewJob uses push so navigate(-1) closes the dialog', () => {
      function PushHarness() {
        const { dialog, openNewJob } = useAutomationUrlState()
        const navigate = useNavigate()
        const [step, setStep] = useState<'start' | 'opened' | 'back'>('start')
        const handled = useRef(false)

        useEffect(() => {
          if (handled.current) return
          if (step === 'opened') {
            handled.current = true
            openNewJob()
          } else if (step === 'back') {
            handled.current = true
            navigate(-1)
          }
        }, [step, openNewJob, navigate])

        return (
          <div>
            <span data-testid="dialog">{dialog ?? 'null'}</span>
            <button onClick={() => { handled.current = false; setStep('opened') }}>
              open
            </button>
            <button onClick={() => { handled.current = false; setStep('back') }}>
              back
            </button>
          </div>
        )
      }

      render(
        <MemoryRouter initialEntries={['/other', '/']}>
          <PushHarness />
        </MemoryRouter>,
      )

      expect(screen.getByTestId('dialog').textContent).toBe('null')

      act(() => { screen.getByText('open').click() })
      expect(screen.getByTestId('dialog').textContent).toBe('new')

      act(() => { screen.getByText('back').click() })
      expect(screen.getByTestId('dialog').textContent).toBe('null')
    })

    it('setautomationTab uses replace so navigate(-1) does not step through tab changes', () => {
      function ReplaceHarness() {
        const { automationTab, setautomationTab } = useAutomationUrlState()
        const navigate = useNavigate()
        const [step, setStep] = useState<'start' | 'switched' | 'back'>('start')
        const handled = useRef(false)

        useEffect(() => {
          if (handled.current) return
          if (step === 'switched') {
            handled.current = true
            setautomationTab('runs')
          } else if (step === 'back') {
            handled.current = true
            navigate(-1)
          }
        }, [step, setautomationTab, navigate])

        return (
          <div>
            <span data-testid="automationTab">{automationTab}</span>
            <button onClick={() => { handled.current = false; setStep('switched') }}>
              switch
            </button>
            <button onClick={() => { handled.current = false; setStep('back') }}>
              back
            </button>
          </div>
        )
      }

      render(
        <MemoryRouter initialEntries={['/other', '/']}>
          <ReplaceHarness />
        </MemoryRouter>,
      )

      expect(screen.getByTestId('automationTab').textContent).toBe('jobs')

      act(() => { screen.getByText('switch').click() })
      expect(screen.getByTestId('automationTab').textContent).toBe('runs')

      act(() => { screen.getByText('back').click() })
      expect(screen.getByTestId('automationTab').textContent).toBe('jobs')
    })

    it('openEditTemplate(7) sets promptDialog=edit and templateId=7', () => {
      const { result } = renderHookWithRouterAndLocation(() => useAutomationUrlState(), )
      act(() => {
        result.current.openEditTemplate(7)
      })
      expect(result.current.promptDialog).toBe('edit')
      expect(result.current.templateId).toBe(7)
    })
  })
})
