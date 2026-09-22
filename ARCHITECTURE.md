# Architecture

Auto Mode for Paseo has one main flow. A user selects the provider in Paseo and
sends a message. The plugin classifies the message and starts a Codex turn.

## Modules

```text
index.client.tsx          Register client features
index.server.ts           Register server features
client/
  settings-screen.tsx     Show plugin settings
server/
  provider.ts             Manage Paseo sessions and Codex turns
  codex-app-server.ts     Run the local Codex JSON-RPC process
  routing.ts              Map a classifier result to turn options
  route-context.ts        Limit recent conversation context
  session-controls.ts     Validate composer controls
  classifier.ts           Define shared decisions and validate answers
  jev.ts                  Call TypeSafe
  laya.ts                 Manage the bounded local Python process
  laya-worker.ts          Embed the Python bridge in the plugin bundle
  laya-questions.ts       Define compact Laya questions
  settings-store.ts       Save settings and migrate old settings
shared/
  settings.ts             Define schemas, defaults, types, and RPCs
tests/                    Test public behavior
```

Paseo requires runtime code in `client/`, `server/`, or `shared/`. The two root
files are the plugin entry points. They only register features.

## Route a new turn

The provider takes these steps for each new turn:

1. Read up to six recent conversation items.
2. Limit each item to 1,000 characters.
3. Send the new message and this context to the selected classifier.
4. Validate all classifier values.
5. Select the lane, model, effort, Fast state, and Plan state.
6. Apply explicit user controls.
7. Start the Codex turn with an explicit sandbox and approval policy.

The context can contain user messages, assistant answers, and plans. It cannot
contain tool output or private reasoning. The classifier uses the context only to
resolve references such as "continue" or "implement the plan."

## Intent and lane rules

Intent controls workspace access when the permission control is Auto-review.
The allowed intent values are `discuss`, `review`, and `implement`.

- `discuss` uses a read-only sandbox.
- `review` uses a read-only sandbox.
- `implement` uses workspace-write access.

An unknown intent stops the turn. It never enables write access.
The lane selects the model and fallback effort. It does not grant workspace access.
Both classifiers choose the lane by task difficulty and risk.
Discussion and review do not force an Astra category.

The internal lane IDs are `staff`, `review`, `cheap`, `standard`, and `lead`.
The cheap lane uses Luna for direct factual questions and mechanical edits.
The standard lane uses Terra for bounded explanations, plans, reviews, and implementation.
The lead lane uses Sol for complex investigations, reviews, and implementation.
The staff lane uses Astra for difficult architecture or deep system analysis.
The review lane uses Astra for high-risk or deep cross-component reviews.
Saved model overrides still apply to these lanes.

The difficult-architecture score has first priority at its configured threshold.
This override does not apply to review intent.
For implementation, the mechanical score can select the cheap lane at its threshold.
This override requires a parallel-work score below 0.5.
Otherwise, the classifier's lane result applies.
Outside review intent, a cheap result with a parallel-work score of 0.7 or more becomes lead.
A review with a cheap result becomes standard.
A review with a staff result uses the configured review model.
A review lane without review intent becomes lead.
An unknown lane becomes standard.

These IDs do not start skills or worker agents. The execution result is advice only.

## Composer controls

The model list contains Auto and each configured model ID. A manual model is
valid for one successful turn or until the user removes a pin. A failed turn
does not consume a one-turn model selection.

Fast and Plan are separate classifier decisions. Both start off for each turn. The classifier
must return a positive decision to enable one. A manual On, Off, Work, or Plan
selection has priority over the classifier.

Each turn sends `serviceTier`, `collaborationMode`, `approvalPolicy`,
`approvalsReviewer`, and a sandbox policy. Thus, a turn does not inherit a Fast,
Plan, or Full access state by mistake.

Auto-review uses `on-request` with `auto_review`. Full access uses
`dangerFullAccess` with `never`. Only the host configuration can select Full
access. The classifier has no permission field. Plan always has priority over Full access
and uses a read-only sandbox.

The provider sends Plan questions to Paseo. A skipped question returns an empty
answer. The provider does not select an answer for the user.

## Session ownership

Paseo owns workspaces and agent tabs. The provider saves the Codex thread ID in
Paseo session data. It also saves the limited route context and safe control
values. It never saves Full access as a value to restore.

A new turn can use a different model in the same Codex thread. A steering
message bypasses classification and keeps the active turn settings.

For history replay, the provider resumes the Codex thread. It emits saved user
messages, assistant messages, reasoning summaries, and commands. It supports
the old full-thread response and the paginated history response.

The plugin does not run an HTTP server or an MCP server. It does not register a
slash command. It does not inject agent configuration. It does not keep a
second session registry.

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
