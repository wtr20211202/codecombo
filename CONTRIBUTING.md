# Contributing

Thank you for considering contributing to Codecombo! **Pull requests are welcome** —
bug fixes, documentation improvements and new features alike.

## How to contribute

1. **Open an issue first** for anything non-trivial (new features, behavior
   changes) so we can align on direction before you invest time.
2. **Fork, branch, commit** — keep commits focused; follow the existing commit
   style (`type(scope): summary`).
3. **Sign your commits (DCO)** — add a `Signed-off-by` line to each commit
   (`git commit -s`), certifying that you wrote the change and have the right
   to submit it under the project's Apache-2.0 license:

   ```
   Signed-off-by: Your Name <you@example.com>
   ```

4. **Include tests** for behavior changes — Go changes need `go test ./...`
   passing, frontend changes need `cd web && npm run check` passing.
5. **Run the linters** before submitting; CI runs the same gates
   (Go build/test, frontend type-check + lint + unit tests).

## Development environment

Prerequisites:

- Go 1.26+
- Node.js 20.19+ / 22.12+ (with npm)
- Git CLI available on `PATH`

```bash
# Frontend dev server on :5173 (proxies /api and /ws to :9999)
cd web && npm install && npm run dev

# Backend on :9999 (run in a second terminal)
go run main.go

# Full build (frontend + Go, output to dist/)
./build.sh          # Linux/macOS
build.bat           # Windows

# Frontend quality gates (type-check + lint + unit tests + contract checks)
cd web && npm run check

# Go tests
go test ./...
```

## Code style

Follow the existing code style of each area (Go conventions for `server/`,
the Vue 3 + Naive UI conventions visible in `web/src/`). Changes should be
platform-neutral (Windows / Linux / macOS) unless explicitly documented
otherwise.

## License

By contributing, you agree that your contributions will be licensed under the
Apache License 2.0 that covers this project.
