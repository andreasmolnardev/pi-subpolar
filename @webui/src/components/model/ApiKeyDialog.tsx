import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Key, ExternalLink, Copy, Shield, Smartphone } from "lucide-react";
import { providerLoginFlowApi, type ProviderLoginEvent, type ProviderLoginFlowStatus, type ProviderLoginPrompt, type ProviderLoginType } from "@/api/oauth";
import type { ProviderAuthMethod, ProviderAuthMethodKind } from "@/api/providers";

export interface ProviderLoginTarget {
  providerId: string;
  instanceId: string;
  name: string;
  api?: string;
  env?: string[];
  methods: readonly ProviderAuthMethod[];
}

interface ApiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderLoginTarget | null;
  onSuccess: () => void;
  mode?: "add" | "edit";
}

function loginType(kind: ProviderAuthMethodKind): ProviderLoginType {
  return kind === "api_key" ? "api_key" : "oauth";
}

function methodIcon(kind: ProviderAuthMethodKind) {
  return kind === "api_key" ? <Key className="h-4 w-4" /> : <Shield className="h-4 w-4" />;
}

function eventText(event: ProviderLoginEvent): string | null {
  if (event.type === "info" || event.type === "progress") return event.message;
  if (event.type === "auth_url") return event.instructions || "Open the authorization page to continue.";
  if (event.type === "device_code") return "Use the device code below to authorize this account.";
  if (event.type === "prompt") return event.prompt.message;
  return null;
}

function isPrompt(value: ProviderLoginPrompt | undefined): value is ProviderLoginPrompt {
  return Boolean(value);
}

