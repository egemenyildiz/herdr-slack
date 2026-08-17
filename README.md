# herdr-slack

<img src="assets/app-icon.png" alt="" width="88" align="right">

Slack control plane for a local [herdr](https://herdr.dev) instance. Browse agents, answer blocked
prompts, send follow-ups, and launch new agents from a phone or the Slack client.

## Why this exists

| | herdr-slack | Typical Slack bridges (e.g. hail, tmux relays) |
|---|---|---|
| Direction | Outbound only ([Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)) | Often requires a tunnel, webhook URL, or hosted broker |
| Scope | Full control plane: browse, prompt, approve menus, launch | Usually notify-only |
| Identity | Stable per-agent cards keyed on `terminal_id` | Often pane- or session-fragile |
| Host | User service on your machine; no backend | Often a relay that reads terminal output |

No relay, no tunnel, no public URL, and no inbound listener on your machine.

## Requirements

- Node.js ≥ 22
- herdr ≥ 0.8.0 (protocol 19)
- macOS or Linux
- **The computer must stay awake** while you drive agents from Slack. Sleep freezes the daemon and
  herdr; there is no wake-from-phone. When herdr is unreachable, Home and session cards drop every
  interactive control (Reply, Refresh, Earlier, End session, New agent) and refuse those actions.

## Agent support

herdr can launch many agent kinds; **this plugin is tested in daily use against Claude and Cursor
only.** Other kinds listed in `agents.example.toml` (Codex, Gemini, Pi, etc.) may work, but thread
lifecycle, blocked-prompt menus, and status handling are unverified — bug reports welcome, especially
with a repro and the agent kind.

## Installation

```bash
herdr plugin install egemenyildiz/herdr-slack
```

Open the setup wizard:

```bash
herdr plugin action invoke setup --plugin herdr-slack
```

Herdr 0.8 does not run plugin startup hooks during install, link, or enable. On the next session
restore, herdr-slack automatically opens setup when configuration is missing. To configure it
immediately after installation, run the action above.

Setup creates a Slack app from the bundled manifest, stores credentials in the OS keychain when
available, and installs a launchd/systemd user service. An incomplete setup can be resumed on the
next run.

Manual wizard (from the plugin directory):

```bash
node app/dist/cli.js setup
```

Verify:

```bash
node app/dist/cli.js doctor
```

### Reset and uninstall

The Slack bridge runs as a launchd/systemd **user service**, so it outlives herdr. `herdr plugin
uninstall` only removes the plugin checkout — it does **not** stop the daemon or unload the service.
Always reset first:

```bash
herdr plugin action invoke reset --plugin herdr-slack
herdr plugin uninstall herdr-slack
```

Reset stops the daemon, removes the user service and shim, and clears that instance’s config,
keychain entries, and state. The action opens a popup, runs non-interactively, and leaves its result
visible until you press Enter. From the plugin directory, the equivalent is
`node app/dist/cli.js reset --yes`.

Reset does **not** delete the Slack app — remove that yourself at
[api.slack.com/apps](https://api.slack.com/apps) if you are done with it.

To stop the process temporarily without wiping setup:

```bash
node app/dist/cli.js daemon stop
```

That leaves the service installed, so it can come back on login or reboot until you reset.

## Usage

Everything is driven from the app's UI — there are no slash commands.

- **Home tab** — the hub: agents grouped by workspace, blocked agents first. **＋ New agent** launches
  one (workspace, directory, kind, first prompt); **Open** brings up a session card.
- **Session cards** — one updating card per agent: latest Slack prompt, latest response, and the
  agent's state in words (*Working*, *Waiting on you*, *Idle*, *Finished*).
- **Reply** — opens a modal and starts one tracked remote turn; the card updates automatically when
  the agent settles.
- **Notifications** — when an agent finishes a turn, its reply is posted under the card, so Slack
  notifies you without a refresh. Editing a card is silent in Slack, hence the extra message. It is
  claimed once per turn, so an agent that settles repeatedly on the same output pings once.
- **Earlier** — prior responses only (the one on the card is excluded), *one per view*, numbered;
  *Older* steps back one at a time. Each entry holds only what the agent said in that turn, not the
  scrollback before it.
- **Refresh** — reads the current response now, for an agent whose settle herdr never reported.
- **End session** — closes the terminal the agent runs in (herdr's `pane.close`) and makes the Slack
  card read-only. Confirm-gated, because it is destructive: sending `Ctrl-C` instead was pointless,
  since agents like Cursor ignore it. Reopening the agent from the *Home* tab re-attaches a fresh
  card as long as the terminal is still alive.

Session cards intentionally do not mirror the full terminal or accept ordinary thread replies.
Use the card's **Reply** button so each prompt has one response and reconnects cannot replay it.

Preview outbound Slack payloads without credentials:

```bash
node app/dist/cli.js daemon run --dry-run
```

## Security

⚠️ **Default `contentMode` is `full`.** Extracted agent responses on session cards are terminal
output sent to Slack — retained, searchable, and on a corporate workspace exportable by admins.
Use `summary` on a work workspace if you do not want free terminal text to leave the machine
(controls still work). See [`SECURITY.md`](SECURITY.md).

## Multiple instances

One herdr socket (default or named session) maps to one Slack workspace. Work and personal stay
isolated: separate bots, credentials, and pinned `team_id`.

## Sleep, offline, and reconnect

While your machine is awake, the daemon holds **two outbound connections**:

| Connection | Purpose |
|---|---|
| Slack (Socket Mode) | Receives card/modal actions, updates session cards, refreshes Home |
| herdr (Unix socket) | Watches agent panes, sends prompts and controls |

**Sleep or network loss does not stop your agents.** Cursor and Claude keep running in herdr unless
herdr itself quit or the OS suspended those processes. What drops is the broker's links to Slack and
herdr — not the agent sessions.

After wake:

- **Slack** — reconnects automatically. Home may briefly show "reconnecting to Slack…". Messages sent
  from your phone while offline are delivered once the socket is back (or may need a retry if sent
  during a long outage).
- **herdr** — reconnects with backoff. If herdr is not running yet, Home shows "herdr not connected —
  start it with `herdr`". The daemon does not start herdr for you.
- **State** — resynced from herdr on reconnect. A reply notice is claimed against its turn id, so a
  reconnect that replays transitions cannot manufacture another completion.

If something looks stuck after wake, open Home and check the status line at the bottom, or run
`herdr-slack doctor`.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Run `npm run check` before opening a PR.

## Bug reports

- [Bug report](https://github.com/egemenyildiz/herdr-slack/issues/new?template=bug.yml)
- [Setup problem](https://github.com/egemenyildiz/herdr-slack/issues/new?template=setup-problem.yml)
- [Feature request](https://github.com/egemenyildiz/herdr-slack/issues/new?template=feature.yml)

## License

[Apache License 2.0](LICENSE).

We chose Apache 2.0 to keep the project as open as practical:

- **Use it anywhere** — personal, commercial, embedded in other tools; no copyleft requirement.
- **Modify and redistribute** — fork, patch, ship in a product; only the license notice stays with
  the code.
- **Patent grant** — contributors grant users a license to any patents their contributions read on,
  which MIT does not spell out.
- **Trademark protection** — the license does not grant use of the project name or branding, so
  "herdr-slack" stays identifiable while the code stays free.

If you need a different license for a corporate policy, open an issue — the goal is maximum reuse,
not gatekeeping.
