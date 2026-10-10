import http from 'node:http'
import net from 'node:net'
import { lookup } from 'node:dns/promises'

export function publicAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [a,b] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && (b === 168 || b === 0 || b === 2) || a === 100 && b! >= 64 && b! <= 127 || a! >= 224 || a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0)
  }
  return net.isIP(address) === 6 && /^[23]/.test(address) && !address.toLowerCase().startsWith('2001:db8:') && !address.toLowerCase().startsWith('2002:') && !address.toLowerCase().startsWith('2001:0:')
}
/** DNS answers are checked and the socket connects to the checked IP, never re-resolving. */
export async function createEgressProxy(allowedPrivateHosts: string[] = [], maxConnectionBytes = 16 * 1024 * 1024) {
  const sockets = new Set<net.Socket>()
  async function target(host: string, port: number) {
    host = host.replace(/^\[|\]$/g, '').toLowerCase()
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Blocked destination')
    const addresses = await lookup(host, { all: true })
    if (!addresses.length || !allowedPrivateHosts.includes(host) && addresses.some(a => !publicAddress(a.address))) throw Error('Blocked destination')
    return { address: addresses[0]!.address, port }
  }
  const server = http.createServer(async (req,res) => {
    try {
      const url = new URL(req.url!)
      if (url.protocol !== 'http:' || url.username || url.password) throw Error('Blocked destination')
      const dest = await target(url.hostname, Number(url.port || 80))
      const headers = { ...req.headers, host: url.host }; delete headers['proxy-authorization']; delete headers['proxy-connection']
      const upstream = http.request({ hostname: dest.address, port: dest.port, path: url.pathname + url.search, method: req.method, headers }, r => { let received=0; r.on('data',chunk=>{received+=chunk.length;if(received>maxConnectionBytes){r.destroy();res.destroy()}}); res.writeHead(r.statusCode || 502, r.headers); r.pipe(res) })
      upstream.setTimeout(60_000, () => upstream.destroy()); upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() }); req.pipe(upstream)
    } catch { res.writeHead(403); res.end('Browser network policy denied destination') }
  })
  server.on('connect', async (req, client, head) => {
    try {
      const url = new URL('https://' + req.url)
      const dest = await target(url.hostname, Number(url.port || 443))
      const upstream = net.connect(dest.port, dest.address)
      let received=0; upstream.on('data',chunk=>{received+=chunk.length;if(received>maxConnectionBytes){upstream.destroy();client.destroy()}}); sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream))
      upstream.setTimeout(60_000, () => upstream.destroy())
      upstream.on('error', () => client.destroy())
      upstream.on('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client) })
      client.on('close', () => upstream.destroy())
    } catch { client.end('HTTP/1.1 403 Forbidden\r\n\r\n') }
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
