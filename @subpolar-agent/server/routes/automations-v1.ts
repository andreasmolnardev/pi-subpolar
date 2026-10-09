import type { BridgeRequestContext } from '../bridge-route-context.ts'
import type { AutomationDefinition, AutomationExecution } from '../../../packages/subpolar-automations/src/index.ts'
import { createOrRotateAutomationWebhookSecret, createPocketBaseAutomationWebhookSecretStore } from '../../../packages/subpolar-persistance-pocketbase/src/automation-webhook-secrets.ts'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function positiveLimit(value: string | null, fallback = 50): number {
  const parsed = value === null ? fallback : Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : fallback
}

function publicExecution(execution: Record<string, any>): Record<string, unknown> {
  return {
    ...execution,
    canonicalRunId: execution.runId,
    ...(execution.runId ? { canonicalSessionId: `automation-${String(execution.id).replaceAll(/[^a-zA-Z0-9_-]/g, '-')}` } : { canonicalSessionId: null }),
    actions: Array.isArray(execution.actions) ? execution.actions.map((action: Record<string, unknown>) => ({
      ...action,
      type: action.actionType,
    })) : [],
  }
}

async function ownedProject(client: any, ownerId: string, projectId: unknown): Promise<boolean> {
  if (projectId === undefined || projectId === null || projectId === '') return true
  if (typeof projectId !== 'string') return false
  return Boolean(await (await import('../persistence/project-store.ts')).createProjectSessionRepository(client).getProject(ownerId, projectId))
}

