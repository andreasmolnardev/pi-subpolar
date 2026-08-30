/**
 * Stateless HTTP tools generated from OpenAPI documents.
 *
 * Configuration is read from ~/.pi/tools.json (and ~/.pi/agent/tools.json for
 * compatibility with Pi's other global configuration) and .pi/tools.json.
 * Project-local entries override global entries by provider name.
 *
 * Example:
 * {
 *   "web": {
 *     "openapi": "./searxng.openapi.yaml",
 *     "headers": { "X-API-Key": { "env": "SEARXNG_API_KEY" } }
 *   }
 * }
 *
 * Every operation with an operationId becomes provider_operationId, e.g.
 * web_search. (Tool names are restricted to letters, numbers, underscores, and
 * dashes by the model APIs.) OpenAPI may also be embedded as an object. This
 * extension does not retain state or write anything to disk.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MANAGEMENT_TOOL = "manage_openapi_tools";
const require = createRequire(import.meta.url);

type AnyObject = Record<string, any>;
type Provider = {
  openapi: string | AnyObject;
  headers?: AnyObject;
  baseUrl?: string;
  /** Allow self-signed certificates for this provider only. */
  skipTlsVerify?: boolean;
  operations?: string[] | Record<string, any>;
};

function object(value: unknown): AnyObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as AnyObject : {};
}

function readJson(path: string): AnyObject {
  if (!existsSync(path)) return {};
  try { return object(JSON.parse(readFileSync(path, "utf8"))); }
  catch (error) { console.error(`Failed to read OpenAPI tools from ${path}:`, error); return {}; }
}

function configProviders(path: string): Record<string, Provider> {
  const root = readJson(path);
  const source = object(root.providers ?? root.tools ?? root);
  const result: Record<string, Provider> = {};
  for (const [name, value] of Object.entries(source)) {
    if (name === "providers" || name === "tools") continue;
    const provider = object(value);
    if (provider.openapi) result[name] = provider as Provider;
  }
  return result;
}

function loadDocument(source: string | AnyObject, base: string): AnyObject {
  if (typeof source !== "string") return source;

  // `openapi` may be either a document path or an inline JSON/YAML document.
  // In particular, YAML stored in tools.json contains newlines and must not be
  // passed to readFileSync as though it were a filename.
  const trimmed = source.trim();
  const inline = trimmed.includes("\n")
    || trimmed.startsWith("{")
    || trimmed.startsWith("[")
    || /^(openapi|swagger):\s*/i.test(trimmed);
  if (inline) return object(parseYaml(source));

  const path = isAbsolute(source) ? source : resolve(base, source);
  const text = readFileSync(path, "utf8");
  return /\.(ya?ml)$/i.test(path) ? object(parseYaml(text)) : object(JSON.parse(text));
}

function resolveRef(document: AnyObject, value: any): any {
  if (!value || typeof value !== "object" || typeof value.$ref !== "string") return value;
  if (!value.$ref.startsWith("#/")) return value;
  let result: any = document;
  for (const part of value.$ref.slice(2).split("/")) result = result?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  return result ?? value;
}

function schema(document: AnyObject, value: any): AnyObject {
  value = resolveRef(document, value) ?? {};
  if (value.allOf) return Object.assign({}, ...value.allOf.map((item: any) => schema(document, item)));
  if (value.oneOf || value.anyOf) return { anyOf: (value.oneOf ?? value.anyOf).map((item: any) => schema(document, item)) };
  const result: AnyObject = { ...value };
  if (result.properties) for (const [key, item] of Object.entries(result.properties)) result.properties[key] = schema(document, item);
  if (result.items) result.items = schema(document, result.items);
  delete result.$ref;
  return result;
}

function operationParameters(document: AnyObject, pathItem: AnyObject, operation: AnyObject): AnyObject {
  const properties: AnyObject = {};
  const required: string[] = [];
  for (const parameter of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    const item = resolveRef(document, parameter);
    if (!item?.name || !item.in || item.in === "cookie") continue;
    const parameterSchema = schema(document, item.schema ?? {});
    properties[item.name] = { ...parameterSchema, description: item.description ?? parameterSchema.description };
    if (item.required) required.push(item.name);
  }
  const requestBody = resolveRef(document, operation.requestBody);
  if (requestBody) {
    const content = object(requestBody.content);
    const media = content["application/json"] ?? Object.values(content)[0];
    if (media?.schema) {
      const bodySchema = schema(document, media.schema);
      properties.body = { ...bodySchema, description: requestBody.description ?? bodySchema.description ?? "Request body" };
      if (requestBody.required) required.push("body");
    }
  }
  return { type: "object", properties, ...(required.length ? { required } : { additionalProperties: false }) };
}

