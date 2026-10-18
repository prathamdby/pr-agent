import type { BotIdentity } from "../../github/appAuth.ts";
export type GitPerson = {
  readonly name: string;
  readonly email: string;
};

export type TriageCommitAttribution = {
  readonly person: GitPerson;
  readonly coAuthoredBy: readonly GitPerson[];
  readonly source: "human" | "app";
};

export function githubNoreplyEmail(userId: number, login: string): string {
  return `${userId}+${login}@users.noreply.github.com`;
}

export function botGitPerson(bot: BotIdentity): GitPerson {
  return {
    name: bot.login,
    email: githubNoreplyEmail(bot.userId, bot.login),
  };
}

export function buildTriageCommitAttribution(params: {
  readonly botIdentity: BotIdentity;
  readonly triggerer: GitPerson | null;
}): TriageCommitAttribution {
  const bot = botGitPerson(params.botIdentity);
  if (params.triggerer == null) {
    return { person: bot, coAuthoredBy: [], source: "app" };
  }
  return {
    person: params.triggerer,
    coAuthoredBy: [bot],
    source: "human",
  };
}

export function gitPersonFromGithubUser(user: {
  readonly id: number;
  readonly login: string;
  readonly name?: string | null;
  readonly email?: string | null;
  readonly type?: string;
}): GitPerson | null {
  if (!Number.isFinite(user.id) || user.id <= 0) return null;
  const login = user.login?.trim();
  if (!login) return null;
  if (user.type === "Bot" || login.endsWith("[bot]")) return null;
  const rawName = user.name?.trim() || login;
  const name =
    rawName
      .replace(/[\r\n]+/g, " ")
      .split("\0")
      .join(" ")
      .trim() || login;
  if (!name) return null;
  const email = (user.email?.trim() || githubNoreplyEmail(user.id, login)).trim();
  if (!email.includes("@")) return null;
  return { name, email };
}

export function formatCoAuthoredByTrailer(person: GitPerson): string {
  return `Co-authored-by: ${person.name} <${person.email}>`;
}
