# opencode-web-evict

Standalone MCP/instance eviction for `opencode web` on v1.18.x.

## Why this exists

OpenCode v1 keeps one MCP fleet alive per directory it has ever served and
never releases them while the server runs (`opencode web` has no quit event
that frees resources). Over days of use this accumulates idle fleets —
notably Engram — until things hang.

Upstream tracking (no official fix as of 2026-10-09):

- `anomalyco/opencode#53068` — feature request, still OPEN
- `anomalyco/opencode#52946` — LRU cap PR, closed without merge

Related prior art (TUI-only, v2-only, not usable with `opencode web`):
`angeloper86/opencode-release-on-quit` (MIT). This script ports the idea to
the v1 HTTP API and was written from scratch for it.

## How it works

- `GET /session` → group sessions per directory, newest `time.updated` wins
- `POST /instance/dispose?directory=<dir>` → dispose that directory's whole
  instance (MCP servers included, reboot lazily on next use)

Dry-run is the default. Nothing mutates without `--apply`.

```bash
node src/evict-web.mjs --base-url http://127.0.0.1:3333 --idle-minutes 60
node src/evict-web.mjs --base-url http://127.0.0.1:3333 --idle-minutes 360 --apply
```

Flags: `--base-url`, `--idle-minutes` (default 60), `--apply`,
`--protect <dir>` (repeatable), `--json`, `--timeout-ms`.

Cron example (every 6h, dispose dirs idle 6h+):

```bash
0 */6 * * * /usr/bin/node /home/servidor/Descargas/opencode-web-evict/src/evict-web.mjs --idle-minutes 360 --apply
```

## Safety

- Directories with activity newer than `--idle-minutes` are skipped.
  (The v1 session list has no active-turn flag — the recency threshold is
  the guard, keep it generous.)
- The directory the script runs from is always excluded; add more with
  `--protect`.
- Exit codes: 0 ok, 1 a dispose failed under `--apply`, 2 connection or
  bad payload (fails loud — cron-monitorable).
- Log: `~/.local/share/opencode/evict-web.log`.

## Provenance

- 2026-10-09: first dry-run found 100 sessions across 3 dirs; `--apply`
  disposed `/home/servidor` (idle 1089h) and `/home/servidor/Decargas`
  (idle 440h), left active `/home/servidor/Descargas` untouched, exit 0.
