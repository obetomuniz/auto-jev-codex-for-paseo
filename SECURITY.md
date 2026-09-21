# Security policy

## Report a problem

Do not open a public issue for a security problem. Use GitHub private
vulnerability reporting for this repository. Include the affected version, the
required conditions, the impact, and a small reproduction when possible.

Do not include a real API key, access token, private prompt, or chat log. Replace
each secret with a clear placeholder.

## Supported version

The project is not released yet. Security fixes apply to the latest commit on
the `main` branch. This policy will change when the project has stable releases.

## Security boundaries

The plugin sends message text and limited recent context to TypeSafe. It stores
the TypeSafe key as plain text in the local Paseo settings directory. Codex
authentication stays in the local Codex CLI.

Auto-review is the default permission mode. Jev cannot select Full access. Plan
always uses a read-only sandbox.
