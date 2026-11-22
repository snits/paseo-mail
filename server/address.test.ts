import { describe, expect, it } from "vitest";
import { HostBook, parseAddress } from "./address";
import { UserError, type HostDirectoryView, type HostEntry } from "./types";

describe("parseAddress (design step 5)", () => {
  // Wrong: normalizing the whole address before splitting (host lower-cased to "srv_entwlor9srmd");
  // leaving the local part as typed ("Probe").
  it("splits before normalizing: the name is normalized, the host part keeps its case", () => {
    expect(parseAddress(" Probe@srv_EntwLoR9srmD ")).toEqual({ kind: "name", local: "probe", host: "srv_EntwLoR9srmD" });
  });

  // Wrong: an absent host part read as "" instead of null.
  it("gives a null host part when there is no @", () => {
    expect(parseAddress(" Bob ")).toEqual({ kind: "name", local: "bob", host: null });
  });

  // Wrong: splitting on the last @ (local "a@b", host "c").
  it("splits on the first @", () => {
    expect(parseAddress("a@b@c")).toEqual({ kind: "name", local: "a", host: "b@c" });
  });

  // Wrong: keeping the "role:" prefix in the local part; the role left as typed ("QA").
  it("normalizes a role's local part", () => {
    expect(parseAddress("role:QA@m2-max")).toEqual({ kind: "role", local: "qa", host: "m2-max" });
  });

  // Wrong: normalizing an agent id like a name ("abc-id"); not trimming it (" Abc-ID").
  it("keeps an agent id's case and only trims it", () => {
    expect(parseAddress("agent: Abc-ID@srv_X")).toEqual({ kind: "agent", local: "Abc-ID", host: "srv_X" });
  });
});

/** Parses, then resolves the host part (if any) the way the mailer does: the error may come from either step. */
function route(book: HostBook, raw: string) {
  const parsed = parseAddress(raw);
  return parsed.host === null ? null : book.resolve(parsed.host);
}

const SELF = { serverId: "srv_Self01", label: "Cantor" };

function entry(serverId: string, label: string | null, enabled = true): HostEntry {
  return { serverId, label, enabled, online: true };
}

function book(...hosts: HostEntry[]): HostBook {
  const view: HostDirectoryView = { self: { ...SELF }, hosts };
  return new HostBook(view);
}

const remote = (serverId: string) => ({ kind: "remote", host: expect.objectContaining({ serverId }) });

