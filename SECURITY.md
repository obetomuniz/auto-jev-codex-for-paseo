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

With Jev selected, the plugin sends message text and limited recent context to
TypeSafe. Auto also sends each enabled preset's complete scope:
at most 240 characters for each of 32 presets. Names and IDs are excluded.
Execution instructions, provider settings, and credentials are excluded.
Scopes cannot authorize edits or select Full access.
The settings screen also sends a scope alone when it detects task types. This
happens after you stop editing it, once for each scope text. Task types select
presets only. They cannot authorize edits or select Full access.
The classifier also receives bounded aggregate counts of uncommitted changes.
These counts include changed files, added and removed lines, binary files, and
untracked files. No filenames, repository paths, file contents, or raw Git output
are sent. Change size informs task depth. It cannot authorize writes.
With Laya selected, it processes that data locally. It stores
the TypeSafe key as plain text in the local Paseo settings directory. Vendor
authentication stays in Paseo and the installed provider CLI.

Automatic approvals is the default permission setting. Neither classifier can
select Full access. Codex enforces intent through its sandbox and Auto-review.
Other providers use their own work mode unless Plan is enabled. Discussion and
review receive no-edit instructions under automatic approvals. Intent alone
does not enable Plan. Native modes do not all provide the same sandbox boundary.
Plan takes priority over Full access.
When Plan is requested but unsupported, the plugin uses normal provider approvals and
no-edit instructions. It reports this fallback. Instructions alone do not
enforce a read-only filesystem. The plugin never selects bypass automatically.
Unavailable optional features use supported defaults. Missing models and invalid
intent stop the turn. Full access is never restored from provider persistence.

Laya is experimental for this routing task. Correctly formatted answers can still
misclassify user intent. Confidence does not replace evaluation on real requests.
Laya errors and oversized context stop the turn. They do not trigger a remote
classifier fallback. Model downloads use Hugging Face. Prompts are passed only
to the local worker. The worker does not receive daemon API keys.
