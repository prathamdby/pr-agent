import { AppError } from "../errors/appError.js";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new AppError({
      domain: "config",
      kind: "missing_env",
      message: `Missing required environment variable: ${name}`,
      context: { name },
    });
  }
  return v;
}

export function setEnvNames(names: readonly string[]): string[] {
  return names.filter((name) => (process.env[name] ?? "") !== "");
}

export function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export function readPositiveNumber(name: string, defaultValue: number): number {
  const value = Number(optionalEnv(name, String(defaultValue)));
  if (!Number.isFinite(value) || value < 1) {
    throw new AppError({
      domain: "config",
      kind: "invalid_number",
      message: `${name} must be a positive number`,
      context: { name },
    });
  }
  return value;
}

export function readNonNegativeNumber(name: string, defaultValue: number): number {
  const value = Number(optionalEnv(name, String(defaultValue)));
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError({
      domain: "config",
      kind: "invalid_number",
      message: `${name} must be zero or a positive number`,
      context: { name },
    });
  }
  return value;
}

export function readPositiveInteger(name: string, defaultValue: number): number {
  const value = Number(optionalEnv(name, String(defaultValue)));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AppError({
      domain: "config",
      kind: "invalid_number",
      message: `${name} must be a positive integer`,
      context: { name },
    });
  }
  return value;
}

export function readNonNegativeInteger(name: string, defaultValue: number): number {
  const value = Number(optionalEnv(name, String(defaultValue)));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError({
      domain: "config",
      kind: "invalid_number",
      message: `${name} must be zero or a non-negative integer`,
      context: { name },
    });
  }
  return value;
}

export function readEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  defaultValue: T,
): T {
  const value = optionalEnv(name, defaultValue);
  const member = allowed.find((candidate) => candidate === value);
  if (member !== undefined) return member;
  throw new AppError({
    domain: "config",
    kind: "invalid_enum",
    message: `${name} must be one of ${allowed.join(", ")}`,
    context: { name, allowed },
  });
}

/**
 * Boolean env that rejects typos instead of silently reading them as false.
 * Empty or whitespace-only values fall back to the default (operator blank = unset).
 */
export function readStrictBoolean(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return defaultValue;
  }
  if (raw !== "true" && raw !== "false") {
    throw new AppError({
      domain: "config",
      kind: "invalid_enum",
      message: `${name} must be one of true, false`,
      context: { name, allowed: ["true", "false"] },
    });
  }
  return raw === "true";
}

/** `NODE_ENV` is read here so slice readers stay free of direct `process.env` access. */
export function isProductionNodeEnv(): boolean {
  return process.env.NODE_ENV === "production";
}
