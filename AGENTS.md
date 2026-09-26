# Agent guide

Use this file for automated changes in this repository.

## Scope

Keep the plugin focused on one job. It classifies a new Paseo message and starts
a configured preset's provider turn with explicit settings. Do not add an HTTP server, an MCP server,
or a second session store.

## Safety rules

- Keep intent and Plan separate. Intent alone must not enable planning mode.
- Use no-edit instructions for native discussion and review under automatic approvals.
- Stop the turn when the intent is missing or invalid.
- Do not let a classifier select Full access.
- Use the native planning mode for Plan. Keep Codex Plan read-only.
- If no planning mode exists, use normal approvals and no-edit instructions.
- Report that fallback. Do not claim it enforces a read-only sandbox.
- Do not save Full access in provider persistence.
- Do not send tool output, private reasoning, credentials, or full chat history
  to a classifier.
- Keep all context limits explicit and covered by tests.

## Code rules

- Keep entry points small. Put runtime code in `client/`, `server/`, or `shared/`.
- Use strict TypeScript.
- Validate data at each external boundary.
- Use clear error messages. Do not silently use a broader permission.
- Add a behavior test for each routing or permission change.
- Do not add a dependency when the platform or standard library has the needed
  function.

## Documentation rules

Use short sentences and active voice. Give one instruction in each sentence.
Define an uncommon term before you use it. Keep procedures in their execution
order. Follow the main principles of Simplified Technical English.

## Local CLI access on Windows

Use `npm.cmd run paseo -- <arguments>` for the installed Paseo CLI.
The launcher checks `PASEO_CLI`, then PATH, then the desktop installation under
`LOCALAPPDATA`. Use `npm.cmd run plugin:install` to install this checkout.
Use `npm.cmd run plugin:status` to verify its source directory and status.
Use `npm.cmd run plugin:reload` after changing an installed checkout.
Reloading a plugin from another checkout does not load this checkout's changes.

The Windows sandbox can block access to the installed CLI or its credentials.
If this occurs, retry through the host's escalation mechanism. A supported
sandbox read grant can fix directory access. Authentication may need a separate
host-approved solution. Do not disable the sandbox to fix CLI discovery.
Do not interpret an in-sandbox command-not-found or HTTP 401 result as proof
that the CLI is missing or that the user must log in again.
Do not copy credentials into this repository. These instructions do not change
the host's permissions or approval requirements.

## Completion checks

Run:

```sh
npm run check
```

Check the staged files for credentials and local paths. Use a Conventional
Commit message for each commit.
