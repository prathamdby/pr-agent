"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const COMPOSE_FILE = "docker-compose.dev.yml";
const SERVICE = "cloudflared";
const HOST_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
const WAIT_MS = 90_000;
const POLL_MS = 2_000;

function composeLogs(bin) {
  return spawnSync(bin, ["compose", "-f", COMPOSE_FILE, "logs", "--no-color", SERVICE], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function readLogs() {
  let result = composeLogs("docker");
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status === 0 || !/permission denied/i.test(combined)) {
    return combined;
  }
  result = spawnSync(
    "sudo",
    ["-n", "docker", "compose", "-f", COMPOSE_FILE, "logs", "--no-color", SERVICE],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function latestHost(text) {
  const matches = [...text.matchAll(HOST_RE)].map((match) => match[0]);
  return matches.at(-1);
}

function sleep(ms) {
  spawnSync("sleep", [String(ms / 1000)]);
}

const deadline = Date.now() + WAIT_MS;
let host = latestHost(readLogs());
while (!host && Date.now() < deadline) {
  sleep(POLL_MS);
  host = latestHost(readLogs());
}

if (!host) {
  process.stderr.write(
    "No trycloudflare URL in cloudflared logs yet. Start the stack with " +
      `docker compose -f ${COMPOSE_FILE} up -d --build and retry.\n`,
  );
  process.exit(1);
}

process.stdout.write(`${host}/webhooks\n`);
