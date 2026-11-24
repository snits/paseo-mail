import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTIC, CANTOR, DROP_PREFIX, MAC, OUT_PREFIX, linkedHosts, mailOf, park, recordOf, reportHost, reversedKeys, setup, setupPair, toolContext, until, wait, type Env, type FakeNetwork, type FakePaseo } from "../test/fixtures";
import type { Mailer, MailerOptions } from "./mailer";
import { mailTools } from "./tools";
import type { Mail } from "./types";

// Task 6 of paseo-mail#xsbz: the importer (design step 8) and the two-daemon end-to-end cases
// (acceptance 8, 9 and 12). The archive-bounce half of step 9 is in mailer.test.ts.

/** The named idle nudge for one mail, written out here rather than read from nudgeText(). */
const NUDGE_ONE = "[paseo-mail] You have 1 unread mail. Call mail_list to see them.";

const mailers: Mailer[] = [];
/** The current test's daemons by serverId, so place() can write a drop's record on its claimed sender host. */
const daemons = new Map<string, FakePaseo>();
afterEach(async () => {
  vi.restoreAllMocks();
  daemons.clear();
  await Promise.all(mailers.splice(0).map((mailer) => mailer.dispose()));
});

/** cantor and the Mac, both started; "lead-id" lives on cantor, "probe-id" on the Mac, registered there as "probe". */
async function pairOf(options: MailerOptions = {}) {
  const pair = await setupPair({ debounceMs: 60_000, ...options });
  mailers.push(pair.cantor.mailer, pair.mac.mailer);
  daemons.set(CANTOR, pair.cantor.paseo).set(MAC, pair.mac.paseo);
  const lead = pair.cantor.paseo.add("lead-id", { title: "Lead" });
  const probe = pair.mac.paseo.add("probe-id", { title: "Probe" });
  await pair.mac.mailer.register(probe, { name: "probe" });
  return { ...pair, lead, probe };
}

/** As pairOf, but the Mac's Mailer is built and not started. */
async function macUnstarted() {
  const { network, cantorHost, macHost } = linkedHosts();
  const cantor = await setup({ debounceMs: 60_000 }, undefined, cantorHost);
  const mac = await setup({ debounceMs: 60_000 }, undefined, macHost);
  mailers.push(cantor.mailer, mac.mailer);
  daemons.set(CANTOR, cantor.paseo).set(MAC, mac.paseo);
  await cantor.mailer.start();
  cantor.paseo.add("lead-id", { title: "Lead" });
  mac.paseo.add("probe-id", { title: "Probe" });
  return { network, cantor, mac };
}

/** A mail from lead on cantor to probe on the Mac, as cantor's hand-off writes it into the drop. */
function dropped(id: string): Mail {
  return mailOf({ id, from: { agentId: "lead-id", name: "lead", title: "Lead", serverId: CANTOR }, to: { agentId: "probe-id", address: "probe@m2-max", serverId: MAC } });
}

/**
 * Writes a drop as its claimed sender host's hand-off would: the drop straight into the host's
 * metadata (no watcher fires, so only an import pass sees it) and, first, the matching record
 * (keyed by the value's id, naming this host and the holder) on the claimed sender agent. A value
 * with no string id, no sender agent, or a claimed host that is not one of this test's daemons gets
 * no record.
 */
function place(host: FakePaseo, agentId: string, mailId: string, value: unknown): void {
  const mail = value as Mail;
  const sender = typeof value === "object" && value !== null && typeof mail.id === "string" && typeof mail.from === "object" ? mail.from : null;
  const senderHost = typeof sender?.serverId === "string" ? daemons.get(sender.serverId) : undefined;
  if (senderHost && typeof sender?.agentId === "string") senderHost.setMetadata(sender.agentId, { [`${OUT_PREFIX}${mail.id}`]: recordOf(mail, host.self.serverId, agentId) });
  forge(host, agentId, mailId, value);
}

/** Writes only the drop, with no record anywhere: a drop its claimed sender host never handed off. */
function forge(host: FakePaseo, agentId: string, mailId: string, value: unknown): void {
  host.setMetadata(agentId, { [`${DROP_PREFIX}${mailId}`]: structuredClone(value) });
}

/** The hand-off record `paseo-mail.out.<mailId>` on a daemon's agent, or undefined. */
function recordOn(host: FakePaseo, agentId: string, mailId: string): unknown {
  return host.metadata.get(agentId)?.[`${OUT_PREFIX}${mailId}`];
}

/** Every hand-off record key on a daemon's agent. */
function outKeys(host: FakePaseo, agentId: string): string[] {
  return Object.keys(host.metadata.get(agentId) ?? {}).filter((key) => key.startsWith(OUT_PREFIX));
}

/** The clearHandOff calls the port recorded, as [serverId, agentId, mailId]. */
function recordClears(host: FakePaseo): unknown[][] {
  return host.calls.filter((call) => call.op === "clearHandOff").map((call) => call.args);
}

/** The lines a console.error spy logged, each call's arguments joined by spaces. */
function logLines(errors: { mock: { calls: unknown[][] } }): string[] {
  return errors.mock.calls.map((args) => args.map(String).join(" "));
}

function hasDrop(host: FakePaseo, agentId: string, mailId: string): boolean {
  return `${DROP_PREFIX}${mailId}` in (host.metadata.get(agentId) ?? {});
}

/** The clearDrop calls the port recorded, as [agentId, mailId]. */
function clears(host: FakePaseo): unknown[][] {
  return host.calls.filter((call) => call.op === "clearDrop").map((call) => call.args);
}

