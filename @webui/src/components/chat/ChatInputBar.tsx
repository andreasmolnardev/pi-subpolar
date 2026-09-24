import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Clipboard, FileText, Image, Link, Paperclip, Plus, Send, X } from "lucide-react";
import { GENERAL_CHAT_PROJECT_ID } from "@subpolar/shared/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import { useAgents, useAbortSession, useConfig, useCreateSession, useSendPrompt, useSteer, useEnqueueFollowUp } from "@/hooks/usePiHarness";
import { getProviders } from "@/api/providers";
import { DEFAULT_USER_PREFERENCES } from "@/api/types/settings";
import { getProject, listProjectMentions, listProjects, loadMentionContext, type MentionContextItem, type Project } from "@/api/projects";
import { SUBPOLAR_API_BASE_URL } from "@/config";
import { useSettings } from "@/hooks/useSettings";
import { showToast } from "@/lib/toast";

import { MentionSuggestions, type MentionItem } from "@/components/message/MentionSuggestions";
import { savePendingSessionPrompt } from "@/lib/pending-session-prompt";
import { shouldBlockSessionCreation } from "@/lib/session-submit";
import { createProjectMarkdown, loadProjectAttachment, loadWebsiteAttachment } from "@/api/attachments";
import { attachmentToParts, validateAttachmentLimits, validateProjectPath, validateWebsiteUrl, type ChatAttachment } from "@/lib/attachments";
import { CommandSuggestions } from "@/components/command/CommandSuggestions";
import { useCommands } from "@/hooks/useCommands";
import { useCommandHandler } from "@/hooks/useCommandHandler";
import { useUIState } from "@/stores/uiStateStore";
import type { components } from "@/api/opencode-types";

export interface ChatInputBarHandle {
  setPromptValue: (value: string) => void;
  submitPrompt: (value: string) => void;
  clearPrompt: () => void;
  triggerFileUpload: () => void;
}

export interface PendingSessionPrompt {
  prompt: string;
  messageID: string;
  model?: string;
  agent?: string;
  permission?: string;
  routing?: boolean;
}

const LARGE_PASTE_THRESHOLD = 500;

const createClientMessageID = () => `optimistic_user_${Date.now()}_${Math.random()}`;


