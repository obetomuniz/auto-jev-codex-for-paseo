# Agent guide

Use this file for automated changes in this repository.

## Scope

Keep the plugin focused on one job. It classifies a new Paseo message and starts
a Codex turn with explicit settings. Do not add an HTTP server, an MCP server,
or a second session store.

## Safety rules

- Treat intent as the workspace-access boundary for Auto-review.
- Stop the turn when the intent is missing or invalid.
- Do not let Jev select Full access.
- Keep Plan read-only.
- Do not save Full access in provider persistence.
- Do not send tool output, private reasoning, credentials, or full chat history
  to TypeSafe.
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

## Before completion

Run:

```sh
npm run check
```

Check the staged files for credentials and local paths. Use a Conventional
Commit message for each commit.
