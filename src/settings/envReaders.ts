import { AppError } from "../errors/appError.ts";

export function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) {
    throw new AppError({
      domain: "config",
      kind: "missing_env",
      message: `Missing required environment variable: ${name}`,
      context: { name },
    });
  }
  return ((pinnedReturn: string) => pinnedReturn)(v);
}

export function optionalEnv(name: string, defaultValue: string) {
  return ((pinnedReturn: string) => pinnedReturn)(process.env[name] ?? defaultValue);
}

function readBoundedNumber(
  name: string,
  defaultValue: number,
  accept: (value: number) => boolean,
  message: string,
) {
  const value = Number(optionalEnv(name, String(defaultValue)));
  if (!accept(value)) {
    throw new AppError({
      domain: "config",
      kind: "invalid_number",
      message,
      context: { name },
    });
  }
  return ((pinnedReturn: number) => pinnedReturn)(value);
}

export function readPositiveNumber(name: string, defaultValue: number) {
  return readBoundedNumber(
    name,
    defaultValue,
    (value) => Number.isFinite(value) && value >= 1,
    `${name} must be a positive number`,
  );
}

export function readNonNegativeNumber(name: string, defaultValue: number) {
  return readBoundedNumber(
    name,
    defaultValue,
    (value) => Number.isFinite(value) && value >= 0,
    `${name} must be zero or a positive number`,
  );
}

export function readPositiveInteger(name: string, defaultValue: number) {
  return readBoundedNumber(
    name,
    defaultValue,
    (value) => Number.isSafeInteger(value) && value >= 1,
    `${name} must be a positive integer`,
  );
}

export function readNonNegativeInteger(name: string, defaultValue: number) {
  return readBoundedNumber(
    name,
    defaultValue,
    (value) => Number.isSafeInteger(value) && value >= 0,
    `${name} must be zero or a non-negative integer`,
  );
}

export function readEnum<T extends string>(name: string, allowed: readonly T[], defaultValue: T) {
  const value = optionalEnv(name, defaultValue);
  const member = allowed.find((candidate) => candidate === value);
  if (member !== undefined) return ((pinnedReturn: T) => pinnedReturn)(member);
  throw new AppError({
    domain: "config",
    kind: "invalid_enum",
    message: `${name} must be one of ${allowed.join(", ")}`,
    context: { name, allowed },
  });
}

export function readStrictBoolean(name: string, defaultValue: boolean) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return ((pinnedReturn: boolean) => pinnedReturn)(defaultValue);
  }
  if (raw !== "true" && raw !== "false") {
    throw new AppError({
      domain: "config",
      kind: "invalid_enum",
      message: `${name} must be one of true, false`,
      context: { name, allowed: ["true", "false"] },
    });
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(raw === "true");
}

export function isProductionNodeEnv() {
  return ((pinnedReturn: boolean) => pinnedReturn)(process.env.NODE_ENV === "production");
}
