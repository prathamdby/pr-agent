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

export function githubNoreplyEmail(userId: number, login: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`${userId}+${login}@users.noreply.github.com`);
}

export function botGitPerson(bot: BotIdentity) {
  return ((pinnedReturn: GitPerson) => pinnedReturn)({
    name: bot.login,
    email: githubNoreplyEmail(bot.userId, bot.login),
  });
}

export function buildTriageCommitAttribution(params: {
  readonly botIdentity: BotIdentity;
  readonly triggerer: GitPerson | null;
}) {
  const bot = botGitPerson(params.botIdentity);
  if (params.triggerer == null) {
    return ((pinnedReturn: TriageCommitAttribution) => pinnedReturn)({
      person: bot,
      coAuthoredBy: [],
      source: "app",
    });
  }
  return ((pinnedReturn: TriageCommitAttribution) => pinnedReturn)({
    person: params.triggerer,
    coAuthoredBy: [bot],
    source: "human",
  });
}

export function gitPersonFromGithubUser(user: {
  readonly id: number;
  readonly login: string;
  readonly name?: string | null;
  readonly email?: string | null;
  readonly type?: string;
}) {
  if (!Number.isFinite(user.id) || user.id <= 0)
    return ((pinnedReturn: GitPerson | null) => pinnedReturn)(null);
  const login = user.login?.trim();
  if (!login) return ((pinnedReturn: GitPerson | null) => pinnedReturn)(null);
  if (user.type === "Bot" || login.endsWith("[bot]"))
    return ((pinnedReturn: GitPerson | null) => pinnedReturn)(null);
  const rawName = user.name?.trim() || login;
  const name =
    rawName
      .replace(/[\r\n]+/g, " ")
      .split("\0")
      .join(" ")
      .trim() || login;
  if (!name) return ((pinnedReturn: GitPerson | null) => pinnedReturn)(null);
  const email = (user.email?.trim() || githubNoreplyEmail(user.id, login)).trim();
  if (!email.includes("@")) return ((pinnedReturn: GitPerson | null) => pinnedReturn)(null);
  return ((pinnedReturn: GitPerson | null) => pinnedReturn)({ name, email });
}

export function formatCoAuthoredByTrailer(person: GitPerson) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `Co-authored-by: ${person.name} <${person.email}>`,
  );
}
