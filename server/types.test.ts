import { describe, expect, it } from "vitest";
import { rejectionReason } from "./types";

describe("rejectionReason", () => {
  // String(error) includes the Error name, which is not part of its message.
  it("preserves an Error's message", () => {
    expect(rejectionReason(new Error("clear failed"))).toBe("clear failed");
  });

  // Reading .message throws on nullish values and loses a primitive's text.
  it.each([
    { reason: undefined, text: "undefined" },
    { reason: null, text: "null" },
    { reason: 42, text: "42" },
  ])("formats a non-Error rejection as $text", ({ reason, text }) => {
    expect(rejectionReason(reason)).toBe(text);
  });

  it.each([
    { name: "an object without a prototype", reason: () => Object.create(null) },
    { name: "a throwing toString", reason: () => ({ toString() { throw new Error("toString failed"); } }) },
    { name: "a throwing Symbol.toPrimitive", reason: () => ({ [Symbol.toPrimitive]() { throw new Error("coercion failed"); } }) },
    { name: "a proxy with a throwing getPrototypeOf", reason: () => new Proxy({}, {
      getPrototypeOf() { throw new Error("prototype lookup failed"); },
    }) },
  ])("returns the fallback for $name", ({ reason }) => {
    expect(rejectionReason(reason())).toBe("Unprintable rejection");
  });
});
