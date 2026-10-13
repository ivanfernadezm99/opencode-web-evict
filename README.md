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

## Installed cron (2026-10-13)

Runs every 6h on `servidor`'s crontab, disposing directories idle 6h+:

```cron
0 */6 * * * cd /tmp && /usr/bin/node /media/servidor/d0a196c3-2d36-4431-b15d-8ea078ad8222/opencode-web-evict/src/evict-web.mjs --idle-minutes 360 --apply >> /home/servidor/.local/share/opencode/evict-web.cron.log 2>&1
```

The `cd /tmp &&` prefix is load-bearing, not cosmetic. Cron defaults the
working directory to `$HOME`, and the script always protects its own cwd.
Without the prefix, cron would run from `/home/servidor` and the cwd guard
would silently shield the home directory forever, so it could never be
evicted. Anchoring cwd at `/tmp` makes the protection predictable and leaves
`$HOME` governed by the idle threshold alone.

`--idle-minutes 360` matches the 6h interval: a directory must be idle for a
full cycle before it becomes a candidate. stdout/stderr go to
`~/.local/share/opencode/evict-web.cron.log`; the script's own action log
stays at `~/.local/share/opencode/evict-web.log`.

`0 */6 * * *` fires at 00:00, 06:00, 12:00 and 18:00. To remove it:
`crontab -l | grep -v evict-web.mjs | crontab -`.

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
- 2026-10-13: installed the cron entry — until then the schedule had only
  ever been an example in this README, never a real crontab line. Validated
  the command under cron's minimal environment (`env -i`,
  `PATH=/usr/bin:/bin`) and anchored it at `cd /tmp` so the cwd guard does
  not shield `$HOME`.
