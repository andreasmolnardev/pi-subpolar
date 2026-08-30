import { useMemo, useState } from "react";
import { useParams, useNavigate, Navigate, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getProject, hasProjectId, listProjects } from "@/api/projects";
import { MessageThread } from "@/components/message/MessageThread";
import { ChatInputBar, type ChatInputBarHandle, type PendingSessionPrompt } from "@/components/chat/ChatInputBar";
import { FloatingTTSButton } from '@/components/message/FloatingTTSButton'
import { ChevronDown, CornerUpLeft } from "lucide-react";
import { Header } from "@/components/ui/header";
import { SessionList } from "@/components/session/SessionList";
import { getSessionListPath } from '@/lib/navigation'
import { GENERAL_CHAT_PROJECT_ID } from '@subpolar/shared/utils'

import { FileBrowserSheet } from "@/components/file-browser/FileBrowserSheet";
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
import { useSession, useAbortSession, useMessages, useCreateSession, useSendPrompt } from "@/hooks/usePiHarness";
import { useProjectActivity } from "@/hooks/useProjectActivity";
import { SUBPOLAR_API_BASE_URL } from "@/config";
import { useSSE } from "@/hooks/useSSE";
import { useUIState } from "@/stores/uiStateStore";
import { useModelSelection } from "@/hooks/useModelSelection";
import { useSessionAgent } from "@/hooks/useSessionAgent";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useSettingsDialog } from "@/hooks/useSettingsDialog";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useMobile } from "@/hooks/useMobile";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { useTTS } from "@/hooks/useTTS";
import { getAssistantText, getLatestPlayableAssistantMessage, useAutoPlayLastResponse } from "@/hooks/useAutoPlayLastResponse";
import { useEffect, useRef, useCallback } from "react";
import { MessageSkeleton } from "@/components/message/MessageSkeleton";
import { getMessagesContentVersion } from "./sessionContentVersion";
import { showToast } from "@/lib/toast";
import { createSubpolarClient } from '@/api/subpolar';
import { usePermissions, useQuestions } from "@/contexts/EventContext";
import { useSessionStatusForSession } from "@/stores/sessionStatusStore";
import type { QuestionRequest } from "@/api/types";
import { QuestionPrompt } from "@/components/session/QuestionPrompt";
import { MinimizedQuestionIndicator } from "@/components/session/MinimizedQuestionIndicator";
import { PermissionRequestDialog } from "@/components/session/PermissionRequestDialog";
import { PendingActionsGroup } from "@/components/notifications/PendingActionsGroup";
import { SessionSendErrorBanner } from "@/components/session/SessionSendErrorBanner";
import { SessionTodoDisplay } from "@/components/message/SessionTodoDisplay";
import { useDialogParam } from "@/hooks/useDialogParam";
import { useSidebarAction } from "@/hooks/useSidebarAction";
import { SessionMoreButton } from "@/components/navigation/SessionMoreButton";

const compareMessageIds = (id1: string, id2: string): number => {
  const num1 = parseInt(id1, 10)
  const num2 = parseInt(id2, 10)
  if (!isNaN(num1) && !isNaN(num2)) return num1 - num2
  return id1.localeCompare(id2)
}

const PENDING_ACTION_SYNC_INTERVAL_MS = 30000
const PROMPT_OVERLAY_CLEARANCE_PX = 16

type PendingPromptLocationState = {
  pendingPrompt?: PendingSessionPrompt
}

