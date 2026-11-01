# Codecombo

Self-hosted, single-binary workbench: a full Git workbench, real terminal
sessions, AI coding agents and remote machines — in one browser tab.

```bash
npm i -g codecombo
codecombo start
```

Then open **http://localhost:9999** and set your lock password on first start.

The npm package is a thin wrapper: `npm` picks the native binary for your
platform (Windows / Linux / macOS, amd64 & arm64) via optional dependencies —
no postinstall scripts, works with `--ignore-scripts`. The app itself is a
single Go binary; state stays in `~/.codecombo/` on your machine.

- Site & docs: https://wtr20211202.github.io/codecombo/
- Source & issues: https://github.com/wtr20211202/codecombo

Apache-2.0. Not affiliated with any third-party agent runtime (see the
[NOTICE](https://github.com/wtr20211202/codecombo/blob/main/NOTICE)).
