import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { createSubpolarClient } from '@/api/subpolar'
import { useModelSelection } from '@/hooks/useModelSelection'
import { showToast } from '@/lib/toast'
import type { components } from '@/api/opencode-types'
import { useSessionStatus } from '@/stores/sessionStatusStore'
import { newSessionPath } from '@/lib/new-session-route'

type CommandType = components['schemas']['Command']

function parseNewSessionArguments(args: string): string[] {
  const segments: string[] = []
  let segment = ''
  let quote: string | undefined
  let hasSegment = false

  const addSegment = () => {
    if (!hasSegment) return
    if (!segment.trim()) throw new Error('Session route names cannot be empty')
    segments.push(segment)
    segment = ''
    hasSegment = false
  }

  for (const character of args.trim()) {
    if (quote) {
      if (character === quote) quote = undefined
      else segment += character
      hasSegment = true
    } else if (character === '"' || character === "'") {
      quote = character
      hasSegment = true
    } else if (/\s/.test(character)) {
      addSegment()
    } else {
      segment += character
      hasSegment = true
    }
  }

  if (quote) throw new Error('Unclosed quote in new-session arguments')
  addSegment()
  return segments
}

interface CommandHandlerProps {
  apiUrl: string
  sessionID: string
  directory?: string
  projectName?: string
  onShowSessionsDialog?: () => void
  onShowModelsDialog?: () => void
  onShowHelpDialog?: () => void
  onToggleDetails?: () => boolean
  onExportSession?: () => void
  currentAgent?: string
}

export function useCommandHandler({
  apiUrl,
  sessionID,
  directory,
  projectName,
  onShowSessionsDialog,
  onShowModelsDialog,
  onShowHelpDialog,
  onToggleDetails,
  onExportSession,
  currentAgent
}: CommandHandlerProps) {
  const navigate = useNavigate()
  const { model, modelString } = useModelSelection(apiUrl, directory)
  const setSessionStatus = useSessionStatus((state) => state.setStatus)
  const [loading, setLoading] = useState(false)

  const executeCommand = useCallback(async (command: CommandType, args: string = '') => {
    if (!apiUrl) return

    setLoading(true)
    
    try {
      const client = createSubpolarClient(apiUrl, directory)
      
      switch (command.name) {
        case 'sessions':
        case 'resume':
        case 'continue':
          onShowSessionsDialog?.()
          break
          
        case 'models':
          onShowModelsDialog?.()
          break
          
        case 'themes': {
          await client.sendCommand(sessionID, {
            command: command.name,
            arguments: args,
            agent: currentAgent,
            model: modelString || undefined
          })
          break
        }
          
        case 'help':
          onShowHelpDialog?.()
          break
          
        case 'new':
        case 'clear': {
          const segments = parseNewSessionArguments(args)
          if (segments.length > 2) throw new Error('Expected an optional agent or project and agent')

          const inheritedProject = projectName?.trim() || undefined
          const inheritedAgent = currentAgent?.trim() || undefined
          const route = segments.length === 2
            ? { projectName: segments[0], agentName: segments[1] }
            : segments.length === 1
              ? { projectName: inheritedProject, agentName: segments[0] }
              : { projectName: inheritedAgent ? inheritedProject : undefined, agentName: inheritedAgent }

          navigate(newSessionPath(route))
          break
        }
          
        case 'details':
          if (onToggleDetails) {
            const expanded = onToggleDetails()
            showToast.success(expanded ? 'Tool details expanded' : 'Tool details collapsed')
          }
          break
          
        case 'export':
          if (onExportSession) {
            onExportSession()
          }
          break

        case 'compact':
        case 'summarize': {
          if (!model?.providerID || !model?.modelID) {
            showToast.error('No model selected. Please select a provider and model first.')
            break
          }

          showToast.loading('Compacting session...', { id: `compact-${sessionID}` })

          setSessionStatus(sessionID, { type: 'compact' })

          await client.summarizeSession(
            sessionID,
            model.providerID,
            model.modelID
          )
          break
        }
          
        case 'share':
        case 'unshare':
        case 'undo':
        case 'redo':
        case 'editor':
        case 'init': {
          await client.sendCommand(sessionID, {
            command: command.name,
            arguments: args,
            agent: currentAgent,
            model: modelString || undefined
          })
          break
        }

        default: {
          await client.sendCommand(sessionID, {
            command: command.name,
            arguments: args,
            agent: currentAgent,
            model: modelString || undefined
          })
        }
      }
    } catch (error) {
      showToast.error(`Command failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      setSessionStatus(sessionID, { type: 'idle' })
    } finally {
      setLoading(false)
    }
  }, [sessionID, apiUrl, directory, projectName, onShowSessionsDialog, onShowModelsDialog, onShowHelpDialog, onToggleDetails, onExportSession, navigate, model, modelString, currentAgent, setSessionStatus])

  return {
    executeCommand,
    loading
  }
}
