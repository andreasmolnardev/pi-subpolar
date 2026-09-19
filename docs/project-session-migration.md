# Project and session metadata migration

`@webui/server/project-store.ts` is the bridge-facing repository for moving project/session **metadata** from the legacy SQLite tables to PocketBase. It does not replace Pi's session store.

## Ownership model

The repository creates or extends two PocketBase base collections:

- `projects`: `user_id`, `name`, `path`, `created_at`, and `updated_at`. Project names are unique per user.
- `sessions`: `user_id`, `session_id`, `project_id`, `project_name`, `title`, `created_at`, `updated_at`, `archived`, `profile`, `model`, `directory`, and `permission_override`. `(user_id, session_id)` is unique.

`session_id` is intentionally not PocketBase's record `id`. It is the Pi-native id from the first line of the JSONL transcript, so PocketBase can use its own short record ids without changing transcript identity. `project_id` is an owner-scoped project record id. It is empty for General Chat and for a legacy session whose project definition was not available.

Every read, update, and delete starts with a `user_id` filter. `getSessionContext` additionally resolves `project_id` through the same owner filter. It returns `null` for an unknown session, an unauthorized session, a deleted project, or an orphaned non-General session; it never trusts a caller-supplied project path to establish context.

## Exports

The module is deliberately not re-exported from the existing server barrel because this change owns only the new file. A later bridge integration can import it directly:

- Types: `ProjectDefinition`, `ProjectRecord`, `SessionRecord`, `StoredSessionRecord`, `SessionContext`, input/options and migration result types.
- Schema: `PROJECTS_COLLECTION`, `SESSIONS_COLLECTION`, `GENERAL_CHAT_NAME`, and `PROJECT_SESSION_SCHEMA`.
- Setup: `ensureProjectSessionCollections`, `createProjectSessionRepository`, and `ProjectSessionRepository`.
- Repository methods: `createProject`, `getProject`, `findProjectByName`, `listProjects`, `updateProject`, `deleteProject`, `createSession`, `getSession`, `listSessions`, `updateSession`, `deleteSession`, `getSessionContext`, `migrateLegacyProjects`, `migrateLegacySessions`, and `migrateLegacyMetadata`.
- Legacy readers/parsers: `parseLegacyProjects`, `parseLegacySessions`, `readLegacyJsonFile`, `readLegacyProjectsFile`, and `readLegacySessionsFile`.

Example setup:

```ts
import { getPocketBaseAdmin } from './pocketbase.ts'
import { createProjectSessionRepository } from './project-store.ts'

const store = createProjectSessionRepository(await getPocketBaseAdmin())
await store.ensureCollections()
const context = await store.getSessionContext(user.id, piSessionId)
```

## Migration assumptions

1. The caller supplies the destination PocketBase user id explicitly. Legacy `user_id` values are not trusted to assign ownership; unowned SQLite/JSON records are assigned to that explicit owner. A multi-user deployment must run migration once per known owner with an intentional source-to-owner mapping.
2. Legacy projects must be migrated before sessions when the session's project should be linked. The session migration resolves the old `project` name against that owner's PocketBase projects. If no definition is present, it retains the session as an owned orphan; context lookup refuses to turn that orphan into a project/filesystem context.
3. Existing project rows are matched by owner and exact name. Existing session rows are matched by owner and Pi `session_id`. Migration is idempotent and merges timestamps, keeps a meaningful existing title, and retains optional metadata already present in PocketBase.
4. `General Chat` is a reserved virtual project and has no `projects` row. General Chat sessions can still have their existing `directory` metadata.
5. Existing collections are extended only with missing fields/indexes. Existing fields with incompatible types, collection API rules, and indexes with different definitions are not silently rewritten; those require an operator migration.
6. Project paths and session directories are stored as resolved strings for compatibility with the current bridge. This repository does not verify that a path exists or open it.

## Transcript preservation

The migration reads only legacy metadata sources such as SQLite rows supplied by the caller or `.sessions.json`/`projects.json` files passed to the file helpers. It never scans, parses, copies, renames, or deletes Pi `.jsonl` transcripts. Session creation/deletion in this repository changes PocketBase metadata only. A later bridge integration should continue to use Pi's normal session directory and the stored Pi `session_id` when opening a transcript.