describe("HostBook.resolve (design step 5)", () => {
  // Wrong: lower-casing the host part before the serverId compare, or comparing serverIds
  // case-insensitively: the lower-cased id then reaches the Mac.
  it("matches a linked serverId exactly, case included", () => {
    const hosts = book(entry("srv_EntwLoR9srmD", "m2-max"));
    expect(hosts.resolve("srv_EntwLoR9srmD")).toEqual(remote("srv_EntwLoR9srmD"));
    expect(() => hosts.resolve("srv_entwlor9srmd")).toThrow(UserError);
  });

  // Both sides differ from "m2-max" in case and whitespace. Wrong: normalizing only the typed side
  // (raw label " M2-Max " never matches); normalizing only the label; an exact compare.
  it("matches a label after trimming and lower-casing both the label and the host part", () => {
    expect(book(entry("srv_EntwLoR9srmD", " M2-Max ")).resolve(" m2-MAX ")).toEqual(remote("srv_EntwLoR9srmD"));
  });

  // Wrong: matching labels without the pattern check ("m2 max" reaches it).
  it("reaches a host whose label does not fit the pattern by serverId only", () => {
    const hosts = book(entry("srv_Spacey", "M2 Max"));
    expect(() => hosts.resolve("m2 max")).toThrow(UserError);
    expect(hosts.resolve("srv_Spacey")).toEqual(remote("srv_Spacey"));
  });

  // Wrong: label.trim() on a null label crashes the lookup of the valid label beside it; String(null)
  // makes "null" a label; dropping null-label entries loses their serverId.
  it("reaches a host with a null label by serverId only, and other labels still resolve", () => {
    const hosts = book(entry("srv_NoLabel", null), entry("srv_EntwLoR9srmD", "m2-max"));
    expect(hosts.resolve("m2-max")).toEqual(remote("srv_EntwLoR9srmD"));
    expect(hosts.resolve("srv_NoLabel")).toEqual(remote("srv_NoLabel"));
    expect(() => hosts.resolve("null")).toThrow(UserError);
  });

  // The two labels differ raw ("mac" vs " MAC ") and clash once normalized. Wrong: checking
  // uniqueness on raw labels (the first wins); first match wins without a uniqueness check.
  it("reaches neither host of a duplicate label by label, and both by serverId", () => {
    const hosts = book(entry("srv_MacA", "mac"), entry("srv_MacB", " MAC "));
    expect(() => hosts.resolve("mac")).toThrow(UserError);
    expect(hosts.resolve("srv_MacA")).toEqual(remote("srv_MacA"));
    expect(hosts.resolve("srv_MacB")).toEqual(remote("srv_MacB"));
  });

  // Own label "Cantor" normalizes to the linked label "cantor". Wrong: comparing the own label
  // raw (the linked host then wins); checking linked labels before the own label.
  it("resolves a linked label equal to the own label to this daemon; the linked host keeps its serverId", () => {
    const hosts = book(entry("srv_Twin", "cantor"));
    expect(hosts.resolve("cantor")).toEqual({ kind: "local" });
    expect(hosts.resolve("srv_Twin")).toEqual(remote("srv_Twin"));
  });

  // A disabled and an enabled entry share the label "attic". Wrong: ignoring `enabled` (the label
  // is then a duplicate and the disabled serverId resolves); filtering disabled entries only after
  // the uniqueness check (the enabled one stops resolving by label).
  it("ignores an enabled: false entry, by label and by serverId", () => {
    const hosts = book(entry("srv_Off", "attic", false), entry("srv_On", "attic"));
    expect(hosts.resolve("attic")).toEqual(remote("srv_On"));
    expect(() => hosts.resolve("srv_Off")).toThrow(UserError);
    // Positive control: the same entry enabled is reachable by its serverId.
    expect(book(entry("srv_Off", "attic")).resolve("srv_Off")).toEqual(remote("srv_Off"));
  });

  // Wrong: no own-host check (the own serverId is unknown, the own label typed in another case too).
  it("resolves the own serverId and the own label to this daemon", () => {
    const hosts = book(entry("srv_EntwLoR9srmD", "m2-max"));
    expect(hosts.resolve("srv_Self01")).toEqual({ kind: "local" });
    expect(hosts.resolve(" CANTOR ")).toEqual({ kind: "local" });
  });

  // Wrong: an unknown host part treated as local, or thrown as a plain Error.
  it("refuses an unknown host with a UserError", () => {
    expect(() => book(entry("srv_EntwLoR9srmD", "m2-max")).resolve("nowhere")).toThrow(UserError);
  });

  // Wrong: an empty host part read as "no host" (null), which routes "probe@" to a local name;
  // an empty local part accepted.
  it("refuses an address with an empty local part or an empty host part", () => {
    const hosts = book(entry("srv_EntwLoR9srmD", "m2-max"));
    expect(() => route(hosts, "@m2-max")).toThrow(UserError);
    expect(() => route(hosts, "probe@")).toThrow(UserError);
    // Positive control: with both parts present the address routes to the Mac.
    expect(route(hosts, "probe@m2-max")).toEqual(remote("srv_EntwLoR9srmD"));
  });
});

describe("HostBook.display (design step 10)", () => {
  // Wrong: returning the raw label (" M2-Max ", "M2 Max"); a label shown for a host it would not
  // resolve to (a duplicate, a non-matching label); "null" for a null label.
  it("shows the label address when the label reaches the host, else the serverId", () => {
    const hosts = book(
      entry("srv_EntwLoR9srmD", " M2-Max "),
      entry("srv_Spacey", "M2 Max"),
      entry("srv_NoLabel", null),
      entry("srv_MacA", "mac"),
      entry("srv_MacB", " MAC "),
    );
    expect(hosts.display("srv_EntwLoR9srmD")).toBe("m2-max");
    expect(hosts.display("srv_Spacey")).toBe("srv_Spacey");
    expect(hosts.display("srv_NoLabel")).toBe("srv_NoLabel");
    expect(hosts.display("srv_MacA")).toBe("srv_MacA");
    expect(hosts.display("srv_Unknown")).toBe("srv_Unknown");
  });
});
