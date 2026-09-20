import { useMemo, useState } from "react";
import { useParams, useNavigate, Navigate, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getProject, hasProjectId, listProjects } from "@/api/projects";
import { MessageThread } from "@/components/message/MessageThread";
import { ChatInputBar, type ChatInputBarHandle } from "@/components/chat/ChatInputBar";
import { ChevronDown, CornerUpLeft, Download } from "lucide-react";
import { Header } from "@/components/ui/header";
import { SessionList } from "@/components/session/SessionList";
import { ProjectNotFoundDialog } from "@/components/project/ProjectNotFoundDialog";
import { getSessionListPath } from '@/lib/navigation'
import { GENERAL_CHAT_PROJECT_ID } from '@subpolar/shared/utils'

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ContextUsageIndicator } from "@/components/session/ContextUsageIndicator";
import { useSession, useAbortSession, useSendPrompt, useSessionQueue, useRemoveQueueEntry, useRetryQueueEntry, useReorderQueueEntry, useClearQueue } from "@/hooks/usePiHarness";
import { useProjectActivity } from "@/hooks/useProjectActivity";
import { SUBPOLAR_API_BASE_URL } from "@/config";
import { useSSE } from "@/hooks/useSSE";
import { useSessionTranscript } from "@/hooks/useSessionTranscript";
import { useUIState } from "@/stores/uiStateStore";
import { useModelSelection } from "@/hooks/useModelSelection";
import { useSessionAgent } from "@/hooks/useSessionAgent";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useMobile } from "@/hooks/useMobile";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { useSessionStatusForSession } from "@/stores/sessionStatusStore";
import { useEffect, useRef, useCallback } from "react";
import { MessageSkeleton } from "@/components/message/MessageSkeleton";
import { getMessagesContentVersion } from "./sessionContentVersion";
import { showToast } from "@/lib/toast";
import { createSubpolarClient } from '@/api/subpolar';
import { usePermissions, useQuestions } from "@/contexts/EventContext";
import type { QuestionRequest } from "@/api/types";
import { QuestionPrompt } from "@/components/session/QuestionPrompt";
import { MinimizedQuestionIndicator } from "@/components/session/MinimizedQuestionIndicator";
import { PermissionRequestDialog } from "@/components/session/PermissionRequestDialog";
import { PendingActionsGroup } from "@/components/notifications/PendingActionsGroup";
import { SessionSendErrorBanner } from "@/components/session/SessionSendErrorBanner";
import { SessionTodoDisplay } from "@/components/message/SessionTodoDisplay";
import { useSidebarAction } from "@/hooks/useSidebarAction";
import { SessionMoreButton } from "@/components/navigation/SessionMoreButton";
import {
  clearPendingSessionPrompt,
  loadPendingSessionPrompt,
  savePendingSessionPrompt,
  type StoredPendingSessionPrompt,
} from "@/lib/pending-session-prompt";
import { newSessionPath } from "@/lib/new-session-route";
import { downloadTranscript, exportTranscript, type TranscriptExportFormat } from "@/lib/transcriptExport";
import { useCompletionSuggestions } from "@/hooks/useCompletionSuggestions";

const compareMessageIds = (id1: string, id2: string): number => {
  const num1 = parseInt(id1, 10)
  const num2 = parseInt(id2, 10)
  if (!isNaN(num1) && !isNaN(num2)) return num1 - num2
  return id1.localeCompare(id2)
}

const PENDING_ACTION_SYNC_INTERVAL_MS = 30000
const PROMPT_OVERLAY_CLEARANCE_PX = 16

type PendingPromptLocationState = {
  pendingPrompt?: StoredPendingSessionPrompt
}

const createClientMessageID = () => `optimistic_user_${Date.now()}_${Math.random()}`;

type DeliveryState = 'pending' | 'running' | 'completed' | 'interrupted' | 'unknown';

