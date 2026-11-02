# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Version history starts at the first public release (v0.1.0-beta.2); earlier internal
history is not part of this public changelog.

## [Unreleased]

## [0.1.0-beta.2] - 2026-11-03

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

[Unreleased]: https://github.com/wtr20211202/codecombo/compare/v0.1.0-beta.2...HEAD
[0.1.0-beta.2]: https://github.com/wtr20211202/codecombo/releases/tag/v0.1.0-beta.2