function valueFromConfig(value: any): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.env === "string") return process.env[value.env];
  return undefined;
}

function result(text: string, details: AnyObject = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export default function openapiTools(pi: ExtensionAPI) {
  let cwd = process.cwd();
  const generatedTools = new Set<string>();

  async function loadAll(): Promise<void> {
    const files = [join(homedir(), ".pi", "tools.json"), join(getAgentDir(), "tools.json"), join(cwd, ".pi", "tools.json")];
    const providers: Record<string, Provider> = {};
    for (const file of files) Object.assign(providers, configProviders(file));

    const nextGenerated = new Set<string>();
    for (const [providerName, provider] of Object.entries(providers)) {
      try {
        const document = loadDocument(provider.openapi, cwd);
        const servers = document.servers ?? [];
        const serverUrl = provider.baseUrl ?? servers[0]?.url;
        if (!serverUrl) throw new Error("OpenAPI document has no server URL (set baseUrl or servers[0].url)");
        // Keep optional undici dependency out of extension startup path.
        const dispatcher: any = provider.skipTlsVerify
          ? new (await import(require.resolve("undici", {
            // Resolve undici from pi's installation. Extensions are loaded
            // outside pi's node_modules, so a plain import("undici") fails.
            paths: [dirname(realpathSync(process.argv[1] ?? "")), process.cwd()],
          }))).Agent({ connect: { rejectUnauthorized: false } })
          : undefined;
        for (const [path, pathItemValue] of Object.entries(object(document.paths))) {
          const pathItem = object(pathItemValue);
          for (const [method, operationValue] of Object.entries(pathItem)) {
            if (!["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(method)) continue;
            const operation = object(operationValue);
            const operationId = operation.operationId;
            if (typeof operationId !== "string" || !operationId) continue;
            const selection = provider.operations;
            if (Array.isArray(selection) && !selection.includes(operationId)) continue;
            if (selection && !Array.isArray(selection) && selection[operationId] === false) continue;

            const name = `${providerName}_${operationId}`;
            nextGenerated.add(name);
            const description = operation.description ?? operation.summary ?? `${method.toUpperCase()} ${path}`;
            const parameters = operationParameters(document, pathItem, operation);
            pi.registerTool({
              name,
              label: `${providerName}.${operationId}`,
              description: `${description} (${method.toUpperCase()} ${path})`,
              promptSnippet: `${description}`,
              parameters: parameters as ReturnType<typeof Type.Object>,
              async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
                const args = object(input);
                let requestPath = path;
                const headers: Record<string, string> = { Accept: "application/json" };
                for (const [key, value] of Object.entries(provider.headers ?? {})) {
                  const resolved = valueFromConfig(value);
                  if (resolved !== undefined) headers[key] = resolved;
                }
                const query = new URLSearchParams();
                for (const parameter of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
                  const item = resolveRef(document, parameter);
                  if (!item?.name || item.in === "cookie" || args[item.name] === undefined) continue;
                  const value = Array.isArray(args[item.name]) ? args[item.name].join(",") : String(args[item.name]);
                  if (item.in === "path") requestPath = requestPath.replace(`{${item.name}}`, encodeURIComponent(value));
                  else if (item.in === "query") query.set(item.name, value);
                  else if (item.in === "header") headers[item.name] = value;
                }
                const url = new URL(requestPath, serverUrl);
                query.forEach((value, key) => url.searchParams.set(key, value));
                const body = args.body === undefined ? undefined : JSON.stringify(args.body);
                if (body !== undefined) headers["Content-Type"] = "application/json";
                // Node's fetch does not expose TLS options directly, but does
                // accept an undici dispatcher. Keep the insecure TLS setting
                // scoped to this provider rather than changing process-wide TLS
                // behavior.
                const response = await fetch(url, {
                  method: method.toUpperCase(),
                  headers,
                  body,
                  signal: ctx.signal,
                  ...(dispatcher ? { dispatcher } : {}),
                } as RequestInit & { dispatcher?: any });
                const text = await response.text();
                if (!response.ok) return result(`HTTP ${response.status} ${response.statusText}\n${text}`, { status: response.status, url: url.toString() });
                let output: unknown = text;
                try { output = JSON.parse(text); } catch { /* non-JSON response */ }
                return result(typeof output === "string" ? output : JSON.stringify(output, null, 2), { status: response.status, url: url.toString() });
              },
            });
          }
        }
      } catch (error) { console.error(`Failed to register OpenAPI provider ${providerName}:`, error); }
    }
    // There is no unregisterTool API. Removing stale generated names from the
    // active set makes deleted tools unavailable immediately.
    const active = pi.getActiveTools().filter((name) => !generatedTools.has(name));
    pi.setActiveTools([...active, ...nextGenerated]);
    generatedTools.clear();
    for (const name of nextGenerated) generatedTools.add(name);
  }

  function configPath(scope: string): string {
    return scope === "global" ? join(homedir(), ".pi", "tools.json") : join(cwd, ".pi", "tools.json");
  }

  function readConfig(path: string): AnyObject {
    return readJson(path);
  }

  function writeProvider(scope: string, provider: string, value: AnyObject | undefined, action: string): string {
    const path = configPath(scope);
    const root = readConfig(path);
    const hasProviders = (root.providers && typeof root.providers === "object" && !Array.isArray(root.providers))
      || (root.tools && typeof root.tools === "object" && !Array.isArray(root.tools));
    const container = hasProviders ? (root.providers ?? root.tools) : root;
    const exists = Object.prototype.hasOwnProperty.call(container, provider);
    if (action === "add" && exists) throw new Error(`Provider "${provider}" already exists in ${scope} tools.json`);
    if ((action === "edit" || action === "delete") && !exists) throw new Error(`Provider "${provider}" does not exist in ${scope} tools.json`);
    if (action === "delete") delete container[provider];
    else container[provider] = value;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(root, null, 2)}\\n`, "utf8");
    return path;
  }

  pi.registerTool({
    name: MANAGEMENT_TOOL,
    label: "Manage OpenAPI Tools",
    description: "Add, edit, delete, or inspect OpenAPI HTTP tool providers. Supports baseUrl, headers, operations, and skipTlsVerify. Master profile only.",
    promptSnippet: "Manage configured OpenAPI tools",
    parameters: Type.Object({
      action: Type.String({ description: "One of: add, edit, delete, get" }),
      provider: Type.Optional(Type.String({ description: "Provider name, such as web" })),
      scope: Type.Optional(Type.String({ description: "local or global; defaults to local" })),
      config: Type.Optional(Type.Any({ description: "Provider configuration containing openapi, headers, baseUrl, operations, or skipTlsVerify" })),
    }),
    async execute(_toolCallId, params) {
      const action = params.action.toLowerCase();
      const scope = params.scope?.toLowerCase() ?? "local";
      if (!["add", "edit", "delete", "get"].includes(action)) return result("action must be add, edit, delete, or get");
      if (!["local", "global"].includes(scope)) return result("scope must be local or global");
      if (action === "get") {
        const path = configPath(scope);
        const config = readConfig(path);
        if (!params.provider) return result(JSON.stringify(config, null, 2), { path, config });
        const providers = object(config.providers ?? config.tools ?? config);
        return result(JSON.stringify(providers[params.provider] ?? null, null, 2), { path, provider: params.provider, config: providers[params.provider] ?? null });
      }
      if (!params.provider?.trim()) return result("provider is required");
      if (action !== "delete" && (!params.config || typeof params.config !== "object" || Array.isArray(params.config) || !params.config.openapi)) return result("config.openapi is required for add and edit");
      try {
        const path = writeProvider(scope, params.provider.trim(), action === "delete" ? undefined : params.config, action);
        await loadAll();
        const verb = action === "add" ? "Added" : action === "edit" ? "Edited" : "Deleted";
        return result(`${verb} OpenAPI provider "${params.provider.trim()}" in ${path}`, { provider: params.provider.trim(), scope, action });
      } catch (error) { return result(error instanceof Error ? error.message : String(error)); }
    },
  });

  pi.on("session_start", async (_event, ctx) => { cwd = ctx.cwd; await loadAll(); });
}