export function ApiKeyDialog({
  open,
  onOpenChange,
  provider,
  onSuccess,
  mode = "add",
}: ApiKeyDialogProps) {
  const [selectedKind, setSelectedKind] = useState<ProviderAuthMethodKind>("api_key");
  const [displayName, setDisplayName] = useState("");
  const [flow, setFlow] = useState<ProviderLoginFlowStatus | null>(null);
  const [events, setEvents] = useState<ProviderLoginEvent[]>([]);
  const [promptValue, setPromptValue] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [isResponding, setIsResponding] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handledFlow = useRef<string | null>(null);

  const methods = useMemo(
    () => (provider?.methods ?? []).filter((method) => method.available),
    [provider?.methods],
  );
  const selectedMethod = methods.find((method) => method.kind === selectedKind) ?? methods[0];
  const currentPrompt = flow?.currentPrompt;
  const isRunning = flow?.phase === "pending";
  const isTerminal = Boolean(flow && flow.phase !== "pending");

  useEffect(() => {
    if (!open) return;
    const firstMethod = methods[0];
    setSelectedKind(firstMethod?.kind ?? "api_key");
    setDisplayName("");
    setFlow(null);
    setEvents([]);
    setPromptValue("");
    setError(null);
    handledFlow.current = null;
  }, [open, provider?.instanceId, methods]);

  useEffect(() => {
    if (!currentPrompt) {
      setPromptValue("");
      return;
    }
    setPromptValue("");
  }, [currentPrompt?.promptId]);

  useEffect(() => {
    const flowId = flow?.flowId;
    if (!flowId || flow?.phase !== "pending") return;

    let cancelled = false;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const [status, eventPage] = await Promise.all([
          providerLoginFlowApi.status(flowId),
          providerLoginFlowApi.events(flowId, cursor),
        ]);
        if (cancelled) return;
        cursor = Math.max(cursor, eventPage.nextSequence);
        setFlow(status);
        setEvents((previous) => {
          const known = new Set(previous.map((event) => event.sequence));
          return [...previous, ...eventPage.events.filter((event) => !known.has(event.sequence))]
            .sort((left, right) => left.sequence - right.sequence);
        });
        if (status.phase === "pending") timer = setTimeout(poll, 700);
      } catch {
        if (!cancelled) {
          setError("Unable to read the provider login status. You can cancel and reconnect to try again.");
          timer = setTimeout(poll, 1500);
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [flow?.flowId, flow?.phase]);

  useEffect(() => {
    if (!flow || flow.phase !== "completed" || handledFlow.current === flow.flowId) return;
    handledFlow.current = flow.flowId;
    onSuccess();
  }, [flow, onSuccess]);

  const handleStart = useCallback(async () => {
    if (!provider || !selectedMethod) return;
    setIsStarting(true);
    setError(null);
    try {
      const started = await providerLoginFlowApi.start({
        providerInstanceId: provider.instanceId,
        type: loginType(selectedMethod.kind),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      setFlow(started);
    } catch {
      setError("Provider login could not start. Please try again.");
    } finally {
      setIsStarting(false);
    }
  }, [displayName, provider, selectedMethod]);

  const handleRespond = useCallback(async () => {
    if (!flow || !currentPrompt || !promptValue.trim()) return;
    setIsResponding(true);
    setError(null);
    const value = promptValue.trim();
    setPromptValue("");
    try {
      const status = await providerLoginFlowApi.respond(flow.flowId, currentPrompt.promptId, value);
      setFlow(status);
    } catch {
      setError("That response was not accepted. Please try the prompt again.");
    } finally {
      setIsResponding(false);
    }
  }, [currentPrompt, flow, promptValue]);

  const handleCancelFlow = useCallback(async () => {
    if (!flow || !isRunning) return;
    setIsCancelling(true);
    try {
      const cancelledFlow = await providerLoginFlowApi.cancel(flow.flowId);
      setFlow(cancelledFlow);
    } catch {
      setError("The login flow could not be cancelled.");
    } finally {
      setIsCancelling(false);
    }
  }, [flow, isRunning]);

  const handleClose = useCallback(async () => {
    if (flow?.phase === "pending") await handleCancelFlow();
    setFlow(null);
    setEvents([]);
    setPromptValue("");
    setError(null);
    onOpenChange(false);
  }, [flow?.phase, handleCancelFlow, onOpenChange]);

  const copyText = useCallback(async (value: string) => {
    await navigator.clipboard?.writeText(value);
  }, []);

  if (!provider) return null;

  const envVarName = provider.env?.[0] || `${provider.providerId.toUpperCase()}_API_KEY`;
  const title = mode === "edit" ? `Reconnect ${provider.name}` : `Login to ${provider.name}`;
  const canRespond = Boolean(currentPrompt && promptValue.trim() && !isResponding);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) void handleClose(); }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {methodIcon(selectedMethod?.kind ?? "api_key")}
            {title}
          </DialogTitle>
          <DialogDescription>
            Credentials are handled by Pi on the server and are never shown here.
          </DialogDescription>
        </DialogHeader>

        {!flow && (
          <div className="space-y-4 py-2">
            {methods.length > 1 && (
              <div className="space-y-2">
                <Label>Login method</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {methods.map((method) => (
                    <Button
                      key={method.kind}
                      type="button"
                      variant={selectedMethod?.kind === method.kind ? "default" : "outline"}
                      className="justify-start"
                      onClick={() => setSelectedKind(method.kind)}
                    >
                      {methodIcon(method.kind)}
                      <span className="ml-2 truncate">{method.label}</span>
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {mode === "add" && (
              <div className="space-y-2">
                <Label htmlFor="provider-account-name">Account label (optional)</Label>
                <Input
                  id="provider-account-name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Personal, Work, or another label"
                  autoComplete="off"
                />
              </div>
            )}
            {selectedMethod?.kind === "api_key" && (
              <p className="text-xs text-muted-foreground">
                Pi will securely ask for the API key. It is sent directly to the server login flow and is never rendered as text.
                {provider.env?.length ? <> Expected environment name: <code>{envVarName}</code>.</> : null}
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => void handleClose()}>Cancel</Button>
              <Button onClick={() => void handleStart()} disabled={!selectedMethod || isStarting}>
                {isStarting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {isStarting ? "Starting…" : "Continue"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {flow && (
          <div className="space-y-4 py-2">
            {error && <p className="text-sm text-destructive">{error}</p>}
            {flow.error && <p className="text-sm text-destructive">{flow.error.message}</p>}
            <div className="rounded-md border border-border bg-muted/40 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {flow.phase === "pending" ? "Waiting for authentication" : flow.phase === "completed" ? "Connected" : `Login ${flow.phase}`}
                </span>
                {isRunning && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </div>
              {events.map((event) => {
                const text = eventText(event);
                if (!text) return null;
                return (
                  <div key={event.sequence}>
                    <p className="text-sm text-muted-foreground">{text}</p>
                    {event.type === "info" && event.links?.map((link) => (
                      <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline mr-3">
                        {link.label || "Open link"} <ExternalLink className="h-3 w-3" />
                      </a>
                    ))}
                  </div>
                );
              })}
            </div>

            {events.filter((event) => event.type === "auth_url").map((event) => (
              <div key={event.sequence} className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => window.open(event.url, "_blank", "noopener,noreferrer")}>
                  <ExternalLink className="h-4 w-4 mr-2" /> Open authorization page
                </Button>
                <Button variant="ghost" size="icon" aria-label="Copy authorization URL" onClick={() => void copyText(event.url)}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            ))}


            {events.filter((event) => event.type === "device_code").map((event) => (
              <div key={event.sequence} className="rounded-md border border-border p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium"><Smartphone className="h-4 w-4" /> Device authorization</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-muted px-3 py-2 text-sm font-mono">{event.userCode}</code>
                  <Button variant="ghost" size="icon" aria-label="Copy device code" onClick={() => void copyText(event.userCode)}><Copy className="h-4 w-4" /></Button>
                </div>
                <Button variant="outline" size="sm" onClick={() => window.open(event.verificationUri, "_blank", "noopener,noreferrer")}>
                  <ExternalLink className="h-4 w-4 mr-2" /> Open verification page
                </Button>
              </div>
            ))}

            {currentPrompt && isPrompt(currentPrompt.prompt) && (
              <div className="space-y-2">
                <Label htmlFor="provider-login-prompt">{currentPrompt.prompt.message}</Label>
                {currentPrompt.prompt.type === "select" ? (
                  <Select value={promptValue} onValueChange={setPromptValue} disabled={isResponding}>
                    <SelectTrigger id="provider-login-prompt"><SelectValue placeholder="Select an option" /></SelectTrigger>
                    <SelectContent>
                      {currentPrompt.prompt.options.map((option) => (
                        <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id="provider-login-prompt"
                    type={currentPrompt.prompt.type === "secret" ? "password" : "text"}
                    value={promptValue}
                    onChange={(event) => setPromptValue(event.target.value)}
                    placeholder={currentPrompt.prompt.placeholder}
                    autoFocus
                    autoComplete="off"
                    disabled={isResponding}
                    onKeyDown={(event) => { if (event.key === "Enter" && canRespond) void handleRespond(); }}
                  />
                )}
                <Button className="w-full" onClick={() => void handleRespond()} disabled={!canRespond}>
                  {isResponding && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Submit response
                </Button>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => void handleClose()} disabled={isCancelling}>{isTerminal ? "Close" : "Cancel login"}</Button>
              {isRunning && <Button variant="destructive" onClick={() => void handleCancelFlow()} disabled={isCancelling}>{isCancelling ? "Cancelling…" : "Cancel login"}</Button>}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
