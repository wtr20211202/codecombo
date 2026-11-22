# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Version history starts at the first public release (v0.0.1-beta.1); earlier internal
history is not part of this public changelog.

## [Unreleased]

## [0.0.1-beta.9] - 2026-11-22

### Added

- **In-app file preview** — preview documents right in the editor without
  creating a share link first: a breadcrumb "Original ↔ Preview" toggle
  renders markdown, CSV, spreadsheets, Word documents (images and embedded
  attachments included), PDFs, images and sandboxed HTML, with per-format
  preference remembered. The share-preview pipeline was extracted into a
  shared package, so fixes and features land on both sides at once.
- **Terminal share "Permanent" tier** — live terminal shares can now be
  truly permanent: an explicit server-side channel, a "permanent" badge
  across the management UI, an expiry editor on each share row, and a
  warning-instead-of-error combination with the unfiltered mode.
- **Guest keyboard input, unified** — the two guest-typing modes
  (application+approval and open direct input) are consolidated into one
  state machine: the switches no longer race over the owner's keyboard,
  arrival of an application is always visible to the owner (notification +
  10-minute validity + pending projection), the old direct-input endpoints
  are retired, and auditing is unified under a single event.
- **docx embedded attachments** — embedded objects (OLE packages) in shared
  Word documents are visible with a 📎 download link and correct original
  filenames (GBK decoding supported); previewable types open in a dedicated
  viewer page; and the extraction chain now works against real Word files,
  where it previously failed systematically.
- **Quickdrop multi-file delivery** — guests stage files (drag / paste /
  multi-select) with thumbnails and upload progress, and get a local
  delivery history; owners get a delivery log with per-file listing,
  sensitive-file marking, direct browser downloads and one-click revoke;
  the share link can be re-copied across days.
- **`frontend.reload` device targeting** — agents driving a page refresh
  can target a specific device/browser binding, with session affinity and
  a graceful notification fallback.

### Changed

- **Share visitor pages, polished** — the terminal view scales up on wide
  screens (font up to ~3×, filling the viewport instead of leaving large
  empty margins) with the view pinned to the latest output; all visitor
  pages follow the light/dark theme switch; embedded-attachment shells gain
  a full-screen mode and an auto-collapsing options block; the writable
  banner and entry bars were merged; and the terminal canvas stays dark
  for readable input in light theme.
- **Quickdrop visitor page visual pass** — branded two-column layout,
  background ambience matching the document-share page, equal-height
  columns, and honest "text or files — at least one" wording.
- **Install script mirror fallback** — when the official download fails,
  install.sh retries via a mirror prefix (override or disable via
  `CODECOMBO_MIRROR`); root installs register the service directly instead
  of misrouting through sudo.
- **Share link picking** — loopback candidates are included, the browser
  address is preferred for loopback entries, and low-quality interface
  candidates are warned about at copy time.

### Fixed

- **Self-update no longer false-rolls-back** — the post-swap health wait is
  liveness-driven instead of a 15-second deadline, so slow machines are no
  longer rolled back mid-startup; the rollback path itself is hardened
  against losing the backup, and failures snapshot the ExecStart path for
  diagnosis.
- **Markdown preview** — wide images fit their column and open in a
  lightbox; the unified preview layout no longer leaks over the git panel
  or loses the toolbar on deep scroll.
- **dsh external targets** — the management surface works with non-loopback
  tokens, liveness checks dial TCP with an explicit not-ready state, and
  empty states explain what to do next.

## [0.0.1-beta.8] - 2026-11-15

### Added

- **Notes gain a tag system** — tag a note from the editor (chip row with
  autocomplete, up to 8 tags, merged into the same debounced save as the
  content), filter the library by tag server-side (AND-ed with the
  sidebar search), and see inline tag badges in the sidebar list.
- **Workspace panels remember state per scene** — the home page and
  project pages now keep separate memories for the notes/terminal/share/
  dashboard panels: each scene restores its own panel layout on entry
  (before the host mounts, so no flicker), and opening a workbench on the
  home page no longer implies the same panel state inside a project.
- **The npm install shape is recognized in the update panel** — update
  check/status responses carry an `npmManaged` flag; the version panel
  replaces the update button with an npm guidance block and a one-click
  copy of the install command; the getting-started page notes that the
  in-app updater steps aside for this install shape.
- **One-line installers hardened on macOS and Windows** — the one-liner
  now downloads the script to a temp file and runs it (instead of piping
  straight into `sh`/`iex`), with an end-of-script sentinel: a truncated
  or proxy-mangled download refuses to execute and points at the npm
  channel instead. macOS `sh` misreport fixes (POSIX-braced variables),
  TLS pinned for old .NET on Windows, and two new content gates keep the
  scripts ASCII-clean and sentinel-synced.
