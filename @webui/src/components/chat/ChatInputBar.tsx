import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FolderKanban, Paperclip, Send, Square, X } from "lucide-react";
import { GENERAL_CHAT_PROJECT_ID } from "@subpolar/shared/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgents, useAbortSession, useConfig, useCreateSession, useSendPrompt } from "@/hooks/usePiHarness";
import { getProviders } from "@/api/providers";
import { DEFAULT_USER_PREFERENCES } from "@/api/types/settings";
import { getProject, listProjectMentions, listProjects, loadMentionContext, type MentionContextItem, type Project } from "@/api/projects";
import { SUBPOLAR_API_BASE_URL } from "@/config";
import { useSettings } from "@/hooks/useSettings";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { MentionSuggestions, type MentionItem } from "@/components/message/MentionSuggestions";

export interface ChatInputBarHandle {
  setPromptValue: (value: string) => void;
  clearPrompt: () => void;
  triggerFileUpload: () => void;
}

export interface PendingSessionPrompt {
  prompt: string;
  model?: string;
  agent?: string;
  permission?: string;
}

const PERMISSION_OPTIONS = [
  { value: "default", label: "Default Permissions" },
  { value: "ask", label: "Ask for Permissions" },
  { value: "none", label: "No Permissions" },
  { value: "allow_all", label: "Dangerously Allow All" },
] as const;

interface ChatInputBarProps {
  placeholder?: string;
  onSend?: () => void;
  defaultProjectId?: string;
  defaultAgent?: string;
  defaultModel?: string;
  defaultPermission?: string;
  sendImmediately?: boolean;
  sessionID?: string;
  directory?: string;
  disabled?: boolean;
  isSessionActive?: boolean;
  hideAgentSelect?: boolean;
  onPromptChange?: (hasContent: boolean) => void;
  onScrollToBottom?: () => void;
}

