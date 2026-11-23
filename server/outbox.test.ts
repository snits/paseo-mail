import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTIC, CANTOR, DROP_PREFIX, MAC, mailOf, linkedHosts, publish, reportHost, setup, setupPair, until, wait, type FakeNetwork, type FakePaseo } from "../test/fixtures";
import type { Mailer, MailerOptions } from "./mailer";
import { UserError, type Mail } from "./types";

// Task 5 of paseo-mail#xsbz: outbox writers and hand-off (design steps 6, 7, 9 and 11).

/** The cross-host body cap in UTF-8 bytes, written out here rather than read from CROSS_HOST_BODY_LIMIT. */
const LIMIT = 32768;

const mailers: Mailer[] = [];
const held: (() => void)[] = [];
afterEach(async () => {
  for (const release of held.splice(0)) release();
  await Promise.all(mailers.splice(0).map((mailer) => mailer.dispose()));
});

/** cantor and the Mac (cantor lists it as "m2-max"), with "lead" registered on cantor. */
async function linked(options: MailerOptions = {}) {
  const pair = await setupPair({ debounceMs: 60_000, ...options });
  mailers.push(pair.cantor.mailer, pair.mac.mailer);
  const lead = pair.cantor.paseo.add("lead-id", { title: "Lead" });
  await pair.cantor.mailer.register(lead, { name: "lead" });
  return { ...pair, lead };
}

/** cantor and the Mac linked as in setupPair, with cantor's Mailer built but not started (no mailer on the Mac). */
async function unstarted(options: MailerOptions = {}) {
  const { network, cantorHost, macHost: mac } = linkedHosts();
  const cantor = await setup({ debounceMs: 60_000, ...options }, undefined, cantorHost);
  mailers.push(cantor.mailer);
  return { network, cantor, mac };
}

/** A third host, linked from cantor as "attic"; no mailer runs there. */
function addAttic(network: FakeNetwork, reachable = true): FakePaseo {
  const attic = network.host(ATTIC, "attic");
  network.link(CANTOR, ATTIC, { label: "attic" });
  if (!reachable) network.setReachable(CANTOR, ATTIC, false);
  return attic;
}

/** An outbox mail from lead, as send would store it; written straight to the store so no send triggers a flush. */
function outMail(id: string, serverId: string, agentId: string | null, address: string): Mail {
  return mailOf({ id, from: { agentId: "lead-id", name: "lead", title: "Lead", serverId: null }, to: { agentId, address, serverId } });
}

/** A mail lead received from an agent on the Mac (as Task 6's importer would store it). */
function fromMac(id: string, from: { agentId: string; name: string | null; title: string | null }): Mail {
  return mailOf({ id, from: { ...from, serverId: MAC }, to: { agentId: "lead-id", address: "lead", serverId: null }, subject: "Question", body: "?" });
}

/** The writeDrop calls a port recorded, in order. */
function writes(paseo: FakePaseo): { serverId: string; agentId: string; mail: Mail }[] {
  return paseo.calls.filter((call) => call.op === "writeDrop").map((call) => ({ serverId: call.args[0] as string, agentId: call.args[1] as string, mail: call.args[2] as Mail }));
}

const PEER_OPS = new Set(["peerAgent", "peerAddresses", "writeDrop"]);
/** The peer calls a port recorded, as [op, ...args] without the mail payload. */
function peerCalls(paseo: FakePaseo): unknown[][] {
  return paseo.calls.filter((call) => PEER_OPS.has(call.op)).map((call) => [call.op, call.args[0], call.args[1]]);
}

const stamped = (store: { get(id: string): Mail | undefined }, id: string): boolean => (store.get(id)?.handedOffAt ?? null) !== null;

/** Lets a promise reject without an unhandled-rejection report while the test still awaits it. */
function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

describe("storing remote mail (design step 6)", () => {
  // Wrong: to.address normalized ("probe@m2-max") or cut to the local part ("Probe"); to.serverId as
  // the link label ("m2-max"); the remote copy stored as local mail (to.serverId null); the Delivery
  // without serverId, or carrying the caller's title; the stored copy's from.serverId set (to the
  // recipient's host) instead of null until the hand-off stamps the drop. writeDrop fails so the
  // mail stays in the outbox.
  it("stores a resolved remote send as one outbox mail with to.address as typed", async () => {
    const { network, cantor, mac, lead } = await linked();
    publish(mac.paseo, "other-id", "other", "Other");
    publish(mac.paseo, "probe-id", "probe", "Probe");
    network.fault(MAC, "writeDrop", true);
    const deliveries = await cantor.mailer.send(lead, ["Probe@M2-Max"], "Hello", "Body");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ address: "Probe@M2-Max", serverId: MAC, agentId: "probe-id", name: "probe", title: "Probe" });
    const id = deliveries[0]!.mailId;
    expect(cantor.store.get(id)).toMatchObject({
      from: { agentId: "lead-id", name: "lead", serverId: null },
      to: { serverId: MAC, agentId: "probe-id", address: "Probe@M2-Max" },
      subject: "Hello",
      body: "Body",
      handedOffAt: null,
    });
    expect(cantor.store.outbox().map((mail) => mail.id)).toEqual([id]);
    expect(cantor.mailer.list("probe-id")).toEqual([]);
    expect(cantor.store.pendingNudges()).toEqual([]);
  });

  // Wrong: refusing a host that is not online; an unresolved Delivery with a made-up agentId (the
  // name, or the serverId); to.address rewritten.
  it("stores an unresolved remote send (host offline) with to.agentId null", async () => {
    const { network, cantor, lead } = await linked();
    network.setReachable(CANTOR, MAC, false);
    const deliveries = await cantor.mailer.send(lead, ["Probe@M2-Max"], "Hello", "Body");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ address: "Probe@M2-Max", serverId: MAC, agentId: null });
    expect(cantor.store.get(deliveries[0]!.mailId)).toMatchObject({ to: { serverId: MAC, agentId: null, address: "Probe@M2-Max" }, handedOffAt: null });
    expect(cantor.store.outbox().map((mail) => mail.id)).toEqual([deliveries[0]!.mailId]);
  });
});