- **Site documentation pages** — getting-started and FAQ pages
  (zero-framework, bilingual, inlined into the site) with two-way
  navigation from the landing page.

### Changed

- **`npm i -g codecombo` tracks the newest release again** — the release
  workflow moves the `latest` dist-tag on every 0.x publish (it had been
  frozen at beta.2); README and site command surfaces updated for the
  transition.
- **Unified positioning strings** — the CLI `-h` header, systemd unit
  descriptions, Windows service name and the home subtitle now share one
  wording (self-hosted single-binary workbench).
- **README restructured** — a ten-minute "First steps" loop, an expanded
  what's-inside table, slimmer module highlights, and a two-entry Docs
  section (site user docs + in-repo architecture docs).
- **Release pages use explicit anchor ids** for the bilingual sections.
- **Notes tabs polish** — double-click empty tab-strip/sidebar space to
  create a note, double-click a tab to rename, keyboard cycling across
  tabs; the notes sidebar is width-adjustable (180–400 px).

### Fixed

- **Share manager** — the stale-snapshot badge now has a real lifecycle
  (lazy mtime comparison + bus subscription) with quick refresh; batch
  freeze carries the server-side constraint wording; the re-share dialog
  shows an explicit mode guide (batch rows disallow switching modes).
- **Editor tabs** — drag cursor semantics settled: no grab cursor over
  tabs, and the close button no longer starts a drag.
- **Notes survive home round-trips** — going home and back no longer
  force-closes the notes workbench (an explicit Esc still closes it, and
  that choice is remembered).
- **UI state hygiene** — two dead persistence keys retired (they were
  never wired); panel-state restore semantics are now pinned by a
  code-level registry, a lint gate and an e2e matrix.

## [0.0.1-beta.7] - 2026-11-12

### Added

- **Update restarts respect how the app is supervised** — after a
  self-update, the restart is routed per supervision form: Windows
  services hand back to SCM (`sc.exe start`), macOS launchd forms let
  KeepAlive relaunch, and bare/foreground processes respawn with the
  original command-line arguments — previously `--host`/`--data-dir`
  flags were silently lost on update. The new process detaches from the
  console (closing the window no longer kills it), its output lands in a
  log file under the data directory, and rollback chains follow the same
  per-form routing.
- **Session auto-naming** — agent terminal sessions are automatically
  named from their first user message (a short content summary); manual
  renames always win, and a settings switch turns auto-naming off (hot).
- **Terminal session groups** — custom groups gain collapse chevrons with
  member-count badges (parity with project groups), drag-and-drop with
  whole-section drop targets (drop anywhere on a group; reordering works
  from both surfaces), and a live hint when the runtime view hides
  groups. Agents can manage groups over the ops API
  (create/rename/reorder/delete, move sessions in and out) with change
  broadcasts to every open UI.
- **Release notes rendered in the update panel** — the in-app update
  panel shows the release notes as sanitized markdown with
  expand/collapse, plus a "view release page" external link.
- **`frontend.reload` agent primitive** — agents can trigger a page or
  view reload (handy after batch edits), gated by the same per-atom
  settings as the other frontend primitives.
- **dsh 0.2.2-rc.1 known-defect marking** — the version dialog flags the
  known-broken dsh release with a warning and upgrade guidance to
  rc.2+.

### Changed

- **Bilingual release notes get anchor navigation** — GitHub release
  pages now open with a language switch line ([English] | [中文]) and
  each language in its own anchored section (English first), replacing
  the collapsed fold; the switch line, both sections and their order are
  asserted at assembly time, so a malformed template fails the release
  instead of shipping silently.
- **Update restart troubleshooting docs** — README and the Linux deploy
  guide now document how each supervision form behaves across a
  self-update (systemd, Windows service incl. the transient STOPPED
  window, launchd, bare/daemonized), with logs and rollback notes.
- **Share visitor page status bar** — the snapshot/expiry two-line hint
  merges into one compact bar (full sentences remain on hover).

### Fixed

- **Notes handle external edits without disruption** — your own saves no
  longer echo back as external updates (per-window origin nonce);
  external changes from other windows swap in without unmounting the
  editor (cursor and selection stay anchored; identical content is a
  no-op); and the 409 conflict bar now actually appears on the real save
  path (it previously never fired due to an error-shape mismatch).
- **Sidebar resizer no longer steals text selection** — resize handles
  only respond on the sidebar side of the divider; the remote host list
  default width rises to 320 px (min 220), existing remembered widths
  are untouched.

