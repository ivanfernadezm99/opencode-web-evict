// Web-mode eviction for opencode web v1.18.x.
//
// The TUI plugin (src/tui.ts) cannot run under `opencode web`: there is no
// TUI quit event, and v1.x has no `debug.location.evict` endpoint. This
// standalone script uses the v1 HTTP API instead:
//   GET  /session                         -> session list (id, directory, time.updated)
//   POST /instance/dispose?directory=<d>  -> dispose that directory's whole
//                                           instance (MCP servers included)
// Safety model: only directories whose newest session activity is older than
// --idle-minutes are candidates. v1 session list has no active-turn flag, so
// the recency threshold IS the guard — keep it generous. The directory the
// script runs from is always excluded; add more via --protect.
// Default is dry-run. Nothing mutates without --apply.

import { appendFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";

const HOME = process.env.HOME ?? "";
const LOG = `${HOME}/.local/share/opencode/evict-web.log`;

const options = {
  baseUrl: "http://127.0.0.1:3333",
  idleMinutes: 60,
  apply: false,
  protect: [],
  json: false,
  timeoutMs: 10_000,
};

for (let i = 0; i < process.argv.length; i++) {
  const arg = process.argv[i];
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

if (!Number.isFinite(options.idleMinutes) || options.idleMinutes < 0) {
  console.error("--idle-minutes must be a non-negative number");
  process.exit(2);
}

const log = async (message) => {
  try {
    await appendFile(LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging is best effort.
  }
};

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
    req.end();
  });

const main = async () => {
  await log(`start base=${options.baseUrl} idle-min=${options.idleMinutes} apply=${options.apply}`);
  const { status, body } = await get(`${options.baseUrl}/session`);
  if (status === 401 || status === 403) {
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

  const idleMsLimit = options.idleMinutes * 60_000;
  const rows = [...byDir.values()]
    .map((e) => {
      const idleMs = now - e.newest;
      let action = "active";
      let reason = "recent activity";
      if (e.directory === cwd) reason = "script cwd (always protected)";
      else if (options.protect.includes(e.directory)) reason = "--protect";
      else if (idleMs >= idleMsLimit) {
        action = options.apply ? "dispose" : "would-dispose";
        reason = `idle ${(idleMs / 3_600_000).toFixed(1)}h`;
      }
      return { ...e, idleMs, action, reason };
    })
    .sort((a, b) => b.idleMs - a.idleMs);

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
