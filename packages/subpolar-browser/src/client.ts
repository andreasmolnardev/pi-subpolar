import type { BrowserLimits, BrowserTab } from "./engine.ts";
import { BrowserWorkerError } from "./engine.ts";
export class WorkerBrowserPort {
  constructor(
    private url: string,
    private token: string,
    private timeoutMs = 65000,
  ) {
    if (token.length < 32)
      throw Error("Browser worker token must contain at least 32 characters");
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      throw Error("Invalid browser worker URL");
  }
  private async call<T>(method: string, args: unknown[]): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL("/v1/browser", this.url), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ method, args }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new BrowserWorkerError(
        "BROWSER_WORKER_DISCONNECTED",
        "Browser worker disconnected",
      );
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new BrowserWorkerError(
        "BROWSER_WORKER_DISCONNECTED",
        "Empty worker response",
      );
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 24 * 1024 * 1024) {
        await reader.cancel();
        throw new BrowserWorkerError(
          "BROWSER_LIMIT",
          "Worker response size exceeded",
        );
      }
      parts.push(chunk.value);
    }
    const value = JSON.parse(Buffer.concat(parts).toString("utf8")) as any;
    if (!response.ok)
      throw new BrowserWorkerError(
        value.code ?? "BROWSER_UNAVAILABLE",
        value.message ?? "Browser operation failed",
      );
    return value.result as T;
  }
  start(
    id: string,
    options: { profileId?: string; limits?: BrowserLimits } = {},
  ) {
    return this.call("start", [id, options]);
  }
  open(id: string, url: string, limits: BrowserLimits) {
    return this.call<BrowserTab>("open", [id, url, limits]);
  }
  navigate(id: string, tabId: string, url: string, limits: BrowserLimits) {
    return this.call<BrowserTab>("navigate", [id, tabId, url, limits]);
  }
  back(id: string, tabId: string) {
    return this.call<BrowserTab>("back", [id, tabId]);
  }
  forward(id: string, tabId: string) {
    return this.call<BrowserTab>("forward", [id, tabId]);
  }
  tabs(id: string) {
    return this.call<BrowserTab[]>("tabs", [id]);
  }
  read(id: string, tabId?: string, maxTextBytes?: number) {
    return this.call<BrowserTab>("read", [id, tabId, maxTextBytes]);
  }
  find(id: string, query: string, tabId?: string) {
    return this.call<{
      query: string;
      matches: Array<{ index: number; text: string }>;
    }>("find", [id, query, tabId]);
  }
  screenshot(id: string, tabId?: string) {
    return this.call<{ mimeType: string; data: string }>("screenshot", [
      id,
      tabId,
    ]);
  }
  wait(id: string, ms: number) {
    return this.call<{ waitedMs: number }>("wait", [id, ms]);
  }
  action(
    id: string,
    operation: string,
    input: Record<string, unknown> = {},
    tabId?: string,
  ) {
    return this.call("action", [id, operation, input, tabId]);
  }
  async close(id: string): Promise<void> {
    await this.call("close", [id]);
  }
  async clearProfile(id: string): Promise<void> {
    await this.call("clearProfile", [id]);
  }
  health() {
    return this.call("health", []);
  }
}
