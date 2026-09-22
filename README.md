# Auto Mode for Paseo

Auto Mode for Paseo is a model router for [Paseo](https://github.com/getpaseo/paseo).
It uses TypeSafe Jev or local Laya to classify each new message. It then starts a Codex turn
with the selected model, reasoning effort, work mode, and speed.

The Codex thread stays the same when the model changes. Paseo continues to own
the workspace and the chat session.

## Requirements

- Paseo 0.8.0 or later with plugins enabled.
- Node.js 24 and npm.
- Codex CLI 0.153.4 or a compatible later version.
- A local Codex CLI login.
- For Jev: a TypeSafe API key.
- For Laya: Python 3.10 or later with Laya 0.3.5 in a separate environment.

## Install

Clone this repository. Then run these commands in the project directory:

```sh
npm ci
npm run check
paseo plugin install .
```

On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`.

If `paseo` is absent from PATH on Windows, use the project's launcher:

```powershell
npm.cmd run plugin:install
npm.cmd run plugin:status
npm.cmd run plugin:reload
```

The launcher checks `PASEO_CLI`, then PATH, then the Paseo Desktop installation
under `LOCALAPPDATA`. Use `npm.cmd run paseo -- --help` for other commands.
Set `PASEO_CLI` to the CLI file if Paseo is installed in a different location.
If the agent sandbox blocks the installation, use a supported read grant or
run the affected command through the host's approval flow. The same applies
when `gh` cannot access the user's existing GitHub login from the sandbox.
No credentials are copied into the project.

Open **Settings > Plugins > Auto Mode for Paseo**.
Select a classifier. Jev remains the default for existing settings.

### Jev

Select **Jev (TypeSafe API)**. Set the TypeSafe API key.
You can also set `TYPESAFE_API_KEY` in the Paseo daemon environment.
The key and Jev model fields appear only when Jev is selected.

### Laya (experimental)

Create a Python environment in the project directory:

```sh
python -m venv .venv-laya
```

Install the supported Laya version on Windows:

```powershell
.venv-laya\Scripts\python.exe -m pip install laya==0.3.5
```

On macOS or Linux, use:

```sh
.venv-laya/bin/python -m pip install laya==0.3.5
```

Select **Laya (local, experimental)** in plugin settings.
Set **Python executable** to the absolute path of that environment's Python executable.
Do not include shell commands or arguments.
Select **Multilingual** for Portuguese. Select **English** for English-only work.
Use **Typed decisions** only when evaluating that specialized checkpoint.
Choose **CPU**, **CUDA**, or **Automatic** as the device.
An explicit device mismatch stops the turn.
Save the settings. Send a short message to load the model.

The first load downloads model files from Hugging Face.
The model stays loaded between classifications until the plugin unloads,
the Laya configuration changes, or classification fails.
Startup has a 120-second limit. Inference has a 30-second limit.
Preload the default model if its first download exceeds the startup limit:

```powershell
.venv-laya\Scripts\python.exe -c "import laya; laya.load('convaiinnovations/laya', subfolder='multilingual', device='cpu')"
```

On macOS or Linux, replace the executable with `.venv-laya/bin/python`.

Laya does not require a TypeSafe key. A saved key stays stored when switching
classifiers. The plugin does not pass it to Laya. A Laya failure stops the turn.
It never sends the request to Jev as a fallback.

Laya quality for this routing task has not been benchmarked. Its confidence
score is not a guarantee of correct intent. Evaluate representative requests
in your language before using it for unattended work.
See the [Laya limitations](https://github.com/NandhaKishorM/laya#honest-limits).

### Codex models

Set the model for each task category. Empty fields use these defaults:

| Task category | Model | Fallback effort |
| --- | --- | --- |
| Architecture | `gpt-6-astra` | `xhigh` |
| Review | `gpt-6-astra` | `xhigh` |
| Mechanical task | `gpt-5.6-luna` | `low` |
| Standard implementation | `gpt-5.6-terra` | `medium` |
| Complex implementation | `gpt-5.6-sol` | `high` |

Select **Auto Mode for Paseo** in a Paseo chat. Then send a text message.
You can also select Astra, Sol, Terra, or Luna manually. The classifier still chooses
the effort for manual models.

## Composer controls

The model control has an Auto option and the configured model IDs. A manual
model applies to the next successful turn by default. Select **Keep selected
model** to use it for later turns.

The mode control has three options:

- **Auto** starts with Plan off. The classifier can enable Plan for a planning task.
- **Work** keeps Plan off.
- **Plan** keeps Plan on and uses a read-only sandbox.

The Fast control has three options:

- **Auto** starts with Fast off. The classifier can enable Fast for an urgent task.
- **On** requests the `fast` service tier.
- **Off** requests the standard service tier.

Fast availability and quota use depend on the Codex account.

The default permission setting is **Auto-review**. It uses the `on-request`
approval policy and the `auto_review` reviewer. The classifier cannot enable Full access.
Only an explicit user selection can enable Full access. Plan stays read-only
when Full access is selected. The plugin does not restore Full access when a
session reopens.

A setting change during a turn applies to the next turn. A steering message
keeps the current model, speed, mode, and permissions.

## Data and security

The selected classifier receives the following data. Jev sends it to TypeSafe.
Laya processes it in a local Python process:

- The new text message.
- Up to six recent user messages, assistant answers, or plans.
- Up to 1,000 characters from each recent item.

The plugin does not send tool output or private reasoning to either classifier. The
plugin stores the short routing context in Paseo session data. It can rebuild
this context from the local Codex history.

The plugin stores a TypeSafe API key in
`~/.paseo/auto-mode-for-paseo.local.json` as plain text. A key in this file has
priority over `TYPESAFE_API_KEY`. The settings API does not return the key to
the client. An empty key field keeps the saved key.

Laya requests have a 16,000-character message limit and a 64 KiB JSON limit.
At most eight classifications can wait or run at once. They run in order.
The worker rejects any supplied state or fixed question that would be truncated
by the model. Default model limits are 512 tokens for English and 1,024 for the
other checkpoints, including questions. Long messages or recent context can
therefore stop a turn. Shorten the message or start a chat with less context.
The plugin does not send images, tool results, or credentials to Laya.

Codex authentication stays in the local Codex CLI. The plugin does not receive
an OpenAI API key.

For Auto-review, discussion and review turns use a read-only sandbox. An
explicit implementation request uses workspace-write access for the current
Paseo workspace. Unknown intent values and invalid scores stop the turn.

The provider supports text, images, streamed responses, Plan questions,
approvals, interrupts, steering, and history replay. It does not support
composer commands.

Paseo renders the image preview in its native composer. Auto Mode for Paseo sends
the image to Codex with the message. It sends only the message text to
the selected classifier for routing.

Attach up to four PNG, JPEG, WebP, or GIF images in one message. Each image
must be 5 MiB or smaller.

## Develop

Run all checks:

```sh
npm run check
```

The tests use simulated TypeSafe, Laya, and Codex services. They do not need
credentials, model downloads, or a running Paseo daemon.
Python bridge tests use a fake Laya module and need Python 3.10 or later.
Set `LAYA_TEST_PYTHON` if the executable is not named `python`.
These tests skip locally when Python is absent. CI requires them.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you submit a change. Read
[ARCHITECTURE.md](ARCHITECTURE.md) for the module boundaries and routing rules.
Report security problems as described in [SECURITY.md](SECURITY.md).

## Migrate from Auto Jev-Codex for Paseo

The repository, package, plugin, provider, and Auto model IDs are now
`auto-mode-for-paseo`. The former ID was `auto-jev-codex-for-paseo`.

Update your Git remote if it still uses the old repository name:

```sh
git remote set-url origin git@github.com:obetomuniz/auto-mode-for-paseo.git
```

Finish active turns. Disable the old plugin in Paseo.
Install this checkout with `paseo plugin install .`.
Open the new plugin settings. Verify the imported values. Save the settings.
Select **Auto Mode for Paseo** for new chats.

If the new settings file is absent, the plugin reads
`~/.paseo/auto-jev-codex-for-paseo.local.json`.
Saving writes `~/.paseo/auto-mode-for-paseo.local.json`.
The old file remains as a backup. Existing keys and model choices are retained.
A malformed new file stops loading. It does not fall back to the old file or
silently select a different classifier.

Paseo owns session-to-provider associations. This plugin does not rewrite its
session database. Old chats may still refer to the old provider ID.
If Paseo supplies an existing session to the new provider, it accepts the old
Auto model ID and retains the Codex thread and safe controls. Full access is
never restored from saved provider data.

## Update an existing installation

Reload the plugin after you update its source:

```sh
paseo plugin reload auto-mode-for-paseo
```

## References

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Codex Auto-review](https://developers.openai.com/codex/sandboxing/auto-review)
- [Codex speed settings](https://developers.openai.com/codex/speed)

## License

This project uses the [MIT License](LICENSE).