interface ChatInputBarProps {
  placeholder?: string;
  onSend?: () => void;
  defaultProjectId?: string;
  defaultAgent?: string;
  defaultModel?: string;
  defaultPermission?: string;
  projectId?: string;
  agent?: string;
  permission?: string;
  model?: string;
  onModelChange?: (model: string) => void;
  routingEnabled?: boolean;
  sendImmediately?: boolean;
  sessionID?: string;
  directory?: string;
  disabled?: boolean;
  isSessionActive?: boolean;
  hideAgentSelect?: boolean;
  hideModelSelect?: boolean;
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
    projectId,
    agent,
    permission,
    model,
    onModelChange,
    routingEnabled = false,
    sendImmediately = false,
    sessionID,
    directory,
    disabled = false,
    isSessionActive = false,
    hideAgentSelect = false,
    hideModelSelect = false,
    onPromptChange,
    onScrollToBottom,
  }: ChatInputBarProps,
  ref,
) {
  const navigate = useNavigate();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { preferences } = useSettings();
  const effectiveDefaultModel = defaultModel ?? preferences?.defaultModel ?? "__auto__";

  const [internalProjectId, setInternalProjectId] = useState<string | null>(defaultProjectId ?? null);
  const [internalAgent, setInternalAgent] = useState(defaultAgent);
  const [selectedModel, setSelectedModel] = useState(effectiveDefaultModel);
  const currentModel = model ?? selectedModel;
  const internalModelChange = useCallback((value: string) => {
    setSelectedModel(value);
    onModelChange?.(value);
  }, [onModelChange]);
  const [internalPermission, setInternalPermission] = useState(defaultPermission);
  const selectedProjectId = projectId ?? internalProjectId;
  const selectedAgent = agent ?? internalAgent;
  const selectedPermission = permission ?? internalPermission;
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const [hasPromptContent, setHasPromptContent] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const [commandQuery, setCommandQuery] = useState<string | null>(null);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [selectedMentions, setSelectedMentions] = useState<MentionContextItem[]>([]);
  const [pastedText, setPastedText] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const creatingSessionRef = useRef(false);
  const pendingCommand = useUIState((state) => state.pendingPromptCommand);
  const clearPendingCommand = useUIState((state) => state.clearPendingPromptCommand);

  const apiUrl = SUBPOLAR_API_BASE_URL;
  const { commands, filterCommands, error: commandsError } = useCommands(apiUrl);

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
      imageInput: boolean;
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
          imageInput: model.modalities?.input.includes("image") ?? model.attachment === true,
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
  const selectedModelSupportsImages = currentModel === "__auto__" || models.find((model) => model.id === currentModel)?.imageInput === true;

  const selectedAgentForRequest = selectedAgent === "__default__" || (!hideAgentSelect && !visibleAgents.some((agent) => agent.name === selectedAgent))
    ? undefined
    : selectedAgent;
  const selectedPermissionForRequest = selectedPermission === "none" || selectedPermission === "allow_all"
    ? selectedPermission
    : "ask";
  const commandHandler = useCommandHandler({
    apiUrl,
    sessionID: sessionID ?? activeSessionId ?? "",
    directory: selectedDirectory,
    currentAgent: selectedAgentForRequest,
  });
  const commandSuggestions = commandQuery === null ? [] : filterCommands(commandQuery);

  const createSession = useCreateSession(apiUrl, selectedDirectory);
  const sendPrompt = useSendPrompt(apiUrl, selectedDirectory);
  const steer = useSteer(apiUrl, selectedDirectory);
  const enqueueFollowUp = useEnqueueFollowUp(apiUrl, selectedDirectory);
  const abortSession = useAbortSession(apiUrl, selectedDirectory, sessionID ?? activeSessionId);
  const isGeneratingMessage = isSessionActive;
  const isWaitingForAnswer = isGeneratingMessage || sendPrompt.isPending;

  useEffect(() => {
    setInternalProjectId(defaultProjectId ?? null);
  }, [defaultProjectId]);

  useEffect(() => {
    setInternalAgent(defaultAgent);
  }, [defaultAgent]);

  useEffect(() => {
    setSelectedModel(effectiveDefaultModel);
  }, [effectiveDefaultModel]);

  useEffect(() => {
    setInternalPermission(defaultPermission);
  }, [defaultPermission]);

  useEffect(() => {
    if (commandsError) showToast.error(commandsError);
  }, [commandsError]);

  useEffect(() => {
    if (!pendingCommand || !textareaRef.current) return;
    const value = `/${pendingCommand.command.name} `;
    textareaRef.current.value = value;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    setCommandQuery(null);
    setHasPromptContent(true);
    onPromptChange?.(true);
    clearPendingCommand();
    textareaRef.current.focus();
  }, [clearPendingCommand, onPromptChange, pendingCommand]);

  const handleTextareaPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const image = Array.from(e.clipboardData.items).find((item) => item.type.startsWith("image/"));
    if (image) {
      const file = image.getAsFile();
      if (file) {
        const error = validateAttachmentLimits({ size: file.size, mime: file.type }, attachments);
        if (error) { showToast.error(error); return; }
        const reader = new FileReader();
        const id = `attachment_${Date.now()}_${Math.random()}`;
        setAttachments((items) => [...items, { id, kind: "image", name: file.name || "pasted-image", status: "loading", size: file.size, mime: file.type }]);
        reader.onload = () => setAttachments((items) => items.map((item) => item.id === id ? { ...item, status: "ready", dataUrl: String(reader.result) } : item));
        reader.onerror = () => setAttachments((items) => items.map((item) => item.id === id ? { ...item, status: "error", error: "Unable to read image" } : item));
        reader.readAsDataURL(file);
        e.preventDefault();
        onPromptChange?.(true);
        return;
      }
    }
    const text = e.clipboardData.getData("text/plain");
    if (text.length < LARGE_PASTE_THRESHOLD) return;

    // Keep long snippets out of the editor so they do not make the composer unexpectedly grow.
    e.preventDefault();
    const id = `attachment_${Date.now()}_${Math.random()}`;
    setAttachments((items) => [...items, { id, kind: "text", name: text.split("\n")[0].trim() || "Pasted context", status: "ready", size: text.length, content: text, contextOnly: true }]);
    setPastedText(null);
    setHasPromptContent(true);
    onPromptChange?.(true);
  }, [attachments, onPromptChange]);

  const removeAttachment = useCallback((id: string) => setAttachments((items) => {
    const next = items.filter((item) => item.id !== id);
    const hasContent = Boolean(textareaRef.current?.value.trim()) || next.some((item) => item.status !== "error");
    setHasPromptContent(hasContent);
    onPromptChange?.(hasContent);
    return next;
  }), [onPromptChange]);

  const addLocalFile = useCallback((file: File) => {
    const error = validateAttachmentLimits({ size: file.size, mime: file.type }, attachments);
    if (error) { showToast.error(error); return; }
    if (file.type.startsWith("image/")) {
      const id = `attachment_${Date.now()}_${Math.random()}`;
      const reader = new FileReader();
      setAttachments((items) => [...items, { id, kind: "image", name: file.name, status: "loading", size: file.size, mime: file.type }]);
      reader.onload = () => setAttachments((items) => items.map((item) => item.id === id ? { ...item, status: "ready", dataUrl: String(reader.result) } : item));
      reader.onerror = () => setAttachments((items) => items.map((item) => item.id === id ? { ...item, status: "error", error: "Unable to read file" } : item));
      reader.readAsDataURL(file);
      setHasPromptContent(true);
      onPromptChange?.(true);
      return;
    }
    const reader = new FileReader();
    const id = `attachment_${Date.now()}_${Math.random()}`;
    setAttachments((items) => [...items, { id, kind: "text", name: file.name, status: "loading", size: file.size, mime: file.type, contextOnly: true }]);
    reader.onload = () => setAttachments((items) => items.map((item) => item.id === id ? { ...item, status: "ready", content: String(reader.result) } : item));
    reader.onerror = () => setAttachments((items) => items.map((item) => item.id === id ? { ...item, status: "error", error: "Unable to read file" } : item));
    reader.readAsText(file);
    setHasPromptContent(true);
    onPromptChange?.(true);
  }, [attachments, onPromptChange]);

  const addProjectFile = useCallback(async () => {
    if (!selectedDirectory) return;
    const path = window.prompt("Project-relative file path");
    if (!path) return;
    const safePath = validateProjectPath(path, selectedDirectory);
    if (!safePath) { showToast.error("File path must stay inside the selected project"); return; }
    const limitError = validateAttachmentLimits({ size: 0, mime: "text/plain" }, attachments);
    if (limitError) { showToast.error(limitError); return; }
    const id = `attachment_${Date.now()}_${Math.random()}`;
    setAttachments((items) => [...items, { id, kind: "file", name: safePath.split("/").pop() ?? safePath, path: safePath, status: "loading" }]);
    setHasPromptContent(true);
    onPromptChange?.(true);
    try {
      const loaded = await loadProjectAttachment(selectedDirectory, safePath);
      setAttachments((items) => items.map((item) => item.id === id ? { ...item, ...loaded, status: "ready" } : item));
    } catch (error) { setAttachments((items) => items.map((item) => item.id === id ? { ...item, status: "error", error: error instanceof Error ? error.message : "Unable to load file" } : item)); }
  }, [onPromptChange, selectedDirectory, attachments]);

  const addWebsite = useCallback(async () => {
    const url = window.prompt("Website URL");
    if (!url) return;
    const error = validateWebsiteUrl(url);
    if (error) { showToast.error(error); return; }
    const id = `attachment_${Date.now()}_${Math.random()}`;
    setAttachments((items) => [...items, { id, kind: "website", name: url, url, status: "loading", contextOnly: true }]);
    setHasPromptContent(true);
    onPromptChange?.(true);
    try { const loaded = await loadWebsiteAttachment(url); setAttachments((items) => items.map((item) => item.id === id ? { ...item, ...loaded, name: new URL(url).hostname, status: "ready" } : item)); }
    catch (reason) { setAttachments((items) => items.map((item) => item.id === id ? { ...item, status: "error", error: reason instanceof Error ? reason.message : "Unable to load website" } : item)); }
  }, [onPromptChange]);

  const showPastedTextInField = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea || pastedText === null) return;
    const value = textarea.value;
    textarea.value = value ? `${value}\n\n${pastedText}` : pastedText;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
    setPastedText(null);
    setHasPromptContent(true);
    onPromptChange?.(true);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [onPromptChange, pastedText]);

  const handleTextareaInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      e.target.style.height = "auto";
      e.target.style.height = `${e.target.scrollHeight}px`;
      const hasContent = e.target.value.trim().length > 0 || pastedText !== null;
      setHasPromptContent(hasContent);
      onPromptChange?.(hasContent);
      const cursor = e.target.selectionStart;
      const beforeCursor = e.target.value.slice(0, cursor);
      const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
      setMentionQuery(match ? match[1] : null);
      setSelectedMentionIndex(0);
      const commandMatch = beforeCursor.match(/^\/([^\s]*)$/);
      setCommandQuery(commandMatch ? commandMatch[1] : null);
      setSelectedCommandIndex(0);
    },
    [onPromptChange, pastedText],
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

  const insertCommand = useCallback((command: components["schemas"]["Command"]) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursor = textarea.selectionStart;
    const beforeCursor = textarea.value.slice(0, cursor);
    const match = beforeCursor.match(/^\/[^\s]*$/);
    if (!match) return;
    const nextValue = `/${command.name} ${textarea.value.slice(cursor)}`;
    textarea.value = nextValue;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
    setCommandQuery(null);
    setHasPromptContent(true);
    onPromptChange?.(true);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(command.name.length + 2, command.name.length + 2);
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

  const handleSubmit = useCallback(async (delivery?: 'steer' | 'queue') => {
    const targetSessionId = sessionID ?? activeSessionId;

    if (isGeneratingMessage && targetSessionId && !delivery) {
      abortSession.mutate(targetSessionId);
      return;
    }

    if (sendPrompt.isPending) return;
    if (shouldBlockSessionCreation(createSession.isPending, creatingSessionRef.current)) return;

    const typedPromptValue = textareaRef.current?.value ?? "";
    const typedPrompt = typedPromptValue.trim();
    const attachmentParts = attachmentToParts(attachments) as Array<
      | { type: "image"; id: string; filename: string; mime: string; dataUrl: string }
      | { type: "file"; path: string; name: string }
      | { type: "text"; content: string }
    >;
    const attachmentText = attachmentParts.filter((part): part is { type: "text"; content: string } => part.type === "text").map((part) => part.content);
    const rawPrompt = [typedPrompt, pastedText?.trim(), ...attachmentText].filter(Boolean).join("\n\n") || (attachmentParts.length ? "Please review the attached context." : "");
    if (!rawPrompt) return;

    const commandMatch = typedPromptValue.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    const commandName = commandMatch?.[1];
    const command = commandName
      ? commands.find((candidate) => candidate.name.toLowerCase() === commandName.toLowerCase())
      : undefined;
    if (sessionID && command) {
      textareaRef.current!.value = "";
      textareaRef.current!.style.height = "auto";
      setHasPromptContent(Boolean(pastedText || attachmentParts.length));
      setCommandQuery(null);
      onPromptChange?.(Boolean(pastedText || attachmentParts.length));
      await commandHandler.executeCommand(command, commandMatch?.[2] ?? "");
      return;
    }
    if (!sessionID && !selectedProject) {
      showToast.error(sendImmediately ? "Select a project before sending" : "General chat is still loading");
      return;
    }

    const creatingNewSession = !sessionID;
    if (creatingNewSession) creatingSessionRef.current = true;

    try {
      const prompt = await buildPromptWithMentionContext(rawPrompt, selectedDirectory, selectedMentions);
       if (!prompt) return;

       if (sessionID) {
        textareaRef.current!.value = "";
        textareaRef.current!.style.height = "auto";
        setPastedText(null);
        setHasPromptContent(false);
        setSelectedMentions([]);
         onPromptChange?.(false);
        const clientId = createClientMessageID();
        if (isGeneratingMessage && (delivery === 'steer' || delivery === 'queue')) {
          const mutation = delivery === 'steer' ? steer : enqueueFollowUp;
          mutation.mutate({ sessionID, content: prompt, clientId }, { onSuccess: onSend });
          return;
        }
        sendPrompt.mutate(
          {
             sessionID,
             prompt,
             parts: attachmentParts.length ? [{ type: "text", content: prompt }, ...attachmentParts.filter((part) => part.type !== "text")] : undefined,
            messageID: clientId,
            model: currentModel === "__auto__" ? undefined : currentModel,
            agent: selectedAgentForRequest,
            permission: selectedPermissionForRequest,
            routing: routingEnabled,
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

      const session = await createSession.mutateAsync({
        agent: selectedAgentForRequest,
        model: currentModel === "__auto__" ? undefined : currentModel,
        permission: selectedPermissionForRequest,
      });

      if (sendImmediately) {
        const messageID = createClientMessageID();
        const pendingPrompt = {
          prompt,
          messageID,
          model: currentModel === "__auto__" ? undefined : currentModel,
          agent: selectedAgentForRequest,
          permission: selectedPermissionForRequest,
          routing: routingEnabled,
        } satisfies PendingSessionPrompt;
        savePendingSessionPrompt(session.id, pendingPrompt);
        setActiveSessionId(session.id);
        textareaRef.current!.value = "";
        textareaRef.current!.style.height = "auto";
        setPastedText(null);
        setHasPromptContent(false);
         setSelectedMentions([]);
         setAttachments([]);
        onPromptChange?.(false);
        navigate(`/projects/${targetProjectId}/sessions/${session.id}`, {
          state: {
            pendingPrompt,
          },
        });
        onSend?.();
        return;
      }

      setActiveSessionId(session.id);
      const messageID = createClientMessageID();
      const pendingPrompt = {
        prompt,
        messageID,
        model: currentModel === "__auto__" ? undefined : currentModel,
        agent: selectedAgentForRequest,
        permission: selectedPermissionForRequest,
        routing: routingEnabled,
      } satisfies PendingSessionPrompt;
      savePendingSessionPrompt(session.id, pendingPrompt);
      textareaRef.current!.value = "";
      textareaRef.current!.style.height = "auto";
      setPastedText(null);
      setHasPromptContent(false);
       setSelectedMentions([]);
       setAttachments([]);
      onPromptChange?.(false);
      navigate(`/projects/${targetProjectId}/sessions/${session.id}`, {
        state: {
          pendingPrompt,
        },
      });

      onSend?.();
    } catch {
      showToast.error("Failed to create session");
    } finally {
      if (creatingNewSession) creatingSessionRef.current = false;
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
    currentModel,
    selectedPermissionForRequest,
    selectedProject,
    selectedDirectory,
     selectedMentions,
     attachments,
    pastedText,
    sendImmediately,
    sendPrompt,
    steer,
    enqueueFollowUp,
    targetProjectId,
    commandHandler,
    commands,
  ]);

  useImperativeHandle(ref, () => ({
    setPromptValue: (value: string) => {
      if (!textareaRef.current) return;
      textareaRef.current.value = value;
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
      textareaRef.current.focus();
      setPastedText(null);
      const hasContent = value.trim().length > 0;
      setHasPromptContent(hasContent);
      onPromptChange?.(hasContent);
    },
    submitPrompt: (value: string) => {
      if (!textareaRef.current) return;
      textareaRef.current.value = value;
      setPastedText(null);
      setHasPromptContent(value.trim().length > 0);
      onPromptChange?.(value.trim().length > 0);
      void handleSubmit();
    },
    clearPrompt: () => {
      if (!textareaRef.current) return;
      textareaRef.current.value = "";
      textareaRef.current.style.height = "auto";
      textareaRef.current.focus();
      setPastedText(null);
      setHasPromptContent(false);
      onPromptChange?.(false);
    },
    triggerFileUpload: () => fileInputRef.current?.click(),
  }), [handleSubmit, onPromptChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (commandQuery !== null && commandSuggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedCommandIndex((index) => Math.min(index + 1, commandSuggestions.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedCommandIndex((index) => Math.max(index - 1, 0));
          return;
        }
        if (e.key === "Tab" || e.key === "Enter") {
          e.preventDefault();
          insertCommand(commandSuggestions[selectedCommandIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setCommandQuery(null);
          return;
        }
      }
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
    [commandQuery, commandSuggestions, handleSubmit, insertCommand, insertMention, mentionItems, mentionQuery, selectedCommandIndex, selectedMentionIndex],
  );


  return (
    <div className="w-full max-w-3xl mx-auto">
      <div className="relative backdrop-blur-md bg-muted/50 rounded-xl p-4 shadow-lg">
        {attachments.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2" aria-label="Attachments">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-sm">
                {attachment.kind === "image" ? <Image className="h-4 w-4 text-primary" /> : attachment.kind === "website" ? <Link className="h-4 w-4 text-primary" /> : <FileText className="h-4 w-4 text-primary" />}
                <span className="max-w-48 truncate">{attachment.name}</span>
                {attachment.status === "loading" && <span className="text-muted-foreground">Loading...</span>}
                {attachment.status === "error" && <span title={attachment.error} className="flex items-center gap-1 text-destructive"><AlertTriangle className="h-3.5 w-3.5" /> Failed</span>}
                {attachment.kind === "text" && attachment.status === "ready" && selectedDirectory && (
                  <button type="button" className="text-xs text-muted-foreground underline" onClick={async () => {
                    const name = window.prompt("Markdown filename", `${attachment.name.replace(/\.txt$/i, "")}.md`);
                    if (!name) return;
                    try {
                      const created = await createProjectMarkdown(selectedDirectory, name, attachment.content ?? "");
                      setAttachments((items) => items.map((item) => item.id === attachment.id ? { ...item, kind: "file", name: created.name, path: created.path, content: undefined, contextOnly: false } : item));
                    } catch (reason) { showToast.error(reason instanceof Error ? reason.message : "Unable to create Markdown file"); }
                  }}>Create .md</button>
                )}
                <button type="button" onClick={() => removeAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`} className="rounded-full text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        )}
        {attachments.some((attachment) => attachment.kind === "image" && attachment.status === "ready") && !selectedModelSupportsImages && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300" role="status">
            <AlertTriangle className="h-4 w-4" /> The selected model may not support images. Your prompt will still be sent.
          </div>
        )}
        {pastedText !== null && (
          <div className="mb-3 flex max-w-full items-center gap-3 rounded-2xl border border-border bg-background/40 px-4 py-3">
            <Clipboard className="h-6 w-6 flex-shrink-0 text-primary" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">
                {pastedText.split("\n")[0].trim() || "Pasted text"}
              </div>
              <button
                type="button"
                onClick={showPastedTextInField}
                className="mt-1 flex items-center gap-1 text-sm text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
              >
                Show in text field <span aria-hidden="true">›</span>
              </button>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setPastedText(null)}
              className="h-7 w-7 flex-shrink-0 rounded-full text-muted-foreground hover:text-foreground"
              aria-label="Remove pasted text"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}

        <MentionSuggestions
          isOpen={mentionQuery !== null && mentionItems.length > 0}
          items={mentionItems}
          onSelect={insertMention}
          onClose={() => setMentionQuery(null)}
          selectedIndex={selectedMentionIndex}
        />
        <CommandSuggestions
          isOpen={commandQuery !== null && commandSuggestions.length > 0}
          query={commandQuery ?? ""}
          commands={commandSuggestions}
          onSelect={insertCommand}
          onClose={() => setCommandQuery(null)}
          selectedIndex={selectedCommandIndex}
        />
          <textarea
            ref={textareaRef}
            onChange={handleTextareaInput}
            onPaste={handleTextareaPaste}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            aria-controls={commandQuery !== null && commandSuggestions.length > 0 ? "command-suggestions" : undefined}
            aria-activedescendant={commandQuery !== null && commandSuggestions.length > 0 ? `command-suggestion-${commandSuggestions[selectedCommandIndex]?.name}` : undefined}
            placeholder={placeholder}
          rows={1}
          style={{ height: "auto", overflow: "hidden" }}
            className="w-full bg-transparent text-[18px] text-foreground placeholder-muted-foreground focus:outline-none resize-none rounded-lg"
          />
        <input ref={fileInputRef} type="file" className="hidden" accept="image/*,text/*,.md,.json,.csv,.xml,.js,.ts,.tsx,.jsx" onChange={(event) => { const file = event.target.files?.[0]; if (file) addLocalFile(file); event.target.value = ""; }} />
        <div className="mt-3 flex items-center">
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="Add attachment">
                <Plus className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" side="top" className="w-52 p-1">
              <Button type="button" variant="ghost" className="h-9 w-full justify-start" onClick={() => fileInputRef.current?.click()}>
                <Paperclip className="mr-2 h-4 w-4" /> Attach file
              </Button>
              <Button type="button" variant="ghost" className="h-9 w-full justify-start" onClick={() => void addProjectFile()} disabled={!selectedDirectory}>
                <FileText className="mr-2 h-4 w-4" /> Attach project file
              </Button>
              <Button type="button" variant="ghost" className="h-9 w-full justify-start" onClick={() => void addWebsite()}>
                <Link className="mr-2 h-4 w-4" /> Add website context
              </Button>
            </PopoverContent>
          </Popover>

          <span className="w-full" />

          {!hideModelSelect && <Select value={currentModel} onValueChange={internalModelChange}>
            <SelectTrigger className="mr-2 h-8 w-auto border-0 bg-transparent text-xs shadow-none focus:ring-0">
              <SelectValue placeholder="Model" />
            </SelectTrigger>
            <SelectContent className="max-h-[300px] overflow-y-auto">
              <SelectItem value="__auto__">Auto Model</SelectItem>
              <SelectSeparator />
              {Array.from(modelsByProvider.entries()).map(([providerName, providerModels], index) => (
                <SelectGroup key={providerName}>
                  {index > 0 && <SelectSeparator />}
                  <SelectLabel>{providerName}</SelectLabel>
                  {providerModels.map((model) => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>}

          {hasPromptContent && !isWaitingForAnswer && (
            <Button
              type="button"
              onClick={() => {
                if (!textareaRef.current) return;
                textareaRef.current.value = "";
                textareaRef.current.style.height = "auto";
                textareaRef.current.focus();
                 setPastedText(null);
                 setAttachments([]);
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

          {isGeneratingMessage ? (
            <div className="flex items-center gap-2">
              <Button
                onClick={() => handleSubmit('steer')}
                disabled={disabled || !hasPromptContent || steer.isPending}
                size="sm"
                className="h-8"
              >
                Steer
              </Button>
              <Button
                onClick={() => handleSubmit('queue')}
                disabled={disabled || !hasPromptContent || enqueueFollowUp.isPending}
                size="sm"
                variant="secondary"
                className="h-8"
              >
                Queue
              </Button>
            </div>
          ) : (
            <Button
              data-submit-prompt
              onClick={() => handleSubmit()}
              disabled={disabled || createSession.isPending || abortSession.isPending || (sendPrompt.isPending && !isGeneratingMessage)}
              size="icon"
              className="h-8 w-8 flex-shrink-0"
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});
