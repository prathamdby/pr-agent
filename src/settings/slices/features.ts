import { AppError } from "../../errors/appError.ts";
import {
  COMMAND_FEATURE_MODES,
  DEFAULT_FEATURE_ASK,
  DEFAULT_FEATURE_COMMIT_STATUS,
  DEFAULT_FEATURE_DESCRIBE,
  DEFAULT_FEATURE_REVIEW,
  DEFAULT_FEATURE_REVIEW_CADENCE,
  DEFAULT_FEATURE_REVIEW_LABELS,
  DEFAULT_FEATURE_TITLE_REWRITE,
  DEFAULT_FEATURE_TRIAGE,
  DEFAULT_FEATURE_VERIFICATION,
  DESCRIBE_FEATURE_MODES,
  REVIEW_CADENCE_MODES,
  REVIEW_FEATURE_MODES,
  REVIEW_LABELS_MODES,
  VERIFICATION_FEATURE_MODES,
  type Features,
} from "../featureModes.ts";
import { ENV } from "../envKeys.ts";
import { readEnum, readStrictBoolean } from "../envReaders.ts";

export function readFeatures(): Features {
  const review = readEnum(ENV.FEATURE_REVIEW, REVIEW_FEATURE_MODES, DEFAULT_FEATURE_REVIEW);
  const reviewCadence = readEnum(
    ENV.FEATURE_REVIEW_CADENCE,
    REVIEW_CADENCE_MODES,
    DEFAULT_FEATURE_REVIEW_CADENCE,
  );
  if (reviewCadence === "every_push" && review === "manual") {
    throw new AppError({
      domain: "config",
      kind: "invalid_enum",
      message:
        "FEATURE_REVIEW_CADENCE=every_push is invalid with FEATURE_REVIEW=manual. Valid pairs are once with manual, auto, or approval, and every_push with auto or approval.",
      context: {
        name: ENV.FEATURE_REVIEW_CADENCE,
        allowed: [
          "once+manual",
          "once+auto",
          "once+approval",
          "every_push+auto",
          "every_push+approval",
        ],
      },
    });
  }
  return {
    review,
    reviewCadence,
    describe: readEnum(ENV.FEATURE_DESCRIBE, DESCRIBE_FEATURE_MODES, DEFAULT_FEATURE_DESCRIBE),
    verification: readEnum(
      ENV.FEATURE_VERIFICATION,
      VERIFICATION_FEATURE_MODES,
      DEFAULT_FEATURE_VERIFICATION,
    ),
    ask: readEnum(ENV.FEATURE_ASK, COMMAND_FEATURE_MODES, DEFAULT_FEATURE_ASK),
    triage: readEnum(ENV.FEATURE_TRIAGE, COMMAND_FEATURE_MODES, DEFAULT_FEATURE_TRIAGE),
    reviewLabels: readEnum(
      ENV.FEATURE_REVIEW_LABELS,
      REVIEW_LABELS_MODES,
      DEFAULT_FEATURE_REVIEW_LABELS,
    ),
    commitStatus: readStrictBoolean(ENV.FEATURE_COMMIT_STATUS, DEFAULT_FEATURE_COMMIT_STATUS),
    titleRewrite: readStrictBoolean(ENV.FEATURE_TITLE_REWRITE, DEFAULT_FEATURE_TITLE_REWRITE),
  } satisfies Features;
}
