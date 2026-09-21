# Contributing

Thank you for your interest in Auto Jev-Codex.

## Before you start

Open an issue for a large behavior change. Explain the user problem and the
expected result. You can send a small fix without an issue.

Do not include credentials, private prompts, chat logs, or personal data in an
issue, test, commit, or pull request.

## Set up the project

Install Node.js 24 and npm. Then run:

```sh
npm ci
npm run check
```

The tests do not use real TypeSafe or Codex services.

## Make a change

Keep each change focused. Preserve the safety rules in [AGENTS.md](AGENTS.md).
Add or update a behavior test when you change routing, persistence, permissions,
Fast, Plan, or model selection.

Update the user documentation when behavior changes. Use short sentences and
active voice. Put procedure steps in their execution order.

## Commit the change

Use [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).
Use this form:

```text
<type>(optional-scope): <description>
```

Use `feat` for a new feature and `fix` for a defect correction. You can also use
`docs`, `test`, `refactor`, `chore`, or `ci`. Add `!` or a `BREAKING CHANGE:`
footer when a change breaks compatibility.

Examples:

```text
feat(routing): add context-aware intent selection
fix(provider): keep Plan turns read-only
docs: explain TypeSafe data handling
```

## Open a pull request

Describe the problem and the resulting behavior. List the checks that you ran.
Call out changes to data handling, permissions, or compatibility.

By contributing, you agree that your contribution is licensed under the MIT
License in [LICENSE](LICENSE).