export function SessionDetail() {
  const { id, sessionId } = useParams<{ id: string; sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const repoId = Number(id) || 0;
  const { open: openSettings } = useSettingsDialog();
  const messageContainerRef = useRef<HTMLDivElement>(null);
  const promptInputRef = useRef<ChatInputBarHandle>(null);
  const consumedPendingPromptRef = useRef<string | null>(null);
  const [sessionsPopoverOpen, setSessionsPopoverOpen] = useState(false);
  const [fileBrowserOpen, setFileBrowserOpen] = useDialogParam('files');
  const [selectedFilePath, setSelectedFilePath] = useState<string | undefined>();
  const [hasPromptContent, setHasPromptContent] = useState(false);
  const [minimizedQuestion, setMinimizedQuestion] = useState<QuestionRequest | null>(null);

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

  const { data: repo, isLoading: repoLoading } = useQuery({
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

  const { data: rawMessages, isLoading: messagesLoading } = useMessages(apiUrl, sessionId, repoDirectory);
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

  const { scrollToBottom } = useAutoScroll({
    containerRef: messageContainerRef,
    messages: messages?.map(m => m.info),
    sessionId,
    contentVersion: messagesContentVersion,
    onScrollStateChange: () => {}
  });
  const abortSession = useAbortSession(apiUrl, repoDirectory, sessionId);
  const createSession = useCreateSession(apiUrl, repoDirectory);
  const sendPendingPrompt = useSendPrompt(apiUrl, repoDirectory);
  const { model, modelString } = useModelSelection(apiUrl, repoDirectory);
  const sessionAgent = useSessionAgent(apiUrl, sessionId, repoDirectory);
  const isEditingMessage = useUIState((state) => state.isEditingMessage);
  const setActivePromptFileBasePath = useUIState((state) => state.setActivePromptFileBasePath);
  const { isEnabled: ttsEnabled } = useTTS();
  const sessionStatus = useSessionStatusForSession(sessionId);
  const {
    pendingCount: pendingPermissionCount,
    respond: respondToPermission,
    getForSession: getPermissionForSession,
    syncForSession: syncPermissionsForSession,
  } = usePermissions();
  const { current: currentQuestion, reply: replyToQuestion, reject: rejectQuestion, syncForSession: syncQuestionsForSession } = useQuestions();

  const lastAssistantMessage = messages?.filter(m => m.info.role === 'assistant').at(-1);
  const lastAssistantText = getAssistantText(lastAssistantMessage);
  const latestPlayableAssistant = useMemo(() => getLatestPlayableAssistantMessage(messages), [messages]);
  
  const isSessionActive = useMemo(() => {
    if (session?.time?.compacting) return true
    if (sessionStatus.type !== 'idle') return true
    if (lastAssistantMessage && !('completed' in lastAssistantMessage.info.time)) return true
    return false
  }, [lastAssistantMessage, session?.time?.compacting, sessionStatus.type])
  const hasIncompleteMessages = lastAssistantMessage ? !('completed' in lastAssistantMessage.info.time && lastAssistantMessage.info.time.completed) : false;
  const isStreamingResponse = hasIncompleteMessages && isSessionActive;
  const workspaceBasePath = repo?.localPath;
  const pendingPrompt = (location.state as PendingPromptLocationState | null)?.pendingPrompt;
  const activePermission = getPermissionForSession(sessionId);

  useEffect(() => {
    if (!pendingPrompt || !sessionId || !isConnected || messagesLoading) return

    const pendingPromptKey = `${sessionId}:${pendingPrompt.prompt}`
    if (consumedPendingPromptRef.current === pendingPromptKey) return
    consumedPendingPromptRef.current = pendingPromptKey

    sendPendingPrompt.mutate({
      sessionID: sessionId,
      prompt: pendingPrompt.prompt,
      model: pendingPrompt.model,
      agent: pendingPrompt.agent,
      permission: pendingPrompt.permission,
      queued: true,
    })

    navigate(`${location.pathname}${location.search}`, { replace: true, state: null })
  }, [
    isConnected,
    location.pathname,
    location.search,
    messagesLoading,
    navigate,
    pendingPrompt,
    sendPendingPrompt,
    sessionId,
  ])

  useEffect(() => {
    setActivePromptFileBasePath(repoDirectory ? workspaceBasePath ?? null : null)

    return () => {
      setActivePromptFileBasePath(null)
    }
  }, [repoDirectory, setActivePromptFileBasePath, workspaceBasePath])

  useAutoPlayLastResponse({
    sessionId: sessionId ?? '',
    lastAssistantMessage,
    lastAssistantText,
    isStreamingResponse,
  });

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

  const handleNewSession = useCallback(async () => {
    try {
      const newSession = await createSession.mutateAsync({ agent: undefined });
      if (newSession?.id) {
        navigate(`/repos/${repoId}/sessions/${newSession.id}${sessionRouteSuffix}`);
      }
    } catch {
      showToast.error('Failed to create new session');
    }
  }, [createSession, navigate, repoId, sessionRouteSuffix]);

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
        navigate(`/repos/${repoId}/sessions/${forkedSession.id}${sessionRouteSuffix}`);
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
    openSettings,
    newSession: handleNewSession,
    closeSession: handleCloseSession,
    compact: handleCompact,
    undo: handleUndo,
    redo: handleRedo,
    fork: handleFork,
    toggleSidebar: () => setFileBrowserOpen(!fileBrowserOpen),
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

  

  const handleFileClick = useCallback((filePath: string) => {
    let pathToOpen = filePath
    
    if (filePath.startsWith('/') && repo?.fullPath) {
      const workspaceReposPath = repo.fullPath.substring(0, repo.fullPath.lastIndexOf('/'))
      
      if (filePath.startsWith(workspaceReposPath + '/')) {
        pathToOpen = filePath.substring(workspaceReposPath.length + 1)
      }
    }
    
    setSelectedFilePath(pathToOpen)
    setFileBrowserOpen(true)
  }, [repo?.fullPath, setFileBrowserOpen]);

  const handleFileBrowserClose = useCallback(() => {
    setFileBrowserOpen(false)
    setSelectedFilePath(undefined)
  }, [setFileBrowserOpen]);

  const handleChildSessionClick = useCallback((childSessionId: string) => {
    navigate(`/repos/${repoId}/sessions/${childSessionId}${sessionRouteSuffix}`)
  }, [navigate, repoId, sessionRouteSuffix]);

  const handleParentSessionClick = useCallback(() => {
    if (session?.parentID) {
      navigate(`/repos/${repoId}/sessions/${session.parentID}${sessionRouteSuffix}`)
    }
  }, [navigate, repoId, session?.parentID, sessionRouteSuffix]);

  const handleUndoMessage = useCallback((restoredPrompt: string) => {
    promptInputRef.current?.setPromptValue(restoredPrompt)
  }, []);

  if (!sessionId) {
    return <Navigate to="/" replace />;
  }

  if (!repo) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-background via-background to-background">
        <div className="flex flex-col items-center gap-2">
          <div className="w-8 h-8 animate-spin rounded-full border-2 border-muted border-t-foreground" />
          <span className="text-muted-foreground">Loading project...</span>
        </div>
      </div>
    );
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
              onFileClick={handleFileClick}
              onChildSessionClick={handleChildSessionClick}
              onUndoMessage={handleUndoMessage}
              model={modelString || undefined}
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
                {ttsEnabled && !hasPromptContent && !isSessionActive && latestPlayableAssistant && (
                  <FloatingTTSButton
                    messageId={latestPlayableAssistant.message.info.id}
                    content={latestPlayableAssistant.text}
                  />
                )}
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
                onPromptChange={setHasPromptContent}
              />
            </div>
          </div>
        )}
      </div>

      <FileBrowserSheet
        isOpen={fileBrowserOpen}
        onClose={handleFileBrowserClose}
        basePath={workspaceBasePath}
        repoName={workspaceDisplayName}
        repoId={repoId}
        initialSelectedFile={selectedFilePath}
      />
    </div>
  );
}
