# AGENTS.md — contributor conventions

Update this file in any PR that changes a convention.

## Project

Slack control plane for a local [herdr](https://herdr.dev) instance. A daemon holds one outbound
Socket Mode connection to Slack and one Unix-socket connection to herdr. No inbound network listener.

Do not re-derive the herdr protocol from other plugins — use [herdr](https://herdr.dev) docs and a
live socket when verifying behaviour.

**Verified agents:** Claude and Cursor (manual + integration tests). Other kinds in the catalog are
best-effort until someone tests them.

## Toolchain

| Concern | Choice |
|---|---|
| Runtime | Node ≥ 22; CI matrix 22 + 26 |
| Language | TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Lint + format | Biome |
| Tests | Vitest + v8 coverage |
| Hooks | Lefthook (`npm run prepare:dev` to repair) |
| Commits | Conventional Commits, squash-merge |

`npm run check` = lint + typecheck + test with coverage (same as CI).

## Invariants

Security-sensitive; breaking these is a security bug.

1. **Identity is `terminal_id`, never `pane_id`.** Resolve `ref → terminal_id → current pane_id` at
   action time; fail closed when the terminal is gone.
2. **Block Kit payloads carry only an opaque `ref`.** Never a pane id or terminal id.
3. **Fail closed** on unknown ref, dead terminal, wrong `team_id`, non-allowlisted user, exhausted
   throttle, or **herdr not connected** (Reply / End / Refresh / Earlier / New agent / menu choices).
4. **Every outbound terminal payload is redacted** (`redact.ts`) before Slack sees it. Extracted
   replies are rendered as mrkdwn sections (`response.ts` → `responseSections`), never raw scrollback.
5. **No inbound listener.** Phone control requires the **machine awake** with herdr running — sleep
   freezes the daemon and Socket Mode; there is no wake-from-Slack path.
6. **Daemon reads `herdrSocketPath` from config**, not `HERDR_SOCKET_PATH` at runtime (except
   `setup` and `daemon ensure`).
7. **Secrets never in logs.** No terminal content in `daemon.log` except `--dry-run`.
8. **Credentials in OS keychain when available**; read via `withCredentials`.
9. **Never read the user's clipboard** (polling). Writing the setup manifest to the clipboard is
   allowed.
10. **Allowlist is Slack member IDs only** — no handle/display-name resolution, no `users:read`.
11. **Every herd-registry record is signed, and unverifiable records are dropped.** A shared registry
    directory is writable by other local accounts, and a queued command is *typed into a terminal* —
    so "can create a file there" must not mean "can drive your agents". The HMAC key derives from the
    Slack bot token (`herd-signing.ts`), which only daemons on that app hold. Never add a registry
    record type that skips `seal`/`unseal`.

## Interaction model

- One updating **session card** per agent (not a chat/terminal mirror).
- Prompts enter only through the **Reply** modal; ordinary thread messages never reach an agent.
- **End session** = herdr `pane.close` (confirm-gated); not Esc / Ctrl-C.
- **Earlier** excludes the response already on the card; one prior turn per modal page.
- A settled turn posts **one** threaded reply notice (claimed by turn id) so Slack notifies the user;
  `chat.update` alone is silent.
- Shared Slack write budget is a **single** token bucket (`RateBudget`), not separate control/data
  lanes.
- When herdr is down, cards and Home **omit** interactive controls and refuse those actions — keep
  the machine awake to drive agents from Slack.
- **One Slack app may back many herdr sources** (same user, other OS user, remote). Exactly one
  daemon is primary and owns Socket Mode + App Home; the rest are satellites that publish neither
  and only write heartbeats into the shared `herdRegistryDir`. Two Socket Mode clients on one app
  race for interactions, and two Home publishers overwrite each other — so ownership is a file
  lock, not a convention.
- **Cross-account setups must set `herdRegistryDir` to one shared path on every daemon.** The default
  is under each user's own config dir, so leaving it unset gives each daemon a *private* registry in
  which it is trivially the only herd — both elect themselves primary and Home flaps between them.
  Setting the key also switches the registry to shared file modes; the default stays 0700/0600.
- **Ownership is only taken during election.** A satellite that claimed it mid-flight would demote
  the real primary on its next tick and leave Slack with no owner at all, so a satellite that sees no
  live owner exits non-zero and lets the service manager restart it into an election.
- Home is a **two-level view** when more than one herd reports in: an overview of herds with their
  agent counts, then one herd's agents. A single herd skips the overview.
- `Surfaces` depends on **`HerdPort`**, not on `HerdBridge`, so the multi-herd paths are testable
  without a registry directory or a second daemon.

## Layout

```
app/src/
  herdr/     socket client, event tail, state projection
  registry/  terminal_id ↔ ref ↔ Slack card, persisted remote turns
  slack/     transport, turn cards/modals, response extraction, guards, redact
  agents/    agents.toml catalog, blocked-prompt menu parser
  config/    config, setup wizard, doctor
  daemon/    supervisor, service units, rate budget, multi-herd registry
app/test/    mirrors app/src
```

## Code

- ESM, `.js` extensions on relative imports.
- `import type` for type-only imports.
- No `any`. Parse untrusted input at boundaries with explicit guards.
- Errors: `HerdrError` / `SlackError` with a `code`; user-visible text, not stack traces.
- No side effects at import time.
- Prefer pure functions for `redact`, `response`, `menu`, `budget`, `state`.

### Slack `action_id` naming

`<surface>_<verb>[_<qualifier>]`, lowercase snake. The `ref` goes in `value` / `private_metadata`.

### Logging

`daemon.log` is ndjson, mode 0600, 5 MB × 3 rotation. Event names: `<area>.<thing>`, lowercase
snake.

## Testing

- Mirror source paths under `app/test/`.
- Fake herdr socket + stubbed Slack transport; no live credentials.
- Global coverage 80%; `slack/guards.ts` 100%.
- Security behaviour needs negative tests.
- Synthetic credentials in `app/test/helpers/fake-credentials.ts` must contain `EXAMPLE`.