## [0.0.1-beta.6] - 2026-11-11

### Added

- **Self-update downloads resume where they dropped** — large update
  downloads keep a `.part` file and resume at the byte offset on retry;
  splice safety is enforced with strong-ETag If-Range / 206 identity
  checks (a changed or swapped remote is refused and cleared, never
  spliced into your package); 200/416 responses fall back to a clean full
  download; and the package swap happens only after the integrity gate
  passes (atomic rename).
- **Automatic retry folded into the resume chain** — transient download
  failures retry with backoff and resume from the offset (progress never
  resets); deterministic failures such as 403/404 don't waste attempts;
  stale temp files are cleaned up after 7 days; and the failed-update
  card gains a one-click "Retry update".
- **Resume progress is visible** — the downloading state reports
  "resumed xx MB" (new `resumedBytes` field), so a long update over a
  flaky connection reads honestly instead of restarting at 0%.
- **System proxy detection joins the update routing** — outbound routing
  is now four-tier: explicit setting > environment variables > system
  proxy auto-detection (off by default; reads the registry on Windows,
  `scutil` on macOS, `gsettings` on GNOME) > direct. The detection tier
  honors NO_PROXY, every proxied path remains guarded by the
  official-domain allowlist, and the version panel shows the effective
  route backed by a new proxy-status diagnostics endpoint (addresses
  redacted, refreshable on demand).

### Changed

- **Update-proxy documentation** — the README gains a bilingual
  update-proxy section (the four tiers, the NO_PROXY stance, when
  detection runs); the Linux deploy guide shows systemd
  `HTTPS_PROXY`/`NO_PROXY` examples with a daemon-reload note; and the
  upgrade decision table adds the Windows-service row plus why re-running
  the installer is safe.

## [0.0.1-beta.5] - 2026-11-10

### Added

- **Update downloads through a proxy** — a new update-proxy setting with
  three-state outbound routing (direct / proxy / auto) lets self-update
  traffic go through your HTTP(S) proxy; proxy-routed requests are guarded
  by an official-domain allowlist so the update chain cannot be pointed at
  arbitrary hosts.
- **Update progress stays visible** — self-updates are accepted
  asynchronously and report their lifecycle from the server side: a global
  progress badge with staged detail (download → verify → swap → restart)
  keeps you informed after you leave the version panel, and failures
  surface as notifications instead of dying quietly.
- **Terminal selection-copy hardening** — the OSC 52 clipboard hand-off is
  unified across all terminal surfaces with tmux `set-clipboard on`;
  tmux version floors surface as a two-tier hint; a failed clipboard write
  gets a fallback toast; and a new tmux mouse-capture toggle (default on,
  hot-switchable, with a one-click "copy-first mode" shortcut) keeps
  drag-copy and scrolling working across TUI applications and older tmux
  builds.
- **Installer parameters documented** — README and the website now show
  one-line installer parameter examples, and `CODECOMBO_DATA_DIR` is
  honored end-to-end through service installation.

### Changed

- **`codecombo update` no longer swaps the binary while the server is stopped** —
  the standalone offline update path (download + replace without signature
  verification) is retired for supply-chain safety. The command now prints
  guidance instead: start the server and update via the verified in-app flow
  (signature verification + auto-rollback), or use your package manager (npm
  installs are pointed at `npm i -g codecombo@latest`). When the server is
  running, `codecombo update` keeps triggering the same verified,
  auto-rollback update as before.
- **"Already up to date" is now visible** — a successful update check
  renders an explicit success state and a checking state; the up-to-date
  decision is unified so the notification panel and the version panel can
  no longer disagree.
- **Upgrade guidance for existing installs** — the README gains an
  install-type decision table, route ranking, and diagnostics for the
  common `203/EXEC` systemd failure.

### Fixed

- **Windows background start survives console close** — `codecombo start`
  now detaches the daemon from the controlling console (closing the
  launcher window used to kill it); the installer diagnostics line runs a
  genuinely foreground `--serve`, and foreground/background wording is
  unified.
- **Script-installed instances can self-update and restart** — the install
  script provisions the same polkit rules the remote deployer uses, so the
  post-update `systemctl restart codecombo` is authorized instead of
  silently leaving the service down.
- **Windows installer upgrade ordering** — the service is stopped before
  the binary is moved into place, pre-checks fail fast before anything is
  overwritten, and a failed overwrite rolls back.
- **The 6-hour auto update check honors its switch** — turning off
  "auto check updates" now actually stops the frontend timer (with hot
  switching), instead of only muting the server-side check.