export const ChatInputBar = forwardRef<ChatInputBarHandle, ChatInputBarProps>(function ChatInputBar(
  {
    placeholder = "Send a message...",
    onSend,
    defaultProjectId,
    defaultAgent = "__default__",
    defaultModel,
    defaultPermission = "default",
    sendImmediately = false,
    sessionID,
    directory,
    disabled = false,
    isSessionActive = false,
    hideAgentSelect = false,
    onPromptChange,
    onScrollToBottom,
  }: ChatInputBarProps,
  ref,
) {
  const navigate = useNavigate();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { preferences } = useSettings();
  const effectiveDefaultModel = defaultModel ?? preferences?.defaultModel ?? "__auto__";

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(defaultProjectId ?? null);
  const [selectedAgent, setSelectedAgent] = useState(defaultAgent);
  const [selectedModel, setSelectedModel] = useState(effectiveDefaultModel);
  const [selectedPermission, setSelectedPermission] = useState(defaultPermission);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const [hasPromptContent, setHasPromptContent] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const [selectedMentions, setSelectedMentions] = useState<MentionContextItem[]>([]);

  const apiUrl = SUBPOLAR_API_BASE_URL;

  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
  });

  const { data: generalChatProject } = useQuery({
    queryKey: ["project", GENERAL_CHAT_PROJECT_ID],
    queryFn: () => getProject(GENERAL_CHAT_PROJECT_ID),
  });

  const getProjectIdValue = (project: Project) => {
    if (project.id === null || project.id === undefined) return null;
    return String(project.id);
  };

  const targetProjectId = selectedProjectId ?? GENERAL_CHAT_PROJECT_ID.toString();
  const selectedProject = targetProjectId === GENERAL_CHAT_PROJECT_ID.toString()
    ? generalChatProject
    : projects.find((p) => getProjectIdValue(p) === targetProjectId);
  const isGeneralChatProject = targetProjectId === GENERAL_CHAT_PROJECT_ID.toString();
  const selectedDirectory = sessionID ? directory : selectedProject?.fullPath;
  const canMentionContext = Boolean(selectedDirectory);

  const { data: agents = [] } = useAgents(apiUrl, selectedDirectory);
  const hiddenChatInputAgents = useMemo(
    () => new Set((preferences?.hiddenChatInputAgents ?? DEFAULT_USER_PREFERENCES.hiddenChatInputAgents).map((name) => name.toLowerCase())),
    [preferences?.hiddenChatInputAgents],
  );
  const visibleAgents = useMemo(
    () => {
      const overrideNames = selectedProject?.hasAgentOverride ? new Set(selectedProject.agentNames ?? []) : null;
      return agents.filter((agent) =>
        !hiddenChatInputAgents.has(agent.name.toLowerCase()) &&
        (!overrideNames || overrideNames.has(agent.name)));
    },
    [agents, hiddenChatInputAgents, selectedProject?.agentNames, selectedProject?.hasAgentOverride],
  );
  const { data: config } = useConfig(apiUrl, selectedDirectory);

  const { data: providersData } = useQuery({
    queryKey: ["subpolar", "providers", apiUrl],
    queryFn: () => getProviders(),
    staleTime: 30000,
  });

  const { data: mentionResults } = useQuery({
    queryKey: ["project-mentions", selectedDirectory, mentionQuery ?? ""],
    queryFn: () => listProjectMentions(selectedDirectory!, mentionQuery ?? ""),
    enabled: canMentionContext && mentionQuery !== null,
    staleTime: 30000,
  });

  const mentionItems = useMemo<MentionItem[]>(() => {
    if (mentionQuery === null) return [];
    const files = (mentionResults?.files ?? []).slice(0, 10).map((file) => ({
      type: "file" as const,
      value: file,
      label: file,
    }));
    const skills = (mentionResults?.skills ?? []).slice(0, 10).map((skill) => ({
      type: "skill" as const,
      value: skill.name,
      label: skill.name,
      description: skill.description,
    }));
    return [...files, ...skills].slice(0, 10);
  }, [mentionQuery, mentionResults]);

  const models = useMemo(() => {
    const providers = providersData?.providers;
    if (!providers) return [];

    const configuredProviders = config?.provider ?? {};
    const disabledProviders = new Set(config?.disabled_providers ?? []);
    const connectedProviders = new Set(providersData?.connected ?? []);

    const result: {
      id: string;
      providerID: string;
      modelID: string;
      name: string;
      providerName: string;
    }[] = [];

    for (const provider of providers) {
      if (disabledProviders.has(provider.id)) continue;

      const isConfigured = provider.id in configuredProviders;
      const isConnected = connectedProviders.has(provider.id);
      if (!isConfigured && !isConnected) continue;

      const configuredModels = configuredProviders[provider.id]?.models;
      const enabledModelKeys = configuredModels
        ? new Set(Object.keys(configuredModels))
        : null;

      for (const [key, model] of Object.entries(provider.models)) {
        if (enabledModelKeys && !enabledModelKeys.has(key)) continue;

        result.push({
          id: `${provider.id}/${key}`,
          providerID: provider.id,
          modelID: key,
          name: model.name || key,
          providerName: provider.name,
        });
      }
    }

    return result;
  }, [providersData, config]);

  const modelsByProvider = useMemo(() => {
    const map = new Map<string, typeof models>();
    for (const model of models) {
      const group = map.get(model.providerName) ?? [];
      group.push(model);
      map.set(model.providerName, group);
    }
    return map;
  }, [models]);

  const selectedAgentForRequest = selectedAgent === "__default__" || (!hideAgentSelect && !visibleAgents.some((agent) => agent.name === selectedAgent))
    ? undefined
    : selectedAgent;
  const selectedPermissionForRequest = selectedPermission === "default" && !selectedAgentForRequest
    ? "ask"
    : selectedPermission;

  const createSession = useCreateSession(apiUrl, selectedDirectory);
  const sendPrompt = useSendPrompt(apiUrl, selectedDirectory);
  const abortSession = useAbortSession(apiUrl, selectedDirectory, sessionID ?? activeSessionId);
  const isGeneratingMessage = isSessionActive;
  const isWaitingForAnswer = isGeneratingMessage || sendPrompt.isPending;

  useEffect(() => {
    setSelectedProjectId(defaultProjectId ?? null);
  }, [defaultProjectId]);

  useEffect(() => {
    setSelectedAgent(defaultAgent);
  }, [defaultAgent]);

  useEffect(() => {
    setSelectedModel(effectiveDefaultModel);
  }, [effectiveDefaultModel]);

  useEffect(() => {
    setSelectedPermission(defaultPermission);
  }, [defaultPermission]);

  useImperativeHandle(ref, () => ({
    setPromptValue: (value: string) => {
      if (!textareaRef.current) return;
      textareaRef.current.value = value;
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
      textareaRef.current.focus();
      const hasContent = value.trim().length > 0;
      setHasPromptContent(hasContent);
      onPromptChange?.(hasContent);
    },
    clearPrompt: () => {
      if (!textareaRef.current) return;
      textareaRef.current.value = "";
      textareaRef.current.style.height = "auto";
      textareaRef.current.focus();
      setHasPromptContent(false);
      onPromptChange?.(false);
    },
    triggerFileUpload: () => {
      fileInputRef.current?.click();
    },
  }), [onPromptChange]);

  const handleTextareaInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      e.target.style.height = "auto";
      e.target.style.height = `${e.target.scrollHeight}px`;
      const hasContent = e.target.value.trim().length > 0;
      setHasPromptContent(hasContent);
      onPromptChange?.(hasContent);
      const cursor = e.target.selectionStart;
      const beforeCursor = e.target.value.slice(0, cursor);
      const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
      setMentionQuery(match ? match[1] : null);
      setSelectedMentionIndex(0);
    },
    [onPromptChange],
  );

  const insertMention = useCallback((item: MentionItem) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursor = textarea.selectionStart;
    const beforeCursor = textarea.value.slice(0, cursor);
    const afterCursor = textarea.value.slice(cursor);
    const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match || match.index === undefined) return;
    const prefixEnd = beforeCursor[match.index] === "@" ? match.index : match.index + 1;
    const nextValue = `${textarea.value.slice(0, prefixEnd)}@${item.value} ${afterCursor}`;
    textarea.value = nextValue;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
    setSelectedMentions((mentions) => {
      const next = { type: item.type, value: item.value };
      if (mentions.some((mention) => mention.type === next.type && mention.value === next.value)) return mentions;
      return [...mentions, next].slice(-10);
    });
    setMentionQuery(null);
    setHasPromptContent(nextValue.trim().length > 0);
    onPromptChange?.(nextValue.trim().length > 0);
    requestAnimationFrame(() => {
      textarea.focus();
      const position = prefixEnd + item.value.length + 2;
      textarea.setSelectionRange(position, position);
    });
  }, [onPromptChange]);

  const buildPromptWithMentionContext = useCallback(async (rawPrompt: string, workspaceDirectory: string | undefined, mentions: MentionContextItem[]) => {
    if (!workspaceDirectory || mentions.length === 0) return rawPrompt;
    try {
      const context = await loadMentionContext(workspaceDirectory, mentions);
      return context ? `${rawPrompt}\n\n<context>\n${context}\n</context>` : rawPrompt;
    } catch {
      showToast.error("Failed to load mentioned context");
      return null;
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    const targetSessionId = sessionID ?? activeSessionId;

    if (isGeneratingMessage && targetSessionId) {
      abortSession.mutate(targetSessionId);
      return;
    }

    if (sendPrompt.isPending) return;

    const rawPrompt = textareaRef.current?.value.trim();
    if (!rawPrompt) return;
    if (!sessionID && !selectedProject) {
      showToast.error(sendImmediately ? "Select a project before sending" : "General chat is still loading");
      return;
    }

    const prompt = await buildPromptWithMentionContext(rawPrompt, selectedDirectory, selectedMentions);
    if (!prompt) return;

    if (sessionID) {
      textareaRef.current!.value = "";
      textareaRef.current!.style.height = "auto";
      setHasPromptContent(false);
      setSelectedMentions([]);
      onPromptChange?.(false);
      sendPrompt.mutate(
        {
          sessionID,
          prompt,
          model: selectedModel === "__auto__" ? undefined : selectedModel,
          agent: selectedAgentForRequest,
          permission: selectedPermissionForRequest,
        },
        {
          onSuccess: () => {
            onScrollToBottom?.();
            onSend?.();
          },
        },
      );
      return;
    }

    try {
      const session = await createSession.mutateAsync({});

      if (sendImmediately) {
        setActiveSessionId(session.id);
        textareaRef.current!.value = "";
        textareaRef.current!.style.height = "auto";
        setHasPromptContent(false);
        setSelectedMentions([]);
        onPromptChange?.(false);
        navigate(`/projects/${targetProjectId}/sessions/${session.id}`, {
          state: {
            pendingPrompt: {
              prompt,
              model: selectedModel === "__auto__" ? undefined : selectedModel,
              agent: selectedAgentForRequest,
              permission: selectedPermissionForRequest,
            } satisfies PendingSessionPrompt,
          },
        });
        onSend?.();
        return;
      }

      setActiveSessionId(session.id);
      textareaRef.current!.value = "";
      textareaRef.current!.style.height = "auto";
      setHasPromptContent(false);
      setSelectedMentions([]);
      onPromptChange?.(false);
      navigate(`/projects/${targetProjectId}/sessions/${session.id}`, {
        state: {
          pendingPrompt: {
            prompt,
            model: selectedModel === "__auto__" ? undefined : selectedModel,
            agent: selectedAgentForRequest,
            permission: selectedPermissionForRequest,
          } satisfies PendingSessionPrompt,
        },
      });

      onSend?.();
    } catch {
      showToast.error("Failed to create session");
    }
  }, [
    abortSession,
    activeSessionId,
    buildPromptWithMentionContext,
    createSession,
    sessionID,
    isGeneratingMessage,
    navigate,
    onPromptChange,
    onScrollToBottom,
    onSend,
    selectedAgentForRequest,
    selectedModel,
    selectedPermissionForRequest,
    selectedProject,
    selectedDirectory,
    selectedMentions,
    sendImmediately,
    sendPrompt,
    targetProjectId,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionQuery !== null && mentionItems.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedMentionIndex((index) => Math.min(index + 1, mentionItems.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedMentionIndex((index) => Math.max(index - 1, 0));
          return;
        }
        if (e.key === "Tab" || e.key === "Enter") {
          e.preventDefault();
          insertMention(mentionItems[selectedMentionIndex]);
          return;
        }
        if (e.key === "Escape") {
          setMentionQuery(null);
          return;
        }
      }
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit, insertMention, mentionItems, mentionQuery, selectedMentionIndex],
  );

  const selectedProjectName = isGeneralChatProject ? null : selectedProject?.name ?? null;

  return (
    <div className="w-full max-w-3xl mx-auto">
      <div className="relative backdrop-blur-md bg-muted/50 rounded-xl p-4 shadow-lg">
        <MentionSuggestions
          isOpen={mentionQuery !== null && mentionItems.length > 0}
          items={mentionItems}
          onSelect={insertMention}
          onClose={() => setMentionQuery(null)}
          selectedIndex={selectedMentionIndex}
        />
          <textarea
            ref={textareaRef}
            onChange={handleTextareaInput}
            onKeyDown={handleKeyDown}
            disabled={disabled}
          placeholder={placeholder}
          rows={1}
          style={{ height: "auto", overflow: "hidden" }}
            className="w-full bg-transparent text-[18px] text-foreground placeholder-muted-foreground focus:outline-none resize-none rounded-lg"
          />
        <input ref={fileInputRef} type="file" className="hidden" />

        <div className="flex mt-3 items-center">
          {!sessionID && (
          <Select
            value={selectedProjectId ?? undefined}
            onValueChange={(v) => {
              setSelectedProjectId(v);
            }}
          >
            <SelectTrigger
              className={cn(
                "h-8 flex-shrink-0 border-0 focus:ring-0 focus:ring-offset-0 text-xs gap-1.5 rounded-md [&>svg:last-child]:hidden",
                selectedProjectId && !isGeneralChatProject
                  ? "bg-primary text-primary-foreground hover:bg-primary/90 w-auto px-2"
                  : "bg-muted hover:bg-muted/80 w-8 px-0 justify-center",
              )}
            >
              <FolderKanban className="h-4 w-4 flex-shrink-0" />
              {selectedProjectName && (
                <span className="max-w-[80px] truncate">{selectedProjectName}</span>
              )}
            </SelectTrigger>
            <SelectContent className="max-h-[300px] overflow-y-auto">
              {projects.map((project) => {
                const projectId = getProjectIdValue(project);
                if (!projectId) return null;

                return (
                  <SelectItem key={projectId} value={projectId}>
                    {project.name}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          )}

          <Button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            size="icon"
            className="h-8 w-8 flex-shrink-0 border-0 bg-muted hover:bg-muted/80 text-foreground ml-2"
          >
            <Paperclip className="h-4 w-4" />
          </Button>

          {!hideAgentSelect && (
            <Select
              value={selectedAgent}
              onValueChange={setSelectedAgent}
            >
              <SelectTrigger className="h-8 text-xs border-0 bg-transparent focus:ring-0 focus:ring-offset-0 gap-2">
                <SelectValue placeholder="Agent" />
              </SelectTrigger>
              <SelectContent className="max-h-[300px] overflow-y-auto">
                <SelectItem value="__default__">Agent</SelectItem>
                {visibleAgents.map((agent) => (
                  <SelectItem key={agent.name} value={agent.name}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select value={selectedModel} onValueChange={setSelectedModel}>
            <SelectTrigger className="h-8 text-xs border-0 bg-transparent focus:ring-0 focus:ring-offset-0 gap-2">
              <SelectValue placeholder="Model" />
            </SelectTrigger>
            <SelectContent className="max-h-[300px] overflow-y-auto">
              <SelectItem value="__auto__">Auto Model</SelectItem>
              <SelectSeparator />
              {Array.from(modelsByProvider.entries()).map((
                [providerName, providerModels],
                index,
              ) => (
                <SelectGroup key={providerName}>
                  {index > 0 && <SelectSeparator />}
                  <SelectLabel>{providerName}</SelectLabel>
                  {providerModels.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={selectedPermission}
            onValueChange={setSelectedPermission}
          >
            <SelectTrigger className="h-8 text-xs border-0 bg-transparent focus:ring-0 focus:ring-offset-0 w-fit gap-2">
              <SelectValue placeholder="Permissions" />
            </SelectTrigger>
            <SelectContent className="max-h-[300px] overflow-y-auto">
              {PERMISSION_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <span className="w-full" />

          {hasPromptContent && !isWaitingForAnswer && (
            <Button
              type="button"
              onClick={() => {
                if (!textareaRef.current) return;
                textareaRef.current.value = "";
                textareaRef.current.style.height = "auto";
                textareaRef.current.focus();
                setHasPromptContent(false);
                onPromptChange?.(false);
              }}
              size="icon"
              variant="ghost"
              className="absolute right-4 bottom-14 h-7 w-7 rounded-full bg-muted/90 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Clear message"
            >
              <X className="h-4 w-4" />
            </Button>
          )}

          <Button
            onClick={handleSubmit}
            disabled={disabled || createSession.isPending || abortSession.isPending || (sendPrompt.isPending && !isGeneratingMessage)}
            size="icon"
            className="h-8 w-8 flex-shrink-0"
          >
            {isGeneratingMessage ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
});