describe("dedup key of remote targets", () => {
  // The right key is `${serverId}/${agentId ?? "name:" + name}`. Counts each wrong key gives are noted
  // per test; a test catches the keys whose count differs from the right one.

  // Two addresses reach probe (by label and by serverId), a third reaches other. Right: 2.
  // Catches: key serverId alone (1); key by the address as typed (3). A key of agentId alone or of
  // `${serverId}/${agentId}` also gives 2 here (the next two tests catch those). The copy keeps the
  // first address typed for probe, as a local send does. Wrong: the last one ("Probe@srv_EntwLoR9srmD").
  it("stores one mail for two addresses that reach the same remote agent", async () => {
    const { network, cantor, mac, lead } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    publish(mac.paseo, "other-id", "other");
    network.fault(MAC, "writeDrop", true);
    const deliveries = await cantor.mailer.send(lead, ["probe@m2-max", "Probe@srv_EntwLoR9srmD", "other@m2-max"], "s", "b");
    expect(deliveries).toHaveLength(2);
    expect(cantor.store.all().map((mail) => mail.to.agentId).sort()).toEqual(["other-id", "probe-id"]);
    expect(cantor.store.all().map((mail) => mail.to.address).sort()).toEqual(["other@m2-max", "probe@m2-max"]);
  });

  // Both unresolved on the offline Mac. Right: 2. Catches: serverId alone (1), agentId alone (null
  // for both: 1), `${serverId}/${agentId}` (both "srv/null": 1).
  it("stores two mails for two unresolved names on the same offline host", async () => {
    const { network, cantor, lead } = await linked();
    network.setReachable(CANTOR, MAC, false);
    const deliveries = await cantor.mailer.send(lead, ["probe@m2-max", "other@m2-max"], "s", "b");
    expect(deliveries).toHaveLength(2);
    expect(cantor.store.all().map((mail) => mail.to.address).sort()).toEqual(["other@m2-max", "probe@m2-max"]);
  });

  // "probe" on two offline hosts, plus "other" on the attic. Right: 3. Catches: serverId alone (2),
  // agentId alone (1), `${serverId}/${agentId}` (2), and a name key without the serverId (2).
  it("stores one mail per host for the same name on two hosts", async () => {
    const { network, cantor, lead } = await linked();
    addAttic(network, false);
    network.setReachable(CANTOR, MAC, false);
    const deliveries = await cantor.mailer.send(lead, ["probe@m2-max", "probe@attic", "other@attic"], "s", "b");
    expect(deliveries).toHaveLength(3);
    expect(cantor.store.all().map((mail) => `${mail.to.serverId} ${mail.to.address}`).sort()).toEqual([
      `${ATTIC} other@attic`,
      `${ATTIC} probe@attic`,
      `${MAC} probe@m2-max`,
    ]);
  });
});

describe("cross-host body cap (design step 6)", () => {
  // "€" is 3 UTF-8 bytes and 1 UTF-16 unit; "é" is 2 bytes and 1 unit. Wrong measures: `.length`
  // (10923 for both bodies, so both accepted); UTF-16LE bytes (21846 for both, both accepted).
  // Wrong limits: `<` for `<=`, or 32 * 1000 (AT_CAP refused); LIMIT + 1 (OVER_CAP accepted).
  const AT_CAP = "€".repeat(10922) + "é";
  const OVER_CAP = "€".repeat(10923);

  it("accepts a remote body of exactly 32 KiB and refuses one byte more, storing nothing", async () => {
    // The fixtures straddle the limit in UTF-8 bytes, not in UTF-16 units or UTF-16LE bytes.
    expect(Buffer.byteLength(AT_CAP, "utf8")).toBe(LIMIT);
    expect(Buffer.byteLength(OVER_CAP, "utf8")).toBe(LIMIT + 1);
    expect(AT_CAP.length).toBe(10923);
    expect(OVER_CAP.length).toBe(10923);
    expect(Buffer.byteLength(OVER_CAP, "utf16le")).toBeLessThan(LIMIT);
    const { network, cantor, lead } = await linked();
    network.setReachable(CANTOR, MAC, false);
    const [delivery] = await cantor.mailer.send(lead, ["probe@m2-max"], "s", AT_CAP);
    expect(cantor.store.get(delivery!.mailId)?.body).toBe(AT_CAP);
    const before = cantor.store.revision;
    const error = await cantor.mailer.send(lead, ["probe@m2-max"], "s", OVER_CAP).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UserError);
    expect(cantor.store.revision).toBe(before);
    expect(cantor.store.all()).toHaveLength(1);
  });

  // Wrong: checking the cap per copy as it is stored (bob's local copy lands first); capping every
  // send (the local-only sends are refused); capping nothing.
  it("refuses a mixed local + remote send over the cap with no copy at all; a local-only send is uncapped", async () => {
    const { network, cantor, lead } = await linked();
    await cantor.mailer.register(cantor.paseo.add("bob-id", { title: "Bob" }), { name: "bob" });
    network.setReachable(CANTOR, MAC, false);
    const before = cantor.store.revision;
    await expect(cantor.mailer.send(lead, ["bob", "probe@m2-max"], "s", OVER_CAP)).rejects.toBeInstanceOf(UserError);
    expect(cantor.store.revision).toBe(before);
    expect(cantor.store.all()).toEqual([]);
    // Positive controls: the same body to bob alone, a far larger one, and the mixed send at the cap.
    expect(await cantor.mailer.send(lead, ["bob"], "s", OVER_CAP)).toMatchObject([{ agentId: "bob-id", serverId: null }]);
    expect(await cantor.mailer.send(lead, ["bob"], "s", "€".repeat(40_000))).toMatchObject([{ agentId: "bob-id" }]);
    const mixed = await cantor.mailer.send(lead, ["bob", "probe@m2-max"], "s", AT_CAP);
    expect(mixed.map((delivery) => delivery.serverId ?? "local").sort()).toEqual(["local", MAC]);
    expect(cantor.mailer.unreadCount("bob-id")).toBe(3);
  });

  // Wrong: a reply path that skips the cap.
  it("refuses a reply to a remote sender over the cap, and accepts one at the cap", async () => {
    const { network, cantor, lead } = await linked();
    network.setReachable(CANTOR, MAC, false);
    await cantor.store.create(fromMac("m_in", { agentId: "probe-id", name: "probe", title: "Probe" }));
    const before = cantor.store.revision;
    await expect(cantor.mailer.reply(lead, "m_in", OVER_CAP)).rejects.toBeInstanceOf(UserError);
    expect(cantor.store.revision).toBe(before);
    expect(cantor.store.all().map((mail) => mail.id)).toEqual(["m_in"]);
    const delivery = await cantor.mailer.reply(lead, "m_in", AT_CAP);
    expect(delivery).toMatchObject({ serverId: MAC, agentId: "probe-id" });
    expect(cantor.store.get(delivery.mailId)?.body).toBe(AT_CAP);
  });
});

