export const OPENCODE_VERSION = '2.0.26'
export const ACP_PROTOCOL_VERSION = 1
export const externalCapabilities = Object.freeze({provider:'opencode-v2',runtimeVersion:OPENCODE_VERSION,acpProtocolVersion:ACP_PROTOCOL_VERSION,streaming:true,persistentSessions:true,permissionRequests:true,mcp:true,customShell:true,nativeShell:false,remoteConnection:false})
export function verifyHandshake(value: any): void {
  if (value?.protocolVersion !== ACP_PROTOCOL_VERSION || value?.agentInfo?.version !== OPENCODE_VERSION || !value?.agentCapabilities?.loadSession || !value?.agentCapabilities?.mcpCapabilities?.http) throw new Error('OpenCode runtime does not match the verified ACP contract')
}
