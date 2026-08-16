# Contributing

Read [`AGENTS.md`](AGENTS.md) before changing code. This project sends keystrokes to terminals; correctness
and security requirements are strict relative to the codebase size.

## Development setup

```bash
git clone https://github.com/egemenyildiz/herdr-slack.git
cd herdr-slack
npm install
npm run check
```

Requires Node ≥ 22 and herdr ≥ 0.8.0 (protocol 19). Run `npm run prepare:dev` if git hooks are missing.

**Agent testing:** day-to-day verification is against **Claude and Cursor** only. PRs that change
agent-specific behaviour should say which agent was exercised, or note that coverage is unit-test
only.

Do not add a root `prepare` script — `herdr plugin install` runs `npm ci --omit=dev` on user machines.

## Pull requests

1. Open an issue first; reference it in the PR (`Closes #123`).
2. Branch from `main`: `feat/123-slug`, `fix/…`, `docs/…`, `chore/…`.
3. Include tests; security-sensitive paths need negative tests.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) (squash-merge; PR title becomes the changelog entry).
5. `npm run check` must pass.
6. Update `AGENTS.md` for convention changes.

## Scope

**Usually accepted:** bug fixes with tests, documentation clarifications, verified agent kind entries in
`agents.example.toml`.

**Discuss first:** inbound listeners, changes to security invariants, clipboard reads, new runtime or
native dependencies.

## Security reports

Use a [private security advisory](https://github.com/egemenyildiz/herdr-slack/security/advisories/new).
Do not file public issues for vulnerabilities. See [`SECURITY.md`](SECURITY.md).
