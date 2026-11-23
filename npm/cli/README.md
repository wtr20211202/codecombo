# Codecombo

Self-hosted, single-binary workbench: a full Git workbench, real terminal
sessions, AI coding agents and remote machines — in one browser tab.

```bash
npm i -g codecombo
codecombo start
```

Then open **https://localhost:9999** and set your lock password on first
start. TLS is on by default — a self-signed certificate is generated on first
start, so your browser will ask you to trust/continue on the first visit; if
certificate generation ever fails the service falls back to plain HTTP and
logs it.

The npm package is a thin wrapper: `npm` picks the native binary for your
platform (Windows / Linux / macOS, amd64 & arm64) via optional dependencies —
no postinstall scripts, works with `--ignore-scripts`. The app itself is a
single Go binary; state stays in `~/.codecombo/` on your machine.

Updates are owned by npm: in-app self-update is intentionally disabled for
npm installs (replacing files inside `node_modules` would desync npm's
version bookkeeping) — run `npm i -g codecombo@latest` to update, or
`codecombo@next` for pre-releases.

**Restarts are supervised by the wrapper.** A restart triggered from the web
settings page keeps the app running in both npm shapes:

- Foreground (`codecombo --serve` in a terminal): the app shuts down
  gracefully and hands restart ownership back to the wrapper, which re-spawns
  the binary with the same arguments — the process stays attached to your
  terminal.
- Daemon (`codecombo start`): the app re-spawns itself detached from the
  terminal, so closing the terminal afterwards does not kill it; follow-up
  output lands in `~/.codecombo/logs/update-restart.log`.

The wrapper also guards against crash loops: if the app requests a restart
5 times within 60 seconds, the wrapper stops re-spawning and exits non-zero
instead of spinning forever.

- Site & docs: https://wtr20211202.github.io/codecombo/
- Source & issues: https://github.com/wtr20211202/codecombo

Apache-2.0. Not affiliated with any third-party agent runtime (see the
[NOTICE](https://github.com/wtr20211202/codecombo/blob/main/NOTICE)).
