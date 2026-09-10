---
name: self-context-reset
description: Safely clear only this session's model context after saving and rereading its own local continuation state. Use when the user requests a fresh context without replacing the session, or authorizes self-clearing after repeated compaction failures. Requires the native self_clear_context tool; an MCP proxy cannot substitute for it.
---

# Self context reset

This is a continuation procedure, not permission to discard unfinished work.
Only perform it when the user or an applicable standing policy authorizes it.
Never clear another session, manufacture a replacement session, or substitute
compact, rewind, delete, natural-language "forget", or a shell/HTTP request.

1. Confirm `self_clear_context` is actually available as a native terminal tool.
   If absent, stop and explain that the session host must register it. This skill
   cannot create tool capabilities.
2. Finish or resolve outstanding tool calls, background agents/shells and
   unanswered questions. Resolve queued messages before preparing the handoff.
   Active compaction and native schedules also block clearing. Do not cancel
   work, remove schedules or discard messages just to bypass that guard.
3. Persist using THIS session's existing memory, project and task conventions.
   Do not impose a new checkpoint format. Save the continuing goal, current
   state, completed side effects, remaining actions, user constraints,
   applicable authorization boundaries and only necessary in-flight contacts.
   Keep private data in its local files; do not upload it or put secrets in
   the recovery prompt.
4. Reread the saved files with normal file tools. Confirm that those files plus
   a short prompt are sufficient to resume without the old conversation. Check
   for missing outcomes, ambiguous permissions, stale file versions and gaps.
   If anything is missing or persistence failed, keep the current context and
   resolve it first. File existence alone does not prove semantic completeness.
5. Call `self_clear_context` as the ONLY tool in its batch. Supply `handoffFiles`
   containing the absolute local paths already reread, and a short `prompt`
   specifying the exact continuing goal, those paths, current scope and actions
   not to replay. Do not include a target session ID or the old transcript.
6. On success the runtime terminates this turn and delivers the prompt into the
   fresh window of the SAME session. Do not send an additional recovery message.
   In the fresh window, read the named files before acting. Continue only the
   authorized goal; ask if recovery is incomplete. Do not rerun completed sends,
   deployments, payments or acknowledgements from the handoff.

Precondition failures leave the context intact. A transport failure after the
RPC was submitted is different: the outcome may be unknown. Never automatically
retry. Inspect native events and the actual current state, and ask for help if
the result cannot be established. A `context_cleared` event alone is not proof
that the terminal tool completed successfully.

Clearing preserves session identity, native event logs, configuration and
system/developer messages. It is not secure erasure or a way to override those
messages. Retained logs do not automatically put past authorizations back into
the new model window. The host owns tool registration on cold resume; this
skill does not restore callbacks or replay pending tool calls.
