import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSessionMcpBridge } from '../src/protocols/mcp/index.ts'
import { ControlledShell, createSandboxExecutionPort } from '../src/execution/shell.ts'
import { verifyHandshake } from '../src/runtime/capabilities.ts'

describe('external runtime boundaries', () => {
 test('rejects old and incomplete ACP runtimes', () => {
  expect(() => verifyHandshake({protocolVersion:1,agentInfo:{version:'1.18.35'}})).toThrow()
  expect(() => verifyHandshake({protocolVersion:2,agentInfo:{version:'2.0.26'}})).toThrow()
  expect(() => verifyHandshake({protocolVersion:1,agentInfo:{version:'2.0.26'},agentCapabilities:{loadSession:true,mcpCapabilities:{http:true}}})).not.toThrow()
 })
 test('MCP scopes discovery, rechecks revocation, and rejects foreign credentials', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'external-mcp-test-'))
  let permitted = true; let calls = 0
  const bridge = startSessionMcpBridge({scope:{ownerId:'owner',agentId:'agent',sessionId:'session',workspace,allowedToolIds:['permitted']},tools:{
   async list() {return permitted ? [{id:'permitted',description:'Allowed tool',inputSchema:{type:'object'}},{id:'excluded',description:'Excluded',inputSchema:{type:'object'}}] : []},
   async call(scope) {expect(scope.ownerId).toBe('owner'); calls++; return {ok:true}}
  }})
  const rpc = async (body: unknown, token = bridge.token, session: string = bridge.sessionId) => fetch(bridge.url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Mcp-Session-Id':session},body:JSON.stringify(body)})
  try {
   expect((await rpc({jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2025-11-25'}},'foreign')).status).toBe(401)
   expect((await (await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}})).json() as any).result.protocolVersion).toBe('2025-11-25')
   const listed: any = await (await rpc({jsonrpc:'2.0',id:2,method:'tools/list'})).json()
   expect(listed.result.tools).toHaveLength(1)
   const params = {name:listed.result.tools[0].name,arguments:{}}
   expect((await (await rpc({jsonrpc:'2.0',id:3,method:'tools/call',params})).json() as any).result.isError).toBe(false)
   expect(calls).toBe(1)
   permitted=false
   expect((await (await rpc({jsonrpc:'2.0',id:4,method:'tools/call',params})).json() as any).error).toBeDefined()
   expect(calls).toBe(1)
   expect((await rpc({jsonrpc:'2.0',id:5,method:'tools/list'},bridge.token,'another-session')).status).toBe(404)
   expect((await (await rpc({jsonrpc:'2.0',id:6,method:'tools/list',ownerId:'other'})).json() as any).error).toBeDefined()
  } finally {await bridge.close(); await rm(workspace,{recursive:true,force:true})}
 })
 test('denied shell commands never reach execution', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'external-denied-test-'))
  let spawned = false
  const shell = new ControlledShell({ownerId:'owner',agentId:'agent',sessionId:'session',workspace},{kind:'test',interactive:false,async spawn(){spawned=true;throw new Error('unexpected')}},{async authorize(){return {allowed:false,reason:'policy denied'}},async audit(){}})
  try {await expect(shell.run({command:'echo denied'})).rejects.toThrow('policy denied');expect(spawned).toBe(false)} finally {await rm(workspace,{recursive:true,force:true})}
 })
 test.skipIf(process.platform !== 'darwin')('OS shell boundary blocks outside reads, network, and unlisted executables', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'external-seatbelt-test-'))
  await mkdir(join(workspace,'nested'))
  const shell = new ControlledShell({ownerId:'owner',agentId:'agent',sessionId:'session',workspace},createSandboxExecutionPort(),{async authorize(){return {allowed:true}},async audit(){}})
  try {
   expect((await shell.run({command:'echo scoped'})).stdout.trim()).toBe('scoped')
   expect((await shell.run({command:'cat /etc/passwd'})).exitCode).not.toBe(0)
   expect((await shell.run({command:'/usr/bin/curl http://127.0.0.1:1'})).exitCode).not.toBe(0)
   expect(() => shell.setState({cwd:'/'})).toThrow()
   shell.setState({cwd:join(workspace,'nested'),environment:{TEST_VALUE:'scoped'}})
   expect((await shell.run({command:'echo "$TEST_VALUE"; pwd'})).stdout).toContain('/nested')
   await expect(shell.run({command:'while :; do :; done',timeoutMs:20})).rejects.toThrow('timed out')
  } finally {await rm(workspace,{recursive:true,force:true})}
 })
})

test.skipIf(!process.env.OPENCODE_TEST_EXECUTABLE)('real pinned OpenCode initializes through the isolated ACP transport', async () => {
 const { verifyOpenCodeInstallation } = await import('../src/providers/opencode/installation.ts')
 const executable = process.env.OPENCODE_TEST_EXECUTABLE!
 const configurationRoot = await mkdtemp(join(tmpdir(), 'external-acp-test-'))
 try {
  const result = await verifyOpenCodeInstallation({id:'test-install',root:join(executable,'../..'),executable},createSandboxExecutionPort(),configurationRoot)
  expect(result.healthy).toBe(true)
  expect(result.version).toBe('2.0.26')
  expect(result.protocolVersion).toBe(1)
 } finally {await rm(configurationRoot,{recursive:true,force:true})}
})
