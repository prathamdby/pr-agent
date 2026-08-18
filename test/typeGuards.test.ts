import { describe, expect, it } from "vitest";
import { isPlainObject, isRecord } from "../src/util/typeGuards.js";

class CustomRecord {
  readonly name = "x";
}

describe("isRecord", () => {
  it("accepts non-array objects including host and custom instances", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(new Date("2026-08-18T00:00:00.000Z"))).toBe(true);
    expect(isRecord(new Map())).toBe(true);
    expect(isRecord(new CustomRecord())).toBe(true);
  });

  it("rejects arrays, null, and primitives", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord("obj")).toBe(false);
    expect(isRecord(1)).toBe(false);
  });
});

describe("isPlainObject", () => {
  it("accepts object literals and null-prototype records", () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(Object.create(Object.prototype))).toBe(true);
  });

  it("rejects arrays, null, and primitives", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject("obj")).toBe(false);
    expect(isPlainObject(1)).toBe(false);
    expect(isPlainObject(true)).toBe(false);
  });

  it("rejects Date, Map, custom class instances, and inherited prototypes", () => {
    expect(isPlainObject(new Date("2026-08-18T00:00:00.000Z"))).toBe(false);
    expect(isPlainObject(new Map([["a", 1]]))).toBe(false);
    expect(isPlainObject(new CustomRecord())).toBe(false);
    expect(isPlainObject(Object.create({}))).toBe(false);
  });
});
