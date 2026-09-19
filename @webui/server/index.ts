export {
  authenticateRequest,
  authCookie,
  clearAuthCookie,
  ensureApplicationCollections,
  getPocketBaseAdmin,
  getPocketBaseUrl,
  getUserPreferences,
  newPocketBaseClient,
  saveUserPreferences,
  type PocketBaseUser,
} from './pocketbase'

export {
  authConfig,
  changePassword,
  signIn,
  signOut,
  signUp,
  syncAdminFromEnv,
} from './auth'

export {
  authorizePiToolCall,
  callTool,
  canonicalToolId,
  continueApprovedTool,
  searchToolsForAgent,
  upsertRegisteredTool,
  describeToolForAgent,
  ensureToolRegistry,
  ensureUserDefaults,
  listAgents,
  listPendingApprovals,
  listToolsForAgent,
  respondToApproval,
  type AgentDefinition,
  type Approval,
  type PermissionOverride,
  type ToolDefinition,
} from './tools'

export {
  ApprovalFlowService,
  createApprovalFlow,
  type ApprovalFlowApproval,
  type ApprovalContinueResult,
  type ApprovalDecision,
} from './approval-flow.ts'

export {
  createToolGateway,
  createToolGatewayExecutor,
  createToolGatewayFromCallTool,
  InProcessToolGateway,
  ToolGatewayAdapterRegistry,
  type ToolGateway,
  type ToolGatewayContext,
  type ToolGatewayRequest,
  type ToolGatewayResult,
} from './tool-gateway.ts'

export {
  AgentRuntimeError,
  createPocketBaseAgentRuntimeAdapter,
  loadAgentRuntime,
  type AgentRuntime,
  type PiRuntimeConfiguration,
} from './agent-runtime.ts'

export {
  SessionContextError,
  createSessionContextResolver,
  createSqliteSessionContextStore,
  resolveSessionContext,
  type ResolvedSessionContext,
  type SessionContextDependencies,
} from './session-context.ts'

export {
  ProjectSessionRepository,
  ProjectPathConflictError,
  createProjectSessionRepository,
  ensureProjectSessionCollections,
} from './project-store.ts'

export {
  McpAdapterError,
  createMcpAdapter,
  DefaultMcpAdapter,
  type McpAdapter,
  type McpServerConfig,
  type McpToolReference,
} from './mcp-adapter.ts'

export * from './request-security.ts'
export * from './network-policy.ts'
export * from './security-redaction.ts'
export * from './project-filesystem.ts'

export * from './provider-accounts.ts'
export * from './provider-catalog.ts'
export * from './provider-login-flow.ts'
export * from './provider-login-flow-store.ts'
export * from './provider-runtime.ts'
export * from './custom-providers.ts'
export * from './gateway-credentials.ts'

export * from './git/contracts.ts'
export * from './git/executor.ts'
export * from './git/policy.ts'
export * from './git/service.ts'
