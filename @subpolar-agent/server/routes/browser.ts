/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleBrowserRoute(
  context: BridgeRequestContext,
): Promise<Response | undefined> {
  const {
    request,
    url,
    path,
    correlationId,
    deps,
    gatewayCredential,
    internalRequest,
  } = context
  let authenticatedUser = context.authenticatedUser
  if (path[1] === 'browser' && authenticatedUser) {
    const browser = new deps.BrowserSessionService(
      await deps.applicationDatabase(),
    )
    const browserContext = async (input: Record<string, unknown> = {}) => {
      if (typeof input.sessionId === 'string' && !input.projectId) {
        const row = await (
          await deps.applicationDatabase()
        )
          .collection('sessions')
          .getFirstListItem(
            `user_id = "${deps.escapeFilter(authenticatedUser.id)}" && session_id = "${deps.escapeFilter(input.sessionId)}"`,
          )
          .catch(() => null)
        if (row?.project_id && row.user_id === authenticatedUser.id)
          input = { ...input, projectId: row.project_id }
      }
      return {
        ownerId: authenticatedUser!.id,
        ...(typeof input.projectId === 'string' && input.projectId.trim()
          ? { projectId: input.projectId.trim() }
          : {}),
        ...(typeof input.sessionId === 'string' && input.sessionId.trim()
          ? { sessionId: input.sessionId.trim() }
          : {}),
        ...(typeof input.taskId === 'string' && input.taskId.trim()
          ? { taskId: input.taskId.trim() }
          : {}),
      }
    }
    try {
      if (path[2] === 'profiles') {
        const id = decodeURIComponent(path[3] ?? '')
        if (path.length === 3 && request.method === 'GET')
          return deps.json({
            profiles: await browser.profiles(authenticatedUser.id),
          })
        if (path.length === 3 && request.method === 'POST')
          return deps.json(
            {
              profile: await browser.createProfile(
                authenticatedUser.id,
                String(deps.object(await deps.body(request)).name ?? ''),
              ),
            },
            201,
          )
        if (path.length === 4 && request.method === 'PATCH')
          return deps.json({
            profile: await browser.renameProfile(
              authenticatedUser.id,
              id,
              String(deps.object(await deps.body(request)).name ?? ''),
            ),
          })
        if (
          (path.length === 4 && request.method === 'DELETE') ||
          (path[4] === 'clear' && request.method === 'POST')
        ) {
          await browser.clearProfile(
            authenticatedUser.id,
            id,
            request.method === 'DELETE',
          )
          return deps.json({ ok: true })
        }
        return deps.json({ error: 'Browser profile route not found' }, 404)
      }
      if (
        ['artifacts', 'downloads'].includes(path[2]) &&
        path[4] === 'file' &&
        request.method === 'GET'
      ) {
        const database = await deps.applicationDatabase()
        const download = path[2] === 'downloads'
        const row = await (download
          ? browser.downloadArtifact(
              authenticatedUser.id,
              decodeURIComponent(path[3]),
            )
          : browser.artifact(authenticatedUser.id, decodeURIComponent(path[3])))
        if (download ? !row.file : !row.image || row.status !== 'captured')
          return deps.json({ error: 'Screenshot unavailable' }, 404)
        const token = await database.files.getToken()
        const response = await fetch(
          database.files.getURL(row, download ? row.file : row.image, {
            token,
          }),
        )
        if (!response.ok)
          return deps.json({ error: 'Screenshot unavailable' }, 404)
        return new Response(response.body, {
          headers: {
            'Content-Type': response.headers.get('Content-Type') ?? 'image/png',
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
            ...(download ? { 'Content-Disposition': 'attachment' } : {}),
          },
        })
      }
      if (path[2] !== 'sessions')
        return deps.json({ error: 'Browser route not found' }, 404)

      if (path.length === 3 && request.method === 'POST') {
        const input = deps.object(await deps.body(request))
        return deps.json(
          {
            session: await browser.create(
              await browserContext(input),
              deps.object(input.limits),
              typeof input.profileId === 'string' ? input.profileId : undefined,
            ),
          },
          201,
        )
      }
      if (path.length === 3 && request.method === 'GET')
        return deps.json({
          sessions: await browser.list(
            await browserContext({
              projectId: url.searchParams.get('projectId') ?? undefined,
              sessionId: url.searchParams.get('sessionId') ?? undefined,
              taskId: url.searchParams.get('taskId') ?? undefined,
            }),
          ),
        })
      const browserId = decodeURIComponent(path[3] ?? '')
      const context = await browserContext({
        projectId: url.searchParams.get('projectId') ?? undefined,
        sessionId: url.searchParams.get('sessionId') ?? undefined,
        taskId: url.searchParams.get('taskId') ?? undefined,
      })
      if (path.length === 4 && request.method === 'GET')
        return deps.json({ session: await browser.get(context, browserId) })
      if (path.length === 5 && path[4] === 'frame' && request.method === 'GET')
        return deps.json(await browser.frame(context, browserId))
      if (
        path.length === 5 &&
        path[4] === 'control' &&
        request.method === 'POST'
      ) {
        const input = deps.object(await deps.body(request))
        return deps.json({
          controller: await browser.control(
            context,
            browserId,
            String(input.action ?? ''),
            typeof input.leaseId === 'string' ? input.leaseId : undefined,
          ),
        })
      }
      if (
        path.length === 5 &&
        path[4] === 'input' &&
        request.method === 'POST'
      ) {
        const input = deps.object(await deps.body(request))
        if (typeof input.leaseId !== 'string' || !input.leaseId)
          return deps.json(
            {
              error: 'Take control before sending browser input',
              code: 'BROWSER_CONTROLLER_EXPIRED',
            },
            409,
          )
        const result = await browser.execute(
          { ...context, manualLeaseId: input.leaseId },
          String(input.operation ?? ''),
          { ...deps.object(input.input), browserSessionId: browserId },
        )
        return deps.json({
          result,
          session: await browser.get(context, browserId),
        })
      }
      if (path.length === 5 && path[4] === 'close' && request.method === 'POST')
        return deps.json({ session: await browser.close(context, browserId) })
      if (
        path.length === 5 &&
        path[4] === 'audit' &&
        request.method === 'GET'
      ) {
        const owned = await browser.get(context, browserId)
        const audit = await (
          await deps.applicationDatabase()
        )
          .collection('browser_audit')
          .getFullList({
            filter: `owner_id = "${deps.escapeFilter(authenticatedUser.id)}" && browser_session_id = "${deps.escapeFilter(owned.id)}"`,
            sort: '-created_at',
          })
        return deps.json({
          audit: audit.filter(
            (row) =>
              row.owner_id === authenticatedUser.id &&
              row.browser_session_id === owned.id,
          ),
        })
      }
      return deps.json({ error: 'Browser session route not found' }, 404)
    } catch (error) {
      if (
        error instanceof deps.BrowserRuntimeError ||
        (typeof error?.code === 'string' &&
          /^BROWSER_[A-Z_]+$/.test(error.code))
      )
        return deps.json(
          { error: error.message, code: error.code },
          error.code === 'BROWSER_SESSION_NOT_FOUND' ? 404 : 409,
        )
      console.warn(
        `Browser session request failed: ${deps.redactedDiagnostic(error)}`,
      )
      return deps.json(
        {
          error: 'Browser session store unavailable',
          code: 'BROWSER_UNAVAILABLE',
        },
        503,
      )
    }
  }
  return undefined
}
