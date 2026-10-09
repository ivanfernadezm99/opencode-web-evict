// opencode-web-evict — release idle `opencode web` (v1.x) instances.
//
// WHAT THIS DOES
//   OpenCode v1 (`opencode web`) keeps one full MCP server fleet alive per
//   directory it has ever served, for as long as the server process runs.
//   Closing a browser tab or ending a chat does NOT release them: there is no
//   "client quit" event that frees per-directory resources, so idle fleets
//   (notably Engram) pile up until the server gets slow or hangs.
//   This script finds directories whose sessions are all idle and disposes
//   their server-side instance, which terminates their MCP child processes.
//   Everything boots lazily again the next time that directory is used.
//
// WHAT IT DOES NOT DO
//   - It does NOT delete session history. The session rows stay in the DB;
//     only the live processes are released.
//   - It does NOT touch the directory with recent activity, the directory
//     the script runs from, or anything listed via --protect.
//   - By default it does NOTHING mutating: dry-run just prints a table.
//     Disposal requires the explicit --apply flag.
//
// HOW IT TALKS TO THE SERVER (v1.18.x HTTP API, no auth on loopback)
//   GET  /session
//     Returns a JSON array of sessions. Each entry carries at least:
//       { id, directory, title, time: { created, updated } }
//     `time.updated` is epoch millis of the session's last activity and is
//     the only idleness signal v1 exposes (there is no active-turn flag,
//     so the --idle-minutes threshold IS the safety guard — keep generous).
//   POST /instance/dispose?directory=<urlencoded dir>
//     Disposes that directory's whole server-side instance, MCP servers
//     included. The disposal runs in server middleware AFTER the response
//     is produced, and the endpoint answers boolean true on success.
//     (A GET on the same path answers 405 — disposal is POST-only.)
//   NOTE: v1.x has no `debug.location.evict` endpoint (that is a v2
//   concept), which is why the TUI plugin opencode-release-on-quit cannot
//   work here and this script exists.
//
// EXIT CODES (cron-monitorable: only 0 means "all good")
//   0 — success (dry-run listed candidates, or every dispose succeeded)
//   1 — at least one dispose failed under --apply (others still attempted)
//   2 — usage/connection/payload error: bad flags, server unreachable,
//       unexpected HTTP status, non-JSON or non-array /session payload,
//       or the server demanding auth (we refuse to guess credentials).

import { appendFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";

// ---------------------------------------------------------------------------
// CLI options. Both `--flag value` and `--flag=value` spellings are accepted;
// bare `--apply` / `--json` act as boolean switches.
// ---------------------------------------------------------------------------
const HOME = process.env.HOME ?? "";
const LOG = `${HOME}/.local/share/opencode/evict-web.log`;

const options = {
  baseUrl: "http://127.0.0.1:3333", // opencode web listener
  idleMinutes: 60, // dirs idle longer than this become candidates
  apply: false, // false = dry-run table only, true = POST disposals
  protect: [], // extra directories to never touch (repeatable)
  json: false, // machine-readable candidate table on stdout
  timeoutMs: 10_000, // per-request HTTP timeout
};

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  // takeValue supports `--key value` (consumes next argv) and `--key=value`.
  const takeValue = () => {
    const eq = arg.indexOf("=");
    if (eq !== -1) return arg.slice(eq + 1);
    return process.argv[++i];
  };
  if (arg === "--apply") options.apply = true;
  else if (arg === "--json") options.json = true;
  else if (arg.startsWith("--base-url")) options.baseUrl = takeValue();
  else if (arg.startsWith("--idle-minutes")) options.idleMinutes = Number(takeValue());
  else if (arg.startsWith("--protect")) options.protect.push(takeValue());
  else if (arg.startsWith("--timeout-ms")) options.timeoutMs = Number(takeValue());
}

// Fail fast on nonsense thresholds: a negative idle window would dispose
// everything, which must never happen silently.
if (!Number.isFinite(options.idleMinutes) || options.idleMinutes < 0) {
  console.error("--idle-minutes must be a non-negative number");
  process.exit(2);
}

// Best-effort activity log. Logging must never break the run, hence the
// swallowed errors — a full disk should not mask the exit code.
const log = async (message) => {
  try {
    await appendFile(LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging is best effort.
  }
};

// Minimal promise wrappers over node:http(s) — zero dependencies on purpose
// so the script runs on any box with node and nothing to npm-install.
const get = (url) =>
  new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { timeout: options.timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${options.timeoutMs}ms`)));
    req.on("error", reject);
  });

const post = (url) =>
  new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.request(url, { method: "POST", timeout: options.timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${options.timeoutMs}ms`)));
    req.on("error", reject);
    req.end(); // no body: the directory travels in the query string
  });

