import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.DATABASE_URL && !process.argv.includes("--use-env")) {
  console.error(
    "Refusing: DATABASE_URL is set. Pass --use-env to run against it, or unset it for a disposable stack.",
  );
  process.exit(1);
}

const name = `pr-agent-verify-${process.pid}`;
let mappedPort = "";
try {
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      name,
      "-p",
      "127.0.0.1::5432",
      "-e",
      "POSTGRES_DB=pr_agent",
      "-e",
      "POSTGRES_USER=pr_agent",
      "-e",
      "POSTGRES_PASSWORD=pr_agent",
      "postgres:16-alpine",
    ],
    { encoding: "utf8" },
  );
  const portOut = execFileSync("docker", ["port", name, "5432"], { encoding: "utf8" });
  mappedPort = portOut.trim().split(":").pop() ?? "";
  if (!mappedPort) throw new Error("no mapped port from docker port");

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      execFileSync("docker", ["exec", name, "pg_isready", "-U", "pr_agent", "-d", "pr_agent"], {
        encoding: "utf8",
        stdio: "pipe",
      });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("postgres never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const databaseUrl = `postgres://pr_agent:pr_agent@127.0.0.1:${mappedPort}/pr_agent`;
  const started = new Date().toISOString();
  let result = "";
  try {
    result = execFileSync("nub", ["run", "test:integration"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? databaseUrl },
    });
    console.log(result.slice(-2000));
  } catch (e) {
    result = e.stdout ?? String(e);
    console.log(result.slice(-2000));
    throw e;
  } finally {
    const stamp = started.replace(/[:.]/g, "-");
    const dir = path.join(ROOT, "verify-artifacts");
    fs.mkdirSync(dir, { recursive: true });
    const artifact = path.join(dir, `${stamp}.md`);
    fs.writeFileSync(
      artifact,
      `# Verify ${started}\n\nDATABASE_URL: ${process.env.DATABASE_URL ? "provided via --use-env" : `disposable container ${name} (127.0.0.1:${mappedPort})`}\n\n\`\`\`\n${result.slice(-8000)}\n\`\`\`\n`,
    );
    console.log(`Artifact: ${path.relative(ROOT, artifact)}`);
  }
} finally {
  try {
    execFileSync("docker", ["rm", "-f", name], { encoding: "utf8", stdio: "pipe" });
  } catch {
    // Container already gone; teardown is best-effort.
  }
}
