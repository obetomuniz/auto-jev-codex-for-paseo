# Auto Jev-Codex for Paseo

Auto Jev-Codex for Paseo is a model router for [Paseo](https://github.com/getpaseo/paseo).
It uses TypeSafe Jev to classify each new message. It then starts a Codex turn
with the selected model, reasoning effort, work mode, and speed.

The Codex thread stays the same when the model changes. Paseo continues to own
the workspace and the chat session.

## Requirements

- Paseo 0.8.0 or later with plugins enabled.
- Node.js 24 and npm.
- Codex CLI 0.153.4 or a compatible later version.
- A local Codex CLI login.
- A TypeSafe API key.

## Install

Clone this repository. Then run these commands in the project directory:

```sh
npm ci
npm run check
paseo plugin install .
```

On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`.

Open **Settings → Plugins → Auto Jev-Codex for Paseo**. Set the TypeSafe API key. You can
also set `TYPESAFE_API_KEY` in the Paseo daemon environment.

Set the model for each task category. Empty fields use these defaults:

| Task category | Model | Fallback effort |
| --- | --- | --- |
| Architecture | `gpt-6-astra` | `xhigh` |
| Review | `gpt-6-astra` | `xhigh` |
| Mechanical task | `gpt-5.6-luna` | `low` |
| Standard implementation | `gpt-5.6-terra` | `medium` |
| Complex implementation | `gpt-5.6-sol` | `high` |

Select **Auto Jev-Codex for Paseo** in a Paseo chat. Then send a text message.
You can also select Astra, Sol, Terra, or Luna manually. Jev still chooses
the effort for manual models.

## Composer controls

The model control has an Auto option and the configured model IDs. A manual
model applies to the next successful turn by default. Select **Keep selected
model** to use it for later turns.

The mode control has three options:

- **Auto** starts with Plan off. Jev can enable Plan for a planning task.
- **Work** keeps Plan off.
- **Plan** keeps Plan on and uses a read-only sandbox.

The Fast control has three options:

- **Auto** starts with Fast off. Jev can enable Fast for an urgent task.
- **On** requests the `fast` service tier.
- **Off** requests the standard service tier.

Fast availability and quota use depend on the Codex account.

The default permission setting is **Auto-review**. It uses the `on-request`
approval policy and the `auto_review` reviewer. Jev cannot enable Full access.
Only an explicit user selection can enable Full access. Plan stays read-only
when Full access is selected. The plugin does not restore Full access when a
session reopens.

A setting change during a turn applies to the next turn. A steering message
keeps the current model, speed, mode, and permissions.

## Data and security

The plugin sends the following data to TypeSafe for classification:

- The new text message.
- Up to six recent user messages, assistant answers, or plans.
- Up to 1,000 characters from each recent item.

The plugin does not send tool output or private reasoning to TypeSafe. The
plugin stores the short routing context in Paseo session data. It can rebuild
this context from the local Codex history.

The plugin stores a TypeSafe API key in
`~/.paseo/auto-jev-codex-for-paseo.local.json` as plain text. A key in this file has
priority over `TYPESAFE_API_KEY`. The settings API does not return the key to
the client. An empty key field keeps the saved key.

Codex authentication stays in the local Codex CLI. The plugin does not receive
an OpenAI API key.

For Auto-review, discussion and review turns use a read-only sandbox. An
explicit implementation request uses workspace-write access for the current
Paseo workspace. Unknown intent values and invalid scores stop the turn.

The provider supports text, images, streamed responses, Plan questions,
approvals, interrupts, steering, and history replay. It does not support
composer commands.

Paseo renders the image preview in its native composer. Auto Jev-Codex for Paseo sends
the image to Codex with the message. It sends only the message text to
TypeSafe for routing.

Attach up to four PNG, JPEG, WebP, or GIF images in one message. Each image
must be 5 MiB or smaller.

## Develop

Run all checks:

```sh
npm run check
```

The tests use simulated TypeSafe and Codex services. They do not need
credentials, network access, or a running Paseo daemon.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you submit a change. Read
[ARCHITECTURE.md](ARCHITECTURE.md) for the module boundaries and routing rules.
Report security problems as described in [SECURITY.md](SECURITY.md).

## Update an existing installation

Reload the plugin after you update its source:

```sh
paseo plugin reload auto-jev-codex-for-paseo
```

## References

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Codex Auto-review](https://developers.openai.com/codex/sandboxing/auto-review)
- [Codex speed settings](https://developers.openai.com/codex/speed)

## License

This project uses the [MIT License](LICENSE).
