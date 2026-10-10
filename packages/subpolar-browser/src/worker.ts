import { timingSafeEqual } from 'node:crypto'
import { ChromiumBrowserPort, type EngineOptions } from './engine.ts'
const methods = new Set(['start','open','navigate','back','forward','tabs','read','find','screenshot','wait','action','close','clearProfile','health'])
export function startBrowserWorker(options:EngineOptions & {token:string;hostname?:string;port?:number}) {
  if(options.token.length<32)throw Error('Browser worker token must contain at least 32 characters')
  const engine=new ChromiumBrowserPort(options)
  const secret=Buffer.from(`Bearer ${options.token}`)
  const server=Bun.serve({hostname:options.hostname??'127.0.0.1',port:options.port??3101,maxRequestBodySize:262144,async fetch(request){
    const supplied=Buffer.from(request.headers.get('authorization')??''); if(supplied.length!==secret.length||!timingSafeEqual(supplied,secret))return Response.json({code:'BROWSER_POLICY',message:'Worker authentication required'},{status:401})
    if(request.method!=='POST'||new URL(request.url).pathname!=='/v1/browser')return new Response(null,{status:404})
    try { const body=await request.json() as any; if(!methods.has(body.method)||!Array.isArray(body.args)||body.args.length>4) return Response.json({code:'BROWSER_INVALID_INPUT',message:'Invalid worker request'},{status:400}); const result=await (engine as any)[body.method](...body.args); return Response.json({result:result??null}) }
    catch(error){ const code=error && typeof error==='object' && 'code' in error ? String(error.code):error instanceof Error && error.name==='TimeoutError'?'BROWSER_TIMEOUT':'BROWSER_UNAVAILABLE'; return Response.json({code,message:code==='BROWSER_PROFILE_BUSY'?'Browser profile is already in use':code==='BROWSER_TIMEOUT'?'Browser operation timed out':'Browser operation failed'},{status:400}) }
  }})
  return {server,engine,close:async()=>{server.stop(true);await engine.dispose()}}
}
if(import.meta.main){ const worker=startBrowserWorker({token:process.env.SUBPOLAR_BROWSER_WORKER_TOKEN??'',hostname:process.env.SUBPOLAR_BROWSER_WORKER_HOST??'127.0.0.1',port:Number(process.env.SUBPOLAR_BROWSER_WORKER_PORT??3101),profileRoot:process.env.SUBPOLAR_BROWSER_PROFILE_ROOT??'./browser-profiles',allowedPrivateHosts:(process.env.SUBPOLAR_BROWSER_ALLOWED_PRIVATE_HOSTS??'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean),maxSessions:Number(process.env.SUBPOLAR_BROWSER_MAX_SESSIONS??4),idleMs:Number(process.env.SUBPOLAR_BROWSER_IDLE_MS??900000)}); for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>void worker.close().then(()=>process.exit(0))) }
