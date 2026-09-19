/**
 * Discover OpenAPI operations into the central Subpolar tool registry.
 *
 * This extension deliberately does not register or execute one Pi tool per
 * operation. Pi exposes only the central `subpolar-tools` gateway; the bridge
 * performs policy checks, approvals, auditing, and HTTP execution.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
type AnyObject = Record<string, any>
type Provider = { openapi: string | AnyObject; headers?: AnyObject; baseUrl?: string; operations?: string[] | Record<string, any> }

function object(value: unknown): AnyObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyObject : {}
}

function readJson(path: string): AnyObject {
  if (!existsSync(path)) return {}
  try { return object(JSON.parse(readFileSync(path, 'utf8'))) } catch { return {} }
}

function configProviders(path: string): Record<string, Provider> {
  const root = readJson(path)
  const source = object(root.providers ?? root.tools ?? root)
  const result: Record<string, Provider> = {}
  for (const [name, value] of Object.entries(source)) {
    if (name === 'providers' || name === 'tools') continue
    const provider = object(value)
    if (provider.openapi) result[name] = provider as Provider
  }
  return result
}

function resolveRef(document: AnyObject, value: any): any {
  if (!value || typeof value !== 'object' || typeof value.$ref !== 'string' || !value.$ref.startsWith('#/')) return value
  let result: any = document
  for (const part of value.$ref.slice(2).split('/')) result = result?.[part.replace(/~1/g, '/').replace(/~0/g, '~')]
  return result ?? value
}

function schema(document: AnyObject, value: any): AnyObject {
  value = resolveRef(document, value) ?? {}
  if (value.allOf) return Object.assign({}, ...value.allOf.map((item: any) => schema(document, item)))
  if (value.oneOf || value.anyOf) return { anyOf: (value.oneOf ?? value.anyOf).map((item: any) => schema(document, item)) }
  const result: AnyObject = { ...value }
  if (result.properties) for (const [key, item] of Object.entries(result.properties)) result.properties[key] = schema(document, item)
  if (result.items) result.items = schema(document, result.items)
  delete result.$ref
  return result
}

function loadDocument(source: string | AnyObject, cwd: string): AnyObject {
  if (typeof source !== 'string') return source
  const trimmed = source.trim()
  if (trimmed.includes('\n') || trimmed.startsWith('{') || /^(openapi|swagger):\s*/i.test(trimmed)) return object(parseYaml(source))
  const path = resolve(cwd, trimmed)
  const text = readFileSync(path, 'utf8')
  return /\.ya?ml$/i.test(path) ? object(parseYaml(text)) : object(JSON.parse(text))
}

function operationParameters(document: AnyObject, pathItem: AnyObject, operation: AnyObject): { schema: AnyObject; parameters: AnyObject[] } {
  const properties: AnyObject = {}
  const required: string[] = []
  const parameters: AnyObject[] = []
  for (const parameter of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    const item = resolveRef(document, parameter)
    if (!item?.name || !item.in || item.in === 'cookie') continue
    const parameterSchema = schema(document, item.schema ?? {})
    properties[item.name] = { ...parameterSchema, description: item.description ?? parameterSchema.description }
    parameters.push({ name: item.name, in: item.in })
    if (item.required) required.push(item.name)
  }
  const requestBody = resolveRef(document, operation.requestBody)
  if (requestBody) {
    const content = object(requestBody.content)
    const media = content['application/json'] ?? Object.values(content)[0]
    if (media?.schema) {
      const bodySchema = schema(document, media.schema)
      properties.body = { ...bodySchema, description: requestBody.description ?? bodySchema.description ?? 'Request body' }
      if (requestBody.required) required.push('body')
    }
  }
  return {
    schema: { type: 'object', properties, ...(required.length ? { required } : { additionalProperties: false }) },
    parameters,
  }
}

function bridgeUrl(): string {
  return `http://127.0.0.1:${Number(process.env.WEBUI_PORT ?? 4173)}`
}

async function registerOperation(providerName: string, provider: Provider, document: AnyObject, path: string, method: string, operation: AnyObject, cwd: string): Promise<void> {
  const servers = Array.isArray(document.servers) ? document.servers : []
  const serverUrl = provider.baseUrl ?? servers[0]?.url
  if (typeof serverUrl !== 'string' || !/^https?:\/\//i.test(serverUrl)) return
  const operationId = typeof operation.operationId === 'string' ? operation.operationId : ''
  if (!operationId) return
  const selection = provider.operations
  if (Array.isArray(selection) && !selection.includes(operationId)) return
  if (selection && !Array.isArray(selection) && selection[operationId] === false) return

  const parsed = operationParameters(document, object(document.paths?.[path]), operation)
  const isRead = method === 'get' || method === 'head' || method === 'options'
  const risk = method === 'delete' ? 'delete' : isRead ? 'read' : 'write'
  const response = await fetch(`${bridgeUrl()}/api/subpolar-cli/tools/register`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.SUBPOLAR_INTERNAL_TOKEN ?? ''}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      toolId: `${providerName}/${operationId}`,
      namespace: providerName,
      description: String(operation.description ?? operation.summary ?? `${method.toUpperCase()} ${path}`),
      adapter: 'openapi',
      target: serverUrl,
      operation: operationId,
      inputSchema: parsed.schema,
      outputSchema: {},
      risk,
      requiresApproval: !isRead,
      metadata: {
        url: new URL(path, serverUrl).toString(),
        method: method.toUpperCase(),
        parameters: parsed.parameters,
        headers: provider.headers ?? {},
        cwd,
      },
    }),
  })
  if (!response.ok) throw new Error(`Tool registration failed for ${providerName}/${operationId}: HTTP ${response.status}`)
}

async function syncConfiguredTools(cwd: string): Promise<void> {
  const files = [join(homedir(), '.pi', 'tools.json'), join(getAgentDir(), 'tools.json'), join(cwd, '.pi', 'tools.json')]
  const providers: Record<string, Provider> = {}
  for (const file of files) Object.assign(providers, configProviders(file))

  for (const [providerName, provider] of Object.entries(providers)) {
    try {
      const document = loadDocument(provider.openapi, cwd)
      for (const [path, pathItemValue] of Object.entries(object(document.paths))) {
        const pathItem = object(pathItemValue)
        for (const [method, operationValue] of Object.entries(pathItem)) {
          if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].includes(method)) continue
          await registerOperation(providerName, provider, document, path, method, object(operationValue), cwd)
        }
      }
    } catch (error) {
      console.error(`Failed to register OpenAPI provider ${providerName}:`, error)
    }
  }
}

export default function openapiTools(pi: any) {
  pi.on('session_start', async (_event: unknown, ctx: { cwd: string }) => {
    await syncConfiguredTools(ctx.cwd)
  })
}
