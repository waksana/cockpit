# Self-clearing model context

Cockpit registers the native `self_clear_context` terminal tool and exposes the
`self-context-reset` skill on session create/resume. Ask the session to use that
skill when you want it to preserve its own continuation state and start with a
fresh model window. No session is cleared automatically by installing this
feature. Existing loaded sessions need an ordinary idle reload to receive the
new registration after upgrading.

The session saves and rereads its own local files using its existing project
and memory conventions. It decides whether recovery is sufficiently complete,
then calls the tool alone with `handoffFiles` and a short `prompt` describing the
continuing goal, the files to read and actions not to replay. The tool checks
that those files are non-empty, readable regular files; it does not read their
contents, generate a summary, define a memory format or upload anything.

The native runtime preserves the session ID, configuration, system/developer
messages and event log, while replacing the model-facing conversation. It ends
the successful terminal tool turn and delivers the recovery prompt itself.
The same agent reads the referenced files in the fresh window. There is no
Cockpit recovery queue, history copy, database, scheduler or additional agent.
Retained event logs do not automatically restore past authorizations.

## Narrow binding

`packages/core/src/context-reset.ts` exports `createContextReset` for reuse by
SDK hosts. Register its `tool` at both create and resume, forward native events
to `observe`, and supply a getter for the actual live session and an
`assertReady` callback for host-owned pending operations/decisions. Reject new
mutations while `busy` is true. The getter must return null for stale/closed
handles. The factory matches the native main-agent message, tool start and
external-tool request; user text and arbitrary session IDs are not identity
credentials.

Cockpit only supplies those bindings and discovers the bundled skill alongside
native project/user skills. Native per-session skill disablement remains
available. The bundled directory does not modify global Copilot configuration.
Hosts outside Cockpit must arrange their own native tool and skill registration;
the skill alone cannot add terminal-tool capability to an ordinary MCP client.

There is intentionally no HTTP/MCP `clear(sessionId)` intent. An RPC can
physically cross HTTP during a tool call, but an MCP JSON field named
`isTerminal` is not the native tool declaration. SDK 1.0.13/runtime 1.0.83 can
report a clear event without producing a clean next window if the tool does not
successfully terminate the native loop.

## Failures and concurrency

The tool refuses parallel batches, non-root calls, pending messages/steering,
background work, unanswered permissions, active compaction, native schedules
and conflicting host operations. It does not cancel any of them. Resolve that
work before preparing the handoff. A preflight failure does not call clear.
Local files still being written must be settled by the session before it calls
the tool; readability does not prove a complete or immutable handoff.

There is one clear attempt per initiating interaction. A native recovery seed
does not re-arm it. The host blocks new mutations during execution, and
observable native activity changes invalidate preflight. This is not a
transaction against untrusted clients that independently control the same
native runtime/session; that topology is not supported by this self-only
binding.

Once the RPC is submitted, a transport error leaves the result uncertain and
blocks retries for that binding. Do not reload merely to bypass that protection:
inspect native clear and tool-completion events and establish the actual state
first. Clearing and acknowledging tool success are separate native messages,
not a crash-atomic transaction. No fallible work follows a successful clear in
the handler, but a process crash between these messages still requires
inspection. A clear event alone is not proof of a completed terminal transition.

Cold resume re-registers the tool/skill without replaying pending tool calls.
The original system/developer instructions still apply; clearing is neither
secure deletion nor a way to override those instructions.

## Targeted native regression

The native test uses a private runtime, isolated HOME/config/cwd, no credentials
and a loopback synthetic model. It checks the actual outgoing model window,
retained events, same session identity, file recovery and a cold restart:

```sh
cd packages/core
COCKPIT_NATIVE_SMOKE=1 node --import tsx --test src/context-reset-native.test.ts
```