describe("reply to a remote sender (design step 9)", () => {
  // cantor has a local "probe" too. Wrong: the local reply path (the decoy gets it); to.address
  // "probe@m2-max" or the agent id; to.agentId dropped; the thread not kept.
  it("goes to the outbox addressed to the sender's agent and name", async () => {
    const { network, cantor, mac, lead } = await linked();
    await cantor.mailer.register(cantor.paseo.add("decoy-id", { title: "Decoy" }), { name: "probe" });
    publish(mac.paseo, "probe-id", "probe", "Probe");
    network.fault(MAC, "writeDrop", true);
    await cantor.store.create(fromMac("m_in", { agentId: "probe-id", name: "probe", title: "Probe" }));
    const delivery = await cantor.mailer.reply(lead, "m_in", "Answer");
    expect(delivery).toMatchObject({ serverId: MAC, agentId: "probe-id", address: "probe" });
    expect(cantor.store.get(delivery.mailId)).toMatchObject({
      to: { serverId: MAC, agentId: "probe-id", address: "probe" },
      subject: "Re: Question",
      threadId: "m_in",
      inReplyTo: "m_in",
      body: "Answer",
    });
    expect(cantor.mailer.list("decoy-id")).toEqual([]);
  });

  // Wrong: to.address as the bare id, or with a host part.
  it("addresses a nameless sender as agent:<id>", async () => {
    const { network, cantor, mac, lead } = await linked();
    mac.paseo.add("anon-id");
    network.fault(MAC, "writeDrop", true);
    await cantor.store.create(fromMac("m_in", { agentId: "anon-id", name: null, title: null }));
    const delivery = await cantor.mailer.reply(lead, "m_in", "Answer");
    expect(delivery).toMatchObject({ serverId: MAC, agentId: "anon-id", address: "agent:anon-id" });
    expect(cantor.store.get(delivery.mailId)?.to).toEqual({ serverId: MAC, agentId: "anon-id", address: "agent:anon-id" });
  });

  // cantor's snapshot reads the Mac offline (refreshed while unreachable, watchers then removed so the
  // return fires no refresh); only a fresh directory read sees it online. Wrong: deciding "online" from
  // the snapshot (accepts); no lookup at all (accepts); the local path's refusal (no peerAgent call).
  it.each(["archived", "missing"] as const)("refuses a reply to a nameless sender that is %s on an online host", async (state) => {
    const { network, cantor, mac, lead } = await linked();
    if (state === "archived") {
      mac.paseo.add("anon-id");
      mac.paseo.archive("anon-id");
    }
    network.setReachable(CANTOR, MAC, false);
    await cantor.mailer.refreshHosts();
    cantor.paseo.watchers.length = 0;
    network.setReachable(CANTOR, MAC, true);
    await cantor.store.create(fromMac("m_in", { agentId: "anon-id", name: null, title: null }));
    const before = cantor.store.revision;
    await expect(cantor.mailer.reply(lead, "m_in", "Answer")).rejects.toBeInstanceOf(UserError);
    expect(cantor.store.revision).toBe(before);
    expect(peerCalls(cantor.paseo)).toContainEqual(["peerAgent", MAC, "anon-id"]);
    // Positive control: once the sender is live there, the same reply is accepted.
    if (state === "archived") mac.paseo.agents.get("anon-id")!.archived = false;
    else mac.paseo.add("anon-id");
    expect(await cantor.mailer.reply(lead, "m_in", "Answer")).toMatchObject({ serverId: MAC, agentId: "anon-id" });
  });

  // The sender is archived on the Mac, so a refusal here means an error or an offline host was taken
  // for "archived or missing". Wrong: folding a throw into "missing"; using the start() snapshot (Mac
  // online) when the directory read throws.
  // The last two cases keep the Mac reachable (its lookup would say "archived") and only the directory
  // entry rules it out. Wrong: ignoring `enabled`; ignoring `online` (both refuse).
  const cannotTell: { why: string; arrange: (network: FakeNetwork, cantor: FakePaseo) => void }[] = [
    {
      why: "the directory read throws",
      arrange: (_network, cantor) => {
        cantor.hostDirectory = async () => Promise.reject(new Error("directory down"));
      },
    },
    { why: "the peerAgent lookup throws", arrange: (network) => network.fault(MAC, "peerAgent", true) },
    { why: "the host is offline", arrange: (network) => network.setReachable(CANTOR, MAC, false) },
    { why: "the directory lists the host disabled (though online)", arrange: (_network, cantor) => reportHost(cantor, MAC, { enabled: false, online: true }) },
    { why: "the directory lists the host offline (though reachable)", arrange: (_network, cantor) => reportHost(cantor, MAC, { online: false }) },
  ];
  it.each(cannotTell)("accepts a reply to an archived nameless sender into the outbox when $why", async ({ arrange }) => {
    const { network, cantor, mac, lead } = await linked();
    mac.paseo.add("anon-id");
    mac.paseo.archive("anon-id");
    await cantor.store.create(fromMac("m_in", { agentId: "anon-id", name: null, title: null }));
    arrange(network, cantor.paseo);
    const delivery = await cantor.mailer.reply(lead, "m_in", "Answer");
    expect(delivery).toMatchObject({ serverId: MAC, agentId: "anon-id", address: "agent:anon-id" });
    expect(cantor.store.outbox().map((mail) => mail.id)).toEqual([delivery.mailId]);
  });

  it("accepts a reply to an archived named sender into the outbox when the directory read throws", async () => {
    const { cantor, mac, lead } = await linked();
    mac.paseo.add("probe-id");
    mac.paseo.archive("probe-id");
    await cantor.store.create(fromMac("m_in", { agentId: "probe-id", name: "probe", title: "Probe" }));
    cantor.paseo.hostDirectory = async () => Promise.reject(new Error("directory down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const delivery = await cantor.mailer.reply(lead, "m_in", "Answer");
      expect(delivery).toMatchObject({ serverId: MAC, agentId: "probe-id", address: "probe" });
      expect(cantor.store.outbox()).toMatchObject([
        { id: delivery.mailId, to: { serverId: MAC, agentId: "probe-id", address: "probe" } },
      ]);
      await vi.waitFor(() => {
        expect(errors.mock.calls).toEqual([["[paseo-mail] handing off the outbox failed:", "directory down"]]);
      });
    } finally {
      errors.mockRestore();
    }
  });

  // design A9: an archived sender with a name is not refused on an online host; the hand-off reaches
  // whoever holds the name there now. Wrong: refusing every archived or missing sender, named or not.
  it("accepts a reply to an archived named sender on an online host, and hands it to the name's holder", async () => {
    const { cantor, mac, lead } = await linked();
    mac.paseo.add("probe-id");
    mac.paseo.archive("probe-id");
    await cantor.store.create(fromMac("m_in", { agentId: "probe-id", name: "probe", title: "Probe" }));
    const delivery = await cantor.mailer.reply(lead, "m_in", "Answer");
    expect(delivery).toMatchObject({ serverId: MAC, agentId: "probe-id", address: "probe" });
    expect(cantor.store.get(delivery.mailId)?.to).toEqual({ serverId: MAC, agentId: "probe-id", address: "probe" });
    publish(mac.paseo, "probe2-id", "probe");
    await cantor.mailer.flushOutbox();
    expect(writes(cantor.paseo).map((write) => [write.mail.id, write.agentId])).toEqual([[delivery.mailId, "probe2-id"]]);
  });
});

describe("hand-off: flushOutbox (design step 7)", () => {
  // cantor's serverId changes after start(), so only a fresh directory read gives the new one.
  // Wrong: from.serverId left null; set to the recipient's host (MAC); cached at start() (CANTOR).
  // No mailer runs on the Mac: its importer would clear a drop from the renamed serverId, which it
  // has no link to, before the peer's metadata is read.
  it("writes paseo-mail.in.<id> on the peer agent with the sender's serverId, then stamps handedOffAt", async () => {
    const { cantor, mac } = await unstarted();
    await cantor.mailer.start();
    publish(mac, "probe-id", "probe", "Probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    cantor.paseo.self.serverId = "srv_CantorRenamed";
    await cantor.mailer.flushOutbox();
    const done = writes(cantor.paseo);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      serverId: MAC,
      agentId: "probe-id",
      mail: { id: "m_001", subject: "subject m_001", body: "body m_001", from: { agentId: "lead-id", name: "lead", serverId: "srv_CantorRenamed" } },
    });
    expect(mac.metadata.get("probe-id")?.[`${DROP_PREFIX}m_001`]).toMatchObject({ id: "m_001", from: { serverId: "srv_CantorRenamed" } });
    expect(stamped(cantor.store, "m_001")).toBe(true);
    expect(cantor.store.outbox()).toEqual([]);
  });

  // Stored out of id order. Wrong: store (insertion) order; newest first.
  it("hands mail to a host in id order", async () => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    for (const id of ["m_003", "m_001", "m_002"]) await cantor.store.create(outMail(id, MAC, "probe-id", "probe@m2-max"));
    await cantor.mailer.flushOutbox();
    expect(writes(cantor.paseo).map((write) => write.mail.id)).toEqual(["m_001", "m_002", "m_003"]);
    expect(cantor.store.outbox()).toEqual([]);
  });

  // Wrong: stamping before the write (or without awaiting it).
  it("sets handedOffAt only after the write resolves", async () => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    const release = cantor.paseo.holdWrites();
    held.push(release);
    const flush = quiet(cantor.mailer.flushOutbox());
    expect(await until(() => cantor.paseo.parkedWrites >= 1)).toBe(true);
    await wait(20);
    expect(stamped(cantor.store, "m_001")).toBe(false);
    release();
    await flush;
    expect(stamped(cantor.store, "m_001")).toBe(true);
  });

  // Wrong: stamping whether or not the write succeeded.
  it("leaves handedOffAt unset when the write fails, and hands off on a later pass", async () => {
    const { network, cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    network.fault(MAC, "writeDrop", true);
    await cantor.mailer.flushOutbox().catch(() => undefined);
    expect(writes(cantor.paseo)).toHaveLength(1);
    expect(stamped(cantor.store, "m_001")).toBe(false);
    network.fault(MAC, "writeDrop", false);
    await cantor.mailer.flushOutbox();
    expect(stamped(cantor.store, "m_001")).toBe(true);
  });

  // m_001: nobody publishes "ghost"; m_002: two agents publish "twin". Wrong: an unresolvable mail
  // stopping the host (m_003 not handed off); the first of two publishers taking it.
  it("skips an unresolvable mail without blocking later mail to the host, and retries it", async () => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    publish(mac.paseo, "twin-a-id", "twin");
    publish(mac.paseo, "twin-b-id", "twin");
    await cantor.store.create(outMail("m_001", MAC, null, "ghost@m2-max"));
    await cantor.store.create(outMail("m_002", MAC, null, "twin@m2-max"));
    await cantor.store.create(outMail("m_003", MAC, "probe-id", "probe@m2-max"));
    await cantor.mailer.flushOutbox();
    expect(writes(cantor.paseo).map((write) => [write.mail.id, write.agentId])).toEqual([["m_003", "probe-id"]]);
    expect(cantor.store.outbox().map((mail) => mail.id)).toEqual(["m_001", "m_002"]);
    // Positive control: once "ghost" is published, the next pass hands m_001 to it.
    publish(mac.paseo, "ghost-id", "ghost");
    await cantor.mailer.flushOutbox();
    expect(writes(cantor.paseo).map((write) => [write.mail.id, write.agentId])).toEqual([
      ["m_003", "probe-id"],
      ["m_001", "ghost-id"],
    ]);
    expect(cantor.store.outbox().map((mail) => mail.id)).toEqual(["m_002"]);
  });

  // Mail alternates hosts: m_001 Mac, m_002 attic, m_003 Mac, m_004 attic. Each host's first mail needs
  // the failing operation (unresolved for peerAddresses, resolved otherwise), its second the other kind.
  // Wrong: skipping only the failed mail (the host's second mail goes); stopping the whole pass (the
  // other host's mail stays, whichever host the pass takes first, hence both hosts fail in turn);
  // folding a peerAgent throw into "missing" (re-resolved by name and handed off).
  const stopCases = (["writeDrop", "peerAgent", "peerAddresses"] as const).flatMap((op) => [
    { op, failing: MAC, other: ATTIC },
    { op, failing: ATTIC, other: MAC },
  ]);
  it.each(stopCases)("a $op throw against $failing stops that host for the pass; $other still gets its mail", async ({ op, failing, other }) => {
    const { network, cantor, mac } = await linked();
    const attic = addAttic(network);
    publish(mac.paseo, "probe-id", "probe");
    publish(attic, "keeper-id", "keeper");
    const recipient: Record<string, { agentId: string; address: string }> = { [MAC]: { agentId: "probe-id", address: "probe@m2-max" }, [ATTIC]: { agentId: "keeper-id", address: "keeper@attic" } };
    const mail = (id: string, serverId: string, resolved: boolean) => outMail(id, serverId, resolved ? recipient[serverId]!.agentId : null, recipient[serverId]!.address);
    const firstResolved = op !== "peerAddresses";
    await cantor.store.create(mail("m_001", MAC, firstResolved));
    await cantor.store.create(mail("m_002", ATTIC, firstResolved));
    await cantor.store.create(mail("m_003", MAC, !firstResolved));
    await cantor.store.create(mail("m_004", ATTIC, !firstResolved));
    const ids: Record<string, string[]> = { [MAC]: ["m_001", "m_003"], [ATTIC]: ["m_002", "m_004"] };
    network.fault(failing, op, true);
    await cantor.mailer.flushOutbox().catch(() => undefined);
    expect(["m_001", "m_002", "m_003", "m_004"].filter((id) => stamped(cantor.store, id))).toEqual(ids[other]);
    expect(writes(cantor.paseo).map((write) => write.mail.id)).not.toContain(ids[failing]![1]);
    // Positive control: with the fault gone, the next pass hands the held mail over, in order.
    network.fault(failing, op, false);
    const mark = writes(cantor.paseo).length;
    await cantor.mailer.flushOutbox();
    expect(writes(cantor.paseo).slice(mark).map((write) => write.mail.id)).toEqual(ids[failing]);
    expect(cantor.store.outbox()).toEqual([]);
  });

  // "other" publishes first. Wrong: matching the stored address as typed ("Probe@M2-Max") or its raw
  // local part ("Probe"); taking the first publisher.
  it("resolves an unresolved mail by the local part of to.address", async () => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "other-id", "other");
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, null, "Probe@M2-Max"));
    await cantor.mailer.flushOutbox();
    expect(writes(cantor.paseo).map((write) => [write.mail.id, write.agentId])).toEqual([["m_001", "probe-id"]]);
    expect(stamped(cantor.store, "m_001")).toBe(true);
  });

  // design step 7: the peer's published addresses are listed once per host per pass. Two unresolved
  // mails to the Mac, one pass. Wrong: listing per mail (2 calls); never listing (nothing written).
  it("lists a host's published addresses once per pass", async () => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "other-id", "other");
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, null, "probe@m2-max"));
    await cantor.store.create(outMail("m_002", MAC, null, "other@m2-max"));
    const mark = cantor.paseo.calls.length;
    await cantor.mailer.flushOutbox();
    expect(cantor.paseo.calls.slice(mark).filter((call) => call.op === "peerAddresses").map((call) => call.args)).toEqual([[MAC]]);
    expect(writes(cantor.paseo).map((write) => [write.mail.id, write.agentId])).toEqual([
      ["m_001", "probe-id"],
      ["m_002", "other-id"],
    ]);
  });

  // The directory lists the Mac disabled but online; the link stays usable, so a call would succeed.
  // Wrong: handing off to any online host, enabled or not.
  it("skips a host the directory lists as disabled", async () => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    const directory = cantor.paseo.hostDirectory.bind(cantor.paseo);
    reportHost(cantor.paseo, MAC, { enabled: false, online: true });
    await cantor.mailer.flushOutbox();
    expect(peerCalls(cantor.paseo)).toEqual([]);
    expect(stamped(cantor.store, "m_001")).toBe(false);
    // Positive control: listed enabled again, the next pass hands it off.
    cantor.paseo.hostDirectory = directory;
    await cantor.mailer.flushOutbox();
    expect(stamped(cantor.store, "m_001")).toBe(true);
  });

  // quiet-id is live but publishes nothing. Wrong: checking a resolved recipient against the published
  // list (not found, re-resolved by "quiet", nobody: skipped).
  it("hands off to a live resolved recipient that is not in the published list", async () => {
    const { cantor, mac } = await linked();
    mac.paseo.add("quiet-id");
    await cantor.store.create(outMail("m_001", MAC, "quiet-id", "quiet@m2-max"));
    await cantor.mailer.flushOutbox();
    expect(peerCalls(cantor.paseo)).toContainEqual(["peerAgent", MAC, "quiet-id"]);
    expect(writes(cantor.paseo).map((write) => [write.mail.id, write.agentId])).toEqual([["m_001", "quiet-id"]]);
    expect(stamped(cantor.store, "m_001")).toBe(true);
  });

  // Wrong: handing off to the stored agent id anyway (archived: written to old-id; missing: the write
  // throws and nothing is handed off); not normalizing the name ("Probe").
  it.each(["archived", "missing"] as const)("re-resolves the recipient by the name in to.address when it is %s", async (state) => {
    const { cantor, mac } = await linked();
    if (state === "archived") {
      mac.paseo.add("old-id");
      mac.paseo.archive("old-id");
    }
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "old-id", "Probe@m2-max"));
    await cantor.mailer.flushOutbox();
    expect(writes(cantor.paseo).map((write) => [write.mail.id, write.agentId])).toEqual([["m_001", "probe-id"]]);
    expect(stamped(cantor.store, "m_001")).toBe(true);
  });

  // The reply form "agent:old-id" has no name. decoy-id publishes the name "old-id". Wrong: reading
  // the id as a name (handed to decoy-id); a parse error stopping the host (m_002 not handed off);
  // handing off to the archived agent; reading the address kind ("agent") as the name (handed to
  // agent-id, which publishes the name "agent").
  it("treats a recipient with no name as unresolvable, and later mail still goes", async () => {
    const { cantor, mac } = await linked();
    mac.paseo.add("old-id");
    mac.paseo.archive("old-id");
    publish(mac.paseo, "decoy-id", "old-id");
    publish(mac.paseo, "agent-id", "agent");
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "old-id", "agent:old-id"));
    await cantor.store.create(outMail("m_002", MAC, "probe-id", "probe@m2-max"));
    await cantor.mailer.flushOutbox();
    expect(writes(cantor.paseo).map((write) => [write.mail.id, write.agentId])).toEqual([["m_002", "probe-id"]]);
    expect(cantor.store.outbox().map((mail) => mail.id)).toEqual(["m_001"]);
  });

  // Whether the pass resolves or rejects is not pinned. Wrong: falling back to the start() snapshot.
  it("does nothing when the directory read at the start of the pass throws", async () => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    const directory = cantor.paseo.hostDirectory.bind(cantor.paseo);
    cantor.paseo.hostDirectory = async () => Promise.reject(new Error("directory down"));
    await cantor.mailer.flushOutbox().catch(() => undefined);
    expect(peerCalls(cantor.paseo)).toEqual([]);
    expect(stamped(cantor.store, "m_001")).toBe(false);
    // Positive control: with the directory back, the next pass hands it off.
    cantor.paseo.hostDirectory = directory;
    await cantor.mailer.flushOutbox();
    expect(stamped(cantor.store, "m_001")).toBe(true);
  });

  // The first pass parks on the write; a second pass started meanwhile must not write m_001 again.
  // A correct implementation never parks a second write, so the bound is the wait. Wrong: no
  // serialization (two writes).
  it("serializes passes: two concurrent flushes write each drop once", async () => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    const release = cantor.paseo.holdWrites();
    held.push(release);
    const first = quiet(cantor.mailer.flushOutbox());
    expect(await until(() => cantor.paseo.parkedWrites >= 1)).toBe(true);
    const second = quiet(cantor.mailer.flushOutbox());
    await until(() => cantor.paseo.parkedWrites >= 2, 200);
    release();
    await Promise.all([first, second]);
    expect(cantor.paseo.parkedWrites).toBe(1);
    expect(writes(cantor.paseo).map((write) => write.mail.id)).toEqual(["m_001"]);
    expect(stamped(cantor.store, "m_001")).toBe(true);
  });

  // m_002 is stored while the first pass is parked on m_001's write. Wrong: a second call joining the
  // pass already running (it read the outbox before m_002 existed, so m_002 waits for the sweep).
  it("a flush called while a pass runs hands off mail stored after that pass began", async () => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    const release = cantor.paseo.holdWrites();
    held.push(release);
    const first = quiet(cantor.mailer.flushOutbox());
    expect(await until(() => cantor.paseo.parkedWrites >= 1)).toBe(true);
    await cantor.store.create(outMail("m_002", MAC, "probe-id", "probe@m2-max"));
    const second = quiet(cantor.mailer.flushOutbox());
    release();
    await second;
    await first;
    expect(stamped(cantor.store, "m_002")).toBe(true);
    expect(writes(cantor.paseo).map((write) => write.mail.id)).toEqual(["m_001", "m_002"]);
  });

  // Pass 1 parks on m_001's write; a second pass for m_002 (to other-id) is queued behind it; dispose()
  // runs before the write is released. The fake's release() refuses nothing, so a queued pass that
  // ran anyway would show as calls about other-id. Wrong: a pass that does not check for dispose()
  // when it starts. Positive control: the same sequence without dispose() makes the second write.
  it.each([true, false])("a pass queued before dispose() makes no peer call once dispose() has run (disposed: %s)", async (disposing) => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    publish(mac.paseo, "other-id", "other");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    const release = cantor.paseo.holdWrites();
    held.push(release);
    const first = quiet(cantor.mailer.flushOutbox());
    expect(await until(() => cantor.paseo.parkedWrites >= 1)).toBe(true);
    await cantor.store.create(outMail("m_002", MAC, "other-id", "other@m2-max"));
    const second = quiet(cantor.mailer.flushOutbox());
    const disposed = disposing ? cantor.mailer.dispose() : Promise.resolve();
    release();
    await Promise.allSettled([first, second]);
    await disposed;
    const aboutOther = peerCalls(cantor.paseo).filter(([, , agentId]) => agentId === "other-id");
    if (disposing) expect(aboutOther).toEqual([]);
    else expect(aboutOther).toEqual([
      ["peerAgent", MAC, "other-id"],
      ["writeDrop", MAC, "other-id"],
    ]);
  });

  // Wrong: calling an offline host anyway (the fake records the call before it throws).
  it("skips a host that is not online", async () => {
    const { network, cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    network.setReachable(CANTOR, MAC, false);
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    await cantor.mailer.flushOutbox();
    expect(peerCalls(cantor.paseo)).toEqual([]);
    expect(stamped(cantor.store, "m_001")).toBe(false);
    // Positive control: online again, a pass hands it off.
    network.setReachable(CANTOR, MAC, true);
    await cantor.mailer.flushOutbox();
    expect(stamped(cantor.store, "m_001")).toBe(true);
  });
});

