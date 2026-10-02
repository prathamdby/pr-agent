import { AppError } from "../../errors/appError.js";
import {
  DEFAULT_ASK_ACTOR_BURST,
  DEFAULT_ASK_ACTOR_MAX_OUTSTANDING,
  DEFAULT_ASK_ACTOR_REFILL_SECONDS,
  DEFAULT_ASK_INSTALLATION_BURST,
  DEFAULT_ASK_INSTALLATION_MAX_OUTSTANDING,
  DEFAULT_ASK_INSTALLATION_REFILL_SECONDS,
  DEFAULT_ASK_PROVIDER_BUDGET_TOKENS,
  DEFAULT_ASK_PROVIDER_BUDGET_WINDOW_SECONDS,
  DEFAULT_ASK_PROVIDER_RESERVATION_TOKENS,
  DEFAULT_ASK_REPOSITORY_BURST,
  DEFAULT_ASK_REPOSITORY_MAX_OUTSTANDING,
  DEFAULT_ASK_REPOSITORY_REFILL_SECONDS,
} from "../askQuotaConstants.js";
import { ENV } from "../envKeys.js";
import { readNonNegativeInteger, readPositiveInteger, readPositiveNumber } from "../envReaders.js";

/** Per-actor, repository, and installation admission plus the optional provider token budget. */
export type AskSlice = {
  readonly actorMaxOutstanding: number;
  readonly repositoryMaxOutstanding: number;
  readonly installationMaxOutstanding: number;
  readonly actorBurst: number;
  readonly repositoryBurst: number;
  readonly installationBurst: number;
  readonly actorRefillSeconds: number;
  readonly repositoryRefillSeconds: number;
  readonly installationRefillSeconds: number;
  readonly providerBudgetTokens: number;
  readonly providerBudgetWindowSeconds: number;
  readonly providerReservationTokens: number;
};

export function readAskSlice(): AskSlice {
  const askActorMaxOutstanding = readPositiveInteger(
    ENV.ASK_ACTOR_MAX_OUTSTANDING,
    DEFAULT_ASK_ACTOR_MAX_OUTSTANDING,
  );
  const askRepositoryMaxOutstanding = readPositiveInteger(
    ENV.ASK_REPOSITORY_MAX_OUTSTANDING,
    DEFAULT_ASK_REPOSITORY_MAX_OUTSTANDING,
  );
  const askInstallationMaxOutstanding = readPositiveInteger(
    ENV.ASK_INSTALLATION_MAX_OUTSTANDING,
    DEFAULT_ASK_INSTALLATION_MAX_OUTSTANDING,
  );
  const askActorBurst = readPositiveInteger(ENV.ASK_ACTOR_BURST, DEFAULT_ASK_ACTOR_BURST);
  const askRepositoryBurst = readPositiveInteger(
    ENV.ASK_REPOSITORY_BURST,
    DEFAULT_ASK_REPOSITORY_BURST,
  );
  const askInstallationBurst = readPositiveInteger(
    ENV.ASK_INSTALLATION_BURST,
    DEFAULT_ASK_INSTALLATION_BURST,
  );
  const askActorRefillSeconds = readPositiveNumber(
    ENV.ASK_ACTOR_REFILL_SECONDS,
    DEFAULT_ASK_ACTOR_REFILL_SECONDS,
  );
  const askRepositoryRefillSeconds = readPositiveNumber(
    ENV.ASK_REPOSITORY_REFILL_SECONDS,
    DEFAULT_ASK_REPOSITORY_REFILL_SECONDS,
  );
  const askInstallationRefillSeconds = readPositiveNumber(
    ENV.ASK_INSTALLATION_REFILL_SECONDS,
    DEFAULT_ASK_INSTALLATION_REFILL_SECONDS,
  );
  const askProviderBudgetTokens = readNonNegativeInteger(
    ENV.ASK_PROVIDER_BUDGET_TOKENS,
    DEFAULT_ASK_PROVIDER_BUDGET_TOKENS,
  );
  const askProviderBudgetWindowSeconds = readPositiveNumber(
    ENV.ASK_PROVIDER_BUDGET_WINDOW_SECONDS,
    DEFAULT_ASK_PROVIDER_BUDGET_WINDOW_SECONDS,
  );
  const askProviderReservationTokens = readPositiveInteger(
    ENV.ASK_PROVIDER_RESERVATION_TOKENS,
    DEFAULT_ASK_PROVIDER_RESERVATION_TOKENS,
  );
  if (askProviderBudgetTokens > 0 && askProviderReservationTokens > askProviderBudgetTokens) {
    throw new AppError({
      code: "config.invalid_number",
      message: `${ENV.ASK_PROVIDER_RESERVATION_TOKENS} must not exceed ${ENV.ASK_PROVIDER_BUDGET_TOKENS} when the provider budget is enabled`,
      context: {
        name: ENV.ASK_PROVIDER_RESERVATION_TOKENS,
        askProviderBudgetTokens,
        askProviderReservationTokens,
      },
    });
  }

  return {
    actorMaxOutstanding: askActorMaxOutstanding,
    repositoryMaxOutstanding: askRepositoryMaxOutstanding,
    installationMaxOutstanding: askInstallationMaxOutstanding,
    actorBurst: askActorBurst,
    repositoryBurst: askRepositoryBurst,
    installationBurst: askInstallationBurst,
    actorRefillSeconds: askActorRefillSeconds,
    repositoryRefillSeconds: askRepositoryRefillSeconds,
    installationRefillSeconds: askInstallationRefillSeconds,
    providerBudgetTokens: askProviderBudgetTokens,
    providerBudgetWindowSeconds: askProviderBudgetWindowSeconds,
    providerReservationTokens: askProviderReservationTokens,
  };
}