- **Update companion-asset failures surface** — signature/hash sidecar
  download failures are distinguished by state, retried a bounded number
  of times with cache bypass, and flagged at check time instead of
  surfacing only at install time.
- **Restart-from-page works over LAN** — restarting the app from the web
  UI now accepts a valid lock token over LAN connections (loopback-only
  before), authorized on both paths.
- **Install script downloads resume** — the main-package download in
  install.sh / install.ps1 passes curl `-C -` alongside the existing
  retries, so a dropped connection resumes the ~50 MB download instead of
  starting over.

## [0.0.1-beta.4] - 2026-11-09

### Added

- **Notes become a real multi-document library** — notes leave the sidebar
  strip: a notepad-style independent view opens as an overlay on the home
  page or fills the project page's main area; multi-document management with
  a recycle bin; a single global notes library with automatic migration of
  existing per-project notes (the old per-project storage and its endpoints
  are retired); three keyboard shortcuts in the notes domain; new notes
  start empty; the agent channel is fully open (agents can create, read and
  edit notes over the ops API).
- **Writable shares: "let the other side type" remote assistance** — a
  shared live terminal can now be opened for direct visitor input: the
  owner grants keyboard access per share behind an explicit confirmation
  and a mandatory passphrase; visitor keystrokes flow over a WebSocket
  uplink bridge straight into the PTY with token-bucket rate limiting;
  pasted blocks (large or multi-line) pass a command-risk pre-check and wait
  in an approval queue until the owner decides; disconnect releases the
  grant immediately and the owner's keyboard is restored; one-click revoke
  from the session badge, the share manager or the notification; the whole
  flow is audited.
- **Visitor terminal pages match the in-app terminal** — the three visitor
  pages (live / frozen / recorded) adapt their layout to the viewport;
  visitor rendering fidelity is aligned with the product terminal; live and
  frozen shares gain a server-side sensitivity-redaction toggle (unfiltered
  mode is labeled end-to-end); the share dialog surfaces TTL and passphrase;
  the collaboration bar overlays no longer squeeze terminal content; guests
  can paste images and files.
- **Mouse-mode Shift-drag selection** — when the terminal captures the mouse
  (DECSET 1000/1002/1003), holding Shift now still selects and copies text:
  an OSC 52 exclusive takeover replaces the clipboard addon, a hint bar on
  the pane marks the mode, insecure contexts fall back gracefully, and
  app-initiated copies suppress the hint so it does not nag after every
  successful copy.
- **Adjustable sidebars** — a generic sidebar resizer (drag, remembered
  width, min/max clamp, double-click reset, keyboard accessible); the
  remote-console host list is now adjustable between 200 and 480 px.
- **Session manager polish** — right-click menus gain the same share/export
  actions and live badge as the bottom terminal; going home now means a
  clean home (the session manager closes instead of following you around),
  while entering a project restores that project's previous layout.

### Changed

- **Home toolbar tidy-up** — lock-related actions get distinct icons
  (layout lock becomes a pin with two states), the version badge is folded
  into the logo entry, and the overflow menu gains icons.

### Fixed

- **Share dialogs invisible on the home page** — the four share-family
  dialogs now host at the app root so they render above any view instead of
  being trapped under the session-manager overlay.
- **Session manager blank after a home round-trip** — the selected icon
  stayed lit while the panel went blank; keep-alive watches now sync
  immediately with the selection.

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

[Unreleased]: https://github.com/wtr20211202/codecombo/compare/v0.0.1-beta.9...HEAD
[0.0.1-beta.9]: https://github.com/wtr20211202/codecombo/releases/tag/v0.0.1-beta.9
[0.0.1-beta.8]: https://github.com/wtr20211202/codecombo/releases/tag/v0.0.1-beta.8
[0.0.1-beta.7]: https://github.com/wtr20211202/codecombo/releases/tag/v0.0.1-beta.7
[0.0.1-beta.6]: https://github.com/wtr20211202/codecombo/releases/tag/v0.0.1-beta.6
[0.0.1-beta.5]: https://github.com/wtr20211202/codecombo/releases/tag/v0.0.1-beta.5
[0.0.1-beta.4]: https://github.com/wtr20211202/codecombo/releases/tag/v0.0.1-beta.4
[0.0.1-beta.3]: https://github.com/wtr20211202/codecombo/releases/tag/v0.0.1-beta.3
[0.0.1-beta.2]: https://github.com/wtr20211202/codecombo/releases/tag/v0.0.1-beta.2
[0.0.1-beta.1]: https://github.com/wtr20211202/codecombo/releases/tag/v0.0.1-beta.1