const main = async () => {
  await log(`start base=${options.baseUrl} idle-min=${options.idleMinutes} apply=${options.apply}`);

  // --- 1. Fetch the session list (read-only). -------------------------------
  const { status, body } = await get(`${options.baseUrl}/session`);
  if (status === 401 || status === 403) {
    // Some setups put auth in front of the server. We stop loudly instead of
    // prompting for, storing, or guessing credentials.
    console.error(`Server requires auth (HTTP ${status}). Refusing to guess credentials.`);
    process.exit(2);
  }
  if (status < 200 || status >= 300) {
    console.error(`GET /session failed: HTTP ${status}`);
    process.exit(2);
  }
  let sessions;
  try {
    sessions = JSON.parse(body);
  } catch {
    console.error("GET /session did not return JSON.");
    process.exit(2);
  }
  if (!Array.isArray(sessions)) {
    console.error("GET /session did not return an array.");
    process.exit(2);
  }

  // --- 2. Collapse sessions per directory. ----------------------------------
  // A directory is only as idle as its NEWEST session: one active chat keeps
  // the whole directory's instance alive, so max(time.updated) is the metric.
  // Sessions without a timestamp count as epoch 0 (ancient) but never crash
  // the max() computation.
  const now = Date.now();
  const cwd = process.cwd();
  const byDir = new Map();
  for (const s of sessions) {
    if (!s || typeof s.directory !== "string") continue;
    const updated = s.time?.updated;
    const ts = typeof updated === "number" ? updated : 0;
    const entry = byDir.get(s.directory) ?? { directory: s.directory, count: 0, newest: 0 };
    entry.count += 1;
    if (ts > entry.newest) entry.newest = ts;
    byDir.set(s.directory, entry);
  }

  // --- 3. Decide an action per directory. -----------------------------------
  // Order of guards matters: cwd and --protect win over idleness, so an
  // explicit protection can never be overridden by a low threshold.
  const idleMsLimit = options.idleMinutes * 60_000;
  const rows = [...byDir.values()]
    .map((e) => {
      const idleMs = now - e.newest;
      let action = "active";
      let reason = "recent activity";
      if (e.directory === cwd) reason = "script cwd (always protected)";
      else if (options.protect.includes(e.directory)) reason = "--protect";
      else if (idleMs >= idleMsLimit) {
        // The label flip is deliberate and safety-critical: without --apply
        // we only ever print "would-dispose"; the word "dispose" appears
        // exclusively on runs that will actually POST.
        action = options.apply ? "dispose" : "would-dispose";
        reason = `idle ${(idleMs / 3_600_000).toFixed(1)}h`;
      }
      return { ...e, idleMs, action, reason };
    })
    .sort((a, b) => b.idleMs - a.idleMs); // stalest first: highest relief first

  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log("directory | sessions | idle | action | reason");
    for (const r of rows) {
      console.log(
        `${r.directory} | ${r.count} | ${(r.idleMs / 3_600_000).toFixed(1)}h | ${r.action} | ${r.reason}`,
      );
    }
  }

  // --- 4. Dispose (only when --apply), one directory at a time. ------------
  // Sequential on purpose: easier to attribute log lines, and a failing
  // directory must not cancel the remaining ones — hence per-dir try/catch
  // with a failure counter instead of an early throw.
  let failed = 0;
  for (const r of rows) {
    if (r.action !== "dispose") {
      await log(`skipped (${r.reason}): ${r.directory}`);
      continue;
    }
    try {
      const url = `${options.baseUrl}/instance/dispose?directory=${encodeURIComponent(r.directory)}`;
      const res = await post(url);
      if (res.status >= 200 && res.status < 300 && res.body.trim() === "true") {
        await log(`disposed: ${r.directory} (sessions=${r.count})`);
      } else {
        failed += 1;
        await log(`dispose failed: ${r.directory}: HTTP ${res.status} body=${res.body.slice(0, 200)}`);
      }
    } catch (err) {
      failed += 1;
      await log(`dispose error: ${r.directory}: ${err?.message ?? err}`);
    }
  }

  await log(`done candidates=${rows.filter((r) => r.action === "dispose").length} failed=${failed}`);
  if (failed > 0) process.exit(1);
};

main().catch((err) => {
  console.error(`fatal: ${err?.message ?? err} (base-url=${options.baseUrl})`);
  process.exit(2);
});
