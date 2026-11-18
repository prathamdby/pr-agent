import crypto from "node:crypto";
import { AppError } from "../../errors/appError.ts";
import {
  DEFAULT_MAINTAINER_DECISION_ASSOCIATIONS,
  DEFAULT_SLASH_ALLOWED_ASSOCIATIONS,
  GITHUB_AUTHOR_ASSOCIATIONS,
} from "../defaults.ts";
import { ENV } from "../envKeys.ts";
import { optionalEnv, requireEnv } from "../envReaders.ts";
import { WEBHOOK_MAX_BODY_BYTES, WEBHOOK_TIMEOUT_MS } from "../webhookConstants.ts";

export type GithubSlice = {
  readonly appId: string;
  readonly privateKey: string;
};

export type WebhookSlice = {
  readonly secret: string;
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
};

export type AssociationsSlice = {
  readonly slashAllowed: ReadonlySet<string>;
  readonly maintainerDecision: ReadonlySet<string>;
};

function stripMatchingQuotes(value: string) {
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
    return ((pinnedReturn: string) => pinnedReturn)(value.slice(1, -1));
  }
  return ((pinnedReturn: string) => pinnedReturn)(value);
}

function looksLikePemPrivateKey(value: string) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    value.includes("-----BEGIN ") && value.includes("PRIVATE KEY-----"),
  );
}

function decodeBase64Pem(value: string) {
  const compact = value.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    return ((pinnedReturn: string | null) => pinnedReturn)(null);
  }

  const decoded = Buffer.from(compact, "base64").toString("utf8").trim();
  return ((pinnedReturn: string | null) => pinnedReturn)(
    looksLikePemPrivateKey(decoded) ? decoded : null,
  );
}

export function normalizeGithubAppPrivateKey(raw: string) {
  const unquoted = stripMatchingQuotes(raw.trim());
  let key = unquoted.replace(/\\n/g, "\n");

  if (!looksLikePemPrivateKey(key)) {
    const decoded = decodeBase64Pem(unquoted);
    if (decoded) key = decoded.replace(/\\n/g, "\n");
  }

  try {
    crypto.createPrivateKey(key);
  } catch {
    throw new AppError({
      domain: "config",
      kind: "invalid_github_app_private_key",
      message:
        "GITHUB_APP_PRIVATE_KEY must be a valid unencrypted PEM private key. Use the GitHub App private key content with real newlines, escaped \\n newlines, or base64-encoded PEM.",
    });
  }

  return ((pinnedReturn: string) => pinnedReturn)(key);
}

const allowedGithubAuthorAssociations = new Set<string>(GITHUB_AUTHOR_ASSOCIATIONS);

function readAssociationAllowlist(name: string, defaultValue: string, allowWildcard: boolean) {
  const values = optionalEnv(name, defaultValue)
    .split(",")
    .map((value) => value.trim().toUpperCase());

  if (allowWildcard && values.length === 1 && values[0] === "*")
    return ((pinnedReturn: ReadonlySet<string>) => pinnedReturn)(new Set(["*"]));

  for (const value of values) {
    if (!allowedGithubAuthorAssociations.has(value)) {
      throw new AppError({
        domain: "config",
        kind: "invalid_enum",
        message: `${name} must be ${allowWildcard ? '"*" or ' : ""}one or more of ${GITHUB_AUTHOR_ASSOCIATIONS.join(", ")}`,
        context: { name, allowed: GITHUB_AUTHOR_ASSOCIATIONS },
      });
    }
  }

  return ((pinnedReturn: ReadonlySet<string>) => pinnedReturn)(new Set(values));
}

export function readGithubSlice() {
  const appId = requireEnv(ENV.GITHUB_APP_ID);
  const privateKey = normalizeGithubAppPrivateKey(requireEnv(ENV.GITHUB_APP_PRIVATE_KEY));
  return ((pinnedReturn: GithubSlice) => pinnedReturn)({ appId, privateKey });
}

export function readWebhookSlice() {
  return ((pinnedReturn: WebhookSlice) => pinnedReturn)({
    secret: requireEnv(ENV.WEBHOOK_SECRET),
    timeoutMs: WEBHOOK_TIMEOUT_MS,
    maxBodyBytes: WEBHOOK_MAX_BODY_BYTES,
  });
}

export function readAssociationsSlice() {
  return ((pinnedReturn: AssociationsSlice) => pinnedReturn)({
    slashAllowed: readAssociationAllowlist(
      ENV.SLASH_ALLOWED_ASSOCIATIONS,
      DEFAULT_SLASH_ALLOWED_ASSOCIATIONS,
      true,
    ),
    maintainerDecision: readAssociationAllowlist(
      ENV.MAINTAINER_DECISION_ASSOCIATIONS,
      DEFAULT_MAINTAINER_DECISION_ASSOCIATIONS,
      false,
    ),
  });
}
