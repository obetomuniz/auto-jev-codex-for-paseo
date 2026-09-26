# Architecture

Auto Mode for Paseo has one main flow. A user selects the provider in Paseo and
sends a message. The plugin classifies the message and selects a preset.
The preset supplies the provider, model, reasoning setting, and instructions.

## Modules

```text
index.client.tsx          Register client features
index.server.ts           Register server features
client/
  settings-screen.tsx     Show plugin settings
  settings-autosave.ts    Validate drafts and serialize automatic settings writes
  task-type-detection.ts  Detect task types after a scope stops changing
server/
  provider.ts             Manage routing sessions and execution adapters
  paseo-execution.ts      Run native Paseo agents through the host SDK
  provider-policy.ts      Map intent to supported native modes
  provider-catalog.ts     Discover installed providers and current models
  execution-notice.ts     Format the applied turn configuration for the conversation
  handoff.ts              Bound conversation handoffs between providers
  questions.ts            Translate grouped Paseo question responses
  codex-app-server.ts     Run the local Codex JSON-RPC process
  routing.ts              Map a classifier result to turn options
  route-context.ts        Limit recent conversation context
  workspace-state.ts      Collect bounded Git change counters
  scope-types.ts          Tag one preset scope with a fixed task type
  session-controls.ts     Validate composer controls
  classifier.ts           Define shared decisions and validate answers
  jev.ts                  Call TypeSafe
  laya.ts                 Manage the bounded local Python process
  laya-worker.ts          Embed the Python bridge in the plugin bundle
  laya-questions.ts       Define compact Laya questions
  settings-store.ts       Save settings and migrate old settings
shared/
  settings.ts             Define schemas, defaults, types, and RPCs
  task-types.ts           Define the fixed task types and detection RPC
tests/                    Test public behavior
```

Paseo requires runtime code in `client/`, `server/`, or `shared/`. The two root
files are the plugin entry points. They only register features.

Settings saves run in order on the daemon. Each save writes a temporary file
beside the settings file, then replaces the settings file. Routing reads a
complete version during autosave. A failed write keeps the previous file.

## Route a new turn

The provider takes these steps for each new turn:

1. Read up to six recent conversation items.
2. Limit each item to 1,000 characters.
3. Read aggregate counts of uncommitted Git changes.
4. Send the new message, bounded context, and counters to the selected classifier.
5. Validate all classifier values, including the task type and required task depth.
6. Keep presets used for the task type, plus untagged presets.
7. Select the best scope match among them with sufficient task depth.
8. Apply a manual preset selection and explicit user controls.
9. Start the configured provider with its supported execution controls.

The context can contain user messages, assistant answers, and plans. It cannot
contain tool output or private reasoning. The classifier uses the context only to
resolve references such as "continue" or "implement the plan."

## Intent and preset rules

Intent controls execution behavior when automatic approvals are selected.
The allowed intent values are `discuss`, `review`, and `implement`.

- `discuss` requests analysis without edits.
- `review` requests analysis without edits.
- `implement` uses the preset's work mode.

Codex maps these intents to read-only or workspace-write sandboxes.
Native providers use their published modes and their own permission semantics.
Discussion and review add no-edit instructions under automatic approvals.
Intent does not enable Plan. The effective Plan setting selects the planning mode.

An unknown intent stops the turn. It never enables write access.
Preset selection uses the same rules for every enabled preset.
Default presets are editable. Their IDs have no routing privileges.
Task depth describes the most demanding work a configured setup can handle.
It is separate from the provider's reasoning setting. The classifier assesses
required depth from the request, recent context, and aggregate change counts.
Among sufficient setups, the highest scope score wins. Ties favor the lowest
sufficient depth, then the preset ID. When none is sufficient, Auto uses the
deepest available setup and reports that limit in the single turn summary.
Manual selection takes priority over this capacity filter.
Laya runs two passes when counts exist: scope fit and intent without counts, then
task depth with counts. The second pass replaces only the depth answer. Local tests
showed that the counts lowered Laya scope accuracy. Jev receives one request.