const getDeliveryState = (value: unknown): DeliveryState | undefined => {
  if (!value || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  if (typeof record.state === 'string' && ['pending', 'running', 'completed', 'interrupted', 'unknown'].includes(record.state)) {
    return record.state as DeliveryState;
  }

  return getDeliveryState(record.delivery) ?? getDeliveryState(record.response);
};

const getTerminalDeliveryState = (error: unknown): 'interrupted' | 'unknown' | undefined => {
  const state = getDeliveryState(error) ?? (
    error && typeof error === 'object'
      ? getDeliveryState((error as { data?: unknown }).data)
      : undefined
  );
  if (state === 'interrupted' || state === 'unknown') return state;

  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  if (code === 'DELIVERY_INTERRUPTED') return 'interrupted';
  if (code === 'DELIVERY_UNKNOWN') return 'unknown';
  return undefined;
};

export function SessionDetail() {
  const { id, sessionId } = useParams<{ id: string; sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const repoId = Number(id) || 0;
  const messageContainerRef = useRef<HTMLDivElement>(null);
  const prependAnchorRef = useRef<{ height: number; top: number; count: number } | null>(null);
  const promptInputRef = useRef<ChatInputBarHandle>(null);
  const consumedPendingPromptRef = useRef<string | null>(null);
  const [, setPendingPromptVersion] = useState(0);
  const [sessionsPopoverOpen, setSessionsPopoverOpen] = useState(false);
  const [minimizedQuestion, setMinimizedQuestion] = useState<QuestionRequest | null>(null);
  const [exportingFormat, setExportingFormat] = useState<TranscriptExportFormat | null>(null);

  const isMobile = useMobile();
  const { keyboardHeight } = useVisualViewport();
  const inputBottomOffset = isMobile ? keyboardHeight : 0;
  const promptOverlayRef = useRef<HTMLDivElement>(null);
  const [promptOverlayHeight, setPromptOverlayHeight] = useState(112);

  useEffect(() => {
    const el = promptOverlayRef.current;
    if (!el) return;
    let mounted = true;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry && mounted) {
        setPromptOverlayHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => {
      mounted = false;
      observer.disconnect();
    };
  }, []);

  const { data: repo, isLoading: repoLoading, isError: repoError } = useQuery({
    queryKey: ["repo", repoId],
    queryFn: () => getProject(repoId),
    enabled: id !== undefined,
  });

  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
  });
  const selectableProjects = useMemo(
    () => projects?.filter((project) => hasProjectId(project) && project.id !== GENERAL_CHAT_PROJECT_ID) ?? [],
    [projects],
  );

  useProjectActivity(repoId, Boolean(repo));

  const apiUrl = SUBPOLAR_API_BASE_URL;
  
  const repoDirectory = repo?.fullPath;
  const sessionRouteSuffix = '';

  const { isConnected, isReconnecting } = useSSE(apiUrl, repoDirectory, sessionId);

  const transcript = useSessionTranscript(apiUrl, sessionId, repoDirectory);
  const rawMessages = transcript.messages;
  const messagesLoading = transcript.isLoading;
  const { data: session, isLoading: sessionLoading } = useSession(
    apiUrl,
    sessionId,
    repoDirectory,
  );

  const messages = useMemo(() => {
    if (!rawMessages) return undefined
    const revertMessageID = session?.revert?.messageID
    if (!revertMessageID) return rawMessages
    return rawMessages.filter(msgWithParts => compareMessageIds(msgWithParts.info.id, revertMessageID) < 0)
  }, [rawMessages, session?.revert?.messageID]);

  const messagesContentVersion = useMemo(() => getMessagesContentVersion(messages), [messages]);

  useEffect(() => {
    const container = messageContainerRef.current
    if (!container || !transcript.hasOlder) return
    const onScroll = () => {
      if (container.scrollTop < 350) {
        if (!prependAnchorRef.current) prependAnchorRef.current = { height: container.scrollHeight, top: container.scrollTop, count: rawMessages?.length ?? 0 }
        transcript.loadOlder()
      }
    }
    container.addEventListener('scroll', onScroll)
    return () => container.removeEventListener('scroll', onScroll)
  }, [rawMessages?.length, transcript.hasOlder, transcript.loadOlder])

  useEffect(() => {
    const anchor = prependAnchorRef.current
    const container = messageContainerRef.current
    if (!anchor || !container || (rawMessages?.length ?? 0) <= anchor.count) return
    container.scrollTop = anchor.top + (container.scrollHeight - anchor.height)
    prependAnchorRef.current = null
  }, [rawMessages?.length])

  const { scrollToBottom } = useAutoScroll({
    containerRef: messageContainerRef,
    messages: messages?.map(m => m.info),
    sessionId,
    contentVersion: messagesContentVersion,
    onScrollStateChange: () => {}
  });
  const abortSession = useAbortSession(apiUrl, repoDirectory, sessionId);
  const sendPendingPrompt = useSendPrompt(apiUrl, repoDirectory);
  const queue = useSessionQueue(apiUrl, sessionId, repoDirectory);
  const removeQueueEntry = useRemoveQueueEntry(apiUrl, repoDirectory);
  const retryQueueEntry = useRetryQueueEntry(apiUrl, repoDirectory);
  const reorderQueueEntry = useReorderQueueEntry(apiUrl, repoDirectory);
  const clearQueue = useClearQueue(apiUrl, repoDirectory);
  const queuedEntries = queue.data ?? [];
  const { model, modelString } = useModelSelection(apiUrl, repoDirectory);
  const sessionAgent = useSessionAgent(apiUrl, sessionId, repoDirectory);
  const isEditingMessage = useUIState((state) => state.isEditingMessage);
  const sessionStatus = useSessionStatusForSession(sessionId);
  const {
    pendingCount: pendingPermissionCount,
    respond: respondToPermission,
    getForSession: getPermissionForSession,
    syncForSession: syncPermissionsForSession,
  } = usePermissions();
  const { current: currentQuestion, reply: replyToQuestion, reject: rejectQuestion, syncForSession: syncQuestionsForSession } = useQuestions();

  const lastAssistantMessage = messages?.filter(m => m.info.role === 'assistant').at(-1);
  const suggestionUserMessage = useMemo(() => {
    if (!messages || !lastAssistantMessage || !sessionId) return undefined
    const assistantIndex = messages.findIndex((message) => message.info.id === lastAssistantMessage.info.id)
    for (let index = assistantIndex - 1; index >= 0; index -= 1) {
      if (messages[index].info.role !== 'user') continue
      return {
        sessionId,
        assistantMessageId: lastAssistantMessage.info.id,
        lastUserText: messages[index].parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n\n').trim(),
        lastAssistantText: lastAssistantMessage.parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n\n').trim(),
      }
    }
    return undefined
  }, [lastAssistantMessage, messages, sessionId])
  const completionSuggestions = useCompletionSuggestions(
    lastAssistantMessage && 'completed' in lastAssistantMessage.info.time && lastAssistantMessage.info.time.completed
      ? suggestionUserMessage
      : undefined,
  )
  const suggestionsByAssistantId = useMemo(() => {
    const result = new Map<string, string[]>()
    if (lastAssistantMessage && completionSuggestions.length > 0) result.set(lastAssistantMessage.info.id, completionSuggestions)
    return result
  }, [completionSuggestions, lastAssistantMessage])
  
  const isSessionActive = useMemo(() => {
    if (session?.time?.compacting) return true
    if (transcript.isConnected && sessionStatus.type !== 'idle') return true
    if (sessionStatus.type !== 'idle') return true
    if (lastAssistantMessage && !('completed' in lastAssistantMessage.info.time)) return true
    return false
  }, [lastAssistantMessage, session?.time?.compacting, sessionStatus.type, transcript.isConnected])
  const hasIncompleteMessages = lastAssistantMessage ? !('completed' in lastAssistantMessage.info.time && lastAssistantMessage.info.time.completed) : false;
  const isStreamingResponse = hasIncompleteMessages && isSessionActive;
  const pendingPrompt = (location.state as PendingPromptLocationState | null)?.pendingPrompt
    ?? (sessionId ? loadPendingSessionPrompt(sessionId) : undefined);
  const inFlightPrompt = pendingPrompt?.status === 'in-flight' ? pendingPrompt : undefined;
  const interruptedPrompt = pendingPrompt?.status === 'interrupted' || pendingPrompt?.status === 'unknown'
    ? pendingPrompt
    : undefined;
  const activePermission = getPermissionForSession(sessionId ?? '');

  const hasCompletedPromptResponse = useMemo(() => {
    if (!inFlightPrompt || !messages) return false;
    const promptIndex = messages.findIndex((message) => message.info.id === inFlightPrompt.messageID);
    if (promptIndex < 0) return false;

    return messages.slice(promptIndex + 1).some((message) => (
      message.info.role === 'assistant' &&
      'completed' in message.info.time &&
      Boolean(message.info.time.completed)
    ));
  }, [inFlightPrompt, messages]);

  useEffect(() => {
    if (!inFlightPrompt || !sessionId || sendPendingPrompt.isPending || !hasCompletedPromptResponse) return;

    clearPendingSessionPrompt(sessionId);
    setPendingPromptVersion((version) => version + 1);
  }, [hasCompletedPromptResponse, inFlightPrompt, sendPendingPrompt.isPending, sessionId]);

  const submitPendingPrompt = useCallback((prompt: StoredPendingSessionPrompt) => {
    if (!sessionId) return;

    const pendingPromptKey = `${sessionId}:${prompt.messageID}`
    if (consumedPendingPromptRef.current === pendingPromptKey) return
    consumedPendingPromptRef.current = pendingPromptKey

    const inFlightPrompt = { ...prompt, status: 'in-flight' as const };
    savePendingSessionPrompt(sessionId, inFlightPrompt);
    setPendingPromptVersion((version) => version + 1);

    sendPendingPrompt.mutate({
      sessionID: sessionId,
      prompt: prompt.prompt,
      messageID: prompt.messageID,
      model: prompt.model,
      agent: prompt.agent,
      permission: prompt.permission,
    }, {
      onSuccess: (data: unknown) => {
        const state = getDeliveryState(data);
        if (state === 'interrupted' || state === 'unknown') {
          savePendingSessionPrompt(sessionId, { ...inFlightPrompt, status: state });
          setPendingPromptVersion((version) => version + 1);
          return;
        }

        if (state === 'pending' || state === 'running' || !state) {
          savePendingSessionPrompt(sessionId, inFlightPrompt);
          setPendingPromptVersion((version) => version + 1);
          return;
        }

        clearPendingSessionPrompt(sessionId);
        setPendingPromptVersion((version) => version + 1);
      },
      onError: (error: unknown) => {
        const terminalState = getTerminalDeliveryState(error) ?? 'unknown';
        savePendingSessionPrompt(sessionId, {
          ...inFlightPrompt,
          ...(terminalState ? { status: terminalState } : {}),
        });
        setPendingPromptVersion((version) => version + 1);
      },
    })
  }, [sendPendingPrompt, sessionId]);

  useEffect(() => {
    if (!pendingPrompt || pendingPrompt.status === 'in-flight' || pendingPrompt.status === 'interrupted' || pendingPrompt.status === 'unknown' || !sessionId || !isConnected || messagesLoading) return

    const pendingPromptKey = `${sessionId}:${pendingPrompt.messageID}`
    if (consumedPendingPromptRef.current === pendingPromptKey) return

    submitPendingPrompt(pendingPrompt)

    navigate(`${location.pathname}${location.search}`, { replace: true, state: null })
  }, [
    isConnected,
    location.pathname,
    location.search,
    messagesLoading,
    navigate,
    pendingPrompt,
    sessionId,
    submitPendingPrompt,
  ])

  const handleRetryInterruptedPrompt = useCallback(() => {
    if (!interruptedPrompt || !sessionId || !isConnected) return

    const retryPrompt: StoredPendingSessionPrompt = {
      ...interruptedPrompt,
      messageID: createClientMessageID(),
      status: 'interrupted',
    }
    savePendingSessionPrompt(sessionId, retryPrompt)
    setPendingPromptVersion((version) => version + 1)
    submitPendingPrompt(retryPrompt)
  }, [interruptedPrompt, isConnected, sessionId, submitPendingPrompt])

  const handleDiscardInterruptedPrompt = useCallback(() => {
    if (!interruptedPrompt || !sessionId) return

    clearPendingSessionPrompt(sessionId)
    setPendingPromptVersion((version) => version + 1)
  }, [interruptedPrompt, sessionId])

  const handleMinimizeQuestion = useCallback((question: QuestionRequest) => {
    setMinimizedQuestion(question)
  }, [])
  
  const handleRestoreQuestion = useCallback(() => {
    setMinimizedQuestion(null)
  }, [])

  useEffect(() => {
    if (minimizedQuestion && minimizedQuestion.sessionID !== sessionId) {
      setMinimizedQuestion(null)
    }
  }, [sessionId, minimizedQuestion])

  const syncPendingActionsForSession = useCallback(async () => {
    if (!repoDirectory || !sessionId) return
    await Promise.all([
      syncPermissionsForSession(repoDirectory, sessionId),
      syncQuestionsForSession(repoDirectory, sessionId),
    ])
  }, [repoDirectory, sessionId, syncPermissionsForSession, syncQuestionsForSession])

  useQuery({
    queryKey: ['subpolar', 'pending-actions', apiUrl, sessionId, repoDirectory],
    queryFn: async () => {
      await syncPendingActionsForSession()
      return null
    },
    enabled: !!repoDirectory && !!sessionId,
    refetchOnMount: 'always',
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    refetchInterval: !isConnected && (isSessionActive || hasIncompleteMessages) ? PENDING_ACTION_SYNC_INTERVAL_MS : false,
    retry: false,
  })

  const handleNewSession = useCallback(() => {
    const agentName = sessionAgent.fromMessage || sessionAgent.fromSession ? sessionAgent.agent : repo?.agentNames?.[0] ?? 'master';
    navigate(newSessionPath({ projectName: repo?.name, agentName }));
  }, [navigate, repo?.agentNames, repo?.name, sessionAgent.agent, sessionAgent.fromMessage, sessionAgent.fromSession]);

  useSidebarAction('new-session', () => {
    handleNewSession();
  });

  const handleCompact = useCallback(async () => {
    if (!apiUrl || !sessionId) return;
    if (!model?.providerID || !model?.modelID) {
      showToast.error('No model selected. Please select a provider and model first.');
      return;
    }

    showToast.loading('Compacting session...', { id: `compact-${sessionId}` });

    try {
      const client = createSubpolarClient(apiUrl, repoDirectory);
      await client.summarizeSession(sessionId, model.providerID, model.modelID);
    } catch (error) {
      showToast.error(`Compact failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }, [apiUrl, sessionId, model, repoDirectory]);

  const handleUndo = useCallback(async () => {
    if (!apiUrl || !sessionId) return;
    try {
      const client = createSubpolarClient(apiUrl, repoDirectory);
      await client.sendCommand(sessionId, { command: 'undo', arguments: '' });
    } catch (error) {
      showToast.error(`Undo failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }, [apiUrl, sessionId, repoDirectory]);

  const handleRedo = useCallback(async () => {
    if (!apiUrl || !sessionId) return;
    try {
      const client = createSubpolarClient(apiUrl, repoDirectory);
      await client.sendCommand(sessionId, { command: 'redo', arguments: '' });
    } catch (error) {
      showToast.error(`Redo failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }, [apiUrl, sessionId, repoDirectory]);

  const handleFork = useCallback(async () => {
    if (!apiUrl || !sessionId) return;
    try {
      const client = createSubpolarClient(apiUrl, repoDirectory);
      const forkedSession = await client.forkSession(sessionId);
      if (forkedSession?.id) {
        navigate(`/projects/${repoId}/sessions/${forkedSession.id}${sessionRouteSuffix}`);
        showToast.success('Session forked');
      }
    } catch (error) {
      showToast.error(`Fork failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }, [apiUrl, sessionId, repoDirectory, navigate, repoId, sessionRouteSuffix]);

  const handleCloseSession = useCallback(() => {
    const tab = new URLSearchParams(location.search).get('repoTab') ?? undefined;
    navigate(getSessionListPath(repoId, tab))
  }, [navigate, repoId, location.search])

  const { leaderActive } = useKeyboardShortcuts({
    openSessions: () => setSessionsPopoverOpen(true),
    newSession: handleNewSession,
    closeSession: handleCloseSession,
    compact: handleCompact,
    undo: handleUndo,
    redo: handleRedo,
    fork: handleFork,
    toggleSidebar: () => {},
    toggleMode: () => {
      const modeButton = document.querySelector(
        "[data-toggle-mode]",
      ) as HTMLButtonElement;
      modeButton?.click();
    },
    submitPrompt: () => {
      const submitButton = document.querySelector(
        "[data-submit-prompt]",
      ) as HTMLButtonElement;
      submitButton?.click();
    },
    abortSession: () => {
      if (sessionId) {
        abortSession.mutate(sessionId);
      }
    },
  });

  

  const handleChildSessionClick = useCallback((childSessionId: string) => {
    navigate(`/projects/${repoId}/sessions/${childSessionId}${sessionRouteSuffix}`)
  }, [navigate, repoId, sessionRouteSuffix]);

  const handleParentSessionClick = useCallback(() => {
    if (session?.parentID) {
      navigate(`/projects/${repoId}/sessions/${session.parentID}${sessionRouteSuffix}`)
    }
  }, [navigate, repoId, session?.parentID, sessionRouteSuffix]);

  const handleUndoMessage = useCallback((restoredPrompt: string) => {
    promptInputRef.current?.setPromptValue(restoredPrompt)
  }, []);

  const handleSuggestionSelect = useCallback((suggestion: string) => {
    promptInputRef.current?.submitPrompt(suggestion)
  }, [])

  const handleExport = useCallback(async (format: TranscriptExportFormat) => {
    if (!session) return
    setExportingFormat(format)
    const toastId = showToast.loading('Loading complete transcript...')
    try {
      const allMessages = await transcript.loadAll()
      const result = exportTranscript(session, allMessages, format)
      downloadTranscript(result.content, result.filename, format)
      showToast.dismiss(toastId)
      showToast.success(`Transcript downloaded as ${format.toUpperCase()}`)
    } catch (error) {
      showToast.dismiss(toastId)
      showToast.error(error instanceof Error ? error.message : 'Unable to export transcript')
    } finally {
      setExportingFormat(null)
    }
  }, [session, transcript.loadAll])

  if (!sessionId) {
    return <Navigate to="/" replace />;
  }

  if (repoError || !repo) {
    return <ProjectNotFoundDialog projectId={id} />
  }

  const workspaceDisplayName = repo?.name || repo?.directory.split('/').pop() || repo?.directory || 'Workspace';
  const isGeneralChatProject = repoId === GENERAL_CHAT_PROJECT_ID;
  const sessionTitle = session?.title || "Untitled Session";
  const tabFromUrl = new URLSearchParams(location.search).get('projectTab') ?? undefined;
  const sessionBackPath = getSessionListPath(repoId, tabFromUrl);

  return (
    <div
      className="h-dvh max-h-dvh overflow-hidden bg-gradient-to-br from-background via-background to-background flex flex-col"
    >
      <div
        data-testid="session-header-region"
        className="flex-shrink-0 overflow-hidden bg-background max-h-72 sm:max-h-80"
      >
        <Header className="bg-background [&_button]:bg-black [&_button]:text-white [&_button]:border-zinc-700 [&_button:hover]:bg-zinc-900">
          <div className="flex items-center gap-1.5 sm:gap-3 min-w-0 flex-1">
            {session?.parentID ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleParentSessionClick}
                  className="text-purple-600 dark:text-purple-400 hover:text-purple-700 dark:hover:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900/20 h-7 px-2 gap-1"
                  title="Back to parent session"
                >
                  <CornerUpLeft className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline text-xs">Parent</span>
                </Button>
                <div className="sm:hidden">
                  <Header.BackButton to={sessionBackPath} className="text-xs" />
                </div>
              </>
            ) : (
              <Header.BackButton to={sessionBackPath} className="text-xs sm:hidden" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1 text-xs sm:text-base font-semibold">
                {!isGeneralChatProject && (
                  <>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="min-w-0 max-w-[38vw] truncate rounded px-1 -mx-1 text-orange-600 transition-colors hover:bg-accent dark:text-orange-400">
                          <span className="truncate">{workspaceDisplayName}</span>
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-72 max-h-96 overflow-y-auto">
                        <DropdownMenuLabel>Switch project</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {selectableProjects.map((project) => (
                          <DropdownMenuItem
                            key={project.id}
                            onClick={() => navigate(`/projects/${project.id}`)}
                            className={project.id === repoId ? "bg-accent" : undefined}
                          >
                            <span className="truncate">{project.name}</span>
                          </DropdownMenuItem>
                        ))}
                        {selectableProjects.length === 0 && (
                          <div className="px-2 py-1.5 text-sm text-muted-foreground">No projects available</div>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <span className="text-muted-foreground">/</span>
                  </>
                )}
                <Popover open={sessionsPopoverOpen} onOpenChange={setSessionsPopoverOpen}>
                  <PopoverTrigger asChild>
                     <button
                       aria-label={`Switch session: ${sessionTitle}`}
                      className="flex min-w-0 items-center gap-1 rounded px-1 -mx-1 transition-colors hover:bg-accent"
                      title="Switch session"
                    >
                      <span className="truncate bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">{sessionTitle}</span>
                      <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="h-[min(70vh,34rem)] w-[min(92vw,34rem)] p-0">
                    {apiUrl && (
                      <SessionList
                        apiUrl={apiUrl}
                        directory={repoDirectory}
                        activeSessionID={sessionId || undefined}
                        onSelectSession={(selectedSessionID) => {
                          navigate(`/projects/${repoId}/sessions/${selectedSessionID}${sessionRouteSuffix}`)
                          setSessionsPopoverOpen(false)
                        }}
                        onNewSession={() => {
                          handleNewSession()
                          setSessionsPopoverOpen(false)
                        }}
                      />
                    )}
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>
          <Header.Actions className="gap-2 sm:gap-4">
            <div className="flex items-center gap-1">
              <PendingActionsGroup />
            </div>
             <ContextUsageIndicator
              apiUrl={apiUrl}
              sessionID={sessionId}
              directory={repoDirectory}
              isConnected={isConnected}
              isReconnecting={isReconnecting}
              messages={messages}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="Export transcript" disabled={exportingFormat !== null}>
                  <Download className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Export transcript</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void handleExport('markdown')}>Markdown</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void handleExport('text')}>Plain text</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void handleExport('json')}>JSON</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <SessionMoreButton />
          </Header.Actions>
        </Header>

        <div className="px-3 sm:px-4">
          <SessionTodoDisplay sessionID={sessionId} />
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden flex flex-col">
        <div key={sessionId} ref={messageContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [mask-image:linear-gradient(to_bottom,transparent,black_16px,black)]" style={{ paddingBottom: promptOverlayHeight + inputBottomOffset + PROMPT_OVERLAY_CLEARANCE_PX }}>
          {repoLoading || sessionLoading || messagesLoading ? (
            <MessageSkeleton />
          ) : apiUrl && repoDirectory ? (
            <MessageThread 
              apiUrl={apiUrl} 
              sessionID={sessionId} 
              directory={repoDirectory}
              messages={messages}
              onChildSessionClick={handleChildSessionClick}
              onUndoMessage={handleUndoMessage}
              model={modelString || undefined}
              suggestionsByAssistantId={suggestionsByAssistantId}
              onSuggestionSelect={handleSuggestionSelect}
            />
          ) : null}
        </div>
        {apiUrl && repoDirectory && !isEditingMessage && (
          <div
            ref={promptOverlayRef}
            className="absolute left-0 right-0 flex justify-center"
            style={{ bottom: inputBottomOffset }}
          >
            <div className="relative w-[94%] md:max-w-4xl">
              <div className="absolute -top-9 right-0 z-50 flex flex-col items-end gap-2">
              </div>
              {leaderActive && (
                <div className="absolute -top-12 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-primary/90 text-primary-foreground border border-primary shadow-lg backdrop-blur-md animate-pulse">
                  <span className="text-sm font-medium">Waiting for shortcut key...</span>
                </div>
              )}
              {minimizedQuestion && minimizedQuestion.sessionID === sessionId && (
                <MinimizedQuestionIndicator
                  question={minimizedQuestion}
                  onRestore={handleRestoreQuestion}
                  onDismiss={() => rejectQuestion(minimizedQuestion.id)}
                />
              )}
              {!minimizedQuestion && currentQuestion && currentQuestion.sessionID === sessionId && (
                <QuestionPrompt
                  key={currentQuestion.id}
                  question={currentQuestion}
                  onReply={replyToQuestion}
                  onReject={rejectQuestion}
                  onMinimize={() => handleMinimizeQuestion(currentQuestion)}
                />
              )}
              {activePermission && (
                <PermissionRequestDialog
                  key={activePermission.id}
                  permission={activePermission}
                  pendingCount={pendingPermissionCount}
                  isFromDifferentSession={false}
                  sessionTitle={sessionTitle}
                  repoDirectory={repoDirectory}
                  onRespond={respondToPermission}
                />
              )}
              <SessionSendErrorBanner sessionId={sessionId} />
              {inFlightPrompt && (
                <div
                  role="status"
                  data-testid="in-flight-prompt-state"
                  className="mb-2 rounded-xl border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm text-blue-900 dark:text-blue-100"
                >
                  Prompt delivery is in progress. It will not be sent again automatically.
                </div>
              )}
              {interruptedPrompt && (
                <div
                  role="alert"
                  data-testid="interrupted-prompt-state"
                  className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
                >
                  <span className="text-amber-900 dark:text-amber-100">
                    {interruptedPrompt.status === 'unknown'
                      ? 'Prompt delivery outcome is unknown. It was not retried automatically.'
                      : 'Prompt delivery was interrupted. It was not retried automatically.'}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleRetryInterruptedPrompt}
                      disabled={!isConnected || sendPendingPrompt.isPending}
                    >
                      Retry
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleDiscardInterruptedPrompt}
                    >
                      Discard
                    </Button>
                  </div>
                </div>
              )}
              {(queue.data?.length ?? 0) > 0 && (
                <div className="mb-2 rounded-xl border border-border bg-muted/60 px-3 py-2" data-testid="enqueued-card">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium">Enqueued</span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => clearQueue.mutate({ sessionID: sessionId! })}>Clear</Button>
                  </div>
                  <div className="space-y-1">
                    {queuedEntries.map((entry, index) => (
                      <div key={entry.clientId} className="flex items-center gap-2 rounded-lg bg-background/60 px-2 py-1.5 text-sm">
                        <span className="min-w-0 flex-1 truncate">{entry.content}</span>
                        {entry.state === 'failed' && <Button type="button" variant="ghost" size="sm" onClick={() => retryQueueEntry.mutate({ sessionID: sessionId!, clientId: entry.clientId })}>Retry</Button>}
                        <Button type="button" variant="ghost" size="sm" aria-label="Move queued message up" disabled={index === 0} onClick={() => reorderQueueEntry.mutate({ sessionID: sessionId!, clientId: entry.clientId, position: index - 1 })}>Up</Button>
                        <Button type="button" variant="ghost" size="sm" aria-label="Move queued message down" disabled={index === queuedEntries.length - 1} onClick={() => reorderQueueEntry.mutate({ sessionID: sessionId!, clientId: entry.clientId, position: index + 1 })}>Down</Button>
                        <Button type="button" variant="ghost" size="sm" onClick={() => removeQueueEntry.mutate({ sessionID: sessionId!, clientId: entry.clientId })}>Remove</Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <ChatInputBar
                ref={promptInputRef}
                directory={repoDirectory}
                defaultProjectId={repoId.toString()}
                defaultAgent={sessionAgent.agent ? sessionAgent.agent : "__default__"}
                defaultModel={sessionAgent.model ? `${sessionAgent.model.providerID}/${sessionAgent.model.modelID}` : "__auto__"}
                defaultPermission={sessionAgent.permission ?? "default"}
                sessionID={sessionId}
                disabled={!isConnected}
                isSessionActive={isStreamingResponse}
                onScrollToBottom={scrollToBottom}
              />
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
