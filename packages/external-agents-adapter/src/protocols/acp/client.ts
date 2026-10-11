import type { IsolatedProcess } from '../../runtime/contracts.ts'
export type AcpMessage = Record<string, any>
export class AcpError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); this.name = 'AcpError' }
}
/** ACP is NDJSON JSON-RPC 2.0. Never expose stderr, which may contain credentials. */
export class AcpClient {
  private sequence = 0
  private pending = new Map<number, {resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>}>()
  private stopped = false
  constructor(private process: IsolatedProcess, private notification: (message: AcpMessage) => Promise<void>, private incoming: (message: AcpMessage) => Promise<unknown>, private timeout = 120_000) {
    void this.read().catch(() => this.fail(new AcpError(-32000, 'ACP transport failed')))
    void (async () => { for await (const ignored of process.stderr) { void ignored } })().catch(() => {})
    void process.exited.then(() => this.fail(new AcpError(-32000, 'ACP process exited')), () => this.fail(new AcpError(-32000, 'ACP process failed')))
  }
  request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    if (this.stopped) return Promise.reject(new AcpError(-32000, 'ACP connection closed'))
    if (signal?.aborted) return Promise.reject(new AcpError(-32800, 'ACP request cancelled'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: any) => { clearTimeout(timer); this.pending.delete(id); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value) }
      const abort = () => finish(new AcpError(-32800, 'ACP request cancelled'))
      const timer = setTimeout(() => finish(new AcpError(-32000, 'ACP request timed out')), this.timeout)
      this.pending.set(id, {resolve: value => finish(undefined, value), reject: error => finish(error), timer})
      signal?.addEventListener('abort', abort, {once:true})
      try { this.send({jsonrpc:'2.0', id, method, params}) } catch { finish(new AcpError(-32000,'ACP write failed')) }
    })
  }
  notify(method: string, params: unknown) { this.send({jsonrpc:'2.0',method,params}) }
  private send(message: unknown) { this.process.stdin.write(JSON.stringify(message) + '\n') }
  private async read() {
    const decoder = new TextDecoder(); let buffer = ''
    for await (const bytes of this.process.stdout) {
      buffer += decoder.decode(bytes, {stream:true})
      if (buffer.length > 8 * 1024 * 1024) throw new Error('ACP frame exceeds limit')
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0,newline); buffer = buffer.slice(newline+1)
        if (!line.trim()) continue
        const message = JSON.parse(line) as AcpMessage
        if (message.jsonrpc !== '2.0') throw new Error('Invalid ACP message')
        if (message.method && message.id !== undefined) {
          try { const result = await this.incoming(message); this.send({jsonrpc:'2.0',id:message.id,result}) }
          catch { this.send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unsupported ACP client request'}}) }
        } else if (message.method) await this.notification(message)
        else if (typeof message.id === 'number') {
          const pending = this.pending.get(message.id)
          if (message.error) pending?.reject(new AcpError(message.error.code, 'ACP request failed', message.error.data))
          else pending?.resolve(message.result)
        }
      }
    }
    if (buffer.trim()) throw new Error('Incomplete ACP frame')
    this.fail(new AcpError(-32000,'ACP connection closed'))
  }
  private fail(error: Error) { this.stopped = true; for (const pending of [...this.pending.values()]) pending.reject(error) }
  async close() { this.fail(new AcpError(-32800,'ACP connection closed')); this.process.stdin.end(); await this.process.stop() }
}