Git counters cover tracked changes against HEAD and the number of untracked files.
They do not cover a committed branch diff or read untracked file contents.
Each of two parallel probes has a 1.5-second timeout and a 256-KiB output limit.
Each counter is capped at 1,000,000. A flag reports capped counts.
Failures yield an unavailable state. Missing or zero counts do not mean low depth.
No filenames, patches, command output, or repository paths reach the classifier.
Each preset supplies a complete Scope, stored in the description field.
Scopes allow up to 240 characters. Names and IDs are not sent to the classifier.
Blank scopes are manual-only. Disabled or deleted presets are excluded.
Initial scopes describe common engineering responsibilities.
They are stored in settings, not in a fixed classifier role rubric.

The classifier receives one fit question per eligible preset in the same request.
There are at most 32 fit questions. Execution instructions, provider, model, effort,
work mode, credentials, and other settings are excluded from these definitions.
Each expected answer must contain a numeric score from 0 to 1.
Missing or invalid scores stop the turn. Unexpected answer IDs are ignored.
The fixed task-type answer bounds free-text scope scores. Only presets used for that
type, plus untagged presets, compete. Without such a preset, all compete and the
summary reports the fallback, except for Other. Local tests showed that per-preset
fit scores alone misrouted broad roles, especially with Laya.
The highest valid score in the type- and capacity-filtered set wins, even when scores are low or zero.
No enabled preset with a scope stops the turn with guidance.
Manual selection skips fit questions. Intent, Plan, and Fast are still classified.
Preset scopes never authorize edits. Intent remains the access boundary.
The selected preset supplies the provider, model, instructions, and effort.
The classifier's effort answer selects the required task depth.
The execution-shape answer remains advisory.

The obsolete lane mapping, routing thresholds, and automatic flag are removed.
Existing model overrides still migrate to preset settings. A one-time scope migration
updates untouched default descriptions. Edited scopes and provider setups stay intact.
Each scope question must fit Laya's existing token budget without truncation.

Task types are stored per preset with a detected-or-manual flag and the scope
text they were detected from. Detected tags apply only while that scope is
unchanged. The settings screen detects them through a plugin RPC after an 800 ms
pause. The RPC sends only the scope, at most 240 characters, and one fixed
choice question to the configured classifier. Each scope text is sent once until
the user retries. Results for a scope that has since changed are dropped.
Manual tags require at least one type. Default scopes seed their tags on migration.
These definitions do not start skills or worker agents.

After startup succeeds, emit one execution notice with the applied preset,
provider, model, intent, mode, and reasoning setting. Include capability fallback
messages in that notice. Do not emit a separate classification notice.

## Composer controls

The model list contains Auto and enabled preset IDs. A manual preset is
valid for one successful turn or until the user removes a pin. A failed turn
does not consume a one-turn preset selection.

Fast and Plan are separate classifier decisions. Both start off for each turn. The classifier
must return a positive decision to enable one. A manual On, Off, Work, or Plan
selection has priority over the classifier.

Each Codex turn sends `serviceTier`, `collaborationMode`, `approvalPolicy`,
`approvalsReviewer`, and a sandbox policy. Thus, a turn does not inherit a Fast,
Plan, or Full access state by mistake.

Codex Auto-review uses `on-request` with `auto_review`. A preset can select
Default Permissions to use `on-request` with the `user` reviewer instead.
Each turn sends the reviewer explicitly, including switches within one thread.
The settings field is hidden for providers with no published work modes.
Full access uses
`dangerFullAccess` with `never`. Only the host configuration can select Full
access. The classifier has no permission field. Plan always has priority over Full access
and uses a read-only sandbox.

The provider sends one permission for the complete Codex question group.
Paseo returns `updatedInput.answers` keyed by question header. The adapter
returns answers keyed by Codex question ID. Duplicate headers are disambiguated.
Free text is allowed. A skipped question returns an empty array.
Malformed responses leave the request pending. The limit is ten questions.

## Session ownership

Paseo owns workspaces and agent tabs. The provider saves the Codex thread ID in
Paseo session data. It also saves bounded route and handoff context, the last
provider, and safe controls. It never saves Full access as a value to restore.

