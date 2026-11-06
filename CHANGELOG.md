# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Version history starts at the first public release (v0.0.1-beta.1); earlier internal
history is not part of this public changelog.

## [Unreleased]

## [0.0.1-beta.3] - 2026-11-06

### Fixed

- **Update checks never actually worked** — the built-in official source is
  a github.com web URL while fetch endpoints are REST API paths; the
  missing URL normalization made every check decode HTML as JSON and fail,
  surfacing as a misleading "no distribution source configured" toast.
  Web repo URLs now normalize to api.github.com, and check failures are no
  longer flattened into "up to date": an empty stable channel (only
  pre-releases published) says so and points to the "Follow pre-releases"
  toggle, while other failures (network, invalid source) surface their
  actual reason (beta.1/beta.2 regression).
- **Windows service data directory** — the service command line now carries
  `--data-dir` directly, pinning the data directory to the installing
  user's profile (`%USERPROFILE%\.codecombo`); the previous
  environment-variable approach silently did not take effect under
  LocalSystem, so the service started with an empty data directory instead
  of reusing the existing one.
- **Legacy upgrade via remote deploy** — migrating an old installation no
  longer fails with `install binary exit 1`: the binary is installed
  directly to the final ExecStart path (the legacy directory is renamed as
  a whole during the first-start migration), removing the chicken-and-egg
  deadlock between the install directory and the migration target. Failed
  installs now surface the remote command's stderr in the task log.
- **Path normalization on Windows** — short (8.3) components in a missing
  target's tail segment are resolved consistently; ancestor resolution
  used to drop the last path segment, causing false traversal rejections
  in edge cases.
- **Recent decisions overlay** — the recent-approval bar is now manually
  dismissable (✕) and only surfaces decisions from the last 48 hours, so
  it no longer permanently covers the terminal panel.

### Changed

- **Update settings take effect immediately** — the "follow pre-releases"
  toggle, update-source changes and the auto-check switch now apply on save
  without a restart. A "Restart app" button in the version panel covers the
  few settings that genuinely need one: Windows services restart via SCM
  failure-recovery, systemd via `systemctl restart`, foreground instances
  respawn themselves with the original arguments.
- **npm platform packages renamed** — `codecombo-win32-*` packages are now
  `codecombo-windows-*` (npm's spam heuristics weigh "win32" naming
  heavily; same-structure darwin/linux packages passed untouched). The
  `os: win32` field stays as npm's standard platform identifier, so
  `npm i -g codecombo` platform selection is unchanged.
- **npm publish flow** — the main package publishes first and a single
  package failure no longer aborts the rest; failures are collected and
  summarized at the end of the run.

## [0.0.1-beta.2] - 2026-11-05

### Added

- **Windows service support** — the registered Windows service now runs the
  real workbench: full SCM protocol (status reporting, stop/shutdown handling
  via the existing graceful exit path, 10s stop grace), service context
  detection in `--serve`, data directory pinned to the installing user
  profile via service environment.

### Fixed

- **Windows installer hardening** (five field incidents on PS 5.1):
  ASCII-only no-BOM script (encoding broke `irm | iex` parsing),
  `WindowsIdentity::Current` property access (method-call crash), line-by-line
  execution guard via WebClient single-string bootstrap, explicit curl exit
  checks (silent failures slid into verification), download progress bar with
  retry/timeouts (silent 50MB download looked like a hang), root/system
  account guard, service start verification with RUNNING polling and
  diagnostics instead of an unconditional "started" message.

## [0.0.1-beta.1] - 2026-11-03

First public release (beta).

### Added

- **Terminal workspace** — multi-session/multi-split/terminal tabs backed by
  real PTYs (ConPTY on Windows, creack/pty on Unix, optional tmux persistent
  sessions with output replay and service-restart recovery), scrollback
  bookmarks, full-output search, command blocks and run-state markers,
  image paste upload.
- **Agent collaboration** — one-click integration of local AI agent runtimes
  (claude / codex / dsh), approval cards for high-risk commands and batch
  replacements (per-item allow/deny), session continuation chains, scheduled
  agent tasks, dual-agent comparison, and an AI-queryable operations manual.
- **Agent ops channel** — agents can operate the workbench itself over a
  structured API: browser downloads, clipboard, open-file-at-line, dev-server
  preview links, ask/approval cards and cross-device notifications, with a
  rendered handbook (`GET /api/ops-manual`).
- **Git workbench** — hunk-level staging/unstage/discard, three-way diff,
  interactive rebase (pick/squash/fixup/reword/drop with drag-and-drop),
  merge preview, changelists and shelves, patch export/import, branch
  management, conflict resolution (text and 3-way), reflog, tags, submodules,
  worktrees, LFS, GPG signing support.
- **Credentials & auth** — per-host PAT/password storage, GitHub/Gitea OAuth
  Device Flow with auto refresh, SSH key generation/import with automatic
  per-host injection, AES-256 encryption of all secrets at rest via a local
  master key.
- **Remote capabilities** — remote host management (SSH credentials encrypted
  at rest), remote terminals (SSH PTY with optional remote tmux), one-click
  remote deployment pipelines (systemd service + dependency bootstrap) with
  live log streaming, port forwarding and an on-call health dashboard.
- **Multi-instance management** — one instance can manage multiple remote
  Codecombo instances through a central proxy (health overview, terminal and
  panel take-over, instance-to-instance sync, machine migration via encrypted
  `.scpkg` packages).
- **Sharing** — visitor links for files/folders/snippets/terminals with TTL,
  password gate, view-once (burn-after-reading) and frozen (read-only
  snapshot) modes.
- **Security foundation** — global lock with first-start password setup,
  idle auto-lock, per-IP rate limiting, approval-boundary output redaction,
  audit log with CSV export.
- **Self-update** — online update check with zero-config default source
  (the official GitHub repo; clear `updateURL` in settings to opt out),
  signature/checksum verification, child-instance binary cache forwarding,
  and automatic rollback on failed updates.
- **npm distribution** — `npm i -g codecombo` installs a thin wrapper plus
  the native binary for the detected platform (Windows/Linux/macOS,
  amd64/arm64) via optional dependencies — no postinstall scripts. Pre-release
  versions publish to the `next` channel (`codecombo@next`); npm-installed
  instances update through npm while the in-app updater steps aside.
- **Project website** — bilingual landing page with screenshots, scenarios
  and quickstart: https://wtr20211202.github.io/codecombo/
- **Cross-platform** — single static binary for Windows/Linux/macOS
  (amd64/arm64), no external database; all state in `~/.codecombo/`.

### Changed

- Documentation overhaul: quickstart moved to the front, complete
  what's-inside toolbox inventory, typical-scenario walkthroughs, and an
  open contribution guide (DCO-signed PRs welcome).

[Unreleased]: https://github.com/wtr20211202/codecombo/compare/v0.0.1-beta.3...HEAD
[0.0.1-beta.3]: https://github.com/wtr20211202/codecombo/releases/tag/v0.0.1-beta.3
[0.0.1-beta.2]: https://github.com/wtr20211202/codecombo/releases/tag/v0.0.1-beta.2
[0.0.1-beta.1]: https://github.com/wtr20211202/codecombo/releases/tag/v0.0.1-beta.1
