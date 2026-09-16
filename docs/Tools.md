# Tools

## How tools work

The model does not call tools directly. It calls a small set of Pi tools that act as the entry point for all tool use.

For each call:

1. Pi sends the request to Subpolar.
2. Subpolar checks that the tool exists, the input is valid, and the active agent is allowed to use it.
3. If the tool needs approval, Subpolar pauses and asks the user.
4. Subpolar runs the tool and sends the result back to the model.

File and shell tools run in the selected project. External HTTP, OpenAPI, and MCP tools are run through the same path. Calls and permission decisions are recorded for auditing.

External tools are not added to the model one by one. Use `search-tool` to find them, then use `subpolar-tools` to list, inspect, or call one.

## Included by default

The default `master` agent can use:

- `read` — read project files.
- `write` — create or replace files. Requires approval.
- `edit` — make targeted file changes. Requires approval.
- `bash` — run commands in the project. Requires approval.
- `grep` — search file contents.
- `find` — find files by pattern.
- `ls` — list directory contents.
- `search-tool` — find available tools.

`subpolar-tools` is available when the agent has access to external tools. Agents can have a smaller or larger set depending on their permissions. Permissions can allow a call, deny it, or require approval.
