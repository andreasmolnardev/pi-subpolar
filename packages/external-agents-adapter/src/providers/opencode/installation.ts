import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { IsolatedExecutionPort, IsolatedProcess } from '../../runtime/contracts.ts'
import { AcpClient } from '../../protocols/acp/client.ts'
import { OPENCODE_VERSION, verifyHandshake } from '../../runtime/capabilities.ts'
import type { OpenCodeInstallation } from './adapter.ts'
async function output(process: IsolatedProcess): Promise<string> {
 let value=''; const read=(async()=>{for await (const bytes of process.stdout) { value+=new TextDecoder().decode(bytes); if(value.length>65536) {await process.stop();throw new Error('Installation output exceeded limit')} }})()
 const discard=(async()=>{for await(const bytes of process.stderr) void bytes})()
 const status=await process.exited; await Promise.all([read,discard]); if(status!==0) throw new Error('OpenCode installation command failed'); return value
}
/** Installer is isolated too. Caller explicitly supplies package-manager executable. */
export async function installOpenCode(options: {root:string;execution:IsolatedExecutionPort;npmExecutable:string}): Promise<OpenCodeInstallation & {version:string}> {
 const root=resolve(options.root); await mkdir(root,{recursive:true,mode:0o700})
 const environment={XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_CACHE_HOME:join(root,'cache'),npm_config_cache:join(root,'npm-cache')}
 await output(await options.execution.spawn({executable:options.npmExecutable,args:['install','--prefix',root,'--save-exact','--no-audit','--no-fund',`@opencode/cli@${OPENCODE_VERSION}`],cwd:root,environment,readableRoots:[root],writableRoots:[root],allowedExecutables:[options.npmExecutable],timeoutMs:300000,maxOutputBytes:65536}))
 const manifest=JSON.parse(await readFile(join(root,'node_modules/@opencode/cli/package.json'),'utf8'))
 if(manifest.version!==OPENCODE_VERSION) throw new Error('Installed OpenCode version mismatch')
 const executable=join(root,'node_modules/.bin/opencode')
 const version=await output(await options.execution.spawn({executable,args:['--version'],cwd:root,environment,readableRoots:[root],writableRoots:[root],allowedExecutables:[executable],timeoutMs:30000,maxOutputBytes:65536}))
 if(version.trim()!==`opencode v${OPENCODE_VERSION}`) throw new Error('Installed binary version mismatch')
 return {id:`opencode-v2-${OPENCODE_VERSION}`,version:OPENCODE_VERSION,executable,root}
}
export async function verifyOpenCodeInstallation(installation:OpenCodeInstallation,execution:IsolatedExecutionPort,configurationRoot:string) {
 const process=await execution.spawn({executable:installation.executable,args:['acp'],cwd:configurationRoot,environment:{XDG_CONFIG_HOME:configurationRoot,XDG_DATA_HOME:join(configurationRoot,'data'),XDG_CACHE_HOME:join(configurationRoot,'cache')},readableRoots:[installation.root,configurationRoot],writableRoots:[configurationRoot],allowedExecutables:[installation.executable],networkPorts:[],allowLoopbackServer:true,timeoutMs:30000,maxOutputBytes:8388608})
 const client=new AcpClient(process,async()=>{},async()=>{throw new Error('Client request unsupported')},15000)
 try {const result=await client.request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'Subpolar',version:'0.1.0'}});verifyHandshake(result);return {healthy:true,version:OPENCODE_VERSION,protocolVersion:1,capabilities:result.agentCapabilities}}
 finally {await client.close()}
}