export async function handleAutomationsV1Route(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, path, url, correlationId, deps } = context
  const ownerId = context.authenticatedUser?.id
  if (path[1] !== 'v1' || path[2] !== 'automations' || !ownerId) return undefined

  try {
    const client = await deps.applicationDatabase()
    const runtime = deps.firstClassAutomationFor(client, ownerId)
    if (path.length === 3 && request.method === 'GET') {
      const automations = await runtime.definitions.list(ownerId) as AutomationDefinition[]
      const enriched = await Promise.all(automations.map(async (automation) => {
        const [executions, schedule] = await Promise.all([
          runtime.executions.list(ownerId, automation.id, 1),
          runtime.repositories.schedules.get(ownerId, automation.id),
        ])
        const latest = executions[0]
        return {
          ...automation,
          lastExecutionAt: latest?.createdAt ?? null,
          lastStatus: latest?.status ?? null,
          nextExecutionAt: schedule?.nextRunAt ?? null,
        }
      }))
      return deps.json({ automations: enriched }, 200, correlationId)
    }

    if (path.length === 3 && request.method === 'POST') {
      const input = await deps.body(request)
      const isWebhook = input.trigger && typeof input.trigger === 'object' && (input.trigger as Record<string, unknown>).type === 'webhook'
      if (!await ownedProject(client, ownerId, input.projectId)) return deps.routeError(correlationId, 'PROJECT_NOT_FOUND', 'Project is not owned by the authenticated user', 403)
      const requestedEnabled = input.enabled !== false
      if (isWebhook) {
        // Create an inactive definition first, then provision the secret and persist
        // the exact reference returned by the secret store before enabling it.
        input.trigger = { type: 'webhook', credentialRef: `wh_${crypto.randomUUID().replaceAll('-', '')}` }
        input.enabled = false
      }
      let automation = await runtime.definitions.create(ownerId, input)
      let webhook
      if (isWebhook) {
        try {
          webhook = await createOrRotateAutomationWebhookSecret(client, ownerId, automation.id)
          const finalized = await runtime.definitions.update(ownerId, automation.id, {
            trigger: { type: 'webhook', credentialRef: webhook.credentialRef },
            enabled: requestedEnabled,
          })
          if (!finalized) throw new Error('Created automation could not be finalized')
          automation = finalized
        } catch (error) {
          if (webhook) await createPocketBaseAutomationWebhookSecretStore(client).revoke(ownerId, automation.id, webhook.credentialRef).catch(() => false)
          const removed = await runtime.definitions.delete(ownerId, automation.id).catch(() => false)
          if (!removed) await runtime.definitions.update(ownerId, automation.id, { enabled: false, trigger: { type: 'manual' } }).catch(() => undefined)
          throw Object.assign(new Error('Webhook credential provisioning failed; the automation was removed or disabled'), {
            code: 'WEBHOOK_CREDENTIAL_PROVISIONING_FAILED',
            cause: error,
          })
        }
      }
      const created = {
        ...automation,
        ...(automation.trigger.type === 'schedule' ? { nextExecutionAt: null } : {}),
        lastExecutionAt: null,
        lastStatus: null,
      }
      return deps.json({ automation: created, ...(webhook ? { webhook: { credentialRef: webhook.credentialRef, url: `/api/v1/automation-webhooks/${encodeURIComponent(webhook.credentialRef)}`, secret: webhook.secret } } : {}) }, 201, correlationId)
    }

    if (path.length < 4) return undefined
    const automationId = decodeURIComponent(path[3]!)
    const automation = await runtime.definitions.get(ownerId, automationId)
    if (!automation) return deps.routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404)

    if (path.length === 4 && request.method === 'GET') {
      const [latest] = await runtime.executions.list(ownerId, automationId, 1) as AutomationExecution[]
      const schedule = await runtime.repositories.schedules.get(ownerId, automationId)
      return deps.json({ automation: { ...automation, lastExecutionAt: latest?.createdAt ?? null, lastStatus: latest?.status ?? null, nextExecutionAt: schedule?.nextRunAt ?? null } }, 200, correlationId)
    }
    if (path.length === 4 && request.method === 'PATCH') {
      const input = await deps.body(request)
      if (Object.hasOwn(input, 'projectId') && !await ownedProject(client, ownerId, input.projectId)) return deps.routeError(correlationId, 'PROJECT_NOT_FOUND', 'Project is not owned by the authenticated user', 403)
      const priorCredentialRef = automation.trigger.type === 'webhook' ? automation.trigger.credentialRef : undefined
      const nextTrigger = input.trigger && typeof input.trigger === 'object' ? input.trigger as Record<string, unknown> : undefined
      const nextCredentialRef = nextTrigger?.type === 'webhook' && typeof nextTrigger.credentialRef === 'string' ? nextTrigger.credentialRef : undefined
      if (nextTrigger?.type === 'webhook' && priorCredentialRef && (!nextCredentialRef || nextCredentialRef === 'managed-webhook')) {
        input.trigger = { type: 'webhook', credentialRef: priorCredentialRef }
      } else if (nextCredentialRef && priorCredentialRef && nextCredentialRef !== priorCredentialRef) {
        return deps.routeError(correlationId, 'WEBHOOK_CREDENTIAL_ROTATION_REQUIRED', 'Use the webhook-secret endpoint to rotate or replace webhook credentials', 409)
      }
      const enteringWebhook = nextTrigger?.type === 'webhook' && !priorCredentialRef
      const webhook = enteringWebhook
        ? await createOrRotateAutomationWebhookSecret(client, ownerId, automationId)
        : undefined
      if (webhook) input.trigger = { type: 'webhook', credentialRef: webhook.credentialRef }
      let updated
      try {
        updated = await runtime.definitions.update(ownerId, automationId, input)
      } catch (error) {
        if (webhook) await createPocketBaseAutomationWebhookSecretStore(client).revoke(ownerId, automationId, webhook.credentialRef).catch(() => false)
        throw error
      }
      if (!updated && webhook) await createPocketBaseAutomationWebhookSecretStore(client).revoke(ownerId, automationId, webhook.credentialRef).catch(() => false)
      if (!updated) return deps.routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404)
      if (priorCredentialRef && updated.trigger.type !== 'webhook') {
        await createPocketBaseAutomationWebhookSecretStore(client).revoke(ownerId, automationId, priorCredentialRef)
      }
      return deps.json({ automation: updated, ...(webhook ? { webhook: { credentialRef: webhook.credentialRef, url: `/api/v1/automation-webhooks/${encodeURIComponent(webhook.credentialRef)}`, secret: webhook.secret } } : {}) }, 200, correlationId)
    }
    if (path.length === 4 && request.method === 'DELETE') {
      if (automation.trigger.type === 'webhook') {
        await createPocketBaseAutomationWebhookSecretStore(client).revoke(ownerId, automationId, automation.trigger.credentialRef)
      }
      return await runtime.definitions.delete(ownerId, automationId)
        ? deps.json({ ok: true }, 200, correlationId)
        : deps.routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404)
    }
    if (path.length === 5 && path[4] === 'webhook-secret' && request.method === 'POST') {
      if (automation.trigger.type !== 'webhook') return deps.routeError(correlationId, 'WEBHOOK_TRIGGER_REQUIRED', 'This automation does not have a webhook trigger', 409)
      const webhook = await createOrRotateAutomationWebhookSecret(client, ownerId, automationId, automation.trigger.credentialRef)
      return deps.json({ webhook: { credentialRef: webhook.credentialRef, url: `/api/v1/automation-webhooks/${encodeURIComponent(webhook.credentialRef)}`, secret: webhook.secret } }, 200, correlationId)
    }
    if (path.length === 5 && request.method === 'POST' && (path[4] === 'enable' || path[4] === 'disable')) {
      const updated = await runtime.definitions.update(ownerId, automationId, { enabled: path[4] === 'enable' })
      return updated ? deps.json({ automation: updated }, 200, correlationId) : deps.routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404)
    }
    if (path.length === 5 && path[4] === 'run' && request.method === 'POST') {
      const input = record(await deps.body(request))
      const payload = input.payload === undefined ? {} : input.payload
      const occurrenceKey = typeof input.idempotencyKey === 'string'
        ? `manual:${input.idempotencyKey}`
        : undefined
      if (occurrenceKey && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(occurrenceKey)) return deps.routeError(correlationId, 'INVALID_IDEMPOTENCY_KEY', 'Invalid idempotency key', 400)
      const execution = await runtime.executions.runNow(ownerId, automationId, { payload, occurrenceKey, signal: request.signal })
      const result = await runtime.execution(ownerId, execution.id) ?? execution
      return deps.json({ execution: publicExecution(result as unknown as Record<string, any>) }, 202, correlationId)
    }
    if (path.length === 5 && path[4] === 'executions' && request.method === 'GET') {
      const executions = await runtime.history(ownerId, automationId, positiveLimit(url.searchParams.get('limit'))) as AutomationExecution[]
      return deps.json({ executions: executions.map((execution) => publicExecution(execution as unknown as Record<string, any>)) }, 200, correlationId)
    }
    if (path.length === 6 && path[4] === 'executions' && request.method === 'GET') {
      const execution = await runtime.execution(ownerId, decodeURIComponent(path[5]!))
      if (!execution || execution.automationId !== automationId) return deps.routeError(correlationId, 'AUTOMATION_EXECUTION_NOT_FOUND', 'Automation execution not found', 404)
      return deps.json({ execution: publicExecution(execution as unknown as Record<string, any>) }, 200, correlationId)
    }
    if (path.length === 7 && path[4] === 'executions' && path[6] === 'cancel' && request.method === 'POST') {
      const executionId = decodeURIComponent(path[5]!)
      const execution = await runtime.executions.cancel(ownerId, executionId)
      if (!execution || execution.automationId !== automationId) return deps.routeError(correlationId, 'AUTOMATION_EXECUTION_NOT_FOUND', 'Automation execution not found', 404)
      const updated = await runtime.execution(ownerId, executionId) ?? execution
      return deps.json({ execution: publicExecution(updated as unknown as Record<string, any>) }, 200, correlationId)
    }
    return undefined
  } catch (error) {
    const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? String((error as { code: string }).code)
      : 'AUTOMATION_REQUEST_FAILED'
    const status = code === 'AUTOMATION_NOT_FOUND' || code === 'AGENT_NOT_FOUND' ? 404
      : code === 'AUTOMATION_ATOMIC_CLAIM_UNSUPPORTED' || code === 'WEBHOOK_CREDENTIAL_PROVISIONING_FAILED' ? 503
        : error instanceof TypeError ? 400 : 500
    const message = error instanceof Error ? error.message : 'Automation request failed'
    return deps.routeError(correlationId, code, message, status)
  }
}
