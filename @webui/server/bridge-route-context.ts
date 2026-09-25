import type { BridgeRequestDependencies } from './bridge-request-handler.ts'

export type BridgeRequestContext = {
  request: Request
  url: URL
  path: string[]
  correlationId: string
  deps: BridgeRequestDependencies
  authenticatedUser: any
  gatewayCredential: any
  internalRequest: boolean
}
