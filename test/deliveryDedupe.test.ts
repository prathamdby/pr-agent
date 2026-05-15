import { describe, expect, it } from "vitest";
import { deliveryDedupeKey, isDuplicateDelivery } from "../src/deliveryDedupe.js";

describe("deliveryDedupeKey", () => {
	it("uses delivery id when present", () => {
		const body = Buffer.from('{"a":1}');
		expect(deliveryDedupeKey("abc-123", body)).toBe("abc-123");
	});

	it("falls back to body hash when delivery missing", () => {
		const body = Buffer.from('{"a":1}');
		const k = deliveryDedupeKey(undefined, body);
		expect(k.startsWith("body:")).toBe(true);
		expect(k.length).toBeGreaterThan(10);
	});
});

describe("isDuplicateDelivery", () => {
	it("returns false on first sight, true on same key", () => {
		const key = `test-dup-${Math.random()}`;
		expect(isDuplicateDelivery(key)).toBe(false);
		expect(isDuplicateDelivery(key)).toBe(true);
	});
});
