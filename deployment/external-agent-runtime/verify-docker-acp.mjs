import { spawn } from 'node:child_process'
import { AcpClient } from '../../packages/external-agents-adapter/src/protocols/acp/client.ts'
import { OPENCODE_VERSION, verifyHandshake } from '../../packages/external-agents-adapter/src/runtime/capabilities.ts'

const process = spawn('docker', [
  'compose', '-f', 'deployment/external-agent-runtime/compose.yaml',
  'exec', '-T', 'opencode-v2',
  '/var/lib/subpolar/opencode/opencode', 'acp',
], { stdio: ['pipe', 'pipe', 'pipe'] })
const isolatedProcess = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  exited: new Promise(resolve => process.once('close', code => resolve(code ?? 1))),
  stop: async () => {
    if (process.exitCode === null) process.kill('SIGTERM')
  },
}
const client = new AcpClient(isolatedProcess, async () => {}, async () => {
  throw new Error('Unexpected OpenCode-to-client request during the ACP lifecycle check')
}, 15000)

try {
  const initialized = await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'Subpolar Docker ACP verifier', version: '0.1.0' },
  })
  verifyHandshake(initialized)
  if (initialized.agentInfo.version !== OPENCODE_VERSION) throw new Error('Unexpected OpenCode version')
  const created = await client.request('session/new', { cwd: '/runtime/sessions', mcpServers: [] })
  if (typeof created.sessionId !== 'string' || !created.sessionId) throw new Error('OpenCode did not create an ACP session')
  await client.request('session/close', { sessionId: created.sessionId })
  console.log(JSON.stringify({ version: initialized.agentInfo.version, protocolVersion: initialized.protocolVersion, sessionLifecycle: 'passed' }))
} finally {
  await client.close()
}
