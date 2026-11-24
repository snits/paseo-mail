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
});
