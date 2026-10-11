import { canonicalRoot, within } from '../../execution/workspace.ts'
import type { JsonValue, RuntimeExecution } from '../../../../subpolar-contracts/src/index.ts'
import type { ExternalRuntimeProvider, ExternalScope, IsolatedExecutionPort, RuntimeMappingPort } from '../../runtime/contracts.ts'
import { AcpClient, type AcpMessage } from '../../protocols/acp/client.ts'
import { externalCapabilities, verifyHandshake } from '../../runtime/capabilities.ts'
import { validateMapping, validateScope } from '../../runtime/lifecycle.ts'
import type { AcpMcpServer } from './configuration.ts'
export interface OpenCodeInstallation { id: string; executable: string; root: string }
export interface PreparedOpenCodeScope { configurationRoot: string; runtimeDirectory: string; modelPorts?: number[]; environment?: Record<string,string>; mcpServers: AcpMcpServer[]; model?: string; mode?: string }
export interface OpenCodeRuntimeOptions {
 installation: OpenCodeInstallation
 execution: IsolatedExecutionPort
 mappings: RuntimeMappingPort
 resolveScope(execution: RuntimeExecution): Promise<ExternalScope>
 prepare(scope: ExternalScope): Promise<PreparedOpenCodeScope>
 permission?(scope: ExternalScope, request: AcpMessage): Promise<'once'|'reject'>
}
export function createOpenCodeProvider(options: OpenCodeRuntimeOptions): ExternalRuntimeProvider {
 if (!options.execution?.kind || !['macos-seatbelt', 'linux-bwrap'].includes(options.execution.kind)) throw new Error('Verified execution isolation is required')
 const active = new Map<string,AcpClient>(); const starting = new Set<string>(); let closed = false
 return {
  id:'opencode-v2', capabilities:() => ({...externalCapabilities}),
  async close() { closed=true; await Promise.all([...active.values()].map(client=>client.close())); active.clear() },
  execute: async (execution) => {
   if (closed) throw new Error('External runtime closed')
   const scope = await options.resolveScope(execution); validateScope(scope)
   if (scope.sessionId !== execution.request.sessionId || scope.ownerId !== execution.request.principal?.id) throw new Error('External runtime execution scope mismatch')
   const key = JSON.stringify([scope.ownerId,scope.sessionId,scope.agentId]); if (active.has(key) || starting.has(key)) throw new Error('External session already running')
   starting.add(key)
   try {
   const prepared = await options.prepare(scope)
   if (!within(canonicalRoot(prepared.configurationRoot), canonicalRoot(prepared.runtimeDirectory)) || canonicalRoot(prepared.runtimeDirectory) === canonicalRoot(prepared.configurationRoot)) throw new Error('Controlled ACP runtime directory required')
   const process = await options.execution.spawn({executable:options.installation.executable,args:['acp'],cwd:prepared.runtimeDirectory,environment:{...prepared.environment,XDG_CONFIG_HOME:prepared.configurationRoot,XDG_DATA_HOME:prepared.configurationRoot+'/data',XDG_CACHE_HOME:prepared.configurationRoot+'/cache'},readableRoots:[options.installation.root,prepared.configurationRoot],writableRoots:[prepared.configurationRoot],allowedExecutables:[options.installation.executable],timeoutMs:180000,maxOutputBytes:8388608,networkPorts:[...(prepared.modelPorts || []),...prepared.mcpServers.map(server => Number(new URL(server.url).port) || (server.url.startsWith('https:')?443:80))],signal:execution.request.signal})
   let text = ''; let externalSessionId = ''; let collecting = false
   const client = new AcpClient(process, async message => {
    if (!collecting || message.method !== 'session/update' || message.params?.sessionId !== externalSessionId) return
    const update = message.params.update
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') text += update.content.text
    await execution.emit({type:'external_runtime_update',provider:'opencode-v2',sessionId:scope.sessionId,update} as JsonValue)
   }, async message => {
    if (message.method !== 'session/request_permission') throw new Error('Unsupported request')
    const decision = message.params?.sessionId === externalSessionId && options.permission ? await options.permission(scope,message) : 'reject'
    const option = message.params?.options?.find((item:any) => item.optionId === decision && item.kind === (decision==='once'?'allow_once':'reject_once'))
    return option ? {outcome:{outcome:'selected',optionId:option.optionId}} : {outcome:{outcome:'cancelled'}}
   })
   active.set(key,client)
   const cancel = () => { if (externalSessionId) { try { client.notify('session/cancel',{sessionId:externalSessionId}) } catch {} } void client.close() }
   execution.request.signal?.addEventListener('abort',cancel,{once:true})
   try {
    verifyHandshake(await client.request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'Subpolar',version:'0.1.0'}},execution.request.signal))
    const mapping = await options.mappings.get(scope.ownerId,scope.sessionId)
    if (mapping) { validateMapping(scope,options.installation.id,mapping); externalSessionId=mapping.externalSessionId; await client.request('session/load',{sessionId:externalSessionId,cwd:prepared.runtimeDirectory,mcpServers:prepared.mcpServers},execution.request.signal) }
    else { const created = await client.request('session/new',{cwd:prepared.runtimeDirectory,mcpServers:prepared.mcpServers},execution.request.signal); externalSessionId=created.sessionId; if (!externalSessionId) throw new Error('ACP session ID missing'); await options.mappings.save({ownerId:scope.ownerId,sessionId:scope.sessionId,provider:'opencode-v2',installationId:options.installation.id,externalSessionId,workspace:scope.workspace}) }
    if (prepared.model) await client.request('session/set_config_option',{sessionId:externalSessionId,configId:'model',value:prepared.model},execution.request.signal)
    if (prepared.mode) await client.request('session/set_mode',{sessionId:externalSessionId,modeId:prepared.mode},execution.request.signal)
    collecting = true
    const result = await client.request('session/prompt',{sessionId:externalSessionId,prompt:[{type:'text',text:execution.request.prompt}]},execution.request.signal)
    return {text,stopReason:result.stopReason,usage:result.usage,provider:'opencode-v2',externalSessionId}
   } finally { execution.request.signal?.removeEventListener('abort',cancel); active.delete(key); await client.close() }
   } finally { starting.delete(key) }
  }
 }
}