A new turn can use a different model in the same Codex thread. A steering
message bypasses classification and keeps the active turn settings.

For history replay, the provider resumes the Codex thread. It emits saved user
messages, assistant messages, reasoning summaries, and commands. It supports
the old full-thread response and the paginated history response.

The plugin does not run an HTTP server or an MCP server. It does not register a
slash command. It supplies native agent configuration through the host SDK. It does not keep a
second session registry.

## Native provider execution

The session-open hook supplies the host Paseo API. The provider adapter does
not create another authenticated client or copy credentials. Settings discovery
uses the same API through a plugin RPC. Discovery excludes this router to prevent recursion.
Refresh waits up to 20 seconds for discovery, then reads the new availability.

For each non-Codex turn, validate the selected model against the current catalog.
Use a supported reasoning setting or omit it to use the model default.
Create an idle native Paseo agent with explicit provider options. Subscribe to
its timeline and await subscription readiness. Send the prompt after subscribing.
Translate native timeline, permission, and terminal events to the router session.
A question or attention event does not complete the turn. Archive the native
agent after completion, failure, or cancellation. Early terminal events are
buffered until the prompt acknowledgment and turn-start events are published.
If Stop fails, the adapter keeps observing the active turn. It reports the
failure and permits another Stop attempt. A terminal event still ends the turn.

Paseo owns native agent histories. The router stores at most 24 conversational
messages of 8,000 characters each in its existing opaque persistence data.
This context is for execution handoffs only. Classification retains its separate
six-message, 1,000-character bounds. Neither context includes tools or reasoning.
Native resume replays the bounded conversation. Full native history remains in Paseo.

Settings discover models, reasoning levels, and modes through the host SDK.
Only published values appear in their selectors. The work-mode selector excludes
planning and bypass modes. Provider changes clear dependent selections.
Native execution rechecks optional capabilities before each run.
Use the preset's work mode, a known automatic or approval mode, or native defaults.
When Plan is enabled, use a published planning mode when available.
If Plan is requested but unsupported, use normal approvals and no-edit instructions with a visible notice.
With Plan off, use the work mode even for discussion and review.
This fallback is not a filesystem sandbox. Native mode semantics remain provider-owned.
Only explicit Full access may select bypass. Plan still takes priority.
Full access is never restored from the router's persistence data.
Fast uses a published model toggle, or normal speed when unavailable.
Forced steering remains Codex-only through this SDK.

## Compatibility

The public and internal IDs are `auto-mode-for-paseo`. The old settings file is
read only when the new file is absent. The next save writes the new filename.
Old Auto model IDs are mapped when Paseo supplies persisted session data.
The plugin does not rewrite host session associations. Old model fallbacks are
resolved when settings load. Obsolete fields are removed on the next save. The
old session registry file stays unchanged.

The provider uses experimental Codex App Server fields for Plan questions and
collaboration mode. The code was checked with Codex CLI 0.153.4. A compatible
later version can also work.

## Validation

`npm run typecheck` checks all TypeScript source. `npm test` compiles and runs
the Node.js tests. `npm run check` runs both commands.

## Local classification

Laya runs in a Python child process over newline-delimited JSON.
The plugin starts no HTTP or MCP server. The child stores no sessions.
Only the selected Python executable runs. No shell interprets its arguments.
The child receives an allowlist of runtime environment variables.
It does not receive API keys from the daemon environment.

The queue allows eight active or waiting requests. Requests run in order.
Startup takes at most 120 seconds. Each inference takes at most 30 seconds.
A changed Python executable, model, or device restarts the worker between requests.
Plugin disposal rejects queued requests and stops the worker.
An error terminates the worker. The next explicit request can start a new one.
No error triggers a request to another classifier.

Requests and responses are limited to 64 KiB each.
New messages are limited to 16,000 characters before tokenization.
Recent context retains the shared six-message and 1,000-character limits.
The Python bridge checks Laya's tokenizer and question budgets before inference.
It rejects input that would be truncated. It does not discard extra history to fit.
Compact questions preserve the intent boundary and share the validated answer schema.
The bridge requires Laya 0.3.5 because it checks that version's serialization rules.
