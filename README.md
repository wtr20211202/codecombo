# Codecombo

**Language / 语言：English | [简体中文](docs/README.zh-CN.md)**

<img src="site/assets/logo/codecombo-tile.svg" alt="Codecombo logo — two meshing arcs around a hub" width="104">

![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)
![Go](https://img.shields.io/badge/Go-1.26+-00ADD8?logo=go&logoColor=white)
![Vue](https://img.shields.io/badge/Vue-3.5-42b883?logo=vue.js&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)
![Status](https://img.shields.io/badge/Status-Beta-orange)
<!-- CI badge: uncomment after the first green run on GitHub Actions
![CI](https://github.com/wtr20211202/codecombo/actions/workflows/ci.yml/badge.svg)
-->

> **Status: Beta.** Codecombo is under active development and has not had its
> stable 1.0 release yet — interfaces and on-disk data formats may still change
> between versions. Feedback and bug reports are very welcome.

**Codecombo — one workbench for every dev tool.**

**Codecombo** is a self-hosted, single-binary workbench that collects your
everyday dev tools — a full Git workbench, real terminal sessions, AI coding
agents, remote machines — into one browser tab, where they share data and work
together. No more juggling separate apps.

- **One binary, no database** — Go (Gin) backend + Vue 3 (Naive UI) frontend
  embedded via `go:embed`; all state stays in `~/.codecombo/` on your machine.
- **Everything is a session** — local shells, remote SSH terminals, AI agents
  (claude / codex / dsh runtimes) live side by side in the same workspace.
- **Built for delegation with control** — agents can run autonomously, but
  high-risk actions come back to you as approval cards.

> **About dsh**: Codecombo neither includes nor distributes dsh (DeepSeek
> Harness) or any third-party agent runtime. It only ships an optional local
> embedding channel: if *you* installed dsh on your machine, Codecombo can
> embed its web UI over a loopback proxy. See [NOTICE](NOTICE).

## Quickstart

### One-line install (recommended)

Downloads the latest release binary, verifies SHA256, installs to
`~/.local/bin` (outside your data directory — the installer never touches
`~/.codecombo`, your data belongs to the app alone) and registers a service
(systemd on Linux, launchd on macOS, Windows service when elevated) — one
command you can paste to your AI assistant:

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/wtr20211202/codecombo/main/scripts/install.sh | sh
```

```powershell
# Windows PowerShell
iex ((New-Object System.Net.WebClient).DownloadString('https://raw.githubusercontent.com/wtr20211202/codecombo/main/scripts/install.ps1'))
```

Then open **http://localhost:9999** and set your lock password on first start.
Version selection is automatic: the latest stable release when one exists;
until then the newest rc, falling back to the newest beta. Port, bind
address, install directory and data directory are adjustable — see
[Optional parameters](#optional-parameters).

**Permissions & the service account.** To register the service you need
elevation — administrator PowerShell on Windows, sudo on Linux (the script
prompts for it and keeps the service running as *your* user, not root);
macOS launchd agents need no elevation. Without elevation the script still
installs the binary and prints a manual start command (no service
registration — `start` runs the app as a background daemon). The service
writes only to your own data directory (`~/.codecombo` — pinned via the
`--data-dir` service argument on Windows, since the service account's
default home points elsewhere).

**Change bind host / port after install**: re-run the same command with the
variables from [Optional parameters](#optional-parameters) (e.g.
`CODECOMBO_HOST=0.0.0.0` — mind where they go), or manage the service directly.
Service control differs per platform — `sc.exe` is Windows' built-in
Service Control command line (the counterpart of `systemctl` on Linux and
`launchctl` on macOS):

**Windows (service = `Codecombo`, via `sc.exe`)**

```powershell
sc.exe query Codecombo                # status
sc.exe stop Codecombo                 # stop
sc.exe config Codecombo binPath= "C:\Users\<you>\AppData\Local\Programs\codecombo\codecombo.exe --serve --port=9999 --host 0.0.0.0"
sc.exe start Codecombo                # start with new bind host
```

**Linux (systemd)**

```bash
sudo systemctl status codecombo       # status
sudo systemctl restart codecombo      # restart after editing the unit's --host
```

**macOS (launchd)**

```bash
launchctl list | grep codecombo       # status
# edit ~/Library/LaunchAgents/com.codecombo.plist (--host 0.0.0.0), then:
launchctl unload ~/Library/LaunchAgents/com.codecombo.plist
launchctl load ~/Library/LaunchAgents/com.codecombo.plist
```

#### Optional parameters

Both installers read four optional environment variables; leave them unset
and you get the defaults below — the same behavior as before:

| Variable | Default | Meaning |
|---|---|---|
| `CODECOMBO_PORT` | `9999` | Service port |
| `CODECOMBO_HOST` | `127.0.0.1` (this machine only) | Bind address; `0.0.0.0` = reachable from your LAN |
| `CODECOMBO_PREFIX` | `~/.local/bin` (Windows: `%LOCALAPPDATA%\Programs\codecombo`) | Directory the binary is installed to |
| `CODECOMBO_DATA_DIR` | `~/.codecombo` | Data directory (absolute path). Only handed to the service — `CC_DATA_DIR` in the systemd unit / launchd plist, `--data-dir` in the Windows service command line and in the printed manual start command; the installer still never creates or writes it |

Where they go: on the `sh` side of the pipe (placed before `curl` they only
reach curl, and the script falls back to the defaults); in PowerShell as
`$env:` assignments before `iex` — they stay set for the rest of that
PowerShell session.

```bash
# Second instance next to an existing one: own port, data dir and install dir
curl -fsSL https://raw.githubusercontent.com/wtr20211202/codecombo/main/scripts/install.sh | CODECOMBO_PORT=11000 CODECOMBO_DATA_DIR=$HOME/.codecombo-test CODECOMBO_PREFIX=$HOME/.local/codecombo-test sh

# LAN access (all interfaces) — trusted networks only, the lock password is the only gate
curl -fsSL https://raw.githubusercontent.com/wtr20211202/codecombo/main/scripts/install.sh | CODECOMBO_HOST=0.0.0.0 sh

# Custom install directory
curl -fsSL https://raw.githubusercontent.com/wtr20211202/codecombo/main/scripts/install.sh | CODECOMBO_PREFIX=$HOME/bin sh
```

```powershell
# Windows: second instance next to an existing one
$env:CODECOMBO_PORT='11000'; $env:CODECOMBO_DATA_DIR="$HOME\.codecombo-test"; $env:CODECOMBO_PREFIX="$env:LOCALAPPDATA\Programs\codecombo-test"; iex ((New-Object System.Net.WebClient).DownloadString('https://raw.githubusercontent.com/wtr20211202/codecombo/main/scripts/install.ps1'))
```

Before adding a second instance:

- **One installer-managed service per machine.** Service names are fixed
  (`codecombo.service` / `com.codecombo` / `Codecombo`). If the existing
  instance already runs as that service (installed by this script or by
  remote deploy), a run with other settings re-points that service — it
  takes the existing instance over instead of adding one. Keep the second
  instance out of service registration then and start a binary with its own
  flags: `<bin> start --port 11000 --data-dir <dir>` — the command the
  installers print when they skip registration (non-elevated PowerShell,
  Linux without sudo credentials).
- **The CLI needs the data dir too**: `<bin> status --data-dir <dir>`,
  `<bin> stop --data-dir <dir>`.
- **Upgrades re-run with the same variables** — without
  `CODECOMBO_DATA_DIR` the rewritten service falls back to `~/.codecombo` at
  its next restart (your data stays in the custom dir; the instance just no
  longer reads it).
- **Never re-run the script on a remote-deployed instance** (see
  [Upgrading](#upgrading)).

### Install with npm

```bash
npm i -g codecombo
codecombo start
```

Then open **http://localhost:9999** and set your lock password on first start.
Requires Node.js 18+ — the npm package is a thin wrapper; `npm` picks the
native binary for your platform (Windows / Linux / macOS, amd64 & arm64) via
optional dependencies. No postinstall scripts. Prebuilt binaries are also on
the [Releases](../../releases) page.

Feeling adventurous? Pre-release versions (rc / beta) publish to the `next`
channel: `npm i -g codecombo@next` — or pin any version explicitly, e.g.
`npm i -g codecombo@0.2.0-rc1`. Stable `npm i -g codecombo` never moves.
Updates for npm installs are owned by npm: the in-app updater stays off for
this install shape — just re-run the install command to move to the latest.

### Upgrading

**Install method decides update method.** Identify your install first — run
`systemctl cat codecombo` and read the binary path in `ExecStart` (no unit,
e.g. a manually started instance — `start` daemon or `--serve` foreground —
or a remote deploy in "direct process" mode: `ps -ef | grep codecombo`
shows the running binary path; `~` is the service user's home, shown as an
absolute path in the unit):

| Check | Installed by | How to upgrade |
|---|---|---|
| `ExecStart` → `~/.local/bin/codecombo` | the install script above | 1 in-app update (preferred) · 2 re-run the script |
| `ExecStart` → `~/.codecombo/bin/codecombo` | remote deploy from a central instance | 1 in-app update · re-deploy remotely · 3 manual replacement — **never** re-run the script |
| `ExecStart` → `/opt/codecombo/bin/codecombo` | manual `/opt` layout ([deploy-linux](docs/deploy-linux.md)) | 1 in-app update · 3 manual replacement |
| `npm ls -g codecombo` lists it | npm | `npm i -g codecombo@latest` (the in-app updater steps aside) |

**1. In-app update (recommended shape)** — "Check Update" in the version
panel (Settings → About) pulls the new binary from GitHub and swaps it with
automatic rollback on failure. Two notes: versions older than v0.0.1-beta.3
cannot see new releases in-app (a check-chain defect, fixed in
v0.0.1-beta.3) — upgrade once via the script/manual paths below first;
during the beta phase the GitHub stable channel stays empty, so turn on
**Follow pre-releases** in the version panel before checking.
Script-installed (systemd-managed) instances: if the service has not come
back on its own after updating, `sudo systemctl restart codecombo` finishes
the rollout.

**2. Re-run the install script (script installs only)** — read your original
`--host`/`--port` from `ExecStart` (installed with a custom data dir? also
pass its `CC_DATA_DIR` from the unit's `Environment=` line back as
`CODECOMBO_DATA_DIR`); the env vars must sit on the `sh` side
of the pipe (placed before `curl` they only apply to curl, and the port/bind
fall back to the 9999/127.0.0.1 defaults):

```bash
sudo -v && curl -fsSL https://raw.githubusercontent.com/wtr20211202/codecombo/main/scripts/install.sh | CODECOMBO_HOST=<original> CODECOMBO_PORT=<original> sh
```

`sudo -v` first — under `curl | sh` the script cannot prompt for a password,
so it proceeds only with cached credentials (without them it still swaps the
binary but skips the service unit). The script swaps the binary via rename
(a running service is fine) but keeps serving the old version until restart:
when it reports a running instance, close with
`sudo systemctl restart codecombo`. On macOS re-running takes effect
immediately (the script reloads the launchd agent itself). **Instances
installed by remote deploy must not re-run the script** — the templated unit
overwrite drops `PATH`/`WorkingDirectory`/`NoNewPrivileges` and reverts the
bind address to `127.0.0.1`, cutting remote access as soon as the service
restarts; that layout upgrades in-app or via a fresh remote deploy from the
central instance (use a central instance on v0.0.1-beta.3 or later — earlier
deployers could fail to upgrade older installs in place). On Windows, run
`sc.exe stop Codecombo` before re-running install.ps1 — Windows locks a
running `.exe`, so the swap fails with the service up.

**3. Manual binary replacement (Linux only)** — the full recipe (stop →
verify SHA256 → keep a `.bak` → replace → start, plus the rollback step)
lives in [docs/deploy-linux.md](docs/deploy-linux.md) §6; the three-state
`status=203/EXEC` triage for a service that won't start is in §7 of the same
doc. Mind the file size: binaries are ~50 MB (linux-amd64 ≈ 51–54 MB) — a
file of tens of bytes means you clicked a `.sha256`/`.sig` sidecar instead
of the binary.

### Build and run

Prerequisites: Go 1.26+, Node.js 20.19+ / 22.12+, Git.

```bash
git clone https://github.com/wtr20211202/codecombo.git
cd codecombo

./build.sh            # Linux/macOS — frontend + Go, output to dist/
build.bat             # Windows

./dist/codecombo start        # start the service (daemon)
# or: ./dist/codecombo        # equivalent to `start`
```

Then open **http://localhost:9999**, set your lock password on first start,
and add a project (a local Git repo, or clone one). Prebuilt binaries for
Windows / Linux / macOS (amd64 & arm64) are published on the
[Releases](../../releases) page.

### Development mode

```bash
cd web && npm install && npm run dev   # Vite dev server on :5173 (proxies to :9999)
go run main.go                         # Go backend on :9999 (second terminal)
```

Run the quality gates before submitting changes: `cd web && npm run check`
(type-check + lint + unit tests + contract gates) and `go test ./...`.

### Access from other devices (LAN)

By default Codecombo binds to `127.0.0.1` (this machine only). To reach it
from your phone or another machine on the LAN, bind all interfaces:

```bash
codecombo start --host 0.0.0.0        # or: -H 0.0.0.0 (flag beats config.json server.host)
```

Then open `http://<machine-ip>:9999` from the other device. The lock password
(first-start setup) is the gate — bind to `0.0.0.0` only on networks you trust.

## What's inside

| Tool | What it does |
|---|---|
| **Git workbench** | Visual Git: hunk-level staging, three-way diffs, drag-and-drop interactive rebase, merge preview, conflict resolution, worktrees, submodules, LFS, GPG-signed commits, commit graph with cherry-pick / squash / extract |
| **Web terminal** | Real PTYs (ConPTY / pty), optional tmux persistence with output replay across restarts, split panes, floating windows, image paste upload, bookmarks, command blocks |
| **Remote machines** | SSH host management with encrypted credentials, remote terminals (incl. remote tmux), one-click remote deployment pipelines (bootstrap → runtime → systemd), live deploy logs, port forwarding |
| **AI agent sessions** | claude / codex / dsh sessions per project — side-by-side runs, continuation chains, scheduled jobs, reusable runbooks, fleet execution; every session a real PTY with replayable scrollback |
| **Agent ops channel** | Agents operate the workbench itself over a structured API: downloads, clipboard, open-at-line, preview links, ask & approval cards, cross-device notifications |
| **Approval center** | High-risk commands and mass replacements return as approval cards with live terminal recording — approve / deny / edit per item; secrets redacted on the way out |
| **On-call dashboard** | One screen for instance health (memory / goroutines / git pressure), 52-week activity heatmap, live change stream, agent collaboration flow, stalled-session triage |
| **Multi-instance sync** | Manage local & remote instances from one screen: switching with health overview, terminal/panel take-over, instance-to-instance sync, encrypted machine migration (`.scpkg`) |
| **Sharing links** | One-click links for files / folders / snippets / live terminals — TTL, password, view-once, frozen snapshot; visitors need no account |
| **dsh integration** | Embed the dsh (DeepSeek Harness) Web UI over a loopback proxy, plus npm version management: upgrade / rollback with changelog |
| **Security foundation** | Global lock (first-start password, idle auto-lock), AES-256 master-key encryption for all stored secrets, per-IP rate limiting, audit log with CSV export |
| **Self-update** | GitHub-release-based update checks with automatic rollback; central instances can cache and forward binaries to child instances |
| **i18n & themes** | English / 简体中文 UI; four built-in themes (Dark / Light / One Dark / Dracula) |

Details and screenshots per tool in [Highlights](#highlights).

## Highlights

### Agent ops channel

The part no other terminal has: agents do not just run *inside* Codecombo —
they can operate the workbench itself over a structured API. An agent can
trigger a browser download for a report it just produced, copy a snippet to
your clipboard, open a file at an exact line, focus a panel, publish a dev-server
preview link, or surface structured questions (ask cards) and high-risk action
requests (approval cards) back to you. Capabilities are registered in a single
registry with a rendered handbook (`GET /api/ops-manual`) agents can read, and
the same channel powers cross-device notifications.

### AI agent sessions

Run multiple AI agent sessions per project — side-by-side comparison of two
agents on the same task, session continuation chains (hand work from one agent
to the next), scheduled agent jobs, reusable runbooks, and fleet execution of a
runbook across many sessions. Every session is a real PTY: attach, replay the
full scrollback after a refresh, bookmark lines, and search across all output.

![Agent session running a real PTY](docs/img/agent-session.png)

*Typical scenario: the server lost power or was rebooted mid-task. The terminal
processes are gone, but the work is not — open Codecombo and tell any agent over
the ops channel to "restore all my previous sessions": each project's sessions
come back the way they were, with full output history replayable.*

### On-call dashboard

A single screen for "what is my box doing right now": instance health (memory /
goroutines / WebSocket clients / git process pressure), a 52-week activity
heatmap, a cross-project live change stream, agent collaboration flow (who
messaged whom, which handoff chain is running), stalled-session triage, and
approval cards waiting for judgement.

![On-call dashboard](docs/img/oncall-dashboard.png)

### Approval center

Agents don't get a blank check. High-risk commands and mass file replacements
return as approval cards with live terminal recording — watch what the agent
did, then approve, deny, or edit per item. Sensitive values (tokens, passwords,
cloud keys) are redacted on the way out.

![Approval card for a high-risk git reset](docs/img/approval-card.png)

### Multi-instance sync

One Codecombo instance can manage many others — local or remote — through a
central proxy: instance switching with health overview, terminal and panel
take-over of a remote instance, instance-to-instance sync, and one-shot
machine migration (export/import an encrypted `.scpkg` package with
credentials, settings and project contexts).

![Instance sync center with a dual-instance topology](docs/img/instance-sync.png)

### Sharing links

Share a file, a folder, a text snippet, or a live terminal with visitors via
one-click links — TTL, password, view-once (burn-after-reading) and
frozen-snapshot are all one toggle away; visitors need no account.

![Share dialog](docs/img/share-dialog.png)

*Typical scenario: a colleague needs the report you just generated. Right-click
the file → Share → send the link. Done — no chat-tool file transfer, no shared
drive, and you can revoke the link at any moment.*

### …and a complete Git workbench

Staging down to the hunk level, three-way diffs, interactive rebase with
drag-and-drop, merge preview, changelists and shelves, conflict resolution,
worktrees, submodules, LFS, GPG-signed commits, reflog, patch export/import,
and a commit graph you can cherry-pick / squash / extract from.

![Project workspace](docs/img/project-editor.png)

## Highlights (continued): the rest of the toolbox

- **dsh integration** — the dsh (DeepSeek Harness) Web UI embedded over a
  loopback proxy; npm version management with upgrade / rollback and a version
  changelog.
- **Web terminal** — real PTYs (ConPTY on Windows, creack/pty on Unix),
  optional tmux persistence with output replay across restarts, split panes,
  floating windows, image paste upload, bookmarks, command blocks.
- **Remote machines** — SSH host management with encrypted credentials,
  remote terminals (with remote tmux), one-click remote deployment pipelines
  (user bootstrap → Node.js/agent runtime → systemd service), live deploy
  logs, port forwarding.
- **Security foundation** — global lock (first-start password setup, idle
  auto-lock), AES-256 encryption for all stored secrets via a local master
  key, per-IP rate limiting, audit log with CSV export.
- **Self-update** — GitHub-release-based update checks with automatic
  rollback; central instances can cache and forward binaries to child
  instances. Zero-config: the official repo is the built-in default source.
  Automatic checks run every 24h and notify on new versions — toggle in the
  version panel to opt out. Which upgrade path applies depends on how you
  installed — see [Upgrading](#upgrading).
- **i18n & themes** — English / 简体中文 UI; four built-in themes
  (Dark / Light / One Dark / Dracula).

## Project structure

```
codecombo/
├── main.go                  # CLI entry (start/stop/update/reset-lock/credential-helper), daemon, embed
├── server/
│   ├── api/                 # HTTP/WS API layer (admin / gitops / notify / shared)
│   ├── git/                 # Git CLI wrapper (execGit + auth injection + write queue)
│   ├── terminal/            # PTY session management (native / tmux backends)
│   ├── deploy/              # Remote deploy engine (Deployer registry + task manager)
│   ├── sync/                # Multi-instance sync + machine migration (.scpkg)
│   ├── share/               # Visitor share links (file/snippet/terminal)
│   ├── config/              # Config store, master-key crypto, data-dir migration
│   ├── store/               # JSON persistence (per-domain stores)
│   └── ...                  # metrics / notification / proxy / update / watch / recording
├── web/                     # Vue 3 + TypeScript frontend (embedded via go:embed)
│   ├── src/views/           # Panels: git, terminal, editor, agents, monitor, settings
│   ├── src/components/      # UI components (layout / monitor / recording / ...)
│   └── e2e/                 # Playwright end-to-end tests
├── docs/                    # Architecture & design docs (Chinese, EN translation on roadmap)
├── scripts/                 # Dev/test tooling (e2e harness, gates)
└── build.sh / build.bat     # Cross-platform build (6 targets)
```

## Docs

Architecture and design documents live in [`docs/`](docs) — currently in
Chinese, English translation is on the roadmap:

- [docs/AGENT_SESSIONS.md](docs/AGENT_SESSIONS.md) — agent sessions, approvals, orchestration primitives, and how the ops manual is injected per runtime (claude / codex auto-inject, dsh manual)
- [docs/EXTENSION_POINTS.md](docs/EXTENSION_POINTS.md) — index of all extension points (kernel modules, deployers, platform adapters, frontend panels, ops events)
- [docs/PERSISTENCE_LANES.md](docs/PERSISTENCE_LANES.md) — the three persistence lanes
- [docs/OPS_EVENTS.md](docs/OPS_EVENTS.md) — ops-channel event catalog for agents
- [docs/adr/](docs/adr) — architecture decision records
- [docs/deploy-linux.md](docs/deploy-linux.md) — Linux deployment guide
- [docs/remote-access.md](docs/remote-access.md) — LAN/remote access & security notes

## Roadmap

- [ ] English translation of the docs (progressive, by demand)
- [ ] SQLite as an optional storage backend — under consideration based on user
      feedback; deliberately **not** implemented before open-sourcing
- [ ] macOS CI in addition to Windows + Linux
- [ ] Plugin API on top of the existing extension points

## Contributing

**Pull requests are welcome** — bug fixes, docs and features alike. Please
open an issue first for non-trivial changes, sign your commits (DCO,
`git commit -s`), and make sure the test gates pass. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full guide and the development
environment setup. Please keep the discussion area friendly and on-topic.

## Security

Please report vulnerabilities privately via
[GitHub Security Advisories](../../security/advisories/new) — do not open
public issues for security problems. See [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). The bundled fonts and vendored assets are
covered by their own licenses, catalogued in [NOTICE](NOTICE).