describe("importDrops: accept (design step 8)", () => {
  // The drop carries every stamp set, a stale to.agentId ("old-id"), to.serverId set, a padded
  // mixed-case address, and non-default thread fields. Wrong: to.agentId kept from the value (old-id);
  // to.serverId kept (MAC: the mail is not local, so in no inbox); to.address as typed, or
  // parseAddress().local ("probe"); any stamp kept; from.serverId dropped; a new id or thread.
  it("stores the drop with the listed rewrite and clears the key", async () => {
    const { mac } = await pairOf();
    const value: Mail = {
      ...dropped("m_100"),
      threadId: "m_090",
      inReplyTo: "m_090",
      to: { agentId: "old-id", address: "  Probe@M2-Max ", serverId: MAC },
      createdAt: "2026-11-20T08:00:00.000Z",
      readAt: "2026-11-22T10:01:00.000Z",
      nudgedAt: "2026-11-22T10:02:00.000Z",
      bouncedAt: "2026-11-22T10:03:00.000Z",
      seenAt: "2026-11-22T10:04:00.000Z",
      handedOffAt: "2026-11-22T10:05:00.000Z",
    };
    place(mac.paseo, "probe-id", "m_100", value);
    await mac.mailer.importDrops();
    expect(mac.store.get("m_100")).toEqual({
      id: "m_100",
      threadId: "m_090",
      inReplyTo: "m_090",
      from: { agentId: "lead-id", name: "lead", title: "Lead", serverId: CANTOR },
      to: { agentId: "probe-id", address: "Probe", serverId: null },
      subject: "subject m_100",
      body: "body m_100",
      createdAt: "2026-11-20T08:00:00.000Z",
      readAt: null,
      nudgedAt: null,
      bouncedAt: null,
      seenAt: null,
      handedOffAt: null,
    });
    expect(mac.mailer.list("probe-id").map((mail) => mail.id)).toEqual(["m_100"]);
    expect(hasDrop(mac.paseo, "probe-id", "m_100")).toBe(false);
    expect(clears(mac.paseo)).toEqual([["probe-id", "m_100"]]);
  });

  // A reply's address has no host part, or keeps "agent:<id>" before the "@". Ids are case-sensitive.
  // Wrong: parseAddress().local ("Anon-ID": the prefix lost); lower-casing ("agent:anon-id"); the
  // address untrimmed or with its host part; splitting on the last "@" ("Probe@M2-Max").
  it.each([
    { typed: "agent:Anon-ID", stored: "agent:Anon-ID" },
    { typed: " agent:Anon-ID@m2-max ", stored: "agent:Anon-ID" },
    { typed: "Probe@M2-Max@extra", stored: "Probe" },
  ])("rewrites to.address $typed to $stored", async ({ typed, stored }) => {
    const { mac } = await pairOf();
    place(mac.paseo, "probe-id", "m_100", { ...dropped("m_100"), to: { agentId: "probe-id", address: typed, serverId: MAC } });
    await mac.mailer.importDrops();
    expect(mac.store.get("m_100")?.to).toEqual({ agentId: "probe-id", address: stored, serverId: null });
  });

  // The value's to.agentId ("old-id") is not the holder. Wrong: storing without scheduling a nudge;
  // scheduling it for the value's to.agentId (none is sent to probe-id). The second, empty pass only
  // shows that nothing more arrives; the nudgedAt stamp would hold back a repeat anyway.
  it("nudges the recipient exactly once", async () => {
    const { mac } = await pairOf({ debounceMs: 5 });
    place(mac.paseo, "probe-id", "m_100", { ...dropped("m_100"), to: { agentId: "old-id", address: "probe@m2-max", serverId: MAC } });
    await mac.mailer.importDrops();
    expect(await until(() => mac.paseo.sent.length > 0)).toBe(true);
    await mac.mailer.importDrops();
    await wait(50);
    expect(mac.paseo.sent).toEqual([{ agentId: "probe-id", text: NUDGE_ONE }]);
  });

  // The fake lists drops on every agent, so the background case is a smoke check (the include
  // flags are Task 3's adapter tests). Wrong: skipping a holder a live lookup reports archived.
  // Wrong: storing the mail but scheduling its nudge only after the clear, so a clear that throws
  // leaves it un-nudged until something else schedules one.
  it("nudges a stored mail even when clearing its drop throws", async () => {
    const { mac } = await pairOf({ debounceMs: 5 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mac.paseo.clearDrop = () => Promise.reject(new Error("clear failed"));
    place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
    await mac.mailer.importDrops().catch(() => undefined);
    expect(mac.store.get("m_100")?.to.agentId).toBe("probe-id");
    expect(await until(() => mac.paseo.sent.length > 0)).toBe(true);
    expect(mac.paseo.sent).toEqual([{ agentId: "probe-id", text: NUDGE_ONE }]);
  });

  it("imports a drop held by an archived local agent and one held by a background agent", async () => {
    const { mac } = await pairOf();
    mac.paseo.add("arch-id");
    mac.paseo.archive("arch-id");
    mac.paseo.add("bg-id");
    mac.paseo.background("bg-id");
    place(mac.paseo, "arch-id", "m_101", dropped("m_101"));
    place(mac.paseo, "bg-id", "m_102", dropped("m_102"));
    await mac.mailer.importDrops();
    expect(mac.store.get("m_101")?.to.agentId).toBe("arch-id");
    expect(mac.store.get("m_102")?.to.agentId).toBe("bg-id");
    expect(hasDrop(mac.paseo, "arch-id", "m_101")).toBe(false);
    expect(hasDrop(mac.paseo, "bg-id", "m_102")).toBe(false);
  });
});

/** Every file under `root` (relative path → content), so a write anywhere in the data dir shows. */
async function filesUnder(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const full = path.join(root, name);
    if ((await stat(full)).isFile()) found[name] = await readFile(full, "utf8");
  }
  return found;
}

describe("importDrops: the mail id becomes a file name (lead ruling on the Task 6 review)", () => {
  // A drop's id is written as <store dir>/<id>.json, so only the shape newId() produces may pass:
  // /^m_[0-9a-z]{1,64}$/, written out here rather than read from production. The Mac's data dir
  // already holds registry.json (probe is registered) and the store dir. Wrong: no check (stored, or
  // a file written outside the store: ../registry overwrites registry.json); a check that parks
  // instead of clearing; a pattern missing one axis below.
  it.each([
    { axis: "wrong prefix", id: "x_abc" },
    { axis: "empty body", id: "m_" },
    { axis: "too long (65)", id: `m_${"a".repeat(65)}` },
    { axis: "upper-case prefix", id: "M_abc" },
    { axis: "upper-case body", id: "m_ABC" },
    { axis: "a dot in the body", id: "m_a.b" },
    { axis: "a slash in the body", id: "m_a/b" },
    { axis: "leading ../ before a good id", id: "../m_abc" },
    { axis: "leading ../ to registry", id: "../registry" },
    { axis: "trailing /..", id: "m_abc/.." },
    { axis: "surrounding whitespace", id: " m_abc" },
    { axis: "the reserved name", id: "mailboxes" },
    // Wrong: a multi-line pattern (the second line, m_abc, would match on its own).
    { axis: "a good id on a second line", id: "../registry\nm_abc" },
  ])("clears a drop whose id has $axis ($id), stores nothing and writes no file", async ({ id }) => {
    const { mac } = await pairOf();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = await filesUnder(mac.root);
    expect(Object.keys(before)).toContain("registry.json");
    place(mac.paseo, "probe-id", id, dropped(id));
    await mac.mailer.importDrops().catch(() => undefined);
    // Soft, so a red run shows every effect at once (cleared? stored? which file written?).
    expect.soft(clears(mac.paseo)).toEqual([["probe-id", id]]);
    expect.soft(hasDrop(mac.paseo, "probe-id", id)).toBe(false);
    expect.soft(mac.store.all()).toEqual([]);
    expect.soft(await filesUnder(mac.root)).toEqual(before);
  });

  // The drop's key is a good id; the mail it carries is not. Wrong: checking the key, not the value's
  // id (the mail is stored as ../registry.json, over registry.json).
  it("checks the value's id, not the drop's key", async () => {
    const { mac } = await pairOf();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = await filesUnder(mac.root);
    place(mac.paseo, "probe-id", "m_100", dropped("../registry"));
    await mac.mailer.importDrops().catch(() => undefined);
    expect.soft(clears(mac.paseo)).toEqual([["probe-id", "m_100"]]);
    expect.soft(mac.store.all()).toEqual([]);
    expect.soft(await filesUnder(mac.root)).toEqual(before);
  });

  // The id check comes before any host or peer lookup: a bad id can never be imported, whatever
  // the sender's host does. Wrong: checking it after the online check (parked while the host is
  // offline) or after the sender lookup.
  it("clears a bad id from an offline host without looking up its sender", async () => {
    const { network, mac } = await pairOf();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    network.setReachable(MAC, CANTOR, false);
    const before = await filesUnder(mac.root);
    place(mac.paseo, "probe-id", "../registry", dropped("../registry"));
    await mac.mailer.importDrops().catch(() => undefined);
    expect.soft(clears(mac.paseo)).toEqual([["probe-id", "../registry"]]);
    expect.soft(mac.paseo.calls.filter((call) => call.op === "peerAgent")).toEqual([]);
    expect.soft(mac.store.all()).toEqual([]);
    expect.soft(await filesUnder(mac.root)).toEqual(before);
  });

  // The ruling is "cleared and logged". Wrong: clearing it silently.
  it("logs a drop it clears for its id, naming the id", async () => {
    const { mac } = await pairOf();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    place(mac.paseo, "probe-id", "m_key", dropped("../registry"));
    await mac.mailer.importDrops().catch(() => undefined);
    const lines = errors.mock.calls.map((args) => args.map(String).join(" "));
    expect(lines.filter((line) => line.includes("[paseo-mail]") && line.includes("../registry"))).toHaveLength(1);
  });

  // Positive controls: the longest body the pattern allows, and an ordinary id. Each adds exactly
  // its own <id>.json in the store dir. Wrong: a bound of 63 or fewer (the 64 one cleared).
  it.each([
    { kind: "a 64-character body", id: `m_${"a".repeat(64)}` },
    { kind: "an ordinary id", id: "m_mi9x2k0000a1b2c3" },
  ])("imports a drop whose id is $kind", async ({ id }) => {
    const { mac } = await pairOf();
    const before = await filesUnder(mac.root);
    place(mac.paseo, "probe-id", id, dropped(id));
    await mac.mailer.importDrops();
    expect(mac.store.get(id)?.to.agentId).toBe("probe-id");
    const after = await filesUnder(mac.root);
    expect(Object.keys(after).filter((name) => !(name in before))).toEqual([path.join("mail", `${id}.json`)]);
  });

  // The id a sending daemon gives a mail must pass the receiver's check. Wrong: newId() and the
  // pattern drifting apart (every cross-host mail would be cleared on arrival).
  it("a mail this daemon sends has an id of that shape", async () => {
    const { cantor, lead } = await pairOf();
    const [delivery] = await cantor.mailer.send(lead, ["probe@m2-max"], "Ping", "x");
    expect(delivery!.mailId).toMatch(/^m_[0-9a-z]{1,64}$/);
  });
});

describe("importDrops: clear without storing (design step 8)", () => {
  // Wrong: parking a value that can never parse (the key stays); a parse error ending the pass first.
  it.each([
    { kind: "a string", value: "not a mail" },
    { kind: "an object missing fields", value: { id: "m_bad", from: { agentId: "lead-id" } } },
  ])("clears a drop whose value is $kind", async ({ value }) => {
    const { mac } = await pairOf();
    place(mac.paseo, "probe-id", "m_bad", value);
    await mac.mailer.importDrops();
    expect(clears(mac.paseo)).toEqual([["probe-id", "m_bad"]]);
    expect(hasDrop(mac.paseo, "probe-id", "m_bad")).toBe(false);
    expect(mac.store.all()).toEqual([]);
  });

  // Reading .message from an undefined rejection aborts the pass before the second clear.
  it("continues clearing malformed drops after a clear rejects without a reason", async () => {
    const { mac } = await pairOf();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    place(mac.paseo, "probe-id", "m_first", "not a mail");
    place(mac.paseo, "probe-id", "m_second", "not a mail");
    const clear = mac.paseo.clearDrop.bind(mac.paseo);
    mac.paseo.clearDrop = (agentId, mailId) =>
      mailId === "m_first" ? Promise.reject() : clear(agentId, mailId);

    const [pass] = await Promise.allSettled([mac.mailer.importDrops()]);
    expect.soft(hasDrop(mac.paseo, "probe-id", "m_first")).toBe(true);
    expect.soft(hasDrop(mac.paseo, "probe-id", "m_second")).toBe(false);
    expect.soft(mac.store.all()).toEqual([]);
    expect.soft(pass?.status).toBe("fulfilled");
    expect(errors).toHaveBeenCalledWith(
      "[paseo-mail] importing mail m_first on probe-id failed; it stays for the next pass:",
      "undefined",
    );
  });

  // No directory entry has srv_Nowhere. Wrong: parking it as a host that is not online (key stays);
  // storing it with no host check.
  it("clears a drop whose sender's host is in no directory entry", async () => {
    const { mac } = await pairOf();
    place(mac.paseo, "probe-id", "m_100", { ...dropped("m_100"), from: { agentId: "lead-id", name: "lead", title: "Lead", serverId: "srv_Nowhere" } });
    await mac.mailer.importDrops();
    expect(clears(mac.paseo)).toEqual([["probe-id", "m_100"]]);
    expect(mac.store.all()).toEqual([]);
  });

  // m_ghost's sender does not exist on cantor; m_old's sender is archived there (fine: accepted).
  // Wrong: no sender lookup (m_ghost stored); parking a missing sender (m_ghost's key stays);
  // treating archived as missing (m_old cleared unstored). place() leaves a matching record of
  // m_ghost on cantor, so only the lookup rules it out. Wrong (paseo-mail#qkf2): checking the
  // record before the sender exists (the line gives "no matching hand-off record" as the reason).
  it("clears a drop whose sender does not exist on its host, and accepts one whose sender is archived", async () => {
    const { cantor, mac } = await pairOf();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    cantor.paseo.add("old-id");
    cantor.paseo.archive("old-id");
    place(mac.paseo, "probe-id", "m_ghost", { ...dropped("m_ghost"), from: { agentId: "ghost-id", name: "ghost", title: null, serverId: CANTOR } });
    place(mac.paseo, "probe-id", "m_old", { ...dropped("m_old"), from: { agentId: "old-id", name: "old", title: null, serverId: CANTOR } });
    await mac.mailer.importDrops();
    const ghostLines = logLines(errors).filter((line) => line.includes("m_ghost"));
    expect(ghostLines).toHaveLength(1);
    expect(ghostLines[0]).toContain("does not exist");
    expect(mac.store.get("m_ghost")).toBeUndefined();
    expect(hasDrop(mac.paseo, "probe-id", "m_ghost")).toBe(false);
    expect(mac.store.get("m_old")?.from).toEqual({ agentId: "old-id", name: "old", title: null, serverId: CANTOR });
    expect(hasDrop(mac.paseo, "probe-id", "m_old")).toBe(false);
  });

  // A drop with no sender agent can never be checked. Wrong: parking it (the key stays for ever).
  it("clears a drop whose from.agentId is null", async () => {
    const { mac } = await pairOf();
    place(mac.paseo, "probe-id", "m_100", { ...dropped("m_100"), from: { agentId: null, name: "paseo-mail", title: null, serverId: CANTOR } });
    await mac.mailer.importDrops();
    expect(clears(mac.paseo)).toEqual([["probe-id", "m_100"]]);
    expect(mac.store.all()).toEqual([]);
  });

  // The holder is archived and the sender missing on cantor. Wrong: an archived holder skipping the
  // sender check (stored).
  it("clears a drop on an archived holder whose sender does not exist on its host", async () => {
    const { mac } = await pairOf();
    mac.paseo.add("arch-id");
    mac.paseo.archive("arch-id");
    place(mac.paseo, "arch-id", "m_ghost", { ...dropped("m_ghost"), from: { agentId: "ghost-id", name: "ghost", title: null, serverId: CANTOR } });
    await mac.mailer.importDrops();
    expect(clears(mac.paseo)).toEqual([["arch-id", "m_ghost"]]);
    expect(mac.store.all()).toEqual([]);
  });
});

describe("importDrops: park (design step 8)", () => {
  // The sender (lead-id) is live on cantor in every case, and only the Mac's directory or the lookup
  // rules it out. Each arrangement returns its undo; undone, the next pass imports (positive control).
  // Wrong, disabled: ignoring `enabled` (accepted); treating a disabled entry as absent (cleared).
  // Wrong, offline: ignoring `online` (the lookup succeeds, accepted). Wrong, lookup throws: folding the
  // error into "missing" (cleared). The two directory cases also catch a pass that reads the start()
  // snapshot (which lists cantor enabled and online).
  const parkCases: { why: string; arrange: (env: { network: FakeNetwork; mac: FakePaseo }) => () => void }[] = [
    { why: "the directory lists the sender's host disabled (though online)", arrange: ({ mac }) => reportHost(mac, CANTOR, { enabled: false, online: true }) },
    { why: "the directory lists the sender's host offline (though reachable)", arrange: ({ mac }) => reportHost(mac, CANTOR, { online: false }) },
    {
      why: "the peerAgent lookup throws",
      arrange: ({ network }) => {
        network.fault(CANTOR, "peerAgent", true);
        return () => network.fault(CANTOR, "peerAgent", false);
      },
    },
  ];
  it.each(parkCases)("parks the drop when $why", async ({ arrange }) => {
    const { network, mac } = await pairOf();
    place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
    const undo = arrange({ network, mac: mac.paseo });
    await mac.mailer.importDrops().catch(() => undefined);
    expect(hasDrop(mac.paseo, "probe-id", "m_100")).toBe(true);
    expect(clears(mac.paseo)).toEqual([]);
    expect(mac.store.all()).toEqual([]);
    undo();
    await mac.mailer.importDrops();
    expect(mac.store.get("m_100")?.to.agentId).toBe("probe-id");
    expect(hasDrop(mac.paseo, "probe-id", "m_100")).toBe(false);
  });

  // paseo-mail#qkf2. The directory lists cantor disabled, though the network still reaches it. m_200
  // is forged (no record) and m_201 a duplicate (already stored, record on cantor): neither waits on
  // a record to be decided. Wrong: the park check after the sender lookup, the record check or the
  // duplicate check (a peerAgent call; m_200 cleared unstored; m_201 and its record cleared).
  // Positive control: with cantor enabled again, the next pass clears both, and m_201's record.
  it("parks a forged and a duplicate drop from a disabled host without looking up their sender", async () => {
    const { cantor, mac } = await pairOf();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mac.store.create({ ...dropped("m_201"), to: { agentId: "probe-id", address: "probe", serverId: null } });
    forge(mac.paseo, "probe-id", "m_200", dropped("m_200"));
    place(mac.paseo, "probe-id", "m_201", dropped("m_201"));
    const undo = reportHost(mac.paseo, CANTOR, { enabled: false, online: true });
    const mark = mac.paseo.calls.length;
    await mac.mailer.importDrops().catch(() => undefined);
    const ops = mac.paseo.calls.slice(mark).map((call) => call.op);
    expect.soft(ops.filter((op) => op === "peerAgent" || op === "clearHandOff" || op === "clearDrop")).toEqual([]);
    expect.soft(hasDrop(mac.paseo, "probe-id", "m_200")).toBe(true);
    expect.soft(hasDrop(mac.paseo, "probe-id", "m_201")).toBe(true);
    expect.soft(recordOn(cantor.paseo, "lead-id", "m_201")).toBeDefined();
    undo();
    await mac.mailer.importDrops();
    expect(hasDrop(mac.paseo, "probe-id", "m_200")).toBe(false);
    expect(hasDrop(mac.paseo, "probe-id", "m_201")).toBe(false);
    expect(recordOn(cantor.paseo, "lead-id", "m_201")).toBeUndefined();
    expect(mac.store.all().map((mail) => mail.id)).toEqual(["m_201"]);
  });

  // An unparsable drop sits beside a good one. Whether the pass resolves or rejects is not pinned.
  // Wrong: falling back to the start() snapshot (m_100 stored); clearing the unparsable drop before
  // the directory read (m_bad cleared).
  it("does nothing when the directory read at the start of the pass throws", async () => {
    const { mac } = await pairOf();
    place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
    place(mac.paseo, "probe-id", "m_bad", "not a mail");
    const directory = mac.paseo.hostDirectory.bind(mac.paseo);
    mac.paseo.hostDirectory = async () => Promise.reject(new Error("directory down"));
    await mac.mailer.importDrops().catch(() => undefined);
    expect(clears(mac.paseo)).toEqual([]);
    expect(hasDrop(mac.paseo, "probe-id", "m_100")).toBe(true);
    expect(hasDrop(mac.paseo, "probe-id", "m_bad")).toBe(true);
    expect(mac.store.all()).toEqual([]);
    // Positive control: with the directory back, the next pass imports one and clears both.
    mac.paseo.hostDirectory = directory;
    await mac.mailer.importDrops();
    expect(mac.store.all().map((mail) => mail.id)).toEqual(["m_100"]);
    expect(hasDrop(mac.paseo, "probe-id", "m_100")).toBe(false);
    expect(hasDrop(mac.paseo, "probe-id", "m_bad")).toBe(false);
  });

  // Two drops on one agent: m_001 (placed first, so listed first) waits or fails, m_002 from cantor
  // is fine. m_001 comes from a third host, the attic, except in the create row. Wrong: the first
  // parked or failed drop ending the pass (m_002 not stored).
  const firstStuck: { why: string; arrange: (env: { network: FakeNetwork; mac: Env }) => string }[] = [
    {
      why: "its sender's host is offline",
      arrange: ({ network }) => {
        network.setReachable(MAC, ATTIC, false);
        return ATTIC;
      },
    },
    {
      why: "its sender lookup throws",
      arrange: ({ network }) => {
        network.fault(ATTIC, "peerAgent", true);
        return ATTIC;
      },
    },
    {
      why: "its create throws",
      arrange: ({ mac }) => {
        const create = mac.store.create.bind(mac.store);
        mac.store.create = (mail) => (mail.id === "m_001" ? Promise.reject(new Error("disk full")) : create(mail));
        return CANTOR;
      },
    },
  ];
  it.each(firstStuck)("a drop that stays because $why does not hold back the next one", async ({ arrange }) => {
    const { network, mac } = await pairOf();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    network.host(ATTIC, "attic").add("keeper-id");
    network.link(MAC, ATTIC, { label: "attic" });
    const sender = arrange({ network, mac });
    const from = sender === ATTIC ? { agentId: "keeper-id", name: "keeper", title: null, serverId: ATTIC } : dropped("m_001").from;
    place(mac.paseo, "probe-id", "m_001", { ...dropped("m_001"), from });
    place(mac.paseo, "probe-id", "m_002", dropped("m_002"));
    await mac.mailer.importDrops().catch(() => undefined);
    expect(hasDrop(mac.paseo, "probe-id", "m_001")).toBe(true);
    expect(mac.store.get("m_001")).toBeUndefined();
    expect(mac.store.get("m_002")?.to.agentId).toBe("probe-id");
    expect(hasDrop(mac.paseo, "probe-id", "m_002")).toBe(false);
  });
});

describe("importDrops: duplicate vs failure (design step 8)", () => {
  // The same drop arrives twice; probe read the first copy in between. Wrong: no store.get check
  // (create throws "already exists", so the second drop parks for ever); overwriting the stored mail
  // (readAt back to null); storing a second copy. The value's to.agentId ("old-id") is not the
  // holder. Wrong: clearing the duplicate on the value's to.agentId (probe-id's key stays).
  it("clears a duplicate drop and stores one mail", async () => {
    const { mac } = await pairOf();
    const value = { ...dropped("m_100"), to: { agentId: "old-id", address: "probe@m2-max", serverId: MAC } };
    place(mac.paseo, "probe-id", "m_100", value);
    await mac.mailer.importDrops();
    const read = await mac.mailer.read("probe-id", "m_100");
    expect(read.readAt).not.toBeNull();
    place(mac.paseo, "probe-id", "m_100", value);
    await mac.mailer.importDrops();
    expect(hasDrop(mac.paseo, "probe-id", "m_100")).toBe(false);
    expect(clears(mac.paseo)).toEqual([
      ["probe-id", "m_100"],
      ["probe-id", "m_100"],
    ]);
    expect(mac.store.all()).toEqual([read]);
  });

  // Wrong: clearing the drop anyway, or before create; treating every create error as a duplicate;
  // failing silently. Whether the pass resolves or rejects is not pinned.
  it("parks the drop and logs when create throws", async () => {
    const { mac } = await pairOf();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const create = mac.store.create.bind(mac.store);
    mac.store.create = () => Promise.reject(new Error("disk full"));
    place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
    const mark = errors.mock.calls.length;
    await mac.mailer.importDrops().catch(() => undefined);
    expect(hasDrop(mac.paseo, "probe-id", "m_100")).toBe(true);
    expect(clears(mac.paseo)).toEqual([]);
    expect(errors.mock.calls.slice(mark).some((args) => String(args[0]).includes("[paseo-mail]"))).toBe(true);
    // Positive control: with create working, the next pass imports and clears it.
    mac.store.create = create;
    await mac.mailer.importDrops();
    expect(mac.store.get("m_100")?.to.agentId).toBe("probe-id");
    expect(hasDrop(mac.paseo, "probe-id", "m_100")).toBe(false);
  });

  // Only setTimeout is faked (the nudge debounce; the sweep is a real setInterval), so I/O and
  // promises stay real. Wrong: the duplicate branch scheduling a nudge too (a debounce timer armed).
  // Positive control: the first, fresh drop arms one.
  it("a duplicate drop schedules no nudge", async () => {
    const { mac } = await pairOf();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      expect(vi.getTimerCount()).toBe(0);
      place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
      await mac.mailer.importDrops();
      expect(vi.getTimerCount()).toBe(1);
      vi.clearAllTimers();
      place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
      await mac.mailer.importDrops();
      expect(hasDrop(mac.paseo, "probe-id", "m_100")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // The drop's key says m_key; its value is mail m_100, already stored. Wrong: the duplicate check
  // on the key's id (create("m_100") throws and the drop parks); clearing by the value's id.
  // place() records m_100 again on cantor, under the value's id. Wrong (paseo-mail#qkf2): looking the
  // record up, or clearing it, by the key's id (m_100's record stays on cantor).
  it("checks a duplicate by the value's id and clears the drop by its key", async () => {
    const { cantor, mac } = await pairOf();
    place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
    await mac.mailer.importDrops();
    const mark = recordClears(mac.paseo).length;
    place(mac.paseo, "probe-id", "m_key", dropped("m_100"));
    await mac.mailer.importDrops();
    expect(clears(mac.paseo)).toEqual([
      ["probe-id", "m_100"],
      ["probe-id", "m_key"],
    ]);
    expect(hasDrop(mac.paseo, "probe-id", "m_key")).toBe(false);
    expect(mac.store.all().map((mail) => mail.id)).toEqual(["m_100"]);
    expect(recordClears(mac.paseo).slice(mark)).toEqual([[CANTOR, "lead-id", "m_100"]]);
    expect(recordOn(cantor.paseo, "lead-id", "m_100")).toBeUndefined();
  });

  // paseo-mail#qkf2. A fresh drop whose key (m_key) is not its mail's id (m_100); cantor holds the
  // record of m_100. Wrong: looking the record up by the key's id (cleared unstored); clearing it
  // by the key's id (m_100's record stays on cantor).
  it("confirms and clears a fresh drop's record by the value's id, not the drop's key", async () => {
    const { cantor, mac } = await pairOf();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    place(mac.paseo, "probe-id", "m_key", dropped("m_100"));
    await mac.mailer.importDrops();
    expect(mac.store.get("m_100")?.to.agentId).toBe("probe-id");
    expect(recordClears(mac.paseo)).toEqual([[CANTOR, "lead-id", "m_100"]]);
    expect(recordOn(cantor.paseo, "lead-id", "m_100")).toBeUndefined();
    expect(hasDrop(mac.paseo, "probe-id", "m_key")).toBe(false);
  });

  // A known mail from a host now offline still waits like any other drop from it. Wrong: the
  // duplicate check before the park checks (cleared). Positive control: online again, it is cleared.
  it("parks a duplicate drop while its sender's host is offline", async () => {
    const { network, mac } = await pairOf();
    place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
    await mac.mailer.importDrops();
    place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
    network.setReachable(MAC, CANTOR, false);
    await mac.mailer.importDrops().catch(() => undefined);
    expect(hasDrop(mac.paseo, "probe-id", "m_100")).toBe(true);
    expect(clears(mac.paseo)).toHaveLength(1);
    network.setReachable(MAC, CANTOR, true);
    await mac.mailer.importDrops();
    expect(hasDrop(mac.paseo, "probe-id", "m_100")).toBe(false);
    expect(mac.store.all()).toHaveLength(1);
  });

  // Two passes started together on one drop. Wrong: passes not serialized (both list the drop and
  // look up its sender; the second create throws "already exists").
  it("serializes passes: two concurrent imports handle a drop once", async () => {
    const { mac } = await pairOf();
    place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
    const mark = mac.paseo.calls.length;
    await Promise.all([mac.mailer.importDrops(), mac.mailer.importDrops()]);
    const calls = mac.paseo.calls.slice(mark);
    expect(calls.filter((call) => call.op === "peerAgent")).toHaveLength(1);
    expect(calls.filter((call) => call.op === "clearDrop")).toHaveLength(1);
    expect(mac.store.all().map((mail) => mail.id)).toEqual(["m_100"]);
  });

  // Wrong: a pass that swallows a localDrops() throw (resolves as if there were no drops).
  it("rejects when listing the local drops throws", async () => {
    const { mac } = await pairOf();
    mac.paseo.localDrops = () => Promise.reject(new Error("list down"));
    await expect(mac.mailer.importDrops()).rejects.toThrow("list down");
  });

  // Pass 1 parks after listing m_001; m_002 lands and a second pass is queued; dispose() runs before
  // pass 1 goes on. m_002 comes from lead2-id, so a queued pass that ran anyway shows as a lookup of
  // lead2-id, a clear of m_002's record on cantor, or a clear of its drop. Wrong: a pass that does
  // not check for dispose() when it starts.
  // Positive control: the same sequence without dispose() handles m_002.
  it.each([true, false])("a pass queued before dispose() makes no peer call or clear once dispose() has run (disposed: %s)", async (disposing) => {
    const { cantor, mac } = await pairOf();
    cantor.paseo.add("lead2-id");
    place(mac.paseo, "probe-id", "m_001", dropped("m_001"));
    const listing = park(mac.paseo, "localDrops", { after: true });
    const first = mac.mailer.importDrops().catch(() => undefined);
    try {
      expect(await until(() => listing.parked === 1)).toBe(true);
      place(mac.paseo, "probe-id", "m_002", { ...dropped("m_002"), from: { agentId: "lead2-id", name: "lead2", title: null, serverId: CANTOR } });
      const second = mac.mailer.importDrops().catch(() => undefined);
      const disposed = disposing ? mac.mailer.dispose() : Promise.resolve();
      listing.open();
      await Promise.all([first, second, disposed]);
    } finally {
      listing.open();
    }
    const aboutM002 = mac.paseo.calls.filter((call) => (call.op === "peerAgent" && call.args[1] === "lead2-id") || (call.op === "clearHandOff" && call.args[2] === "m_002") || (call.op === "clearDrop" && call.args[1] === "m_002"));
    if (disposing) expect(aboutM002).toEqual([]);
    else expect(aboutM002.map((call) => call.op)).toEqual(["peerAgent", "clearHandOff", "clearDrop"]);
  });

  // The pass is parked in its lookup of m_001's sender when dispose() runs; the test opens the gate.
  // The pass is queued after start() returns. Wrong: dispose() as at 14b5e87a68b6 (resolves at once,
  // and the pass stores m_001 and clears its drop afterwards); awaiting only the hand-off queue;
  // awaiting an imports idle() taken before the pass was queued (it resolves at once). Positive
  // control: once the gate opens, dispose() resolves.
  it("dispose() waits for an import pass in flight, so nothing is stored or cleared after it resolves", async () => {
    const { mac } = await pairOf();
    place(mac.paseo, "probe-id", "m_001", dropped("m_001"));
    const lookup = park(mac.paseo, "peerAgent");
    const events: string[] = [];
    const create = mac.store.create.bind(mac.store);
    mac.store.create = (mail) => {
      events.push("create");
      return create(mail);
    };
    const clear = mac.paseo.clearDrop.bind(mac.paseo);
    mac.paseo.clearDrop = (agentId, mailId) => {
      events.push("clear");
      return clear(agentId, mailId);
    };
    try {
      const pass = mac.mailer.importDrops().catch(() => undefined);
      expect(await until(() => lookup.parked === 1)).toBe(true);
      const disposed = mac.mailer.dispose().then(() => {
        events.push("disposed");
      });
      expect(await Promise.race([disposed.then(() => "resolved"), wait(100).then(() => "pending")])).toBe("pending");
      lookup.open();
      expect(await Promise.race([disposed.then(() => "resolved"), wait(1000).then(() => "pending")])).toBe("resolved");
      await pass;
      expect(events).toEqual(["create", "clear", "disposed"]);
    } finally {
      lookup.open();
    }
  });

  // The pass is parked in its lookup of m_001's sender behind a gate that only release() settles: it
  // rejects the call, as the SDK rejects a closed client's calls in flight. The test never opens it.
  // Wrong: dispose() awaiting the queues before release() (it waits on a call only release() can
  // end; in production, the SDK's 60 s request deadline). The failed lookup leaves the drop in place.
  it("dispose() releases the port before it waits, so a parked lookup ends and the pass writes nothing", async () => {
    const { mac } = await pairOf();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    place(mac.paseo, "probe-id", "m_001", dropped("m_001"));
    const lookup = park(mac.paseo, "peerAgent", { refuseOnRelease: new Error("client closed") });
    try {
      const pass = mac.mailer.importDrops().catch(() => undefined);
      expect(await until(() => lookup.parked === 1)).toBe(true);
      const disposed = mac.mailer.dispose();
      expect(await Promise.race([disposed.then(() => "resolved"), wait(1000).then(() => "pending")])).toBe("resolved");
      await pass;
      expect(mac.store.get("m_001")).toBeUndefined();
      expect(hasDrop(mac.paseo, "probe-id", "m_001")).toBe(true);
      expect(clears(mac.paseo)).toEqual([]);
      expect(errors.mock.calls).toEqual([["[paseo-mail] importing mail m_001 on probe-id failed; it stays for the next pass:", "client closed"]]);
    } finally {
      lookup.refuse(new Error("test over"));
    }
  });

  // The pass is parked in its lookup of m_001's sender when dispose() runs; the test opens the gate.
  // store.close() only waits for the store's own queue and refuses no later write, so the log records
  // each call when it is made. Wrong: closing the store alongside the queue wait (a Promise.all of
  // release(), idle() and close()); dispose() as at 14b5e87a68b6. Both log the close before the create.
  it("dispose() closes the store only after an import pass in flight has stored its mail", async () => {
    const { mac } = await pairOf();
    place(mac.paseo, "probe-id", "m_001", dropped("m_001"));
    const lookup = park(mac.paseo, "peerAgent");
    const events: string[] = [];
    const create = mac.store.create.bind(mac.store);
    mac.store.create = (mail) => {
      events.push("create");
      return create(mail);
    };
    const close = mac.store.close.bind(mac.store);
    mac.store.close = () => {
      events.push("close");
      return close();
    };
    try {
      const pass = mac.mailer.importDrops().catch(() => undefined);
      expect(await until(() => lookup.parked === 1)).toBe(true);
      const disposed = mac.mailer.dispose();
      lookup.open();
      await pass;
      await disposed;
      expect(events).toEqual(["create", "close"]);
    } finally {
      lookup.open();
    }
  });

  // release() is parked on a test gate (the port's real release() waits for the peer clients to
  // close), and an import is called meanwhile with a valid drop waiting. Wrong: dispose() marking
  // itself disposed only after release() resolves (the pass starts, looks up the sender, stores
  // m_001 and clears its record on cantor and its drop). Positive control: the same import without
  // dispose() does all four.
  it.each([true, false])("an import called while dispose() awaits release() makes no peer call, store or clear (disposed: %s)", async (disposing) => {
    const { mac } = await pairOf();
    place(mac.paseo, "probe-id", "m_001", dropped("m_001"));
    const releasing = park(mac.paseo, "release");
    const creates: string[] = [];
    const create = mac.store.create.bind(mac.store);
    mac.store.create = (mail) => {
      creates.push(mail.id);
      return create(mail);
    };
    const mark = mac.paseo.calls.length;
    try {
      const disposed = disposing ? mac.mailer.dispose() : Promise.resolve();
      if (disposing) expect(await until(() => releasing.parked === 1)).toBe(true);
      const imported = mac.mailer.importDrops().catch(() => undefined);
      expect(await Promise.race([imported.then(() => "settled"), wait(1000).then(() => "pending")])).toBe("settled");
      releasing.open();
      await disposed;
      const ops = mac.paseo.calls
        .slice(mark)
        .map((call) => call.op)
        .filter((op) => op === "peerAgent" || op === "clearHandOff" || op === "clearDrop");
      if (disposing) {
        expect(ops).toEqual([]);
        expect(creates).toEqual([]);
      } else {
        expect(ops).toEqual(["peerAgent", "clearHandOff", "clearDrop"]);
        expect(creates).toEqual(["m_001"]);
      }
    } finally {
      releasing.open();
    }
  });

  // The Mac's hand-off of m_050 (probe to lead on cantor) is parked on its write when a drop from
  // lead lands. Wrong: one queue for hand-offs and imports (the import waits behind the parked write).
  // Positive control: once the write is released, the hand-off stamps m_050.
  it("an import pass does not wait behind a hand-off pass parked on its write", async () => {
    const { mac } = await pairOf();
    await mac.store.create(mailOf({ id: "m_050", from: { agentId: "probe-id", name: "probe", title: "Probe", serverId: null }, to: { agentId: "lead-id", address: "lead@cantor", serverId: CANTOR } }));
    place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
    const write = park(mac.paseo, "writeDrop");
    try {
      const handOff = mac.mailer.flushOutbox().catch(() => undefined);
      expect(await until(() => write.parked === 1)).toBe(true);
      const imported = mac.mailer.importDrops().catch(() => undefined);
      expect(await Promise.race([imported.then(() => "settled"), wait(1000).then(() => "pending")])).toBe("settled");
      expect(mac.store.get("m_100")?.to.agentId).toBe("probe-id");
      expect(hasDrop(mac.paseo, "probe-id", "m_100")).toBe(false);
      expect(mac.store.get("m_050")?.handedOffAt).toBeNull();
      write.open();
      await handOff;
      expect(mac.store.get("m_050")?.handedOffAt).not.toBeNull();
    } finally {
      write.open();
    }
  });
});

// paseo-mail#qkf2 Task 2: the importer stores a drop only when its claimed sender host holds a
// matching hand-off record (design "Import order", acceptance 3-7). In every test the holder is
// probe-id on the Mac and the claimed sender lead-id on cantor.

describe("importDrops: the claimed sender host confirms the hand-off (paseo-mail#qkf2)", () => {
  // A raw write puts a drop on probe claiming lead on cantor; cantor holds no record of it, and a
  // record that would match sits on the holder instead. Wrong: no record check (stored and nudged);
  // reading the record from the holder (stored); parking it (the drop stays); clearing it silently
  // (no line naming m_300 and cantor); asking cantor to clear a record it never held (a clearHandOff
  // call). Positive control: the same mail placed with its record on cantor imports and nudges.
  it("clears a drop its claimed sender host holds no record of, unstored, logged, and nudges nobody", async () => {
    const { cantor, mac } = await pairOf({ debounceMs: 5 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mail = dropped("m_300");
    forge(mac.paseo, "probe-id", "m_300", mail);
    mac.paseo.setMetadata("probe-id", { [`${OUT_PREFIX}m_300`]: recordOf(mail, MAC, "probe-id") });
    await mac.mailer.importDrops();
    await wait(50);
    expect.soft(mac.store.all()).toEqual([]);
    expect.soft(hasDrop(mac.paseo, "probe-id", "m_300")).toBe(false);
    expect.soft(clears(mac.paseo)).toEqual([["probe-id", "m_300"]]);
    expect.soft(recordClears(mac.paseo)).toEqual([]);
    expect.soft(outKeys(cantor.paseo, "lead-id")).toEqual([]);
    expect.soft(mac.paseo.sent).toEqual([]);
    expect.soft(logLines(errors).filter((line) => line.includes("[paseo-mail]") && line.includes("m_300") && line.includes(CANTOR))).toHaveLength(1);
    place(mac.paseo, "probe-id", "m_300", mail);
    await mac.mailer.importDrops();
    expect(mac.store.get("m_300")?.to.agentId).toBe("probe-id");
    expect(await until(() => mac.paseo.sent.length > 0)).toBe(true);
  });

  // The attic (linked both ways with the Mac) writes the drop through its own writeDrop, so the Mac's
  // watcher fires, after recording the hand-off on its own lead-id as a genuine attic hand-off would.
  // The drop claims lead on cantor, which holds nothing. Wrong: accepting a record held by any linked
  // host, or by a host that has an agent of the sender's id (stored); no record check. Positive
  // control: the same mail placed with its record on cantor imports.
  it("clears a drop a third host wrote claiming cantor's sender, though the third host holds a matching record", async () => {
    const { network, cantor, mac } = await pairOf({ debounceMs: 5 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const attic = network.host(ATTIC, "attic");
    attic.add("lead-id", { title: "Lead" });
    network.link(ATTIC, MAC, { label: "m2-max" });
    network.link(MAC, ATTIC, { label: "attic" });
    const mail = dropped("m_301");
    await attic.recordHandOff("lead-id", "m_301", recordOf(mail, MAC, "probe-id"));
    await attic.writeDrop(MAC, "probe-id", mail);
    await mac.mailer.importDrops();
    await wait(50);
    expect.soft(mac.store.all()).toEqual([]);
    expect.soft(hasDrop(mac.paseo, "probe-id", "m_301")).toBe(false);
    expect.soft(recordClears(mac.paseo)).toEqual([]);
    expect.soft(outKeys(cantor.paseo, "lead-id")).toEqual([]);
    expect.soft(mac.paseo.sent).toEqual([]);
    place(mac.paseo, "probe-id", "m_301", mail);
    await mac.mailer.importDrops();
    expect(mac.store.get("m_301")?.to.agentId).toBe("probe-id");
  });

  // lead on cantor holds a record of m_400 that does not match the drop on probe-id. In the holder
  // and host rows the drop's own to.agentId / to.serverId agree with the record, so comparing the
  // record with the drop's to fields, not with the holder and this host, accepts it. Wrong: checking
  // only that a record exists; skipping its to.agentId, its to.serverId, or its digest; clearing the
  // record on a mismatch (a clearHandOff call, the record gone). m_401 beside it carries a matching
  // record (positive control).
  const mismatches: { kind: string; arrange: () => { value: Mail; record: unknown } }[] = [
    {
      kind: "names another holder on this host",
      arrange: () => {
        const value = { ...dropped("m_400"), to: { agentId: "other-id", address: "probe@m2-max", serverId: MAC } };
        return { value, record: recordOf(value, MAC, "other-id") };
      },
    },
    {
      kind: "names another recipient host",
      arrange: () => {
        const value = { ...dropped("m_400"), to: { agentId: "probe-id", address: "probe@m2-max", serverId: ATTIC } };
        return { value, record: recordOf(value, ATTIC, "probe-id") };
      },
    },
    {
      kind: "carries the digest of other content (the body differs)",
      arrange: () => ({ value: { ...dropped("m_400"), body: "body m_400, rewritten" }, record: recordOf(dropped("m_400"), MAC, "probe-id") }),
    },
  ];
  it.each(mismatches)("clears a drop whose record $kind, unstored, and leaves the record", async ({ arrange }) => {
    const { cantor, mac } = await pairOf();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mac.paseo.add("other-id");
    const { value, record } = arrange();
    forge(mac.paseo, "probe-id", "m_400", value);
    cantor.paseo.setMetadata("lead-id", { [`${OUT_PREFIX}m_400`]: record });
    place(mac.paseo, "probe-id", "m_401", dropped("m_401"));
    await mac.mailer.importDrops();
    expect.soft(mac.store.get("m_400")).toBeUndefined();
    expect.soft(hasDrop(mac.paseo, "probe-id", "m_400")).toBe(false);
    expect.soft(recordClears(mac.paseo).filter((args) => args[2] === "m_400")).toEqual([]);
    expect.soft(recordOn(cantor.paseo, "lead-id", "m_400")).toStrictEqual(record);
    expect(mac.store.get("m_401")?.to.agentId).toBe("probe-id");
    expect(hasDrop(mac.paseo, "probe-id", "m_401")).toBe(false);
  });

  // The drop carries every stamp set (outside the digest), its keys and from's and to's reversed;
  // lead also holds the record of another mail, m_599, which must stay. Wrong: a digest over the raw
  // value or its JSON, or over the fields in the value's key order (no match: cleared unstored);
  // the record cleared on the Mac or by the holder's id (args); every record lead holds cleared (m_599
  // gone); the record cleared before the store (event order); no record clear (it stays).
  it("stores a recorded drop, nudges once, then clears the record on cantor and the drop", async () => {
    const { cantor, mac } = await pairOf({ debounceMs: 5 });
    const mail: Mail = { ...dropped("m_500"), readAt: "2026-11-22T10:01:00.000Z", nudgedAt: "2026-11-22T10:02:00.000Z", seenAt: "2026-11-22T10:04:00.000Z", handedOffAt: "2026-11-22T10:05:00.000Z" };
    const value = reversedKeys(mail);
    expect(JSON.stringify(value)).not.toBe(JSON.stringify(mail));
    place(mac.paseo, "probe-id", "m_500", value);
    const other = recordOf(dropped("m_599"), MAC, "probe-id");
    cantor.paseo.setMetadata("lead-id", { [`${OUT_PREFIX}m_599`]: other });
    const events: string[] = [];
    const create = mac.store.create.bind(mac.store);
    mac.store.create = (stored) => {
      events.push("create");
      return create(stored);
    };
    const clearRecord = mac.paseo.clearHandOff.bind(mac.paseo);
    mac.paseo.clearHandOff = (serverId, agentId, mailId) => {
      events.push("clearHandOff");
      return clearRecord(serverId, agentId, mailId);
    };
    const clearDrop = mac.paseo.clearDrop.bind(mac.paseo);
    mac.paseo.clearDrop = (agentId, mailId) => {
      events.push("clearDrop");
      return clearDrop(agentId, mailId);
    };
    await mac.mailer.importDrops();
    expect.soft(mac.store.get("m_500")?.to.agentId).toBe("probe-id");
    expect.soft(events).toEqual(["create", "clearHandOff", "clearDrop"]);
    expect.soft(recordClears(mac.paseo)).toEqual([[CANTOR, "lead-id", "m_500"]]);
    expect.soft(outKeys(cantor.paseo, "lead-id")).toEqual([`${OUT_PREFIX}m_599`]);
    expect.soft(recordOn(cantor.paseo, "lead-id", "m_599")).toStrictEqual(other);
    expect.soft(hasDrop(mac.paseo, "probe-id", "m_500")).toBe(false);
    expect(await until(() => mac.paseo.sent.length > 0)).toBe(true);
    await mac.mailer.importDrops();
    await wait(50);
    expect(mac.paseo.sent).toEqual([{ agentId: "probe-id", text: NUDGE_ONE }]);
  });

  // cantor reads online but refuses the record clear. Wrong: rethrowing (the pass logs it and the drop
  // stays for the next pass); clearing the record before the store, so the failure leaves the mail
  // unstored; skipping the drop clear after the failure; no record clear tried (no call, no line
  // naming m_600). The record stays on cantor (the clear failed).
  it("stores the mail and clears the drop when clearing its record on cantor throws, and logs it", async () => {
    const { network, cantor, mac } = await pairOf({ debounceMs: 5 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    network.fault(CANTOR, "clearHandOff", true);
    place(mac.paseo, "probe-id", "m_600", dropped("m_600"));
    await mac.mailer.importDrops();
    expect.soft(recordClears(mac.paseo)).toEqual([[CANTOR, "lead-id", "m_600"]]);
    expect.soft(mac.store.get("m_600")?.to.agentId).toBe("probe-id");
    expect.soft(hasDrop(mac.paseo, "probe-id", "m_600")).toBe(false);
    expect.soft(recordOn(cantor.paseo, "lead-id", "m_600")).toBeDefined();
    expect.soft(logLines(errors).filter((line) => line.includes("[paseo-mail]") && line.includes("m_600")).length).toBeGreaterThan(0);
    expect(await until(() => mac.paseo.sent.length > 0)).toBe(true);
  });

  // Throwing from the record-clear log handler leaves a stored mail's local drop behind.
  it("clears the local drop when its sender record clear rejects without a reason", async () => {
    const { cantor, mac } = await pairOf();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    place(mac.paseo, "probe-id", "m_601", dropped("m_601"));
    const clear = mac.paseo.clearHandOff.bind(mac.paseo);
    mac.paseo.clearHandOff = (serverId, agentId, mailId) =>
      serverId === CANTOR && agentId === "lead-id" && mailId === "m_601"
        ? Promise.reject()
        : clear(serverId, agentId, mailId);

    await mac.mailer.importDrops();
    expect.soft(mac.store.get("m_601")?.to.agentId).toBe("probe-id");
    expect.soft(recordOn(cantor.paseo, "lead-id", "m_601")).toBeDefined();
    expect.soft(hasDrop(mac.paseo, "probe-id", "m_601")).toBe(false);
    expect(errors).toHaveBeenCalledWith(
      `[paseo-mail] clearing the hand-off record of mail m_601 on lead-id (${CANTOR}) failed:`,
      "undefined",
    );
  });

  // The lookup of lead on cantor throws on the first pass, then works. Wrong: the record cleared while
  // the drop parks; storing twice; no record clear on the later pass. The third pass finds nothing.
  it("a drop parked while its sender lookup throws is imported once by a later pass, which then clears its record", async () => {
    const { network, cantor, mac } = await pairOf();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    place(mac.paseo, "probe-id", "m_610", dropped("m_610"));
    network.fault(CANTOR, "peerAgent", true);
    await mac.mailer.importDrops().catch(() => undefined);
    expect.soft(recordClears(mac.paseo)).toEqual([]);
    expect.soft(recordOn(cantor.paseo, "lead-id", "m_610")).toBeDefined();
    expect.soft(hasDrop(mac.paseo, "probe-id", "m_610")).toBe(true);
    expect.soft(mac.store.all()).toEqual([]);
    network.fault(CANTOR, "peerAgent", false);
    await mac.mailer.importDrops();
    await mac.mailer.importDrops();
    expect(mac.store.all().map((stored) => stored.id)).toEqual(["m_610"]);
    expect(recordClears(mac.paseo)).toEqual([[CANTOR, "lead-id", "m_610"]]);
    expect(recordOn(cantor.paseo, "lead-id", "m_610")).toBeUndefined();
    expect(hasDrop(mac.paseo, "probe-id", "m_610")).toBe(false);
  });

  // The create throws on the first pass. Wrong: the record cleared before the store (the next pass
  // finds no record and clears the drop unstored: the mail is lost). Positive control: with create
  // working, the next pass stores it and clears the record.
  it("leaves the record on cantor while a drop waits because its create throws, so a later pass still imports it", async () => {
    const { cantor, mac } = await pairOf();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const create = mac.store.create.bind(mac.store);
    mac.store.create = () => Promise.reject(new Error("disk full"));
    place(mac.paseo, "probe-id", "m_620", dropped("m_620"));
    await mac.mailer.importDrops().catch(() => undefined);
    expect.soft(recordClears(mac.paseo)).toEqual([]);
    expect.soft(recordOn(cantor.paseo, "lead-id", "m_620")).toBeDefined();
    expect.soft(hasDrop(mac.paseo, "probe-id", "m_620")).toBe(true);
    mac.store.create = create;
    await mac.mailer.importDrops();
    expect(mac.store.get("m_620")?.to.agentId).toBe("probe-id");
    expect(recordClears(mac.paseo)).toEqual([[CANTOR, "lead-id", "m_620"]]);
    expect(recordOn(cantor.paseo, "lead-id", "m_620")).toBeUndefined();
  });

  // m_701, m_702 and m_703 are already in probe's inbox (written straight to the store). Their drops
  // arrive again: m_701 with lead's matching record, m_702 with none, m_703 with a record naming
  // other-id. Wrong: a duplicate path that never clears the record (m_701's stays); one that clears
  // whatever record lead holds (m_703's gone) or asks for one that is not there (a call for m_702);
  // storing again; the no-match discard ahead of the duplicate check (m_702 and m_703 logged as
  // cleared unstored: the duplicate path logs nothing).
  it("clears a duplicate drop, and its record on cantor only when the record matches", async () => {
    const { cantor, mac } = await pairOf();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const id of ["m_701", "m_702", "m_703"]) await mac.store.create({ ...dropped(id), to: { agentId: "probe-id", address: "probe", serverId: null } });
    const before = mac.store.all();
    place(mac.paseo, "probe-id", "m_701", dropped("m_701"));
    forge(mac.paseo, "probe-id", "m_702", dropped("m_702"));
    forge(mac.paseo, "probe-id", "m_703", dropped("m_703"));
    const stale = recordOf(dropped("m_703"), MAC, "other-id");
    cantor.paseo.setMetadata("lead-id", { [`${OUT_PREFIX}m_703`]: stale });
    await mac.mailer.importDrops();
    expect.soft(recordClears(mac.paseo)).toEqual([[CANTOR, "lead-id", "m_701"]]);
    expect.soft(outKeys(cantor.paseo, "lead-id")).toEqual([`${OUT_PREFIX}m_703`]);
    expect.soft(recordOn(cantor.paseo, "lead-id", "m_703")).toStrictEqual(stale);
    expect.soft(clears(mac.paseo)).toEqual([
      ["probe-id", "m_701"],
      ["probe-id", "m_702"],
      ["probe-id", "m_703"],
    ]);
    expect.soft(mac.store.all()).toEqual(before);
    expect.soft(logLines(errors).filter((line) => /m_70[123]/.test(line))).toEqual([]);
  });

  // m_710 is already stored; its drop arrives again with lead's matching record, and cantor refuses
  // the record clear. Wrong: the duplicate path clearing the record without catching (the pass logs
  // the failure and the drop stays for ever). Positive control: the failure is logged.
  it("clears a duplicate drop and logs it when clearing its matching record on cantor throws", async () => {
    const { network, cantor, mac } = await pairOf();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mac.store.create({ ...dropped("m_710"), to: { agentId: "probe-id", address: "probe", serverId: null } });
    place(mac.paseo, "probe-id", "m_710", dropped("m_710"));
    network.fault(CANTOR, "clearHandOff", true);
    await mac.mailer.importDrops();
    expect.soft(recordClears(mac.paseo)).toEqual([[CANTOR, "lead-id", "m_710"]]);
    expect.soft(hasDrop(mac.paseo, "probe-id", "m_710")).toBe(false);
    expect.soft(recordOn(cantor.paseo, "lead-id", "m_710")).toBeDefined();
    expect.soft(logLines(errors).filter((line) => line.includes("[paseo-mail]") && line.includes("m_710")).length).toBeGreaterThan(0);
  });

  // lead holds a value under m_720's record key that is no record (a string, then an empty object).
  // Wrong: reading the record's fields without checking its shape (the read throws: the drop parks
  // for ever); treating any value as a match (stored). Positive control: m_721 beside it, recorded.
  it.each([{ kind: "a string", value: "not a record" as unknown }, { kind: "an empty object", value: {} }])("clears a drop unstored when its record key holds $kind", async ({ value }) => {
    const { cantor, mac } = await pairOf();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    forge(mac.paseo, "probe-id", "m_720", dropped("m_720"));
    cantor.paseo.setMetadata("lead-id", { [`${OUT_PREFIX}m_720`]: value });
    place(mac.paseo, "probe-id", "m_721", dropped("m_721"));
    await mac.mailer.importDrops();
    expect.soft(hasDrop(mac.paseo, "probe-id", "m_720")).toBe(false);
    expect.soft(mac.store.get("m_720")).toBeUndefined();
    expect.soft(recordClears(mac.paseo).filter((args) => args[2] === "m_720")).toEqual([]);
    expect.soft(recordOn(cantor.paseo, "lead-id", "m_720")).toStrictEqual(value);
    expect(mac.store.get("m_721")?.to.agentId).toBe("probe-id");
  });

  // RULING (Jerry, relayed by paseo-mail-lead): the importer ignores unknown fields in a record, so
  // records stay forward-compatible. lead's record of m_730 matches on to and digest and carries an
  // extra field. Wrong: a strict record schema (no match: cleared unstored, nobody nudged, the record
  // left on cantor).
  it("stores a drop whose matching record carries an unknown field, nudges, and clears the record and the drop", async () => {
    const { cantor, mac } = await pairOf({ debounceMs: 5 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    forge(mac.paseo, "probe-id", "m_730", dropped("m_730"));
    cantor.paseo.setMetadata("lead-id", { [`${OUT_PREFIX}m_730`]: { ...recordOf(dropped("m_730"), MAC, "probe-id"), via: "future" } });
    await mac.mailer.importDrops();
    expect.soft(mac.store.get("m_730")?.to.agentId).toBe("probe-id");
    expect.soft(recordClears(mac.paseo)).toEqual([[CANTOR, "lead-id", "m_730"]]);
    expect.soft(recordOn(cantor.paseo, "lead-id", "m_730")).toBeUndefined();
    expect.soft(hasDrop(mac.paseo, "probe-id", "m_730")).toBe(false);
    expect(await until(() => mac.paseo.sent.length > 0)).toBe(true);
    expect(mac.paseo.sent).toEqual([{ agentId: "probe-id", text: NUDGE_ONE }]);
  });
});

describe("importDrops: cross-host subject and body cap (paseo-mail#6d9k)", () => {
  const half = "€".repeat(5461) + "x";

  // The split content fits under separate limits. Surrogate halves must be encoded as separate fields.
  it.each([
    { kind: "subject only", subject: half.repeat(2), body: "", extraSubject: "x", extraBody: "" },
    { kind: "body only", subject: "", body: half.repeat(2), extraSubject: "", extraBody: "x" },
    { kind: "subject and body", subject: half, body: half, extraSubject: "", extraBody: "x" },
    { kind: "fields with split surrogate halves", subject: "x".repeat(32762) + "\uD83D", body: "\uDE42", extraSubject: "x", extraBody: "" },
  ])("imports exactly 32 KiB in the $kind and clears an oversized drop without storing it", async ({ subject, body, extraSubject, extraBody }) => {
    const { cantor, mac } = await pairOf();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const atLimit = { ...dropped("m_atlimit"), subject, body };
    const oversized = { ...dropped("m_oversized"), subject: extraSubject + subject, body: body + extraBody };
    expect(Buffer.byteLength(atLimit.subject, "utf8") + Buffer.byteLength(atLimit.body, "utf8")).toBe(32768);
    expect(Buffer.byteLength(oversized.subject, "utf8") + Buffer.byteLength(oversized.body, "utf8")).toBe(32769);
    place(mac.paseo, "probe-id", atLimit.id, atLimit);
    place(mac.paseo, "probe-id", oversized.id, oversized);
    const oversizedRecord = recordOf(oversized, MAC, "probe-id");

    await mac.mailer.importDrops();

    expect.soft(mac.store.get(atLimit.id)).toMatchObject({ subject, body, to: { agentId: "probe-id", serverId: null } });
    expect.soft(mac.store.all().map((mail) => mail.id)).toEqual([atLimit.id]);
    expect.soft(hasDrop(mac.paseo, "probe-id", atLimit.id)).toBe(false);
    expect.soft(hasDrop(mac.paseo, "probe-id", oversized.id)).toBe(false);
    expect.soft(recordClears(mac.paseo)).toEqual([[CANTOR, "lead-id", atLimit.id]]);
    expect.soft(recordOn(cantor.paseo, "lead-id", atLimit.id)).toBeUndefined();
    expect.soft(recordOn(cantor.paseo, "lead-id", oversized.id)).toStrictEqual(oversizedRecord);
    expect(logLines(errors)).toEqual([expect.stringMatching(/\[paseo-mail\].*m_oversized.*(?:byte|limit|large|size)/i)]);
  });

  it("clears an oversized unconfirmed drop for its missing hand-off record", async () => {
    const { cantor, mac } = await pairOf();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mail = { ...dropped("m_unconfirmed"), subject: half, body: half + "x" };
    forge(mac.paseo, "probe-id", mail.id, mail);

    await mac.mailer.importDrops();

    expect.soft(mac.store.all()).toEqual([]);
    expect.soft(hasDrop(mac.paseo, "probe-id", mail.id)).toBe(false);
    expect.soft(recordClears(mac.paseo)).toEqual([]);
    expect.soft(outKeys(cantor.paseo, "lead-id")).toEqual([]);
    expect(logLines(errors)).toEqual([expect.stringMatching(/\[paseo-mail\].*m_unconfirmed.*no matching hand-off record/i)]);
  });

  // A duplicate still acknowledges its matching record when its content exceeds the cap.
  it("clears both the drop and the sender record for an oversized mail already stored", async () => {
    const { cantor, mac } = await pairOf();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mail = { ...dropped("m_oversizedduplicate"), subject: half, body: half + "x" };
    const stored = { ...mail, to: { agentId: "probe-id", address: "probe", serverId: null } };
    await mac.store.create(stored);
    const before = mac.store.revision;
    place(mac.paseo, "probe-id", mail.id, mail);

    await mac.mailer.importDrops();

    expect.soft(mac.store.all()).toEqual([stored]);
    expect.soft(mac.store.revision).toBe(before);
    expect.soft(hasDrop(mac.paseo, "probe-id", mail.id)).toBe(false);
    expect.soft(recordClears(mac.paseo)).toEqual([[CANTOR, "lead-id", mail.id]]);
    expect.soft(recordOn(cantor.paseo, "lead-id", mail.id)).toBeUndefined();
    expect(logLines(errors)).toEqual([]);
  });
});

describe("import triggers (design step 8)", () => {
  // The drop is there before start(); the sweep is the default 60 s and no watcher fires.
  // Wrong: start() without an import pass.
  it("start() imports drops already waiting", async () => {
    const { mac } = await macUnstarted();
    place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
    await mac.mailer.start();
    expect(await until(() => mac.store.get("m_100") !== undefined, 500)).toBe(true);
  });

  // Each start() step is guarded on its own (plan "Shared constraints"). A mail waits in the Mac's
  // outbox and listing the drops throws. Wrong: a failed import ending start() before its hand-off.
  it("start() still hands off the outbox when its import pass fails", async () => {
    const { mac } = await macUnstarted();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mac.store.create({
      ...dropped("m_out"),
      from: { agentId: "probe-id", name: "probe", title: "Probe", serverId: null },
      to: { agentId: "lead-id", address: "lead@cantor", serverId: CANTOR },
    });
    mac.paseo.localDrops = () => Promise.reject(new Error("list down"));
    await mac.mailer.start();
    expect(await until(() => mac.store.get("m_out")?.handedOffAt != null, 500)).toBe(true);
  });

  // Wrong: dropsChanged left a no-op.
  it("a dropsChanged event imports", async () => {
    const { mac } = await pairOf();
    place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
    for (const watcher of [...mac.paseo.watchers]) watcher.dropsChanged();
    expect(await until(() => mac.store.get("m_100") !== undefined)).toBe(true);
  });

  // Rethrowing while logging a watcher-triggered import creates an unhandled rejection.
  it("logs a dropsChanged import failure when listing rejects without a reason", async () => {
    const { mac } = await pairOf();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mac.paseo.localDrops = () => Promise.reject();

    for (const watcher of [...mac.paseo.watchers]) watcher.dropsChanged();
    await vi.waitFor(() => {
      expect(errors).toHaveBeenCalledWith("[paseo-mail] import on new drops failed:", "undefined");
    });
  });

  // Wrong: a sweep that only hands off.
  it("the sweep imports on its own", async () => {
    const { mac } = await pairOf({ sweepMs: 20 });
    place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
    expect(await until(() => mac.store.get("m_100") !== undefined)).toBe(true);
  });

  // The design lists no import on host-online. The hostOnline handler is let run to its flush before
  // the check. Wrong: importing on hostOnline. Positive control: dropsChanged on the same mailer imports.
  it("a host coming online does not import", async () => {
    const { network, mac } = await pairOf();
    const imports = vi.spyOn(mac.mailer, "importDrops").mockResolvedValue(undefined);
    const flushes = vi.spyOn(mac.mailer, "flushOutbox");
    network.setReachable(MAC, CANTOR, false);
    network.setReachable(MAC, CANTOR, true);
    expect(await until(() => flushes.mock.calls.length > 0)).toBe(true);
    await Promise.allSettled(flushes.mock.results.map((result) => result.value));
    await wait(30);
    expect(imports).not.toHaveBeenCalled();
    for (const watcher of [...mac.paseo.watchers]) watcher.dropsChanged();
    expect(await until(() => imports.mock.calls.length > 0)).toBe(true);
  });
});

describe("two daemons end to end (acceptance 12, 9)", () => {
  // Done-when 1-3, through the real triggers only (the send's hand-off writes the drop, whose
  // dropsChanged imports it). Wrong: no import on dropsChanged; no nudge scheduled on import; the
  // reply's from.serverId not the Mac's.
  it("cantor's lead sends to probe@m2-max, the Mac agent is nudged once, reads it, and its reply lands in cantor's inbox", async () => {
    const { cantor, mac, lead, probe } = await pairOf({ debounceMs: 5 });
    await cantor.mailer.register(lead, { name: "cantor-routing-lead" });
    const [delivery] = await cantor.mailer.send(lead, ["probe@m2-max"], "Ping", "Are you there?");
    const id = delivery!.mailId;
    expect(await until(() => mac.mailer.unreadCount("probe-id") === 1)).toBe(true);
    expect(await until(() => mac.paseo.sent.length > 0)).toBe(true);
    await wait(50);
    expect(mac.paseo.sent).toEqual([{ agentId: "probe-id", text: NUDGE_ONE }]);
    expect(await mac.mailer.read("probe-id", id)).toMatchObject({
      subject: "Ping",
      body: "Are you there?",
      from: { agentId: "lead-id", name: "cantor-routing-lead", serverId: CANTOR },
      to: { agentId: "probe-id", address: "probe", serverId: null },
    });
    const reply = await mac.mailer.reply(probe, id, "Here.");
    expect(await until(() => cantor.mailer.list("lead-id").length === 1)).toBe(true);
    expect(cantor.mailer.list("lead-id")[0]).toMatchObject({
      id: reply.mailId,
      subject: "Re: Ping",
      body: "Here.",
      threadId: id,
      inReplyTo: id,
      from: { agentId: "probe-id", name: "probe", serverId: MAC },
      to: { agentId: "lead-id", address: "cantor-routing-lead", serverId: null },
    });
  });

  // paseo-mail#qkf2, through the real triggers: cantor's hand-off records the mail on lead, and the
  // Mac's import clears that record. Wrong: an importer that never clears it (it stays on lead for
  // ever); clearing it on the Mac, or by the holder's id (args).
  it("cantor's record of a mail is gone once the Mac has imported it", async () => {
    const { cantor, mac, lead } = await pairOf({ debounceMs: 5 });
    const [delivery] = await cantor.mailer.send(lead, ["probe@m2-max"], "Ping", "x");
    const id = delivery!.mailId;
    expect(await until(() => mac.store.get(id) !== undefined)).toBe(true);
    expect(cantor.paseo.calls.filter((call) => call.op === "recordHandOff").map((call) => call.args.slice(0, 2))).toEqual([["lead-id", id]]);
    expect(await until(() => recordOn(cantor.paseo, "lead-id", id) === undefined)).toBe(true);
    expect(recordClears(mac.paseo)).toEqual([[CANTOR, "lead-id", id]]);
    expect(hasDrop(mac.paseo, "probe-id", id)).toBe(false);
  });

  // The Mac cannot reach cantor, so it cannot check the sender: the drop parks. Wrong: clearing it
  // (the sender's lookup throws, folded into "missing"); storing it unchecked.
  it("parks a drop while the reverse link is down, and imports it when the link returns", async () => {
    const { network, cantor, mac, lead } = await pairOf({ debounceMs: 5 });
    network.setReachable(MAC, CANTOR, false);
    const [delivery] = await cantor.mailer.send(lead, ["probe@m2-max"], "Ping", "x");
    const id = delivery!.mailId;
    expect(await until(() => hasDrop(mac.paseo, "probe-id", id))).toBe(true);
    await mac.mailer.importDrops().catch(() => undefined);
    expect(hasDrop(mac.paseo, "probe-id", id)).toBe(true);
    expect(mac.store.all()).toEqual([]);
    network.setReachable(MAC, CANTOR, true);
    await mac.mailer.importDrops();
    expect(mac.mailer.list("probe-id").map((mail) => mail.id)).toEqual([id]);
    expect(hasDrop(mac.paseo, "probe-id", id)).toBe(false);
    expect(await until(() => mac.paseo.sent.length > 0)).toBe(true);
  });

  // lead is archived after sending and lead2 takes its name. The Mac's hand-off writes the drop on
  // lead2-id, but the drop's to.agentId is still lead-id. Wrong: the importer keeping the value's
  // to.agentId (the reply lands in lead-id's mailbox).
  it("a reply to an imported mail from an archived named sender reaches the name's new holder", async () => {
    const { cantor, mac, lead, probe } = await pairOf();
    await cantor.mailer.register(lead, { name: "cantor-routing-lead" });
    const [delivery] = await cantor.mailer.send(lead, ["probe@m2-max"], "Ping", "x");
    const id = delivery!.mailId;
    expect(await until(() => mac.store.get(id) !== undefined)).toBe(true);
    cantor.paseo.archive("lead-id");
    await cantor.mailer.onArchived("lead-id");
    await cantor.mailer.register(cantor.paseo.add("lead2-id", { title: "Lead 2" }), { name: "cantor-routing-lead" });
    const reply = await mac.mailer.reply(probe, id, "Answer");
    expect(await until(() => cantor.mailer.list("lead2-id").length === 1)).toBe(true);
    expect(cantor.mailer.list("lead2-id")[0]).toMatchObject({
      id: reply.mailId,
      from: { agentId: "probe-id", serverId: MAC },
      to: { agentId: "lead2-id", address: "cantor-routing-lead", serverId: null },
    });
    expect(cantor.mailer.list("lead-id")).toEqual([]);
  });

  // The sender has no registry entry and a mixed-case id. Wrong: the reply's to.address rewritten
  // through parseAddress ("Anon-ID") or lower-cased; the reply not reaching the sender by id.
  it("a reply to an unregistered live sender reaches it by id", async () => {
    const { cantor, mac, probe } = await pairOf();
    const anon = cantor.paseo.add("Anon-ID", { title: "Anon" });
    const [delivery] = await cantor.mailer.send(anon, ["probe@m2-max"], "Ping", "x");
    const id = delivery!.mailId;
    expect(await until(() => mac.store.get(id) !== undefined)).toBe(true);
    expect(mac.store.get(id)?.from).toMatchObject({ agentId: "Anon-ID", name: null, serverId: CANTOR });
    const reply = await mac.mailer.reply(probe, id, "Answer");
    expect(await until(() => cantor.mailer.list("Anon-ID").length === 1)).toBe(true);
    expect(cantor.mailer.list("Anon-ID")[0]).toMatchObject({
      id: reply.mailId,
      from: { agentId: "probe-id", name: "probe", serverId: MAC },
      to: { agentId: "Anon-ID", address: "agent:Anon-ID", serverId: null },
    });
  });

  it.each([
    { sender: "named", name: "lead", remaining: "a lookalike link", lookalike: true },
    { sender: "nameless", name: null, remaining: "a lookalike link", lookalike: true },
    { sender: "named", name: "lead", remaining: "no links", lookalike: false },
  ])("mail_reply refuses a $sender sender after removing its host link, leaving $remaining", async ({ name, lookalike }) => {
    const { network, cantor, mac, lead, probe } = await pairOf();
    if (name !== null) await cantor.mailer.register(lead, { name });
    const [delivery] = await cantor.mailer.send(lead, ["probe@m2-max"], "Ping", "Question");
    const id = delivery!.mailId;
    expect(await until(() => mac.store.get(id) !== undefined)).toBe(true);
    expect(mac.store.get(id)?.from).toMatchObject({ agentId: lead.id, name, serverId: CANTOR });

    const reply = mailTools(mac.mailer).find((tool) => tool.name === "mail_reply")!;
    const input = reply.input.parse({ id, body: "Answer" });
    const context = toolContext(probe.id, probe.title);
    const linked = await reply.execute(input, context);
    expect(linked.isError).toBeUndefined();
    expect(await until(() => cantor.mailer.list(lead.id).some((mail) => mail.inReplyTo === id))).toBe(true);
    await mac.mailer.flushOutbox();
    expect(mac.store.outbox()).toEqual([]);

    // The link is removed without a watcher event.
    mac.paseo.links.delete(CANTOR);
    if (lookalike) {
      const lookalikeId = CANTOR.toLowerCase();
      network.host(lookalikeId, "lookalike");
      network.link(MAC, lookalikeId, { label: CANTOR });
    } else {
      expect((await mac.paseo.hostDirectory()).hosts).toEqual([]);
    }
    const before = mac.store.revision;
    const unlinked = await reply.execute(input, context);

    expect.soft(unlinked.isError).toBe(true);
    expect.soft(unlinked.text).toContain(`unknown host "${CANTOR}"`);
    expect.soft(mac.store.revision).toBe(before);
    expect.soft(mac.store.outbox()).toEqual([]);
  });
});
