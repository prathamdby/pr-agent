import { chmod, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const GIT_ASKPASS_NAME = "git-askpass.sh";
export const GIT_TOKEN_FILE_NAME = "git-token";

export type GitCredentialFiles = {
  readonly askpass: string;
  readonly tokenFile: string;
  readonly cleanup: () => Promise<void>;
};

export async function createGitCredentialFiles(
  rootDir: string,
  token: string,
): Promise<GitCredentialFiles> {
  const askpass = join(rootDir, GIT_ASKPASS_NAME);
  const tokenFile = join(rootDir, GIT_TOKEN_FILE_NAME);
  await writeFile(
    askpass,
    [
      "#!/bin/sh",
      'token=""',
      'if [ -n "$GIT_TOKEN_FILE" ] && [ -f "$GIT_TOKEN_FILE" ]; then',
      '  token=$(cat "$GIT_TOKEN_FILE")',
      "fi",
      'case "$1" in',
      "  *Username*) printf '%s\\n' x-access-token ;;",
      "  *) printf '%s\\n' \"$token\" ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await writeFile(tokenFile, token, { mode: 0o600 });
  return {
    askpass,
    tokenFile,
    cleanup: async () => {
      await rm(askpass, { force: true });
      await rm(tokenFile, { force: true });
    },
  };
}

export async function makeDirectoriesWritable(dir: string): Promise<void> {
  await chmod(dir, 0o755).catch(() => undefined);
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await makeDirectoriesWritable(full);
    }
  }
}