describe("hand-off triggers and lifecycle (design steps 7 and 11)", () => {
  // Wrong: send awaiting the flush (still pending while the write is held); no flush after a send.
  it("a send starts a flush without awaiting it", async () => {
    const { cantor, mac, lead } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    const release = cantor.paseo.holdWrites();
    held.push(release);
    const sent = quiet(cantor.mailer.send(lead, ["probe@m2-max"], "s", "b"));
    expect(await Promise.race([sent.then(() => "resolved"), wait(500).then(() => "pending")])).toBe("resolved");
    expect(await until(() => cantor.paseo.parkedWrites >= 1)).toBe(true);
    const [delivery] = await sent;
    release();
    expect(await until(() => stamped(cantor.store, delivery!.mailId))).toBe(true);
  });

  // Wrong: reply awaiting the flush; no flush after a reply.
  it("a reply starts a flush without awaiting it", async () => {
    const { cantor, mac, lead } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(fromMac("m_in", { agentId: "probe-id", name: "probe", title: null }));
    const release = cantor.paseo.holdWrites();
    held.push(release);
    const replied = quiet(cantor.mailer.reply(lead, "m_in", "Answer"));
    expect(await Promise.race([replied.then(() => "resolved"), wait(500).then(() => "pending")])).toBe("resolved");
    expect(await until(() => cantor.paseo.parkedWrites >= 1)).toBe(true);
    const delivery = await replied;
    release();
    expect(await until(() => stamped(cantor.store, delivery.mailId))).toBe(true);
  });

  // The attic is linked after start() and unreachable; the mail is written straight to the store, so
  // only hostOnline can move it. Wrong: hostOnline flushing without refreshing the snapshot (display
  // stays the serverId); refreshing without flushing; no hostOnline handler.
  it("a host coming online refreshes the host snapshot and flushes", async () => {
    const { network, cantor } = await linked();
    const attic = addAttic(network, false);
    publish(attic, "keeper-id", "keeper");
    await cantor.store.create(outMail("m_001", ATTIC, "keeper-id", "keeper@attic"));
    expect(cantor.mailer.hosts().display(ATTIC)).toBe(ATTIC);
    network.setReachable(CANTOR, ATTIC, true);
    expect(await until(() => stamped(cantor.store, "m_001"))).toBe(true);
    expect(await until(() => cantor.mailer.hosts().display(ATTIC) === "attic")).toBe(true);
  });

  // Wrong: no sweep timer; sweepMs ignored (default 60 s).
  it("the sweep timer flushes on its own", async () => {
    const { cantor, mac } = await linked({ sweepMs: 20 });
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    expect(await until(() => stamped(cantor.store, "m_001"))).toBe(true);
  });

  // A pass in flight at dispose() may finish; m_002 is stored after that, so only a live timer could
  // hand it off. Wrong: dispose() not clearing the sweep timer; not awaiting release().
  it("dispose() stops the sweep and awaits the port's release", async () => {
    const { cantor, mac } = await linked({ sweepMs: 20 });
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    // Positive control: the sweep runs before dispose().
    expect(await until(() => stamped(cantor.store, "m_001"))).toBe(true);
    let released = false;
    const release = cantor.paseo.release.bind(cantor.paseo);
    cantor.paseo.release = async () => {
      await wait(20);
      await release();
      released = true;
    };
    await cantor.mailer.dispose();
    expect(released).toBe(true);
    await wait(60);
    await cantor.store.create(outMail("m_002", MAC, "probe-id", "probe@m2-max"));
    await wait(150);
    expect(stamped(cantor.store, "m_002")).toBe(false);
    expect(writes(cantor.paseo).map((write) => write.mail.id)).not.toContain("m_002");
  });

  // Wrong: dispose() leaving the sweep timer armed. A timer whose callback checks a disposed flag
  // hands nothing off, so the test above cannot see it; fake timers count what is still armed.
  it("dispose() leaves no timer armed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const { cantor, mac } = await linked({ sweepMs: 20 });
      // Positive control: the started mailers have armed their sweeps.
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await cantor.mailer.dispose();
      await mac.mailer.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // The pass is parked on m_001's write when dispose() runs; the test releases the write. The pass is
  // queued after start() returns. Wrong: dispose() as at 14b5e87a68b6 (resolves at once, and the pass
  // stamps handedOffAt afterwards); awaiting only the import queue; awaiting a hand-off idle() taken
  // before the pass was queued (it resolves at once). Positive control: once the write is released,
  // dispose() resolves.
  it("dispose() waits for a hand-off pass in flight, so nothing is stamped after it resolves", async () => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    const events: string[] = [];
    const update = cantor.store.update.bind(cantor.store);
    cantor.store.update = (ids, change) => {
      events.push("update");
      return update(ids, change);
    };
    const release = cantor.paseo.holdWrites();
    held.push(release);
    const pass = quiet(cantor.mailer.flushOutbox());
    expect(await until(() => cantor.paseo.parkedWrites >= 1)).toBe(true);
    const disposed = cantor.mailer.dispose().then(() => {
      events.push("disposed");
    });
    expect(await Promise.race([disposed.then(() => "resolved"), wait(100).then(() => "pending")])).toBe("pending");
    release();
    expect(await Promise.race([disposed.then(() => "resolved"), wait(1000).then(() => "pending")])).toBe("resolved");
    await pass;
    expect(events).toEqual(["update", "disposed"]);
  });

  // The pass is parked on m_001's write behind a gate that only release() settles: it rejects the
  // call, as the SDK rejects a closed client's calls in flight. holdWrites() can only resolve, so the
  // gate is the test's own; the test never opens it. Wrong: dispose() awaiting the queues before
  // release() (it waits on a call only release() can end; in production, the SDK's 60 s request
  // deadline). The failed write leaves m_001 in the outbox.
  it("dispose() releases the port before it waits, so a parked write ends and nothing is stamped", async () => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    let refuse!: (error: Error) => void;
    const gate = new Promise<void>((_resolve, reject) => {
      refuse = reject;
    });
    gate.catch(() => undefined);
    held.push(() => refuse(new Error("test over")));
    let parked = false;
    const write = cantor.paseo.writeDrop.bind(cantor.paseo);
    cantor.paseo.writeDrop = async (serverId, agentId, mail) => {
      parked = true;
      await gate;
      return write(serverId, agentId, mail);
    };
    const release = cantor.paseo.release.bind(cantor.paseo);
    cantor.paseo.release = async () => {
      refuse(new Error("client closed"));
      await release();
    };
    const pass = quiet(cantor.mailer.flushOutbox());
    expect(await until(() => parked)).toBe(true);
    const disposed = cantor.mailer.dispose();
    expect(await Promise.race([disposed.then(() => "resolved"), wait(1000).then(() => "pending")])).toBe("resolved");
    await pass;
    expect(stamped(cantor.store, "m_001")).toBe(false);
    expect(writes(cantor.paseo)).toEqual([]);
    expect(cantor.store.outbox().map((mail) => mail.id)).toEqual(["m_001"]);
  });

  // The pass is parked on m_001's write when dispose() runs; the test releases the write. store.close()
  // only waits for the store's own queue and refuses no later write, so the log records each call when
  // it is made. Wrong: closing the store alongside the queue wait (a Promise.all of release(), idle()
  // and close()); dispose() as at 14b5e87a68b6. Both log the close before the stamp.
  it("dispose() closes the store only after a hand-off pass in flight has stamped", async () => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    const events: string[] = [];
    const update = cantor.store.update.bind(cantor.store);
    cantor.store.update = (ids, change) => {
      events.push("update");
      return update(ids, change);
    };
    const close = cantor.store.close.bind(cantor.store);
    cantor.store.close = () => {
      events.push("close");
      return close();
    };
    const release = cantor.paseo.holdWrites();
    held.push(release);
    const pass = quiet(cantor.mailer.flushOutbox());
    expect(await until(() => cantor.paseo.parkedWrites >= 1)).toBe(true);
    const disposed = cantor.mailer.dispose();
    release();
    await pass;
    await disposed;
    expect(events).toEqual(["update", "close"]);
  });

  // Only setInterval is faked, so the 59 s mark is reached without waiting. Wrong: any other default
  // (1 s fires before the 59 s check; 120 s has not fired at 60 s). The expected 60 s is written here.
  it("the sweep runs every 60 s by default", async () => {
    const DEFAULT_SWEEP_MS = 60_000;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { cantor, mac } = await linked();
      publish(mac.paseo, "probe-id", "probe");
      await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
      await vi.advanceTimersByTimeAsync(DEFAULT_SWEEP_MS - 1000);
      expect(await until(() => stamped(cantor.store, "m_001"), 300)).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await until(() => stamped(cantor.store, "m_001"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // start() handles the watch() throw on its own. Wrong: rethrowing it, which skips the sweep (and the
  // startup flush). m_001 is stored after start(), so only the sweep can move it.
  it("a watch() that throws does not stop the sweep", async () => {
    const { cantor, mac } = await unstarted({ sweepMs: 20 });
    cantor.paseo.watch = () => {
      throw new Error("watch down");
    };
    publish(mac, "probe-id", "probe");
    const started = await cantor.mailer.start().then(
      () => "resolved",
      () => "rejected",
    );
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    expect(await until(() => stamped(cantor.store, "m_001"))).toBe(true);
    expect(started).toBe("resolved");
  });

  // Mail stored before start(), the default 60 s sweep, no send. Wrong: start() without its own flush.
  it("start() hands off mail already in the outbox", async () => {
    const { cantor, mac } = await unstarted();
    publish(mac, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    await cantor.mailer.start();
    expect(await until(() => stamped(cantor.store, "m_001"), 500)).toBe(true);
  });

  // index.server.ts does not await start(); here start() is parked in its backfill when dispose() runs.
  // Wrong: start() going on to watch the port and arm the sweep after dispose().
  it("start() watches nothing and arms no timer when dispose() ran while it was in flight", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { cantor } = await unstarted({ sweepMs: 20 });
      await cantor.registry.set({ agentId: "a-carol", name: "carol", roles: [], workspaceId: null, projectId: null, updatedAt: "2026-11-22T10:00:00.000Z" });
      const release = cantor.paseo.holdPublishes();
      held.push(release);
      const started = cantor.mailer.start();
      expect(await until(() => cantor.paseo.parkedPublishes >= 1)).toBe(true);
      await cantor.mailer.dispose();
      release();
      await started;
      expect(cantor.paseo.calls.map((call) => call.op)).not.toContain("watch");
      expect(vi.getTimerCount()).toBe(0);
      // Positive control: a start() nobody disposes watches the port and arms one sweep.
      const other = await unstarted({ sweepMs: 20 });
      await other.cantor.mailer.start();
      expect(other.cantor.paseo.calls.map((call) => call.op)).toContain("watch");
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
