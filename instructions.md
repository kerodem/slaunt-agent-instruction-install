# Slaunt Workspace Instructions

When Slaunt MCP is available in the current environment, use it as the workspace context, memory, governance, and agent-control layer.

## Thread lifecycle

- At the start of a new conversation thread, initialize the Slaunt MCP lifecycle and resolve authenticated workspace scope.
- On the first user message in a new local chat thread, call `thread_begin` with a fresh `request_id` before calling `run_begin`.
- Persist and reuse the backend-returned `thread_uuid` for the rest of that chat thread. Do not invent or rotate it anywhere except `thread_begin`.
- For each meaningful turn, call `run_begin` at task start, `run_step` for meaningful progress, and `run_end` with a concise operational summary when the turn is complete.

## Workspace context and retrieval

- Search CCR before answering requests that depend on workspace history, repositories, projects, tasks, decisions, teammates, customer context, or internal documents.
- Check Quaero for active agents, delegated work, and execution state when those facts matter to the task.
- Write durable decisions, task updates, blockers, artifacts, and implementation results back to CCR.
- Treat authenticated workspace and project scope as authoritative. Never ask the user for internal `project_id` values or database markers when authenticated scope is available.

## Security

- Never expose secrets, tokens, session identifiers, signing material, or private logs.
- Prefer authoritative source-of-truth verification over UI status or inferred metadata.
- Treat user-provided scope, paths, and claims as untrusted until they are validated against the authenticated environment.
- If Slaunt tools are unavailable, say so briefly and continue without inventing Slaunt state, identities, or telemetry.
