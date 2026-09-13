"use strict";

const { generateKeyPairSync } = require("node:crypto");
const { spawn } = require("node:child_process");

function hasPem(value) {
  return typeof value === "string" && value.includes("BEGIN") && value.includes("PRIVATE KEY");
}

if (!hasPem(process.env.GITHUB_APP_PRIVATE_KEY)) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({
    type: "pkcs1",
    format: "pem",
  });
}

if (!process.env.GITHUB_APP_ID) {
  process.env.GITHUB_APP_ID = "1";
}

if (!process.env.WEBHOOK_SECRET) {
  process.env.WEBHOOK_SECRET = "local-dev-webhook-secret";
}

const child = spawn(process.execPath, ["dist/index.js"], {
  stdio: "inherit",
  env: process.env,
});

function forward(signal) {
  if (!child.killed) {
    child.kill(signal);
  }
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    forward(signal);
  });
}

child.on("error", () => {
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
