import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTIC, CANTOR, DROP_PREFIX, MAC, OUT_PREFIX, digestOf, mailOf, linkedHosts, park, publish, recordOf, reportHost, reversedKeys, setup, setupPair, sha256, until, wait, type FakeNetwork, type FakePaseo } from "../test/fixtures";
import { handOffDigest, type Mailer, type MailerOptions } from "./mailer";
import { UserError, type HandOffRecord, type Mail } from "./types";

// Task 5 of paseo-mail#xsbz: outbox writers and hand-off (design steps 6, 7, 9 and 11).

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

describe("cross-host subject and body cap (paseo-mail#6d9k)", () => {
  const subjectHalf = "€".repeat(5461) + "x";
  const bodyHalf = "🙂".repeat(4096);

  // The split content fits under separate limits. Surrogate halves must be encoded as separate fields.
  it.each([
    { kind: "subject only", subject: subjectHalf.repeat(2), body: "", extraSubject: "x", extraBody: "" },
    { kind: "body only", subject: "", body: subjectHalf.repeat(2), extraSubject: "", extraBody: "x" },
    { kind: "subject and body", subject: subjectHalf, body: bodyHalf, extraSubject: "", extraBody: "x" },
    { kind: "fields with split surrogate halves", subject: "x".repeat(32762) + "\uD83D", body: "\uDE42", extraSubject: "x", extraBody: "" },
  ])("accepts exactly 32 KiB in the $kind and refuses one byte more", async ({ subject, body, extraSubject, extraBody }) => {
    expect(Buffer.byteLength(subject, "utf8") + Buffer.byteLength(body, "utf8")).toBe(32768);
    const oversizedSubject = extraSubject + subject;
    const oversizedBody = body + extraBody;
    expect(Buffer.byteLength(oversizedSubject, "utf8") + Buffer.byteLength(oversizedBody, "utf8")).toBe(32769);
    const { network, cantor, lead } = await linked();
    network.setReachable(CANTOR, MAC, false);
    const to = ["probe@m2-max"];
    const [delivery] = await cantor.mailer.send(lead, to, subject, body);
    expect(cantor.store.get(delivery!.mailId)).toMatchObject({ subject, body });
    const before = cantor.store.revision;
    await expect.soft(cantor.mailer.send(lead, to, oversizedSubject, oversizedBody)).rejects.toBeInstanceOf(UserError);
    expect.soft(cantor.store.revision).toBe(before);
    expect(cantor.store.outbox().map((mail) => mail.id)).toEqual([delivery!.mailId]);
  });

  // Wrong: checking the cap per copy as it is stored (bob's local copy lands first); capping every
  // send (the local-only sends are refused); capping nothing.
  it("refuses a mixed local + remote send over the cap with no copy at all; a local-only send is uncapped", async () => {
    const { network, cantor, lead } = await linked();
    await cantor.mailer.register(cantor.paseo.add("bob-id", { title: "Bob" }), { name: "bob" });
    network.setReachable(CANTOR, MAC, false);
    const oversizedBody = bodyHalf + "x";
    const before = cantor.store.revision;
    await expect.soft(cantor.mailer.send(lead, ["bob", "probe@m2-max"], subjectHalf, oversizedBody)).rejects.toBeInstanceOf(UserError);
    expect.soft(cantor.store.revision).toBe(before);
    expect(cantor.store.all().map((mail) => mail.id)).toEqual([]);
    // Bob alone can receive the same content, or a much larger subject and body.
    expect(await cantor.mailer.send(lead, ["bob"], subjectHalf, oversizedBody)).toMatchObject([{ agentId: "bob-id", serverId: null }]);
    const hugeSubject = "s".repeat(1048576);
    const hugeBody = "€".repeat(40_000);
    const [local] = await cantor.mailer.send(lead, ["bob"], hugeSubject, hugeBody);
    expect(cantor.store.get(local!.mailId)).toMatchObject({ subject: hugeSubject, body: hugeBody });
    const mixed = await cantor.mailer.send(lead, ["bob", "probe@m2-max"], subjectHalf, bodyHalf);
    expect(mixed.map((delivery) => delivery.serverId ?? "local").sort()).toEqual(["local", MAC]);
    expect(cantor.mailer.unreadCount("bob-id")).toBe(3);
  });

  it("refuses a 1 MiB subject in a remote send with a short body", async () => {
    const { network, cantor, lead } = await linked();
    network.setReachable(CANTOR, MAC, false);
    const refused = cantor.mailer.send(lead, ["probe@m2-max"], "s".repeat(1048576), "b");
    await expect.soft(refused).rejects.toBeInstanceOf(UserError);
    await expect.soft(refused).rejects.toThrow(/subject and body.*32768 bytes/i);
    expect(cantor.store.all().map((mail) => mail.id)).toEqual([]);
  });

  it.each([
    { kind: "a generated prefix", prefix: "", replyPrefix: "Re: " },
    { kind: "an existing prefix", prefix: "re: ", replyPrefix: "" },
  ])("includes the reply subject with $kind in the cross-host cap", async ({ prefix, replyPrefix }) => {
    const { network, cantor, lead } = await linked();
    network.setReachable(CANTOR, MAC, false);
    const original = fromMac("m_in", { agentId: "probe-id", name: "probe", title: "Probe" });
    original.subject = prefix + "é".repeat(16381);
    await cantor.store.create(original);
    const subject = replyPrefix + original.subject;
    expect(Buffer.byteLength(subject + "é", "utf8")).toBe(32768);
    expect(Buffer.byteLength(subject + "éx", "utf8")).toBe(32769);
    const before = cantor.store.revision;
    await expect.soft(cantor.mailer.reply(lead, "m_in", "éx")).rejects.toBeInstanceOf(UserError);
    expect.soft(cantor.store.revision).toBe(before);
    expect.soft(cantor.store.all().map((mail) => mail.id)).toEqual(["m_in"]);
    const delivery = await cantor.mailer.reply(lead, "m_in", "é");
    expect(delivery).toMatchObject({ serverId: MAC, agentId: "probe-id" });
    expect(cantor.store.get(delivery.mailId)).toMatchObject({ subject, body: "é" });
  });

  it("allows an oversized reply to a live local sender", async () => {
    const { cantor, lead } = await linked();
    const bob = cantor.paseo.add("bob-id", { title: "Bob" });
    const [original] = await cantor.mailer.send(bob, ["lead"], "Question", "?");
    const body = "x".repeat(32769);

    const delivery = await cantor.mailer.reply(lead, original!.mailId, body);

    expect(delivery).toMatchObject({ agentId: "bob-id", serverId: null });
    expect(cantor.mailer.list("bob-id")).toMatchObject([{ id: delivery.mailId, subject: "Re: Question", body }]);
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
    const write = park(cantor.paseo, "writeDrop");
    held.push(write.open);
    const flush = quiet(cantor.mailer.flushOutbox());
    expect(await until(() => write.parked >= 1)).toBe(true);
    await wait(20);
    expect(stamped(cantor.store, "m_001")).toBe(false);
    write.open();
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

  it("keeps mail queued for a host that rejects without a reason and hands off to the other host", async () => {
    const { network, cantor, mac } = await sender();
    const attic = addAttic(network);
    publish(attic, "keeper-id", "keeper");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    await cantor.store.create(outMail("m_002", ATTIC, "keeper-id", "keeper@attic"));
    await cantor.store.create(outMail("m_003", MAC, "probe-id", "probe@m2-max"));
    const writeDrop = cantor.paseo.writeDrop.bind(cantor.paseo);
    cantor.paseo.writeDrop = async (serverId, agentId, mail) => {
      if (serverId === MAC) return Promise.reject();
      await writeDrop(serverId, agentId, mail);
    };

    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await cantor.mailer.flushOutbox();
      expect(errors).toHaveBeenCalledExactlyOnceWith(
        `[paseo-mail] handing mail to ${MAC} failed; retrying on the next pass:`,
        "undefined",
      );
    } finally {
      errors.mockRestore();
    }
    expect(cantor.store.outbox().map((mail) => mail.id)).toEqual(["m_001", "m_003"]);
    expect(mac.metadata.get("probe-id")?.[`${DROP_PREFIX}m_001`]).toBeUndefined();
    expect(mac.metadata.get("probe-id")?.[`${DROP_PREFIX}m_003`]).toBeUndefined();
    expect(attic.metadata.get("keeper-id")?.[`${DROP_PREFIX}m_002`]).toMatchObject({ id: "m_002" });
    expect(stamped(cantor.store, "m_002")).toBe(true);
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
    const write = park(cantor.paseo, "writeDrop");
    held.push(write.open);
    const first = quiet(cantor.mailer.flushOutbox());
    expect(await until(() => write.parked >= 1)).toBe(true);
    const second = quiet(cantor.mailer.flushOutbox());
    await until(() => write.parked >= 2, 200);
    write.open();
    await Promise.all([first, second]);
    expect(write.parked).toBe(1);
    expect(writes(cantor.paseo).map((write) => write.mail.id)).toEqual(["m_001"]);
    expect(stamped(cantor.store, "m_001")).toBe(true);
  });

  // Wrong: scheduling a separate pass for each request made before the first pass starts.
  it("shares one hand-off pass for flushes requested before it starts", async () => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    const mark = cantor.paseo.calls.length;
    await Promise.all([cantor.mailer.flushOutbox(), cantor.mailer.flushOutbox()]);
    expect(writes(cantor.paseo).map((write) => write.mail.id)).toEqual(["m_001"]);
    expect(stamped(cantor.store, "m_001")).toBe(true);
    expect(cantor.paseo.calls.slice(mark).filter((call) => call.op === "hostDirectory")).toHaveLength(1);
  });

  // Wrong: joining the running pass leaves m_002 waiting; an ordinary FIFO does a directory read
  // for every request; concurrent passes read the directory again while the first write is parked.
  it("coalesces a burst of flushes into one later pass that hands off late mail", async () => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    const write = park(cantor.paseo, "writeDrop");
    held.push(write.open);
    const mark = cantor.paseo.calls.length;
    const starts = () => cantor.paseo.calls.slice(mark).filter((call) => call.op === "hostDirectory");
    const first = quiet(cantor.mailer.flushOutbox());
    expect(await until(() => write.parked >= 1)).toBe(true);
    await cantor.store.create(outMail("m_002", MAC, "probe-id", "probe@m2-max"));
    const burst = Array.from({ length: 4 }, () => quiet(cantor.mailer.flushOutbox().then(() => {
      expect(stamped(cantor.store, "m_002")).toBe(true);
    })));
    await wait(0);
    expect(starts()).toHaveLength(1);
    write.open();
    await Promise.all([first, ...burst]);
    expect(starts()).toHaveLength(2);
    expect(writes(cantor.paseo).map((write) => write.mail.id)).toEqual(["m_001", "m_002"]);
  });

  // Wrong: translating a waiting hand-off's rejection to success for a caller joining that pass.
  it("every flush sharing a waiting hand-off sees its rejection", async () => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    const write = park(cantor.paseo, "writeDrop");
    held.push(write.open);
    const first = quiet(cantor.mailer.flushOutbox());
    expect(await until(() => write.parked === 1)).toBe(true);
    await cantor.store.create(outMail("m_002", MAC, "probe-id", "probe@m2-max"));
    const followers = Promise.allSettled([cantor.mailer.flushOutbox(), cantor.mailer.flushOutbox()]);
    const directory = park(cantor.paseo, "hostDirectory");
    held.push(directory.open);
    write.open();
    await first;
    expect(await until(() => directory.parked === 1)).toBe(true);
    const refused = new Error("directory refused");
    directory.refuse(refused);
    expect(await followers).toEqual([
      { status: "rejected", reason: refused },
      { status: "rejected", reason: refused },
    ]);
    expect(writes(cantor.paseo).map((write) => write.mail.id)).toEqual(["m_001"]);
    expect(stamped(cantor.store, "m_002")).toBe(false);
    await cantor.mailer.flushOutbox();
    expect(writes(cantor.paseo).map((write) => write.mail.id)).toEqual(["m_001", "m_002"]);
    expect(stamped(cantor.store, "m_002")).toBe(true);
  });

  // Wrong: hand-off waiting for the import lane to finish while its drop listing is parked.
  it("writes and stamps an outgoing drop while import is listing drops", async () => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    const listing = park(cantor.paseo, "localDrops");
    held.push(listing.open);
    const importing = quiet(cantor.mailer.importDrops());
    expect(await until(() => listing.parked === 1)).toBe(true);
    const flushing = quiet(cantor.mailer.flushOutbox());
    try {
      expect(await until(() => stamped(cantor.store, "m_001"))).toBe(true);
      expect(writes(cantor.paseo).map((write) => [write.mail.id, write.agentId])).toEqual([["m_001", "probe-id"]]);
    } finally {
      listing.open();
      await Promise.all([importing, flushing]);
    }
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
    const write = park(cantor.paseo, "writeDrop");
    held.push(write.open);
    const mark = cantor.paseo.calls.length;
    const first = quiet(cantor.mailer.flushOutbox());
    expect(await until(() => write.parked >= 1)).toBe(true);
    await cantor.store.create(outMail("m_002", MAC, "other-id", "other@m2-max"));
    const second = quiet(cantor.mailer.flushOutbox());
    const third = quiet(cantor.mailer.flushOutbox());
    const disposed = disposing ? cantor.mailer.dispose() : Promise.resolve();
    write.open();
    await Promise.all([first, second, third]);
    await disposed;
    expect(cantor.paseo.calls.slice(mark).filter((call) => call.op === "hostDirectory")).toHaveLength(disposing ? 1 : 2);
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
    const write = park(cantor.paseo, "writeDrop");
    held.push(write.open);
    const sent = quiet(cantor.mailer.send(lead, ["probe@m2-max"], "s", "b"));
    expect(await Promise.race([sent.then(() => "resolved"), wait(500).then(() => "pending")])).toBe("resolved");
    expect(await until(() => write.parked >= 1)).toBe(true);
    const [delivery] = await sent;
    write.open();
    expect(await until(() => stamped(cantor.store, delivery!.mailId))).toBe(true);
  });

  // Wrong: reply awaiting the flush; no flush after a reply.
  it("a reply starts a flush without awaiting it", async () => {
    const { cantor, mac, lead } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(fromMac("m_in", { agentId: "probe-id", name: "probe", title: null }));
    const write = park(cantor.paseo, "writeDrop");
    held.push(write.open);
    const replied = quiet(cantor.mailer.reply(lead, "m_in", "Answer"));
    expect(await Promise.race([replied.then(() => "resolved"), wait(500).then(() => "pending")])).toBe("resolved");
    expect(await until(() => write.parked >= 1)).toBe(true);
    const delivery = await replied;
    write.open();
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
    const write = park(cantor.paseo, "writeDrop");
    held.push(write.open);
    const pass = quiet(cantor.mailer.flushOutbox());
    expect(await until(() => write.parked >= 1)).toBe(true);
    const disposed = cantor.mailer.dispose().then(() => {
      events.push("disposed");
    });
    expect(await Promise.race([disposed.then(() => "resolved"), wait(100).then(() => "pending")])).toBe("pending");
    write.open();
    expect(await Promise.race([disposed.then(() => "resolved"), wait(1000).then(() => "pending")])).toBe("resolved");
    await pass;
    expect(events).toEqual(["update", "disposed"]);
  });

  // The pass is parked on m_001's write behind a gate that only release() settles: it rejects the
  // call, as the SDK rejects a closed client's calls in flight. Wrong: dispose() awaiting the queues
  // before release() (it waits on a call only release() can end; in production, the SDK's 60 s
  // request deadline). The failed write leaves m_001 in the outbox.
  it("dispose() releases the port before it waits, so a parked write ends and nothing is stamped", async () => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    const write = park(cantor.paseo, "writeDrop", { refuseOnRelease: new Error("client closed") });
    held.push(() => write.refuse(new Error("test over")));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const pass = quiet(cantor.mailer.flushOutbox());
      expect(await until(() => write.parked === 1)).toBe(true);
      const disposed = cantor.mailer.dispose();
      expect(await Promise.race([disposed.then(() => "resolved"), wait(1000).then(() => "pending")])).toBe("resolved");
      await pass;
      expect(stamped(cantor.store, "m_001")).toBe(false);
      expect(writes(cantor.paseo)).toEqual([]);
      expect(cantor.store.outbox().map((mail) => mail.id)).toEqual(["m_001"]);
      expect(errors.mock.calls).toEqual([[`[paseo-mail] handing mail to ${MAC} failed; retrying on the next pass:`, "client closed"]]);
    } finally {
      errors.mockRestore();
    }
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
    const write = park(cantor.paseo, "writeDrop");
    held.push(write.open);
    const pass = quiet(cantor.mailer.flushOutbox());
    expect(await until(() => write.parked >= 1)).toBe(true);
    const disposed = cantor.mailer.dispose();
    write.open();
    await pass;
    await disposed;
    expect(events).toEqual(["update", "close"]);
  });

  // release() is parked on a test gate (the port's real release() waits for the peer clients to
  // close), and a flush is called meanwhile with m_001 in the outbox for an online host. Wrong:
  // dispose() marking itself disposed only after release() resolves (the pass starts, writes the
  // drop and stamps m_001). Positive control: the same flush without dispose() writes and stamps.
  it.each([true, false])("a flush called while dispose() awaits release() makes no peer call or stamp (disposed: %s)", async (disposing) => {
    const { cantor, mac } = await linked();
    publish(mac.paseo, "probe-id", "probe");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    const releasing = park(cantor.paseo, "release");
    held.push(releasing.open);
    const updates: string[][] = [];
    const update = cantor.store.update.bind(cantor.store);
    cantor.store.update = (ids, change) => {
      updates.push(ids);
      return update(ids, change);
    };
    const mark = cantor.paseo.calls.length;
    const disposed = disposing ? cantor.mailer.dispose() : Promise.resolve();
    if (disposing) expect(await until(() => releasing.parked === 1)).toBe(true);
    const flushed = quiet(cantor.mailer.flushOutbox());
    expect(await Promise.race([flushed.then(() => "settled", () => "settled"), wait(1000).then(() => "pending")])).toBe("settled");
    releasing.open();
    await disposed;
    const ops = cantor.paseo.calls.slice(mark).map((call) => call.op).filter((op) => PEER_OPS.has(op));
    if (disposing) {
      expect(ops).toEqual([]);
      expect(updates).toEqual([]);
    } else {
      expect(ops).toEqual(["peerAgent", "writeDrop"]);
      expect(updates).toEqual([["m_001"]]);
    }
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
      const publishing = park(cantor.paseo, "publishAddress");
      const started = cantor.mailer.start();
      try {
        expect(await until(() => publishing.parked === 1)).toBe(true);
        const disposed = cantor.mailer.dispose();
        expect(await Promise.race([disposed.then(() => "resolved"), wait(1000).then(() => "pending")])).toBe("resolved");
      } finally {
        publishing.open();
        await started;
      }
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

// paseo-mail#qkf2 Task 1: before each drop write, the hand-off writes a record on the sending agent.

/** The recordHandOff calls a port recorded, in order. */
function records(paseo: FakePaseo): { agentId: unknown; mailId: unknown; record: unknown }[] {
  return paseo.calls.filter((call) => call.op === "recordHandOff").map((call) => ({ agentId: call.args[0], mailId: call.args[1], record: call.args[2] }));
}

/** The record and drop writes a port recorded, as [op, mail id], in order. */
function recordsAndDrops(paseo: FakePaseo): unknown[][] {
  return paseo.calls
    .filter((call) => call.op === "recordHandOff" || call.op === "writeDrop")
    .map((call) => [call.op, call.op === "writeDrop" ? (call.args[2] as Mail).id : call.args[1]]);
}

/** Every paseo-mail.out.* key on a daemon, as "<agentId> <key>". */
function outKeys(paseo: FakePaseo): string[] {
  return [...paseo.metadata].flatMap(([agentId, entries]) => Object.keys(entries).filter((key) => key.startsWith(OUT_PREFIX)).map((key) => `${agentId} ${key}`));
}

/** Runs `action` with console.error silenced; returns each line it logged, its arguments joined by spaces. */
async function logged(action: () => Promise<unknown>): Promise<string[]> {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await action();
    return errors.mock.calls.map((call) => call.map(String).join(" "));
  } finally {
    errors.mockRestore();
  }
}

/**
 * cantor's started Mailer, with "lead-id" live on cantor and "probe" published on the Mac. No mailer
 * runs on the Mac, so nothing there imports a drop (or, once the importer confirms, clears a record).
 */
async function sender() {
  const { network, cantor, mac } = await unstarted();
  await cantor.mailer.start();
  cantor.paseo.add("lead-id", { title: "Lead" });
  publish(mac, "probe-id", "probe", "Probe");
  return { network, cantor, mac };
}

/** The record lead's m_001 to probe-id on the Mac must carry, from outMail's fields and cantor's serverId. */
function recordOfM001(): HandOffRecord {
  const drop = outMail("m_001", MAC, "probe-id", "probe@m2-max");
  return recordOf({ ...drop, from: { ...drop.from, serverId: CANTOR } }, MAC, "probe-id");
}

describe("hand-off record (paseo-mail#qkf2)", () => {
  // The stored to.agentId (old-id) is archived on the Mac, so the hand-off re-resolves "Probe" to
  // probe-id; threadId and inReplyTo differ from the id so no two digest fields share a value.
  // Wrong: the record on the recipient agent or on the Mac instead of on lead-id on cantor; to.agentId
  // from mail.to.agentId (old-id); to.serverId as cantor's own serverId; the digest over the outbox
  // copy (from.serverId null) instead of the drop as written (from.serverId cantor).
  it("writes paseo-mail.out.<id> on the sending agent: the recipient host, the agent the drop went to, and the digest of the drop", async () => {
    const { cantor, mac } = await sender();
    mac.add("old-id");
    mac.archive("old-id");
    const stored = mailOf({
      id: "m_001",
      threadId: "m_009",
      inReplyTo: "m_00a",
      from: { agentId: "lead-id", name: "lead", title: "Lead", serverId: null },
      to: { agentId: "old-id", address: "Probe@m2-max", serverId: MAC },
      subject: "Status",
      body: "All green",
    });
    await cantor.store.create(stored);
    await cantor.mailer.flushOutbox();
    const expected = recordOf({ ...stored, from: { ...stored.from, serverId: CANTOR } }, MAC, "probe-id");
    expect(expected.digest).not.toBe(digestOf(stored));
    expect(records(cantor.paseo)).toStrictEqual([{ agentId: "lead-id", mailId: "m_001", record: expected }]);
    expect(cantor.paseo.metadata.get("lead-id")?.[`${OUT_PREFIX}m_001`]).toStrictEqual(expected);
    expect(outKeys(cantor.paseo)).toEqual([`lead-id ${OUT_PREFIX}m_001`]);
    expect(outKeys(mac)).toEqual([]);
    // The drop the record describes went to probe-id, stamped with cantor's serverId.
    expect(writes(cantor.paseo)).toMatchObject([{ serverId: MAC, agentId: "probe-id", mail: { id: "m_001", from: { serverId: CANTOR } } }]);
    expect(stamped(cantor.store, "m_001")).toBe(true);
  });

  // The drop write fails. Wrong: the record written after the drop (no record when the drop write
  // fails); stamping anyway. Positive control: the next pass rewrites the same record, then the drop.
  it("writes the record before the drop: a failing drop write leaves the record, and the retry rewrites it", async () => {
    const { network, cantor, mac } = await sender();
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    network.fault(MAC, "writeDrop", true);
    await cantor.mailer.flushOutbox().catch(() => undefined);
    const expected = recordOfM001();
    expect(recordsAndDrops(cantor.paseo)).toEqual([
      ["recordHandOff", "m_001"],
      ["writeDrop", "m_001"],
    ]);
    expect(cantor.paseo.metadata.get("lead-id")?.[`${OUT_PREFIX}m_001`]).toStrictEqual(expected);
    expect(stamped(cantor.store, "m_001")).toBe(false);
    network.fault(MAC, "writeDrop", false);
    await cantor.mailer.flushOutbox();
    expect(recordsAndDrops(cantor.paseo)).toEqual([
      ["recordHandOff", "m_001"],
      ["writeDrop", "m_001"],
      ["recordHandOff", "m_001"],
      ["writeDrop", "m_001"],
    ]);
    expect(records(cantor.paseo).map((call) => call.record)).toStrictEqual([expected, expected]);
    expect(cantor.paseo.metadata.get("lead-id")?.[`${OUT_PREFIX}m_001`]).toStrictEqual(expected);
    expect(mac.metadata.get("probe-id")?.[`${DROP_PREFIX}m_001`]).toMatchObject({ id: "m_001" });
    expect(stamped(cantor.store, "m_001")).toBe(true);
  });

  // The sending agent exists (live, or archived: the daemon still has it), and every record write is
  // refused. Wrong: writing the drop anyway (a writeDrop call); taking the agent for gone and going on
  // to m_002 (a second recordHandOff call); stamping; stopping the host without reporting the refusal
  // (no log line naming the Mac and the refusal). Positive control: with writes accepted again, the
  // next pass hands both over in order.
  it.each(["live", "archived"] as const)("a refused record write for a %s sending agent writes no drop and stops the host for the pass", async (state) => {
    const { cantor } = await sender();
    if (state === "archived") cantor.paseo.archive("lead-id");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    await cantor.store.create(outMail("m_002", MAC, "probe-id", "probe@m2-max"));
    cantor.paseo.failRecords = true;
    const lines = await logged(() => cantor.mailer.flushOutbox().catch(() => undefined));
    expect(lines.some((line) => line.includes(MAC) && line.includes("metadata write refused"))).toBe(true);
    expect(records(cantor.paseo).map((call) => call.mailId)).toEqual(["m_001"]);
    expect(writes(cantor.paseo)).toEqual([]);
    expect(cantor.store.outbox().map((mail) => mail.id)).toEqual(["m_001", "m_002"]);
    cantor.paseo.failRecords = false;
    await cantor.mailer.flushOutbox();
    expect(writes(cantor.paseo).map((write) => write.mail.id)).toEqual(["m_001", "m_002"]);
    expect(cantor.store.outbox()).toEqual([]);
  });

  // The daemon refuses a metadata write on an agent it does not have; the fake writes anyway, so the
  // test refuses exactly the writes on agents cantor does not have, with the same error text as a
  // refusal on a live agent (no telling the two apart by message). m_001's sender (gone-id) was never
  // on cantor; m_002 comes after it in id order, from lead-id. Wrong: the refusal stopping the host
  // (m_002 not handed off); stamping m_001; writing m_001's drop without a record; dropping m_001
  // from the store; no log. Positive control: m_002, in the same pass.
  it("a refused record write for a sending agent that no longer exists leaves that mail in the outbox and later mail still goes", async () => {
    const { cantor, mac } = await sender();
    await cantor.store.create(mailOf({ id: "m_001", from: { agentId: "gone-id", name: "gone", title: null, serverId: null }, to: { agentId: "probe-id", address: "probe@m2-max", serverId: MAC } }));
    await cantor.store.create(outMail("m_002", MAC, "probe-id", "probe@m2-max"));
    const record = cantor.paseo.recordHandOff.bind(cantor.paseo);
    cantor.paseo.recordHandOff = async (agentId, mailId, value) => {
      cantor.paseo.failRecords = !cantor.paseo.agents.has(agentId);
      return record(agentId, mailId, value);
    };
    expect(await cantor.paseo.agent("gone-id")).toBeNull();
    const lines = await logged(() => cantor.mailer.flushOutbox());
    expect(records(cantor.paseo).map((call) => [call.agentId, call.mailId])).toEqual([
      ["gone-id", "m_001"],
      ["lead-id", "m_002"],
    ]);
    expect(writes(cantor.paseo).map((write) => [write.mail.id, write.agentId])).toEqual([["m_002", "probe-id"]]);
    expect(mac.metadata.get("probe-id")?.[`${DROP_PREFIX}m_001`]).toBeUndefined();
    expect(stamped(cantor.store, "m_002")).toBe(true);
    expect(cantor.store.outbox().map((mail) => mail.id)).toEqual(["m_001"]);
    expect(stamped(cantor.store, "m_001")).toBe(false);
    expect(lines.some((line) => line.includes("m_001"))).toBe(true);
  });

  // Wrong: treating an archived sender as gone (looked up first, or after a write that succeeded),
  // so its mail stays in the outbox with no record.
  it("hands off an archived sending agent's mail with its record", async () => {
    const { cantor, mac } = await sender();
    cantor.paseo.archive("lead-id");
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    await cantor.mailer.flushOutbox();
    expect(records(cantor.paseo)).toStrictEqual([{ agentId: "lead-id", mailId: "m_001", record: recordOfM001() }]);
    expect(cantor.paseo.metadata.get("lead-id")?.[`${OUT_PREFIX}m_001`]).toStrictEqual(recordOfM001());
    expect(mac.metadata.get("probe-id")?.[`${DROP_PREFIX}m_001`]).toMatchObject({ id: "m_001" });
    expect(stamped(cantor.store, "m_001")).toBe(true);
  });

  // Cannot arise today (senderOf always sets the caller), so the mail is written straight to the
  // store. Wrong: recordHandOff with a null agent; the drop written without a record; the host stopped
  // (m_002 not handed off); skipping it silently (no log line naming m_001). Positive control: m_002,
  // in the same pass.
  it("leaves a mail with no sending agent in the outbox, writes nothing for it, and later mail still goes", async () => {
    const { cantor } = await sender();
    await cantor.store.create(mailOf({ id: "m_001", from: { agentId: null, name: null, title: null, serverId: null }, to: { agentId: "probe-id", address: "probe@m2-max", serverId: MAC } }));
    await cantor.store.create(outMail("m_002", MAC, "probe-id", "probe@m2-max"));
    const lines = await logged(() => cantor.mailer.flushOutbox());
    expect(records(cantor.paseo).map((call) => call.mailId)).toEqual(["m_002"]);
    expect(writes(cantor.paseo).map((write) => write.mail.id)).toEqual(["m_002"]);
    expect(cantor.store.outbox().map((mail) => mail.id)).toEqual(["m_001"]);
    expect(lines.some((line) => line.includes("m_001"))).toBe(true);
  });

  // m_001 is for "ghost", which nobody on the Mac publishes; m_002 is for probe. Wrong: recording the
  // hand-off before the recipient is resolved (a record for m_001 that no drop will ever match).
  // Positive control: m_002's record.
  it("writes no record for a mail that reaches no single agent", async () => {
    const { cantor } = await sender();
    await cantor.store.create(outMail("m_001", MAC, null, "ghost@m2-max"));
    await cantor.store.create(outMail("m_002", MAC, "probe-id", "probe@m2-max"));
    await logged(() => cantor.mailer.flushOutbox());
    expect(records(cantor.paseo).map((call) => call.mailId)).toEqual(["m_002"]);
    expect(outKeys(cantor.paseo)).toEqual([`lead-id ${OUT_PREFIX}m_002`]);
    expect(cantor.store.outbox().map((mail) => mail.id)).toEqual(["m_001"]);
  });

  // The record write succeeds (the fake does not check the agent) but the drop write fails, and the
  // sending agent is one cantor does not have. A failed drop write is a failure of the host, whoever
  // sent the mail. Wrong: reading the failed drop write as "sender gone" (the lookup says null) and
  // going on to m_002 in the same pass. Positive control: the failure is logged against the Mac.
  it("a failed drop write stops the host for the pass even when the sending agent is gone", async () => {
    const { network, cantor } = await sender();
    await cantor.store.create(mailOf({ id: "m_001", from: { agentId: "gone-id", name: "gone", title: null, serverId: null }, to: { agentId: "probe-id", address: "probe@m2-max", serverId: MAC } }));
    await cantor.store.create(outMail("m_002", MAC, "probe-id", "probe@m2-max"));
    network.fault(MAC, "writeDrop", true);
    expect(await cantor.paseo.agent("gone-id")).toBeNull();
    const lines = await logged(() => cantor.mailer.flushOutbox().catch(() => undefined));
    expect(recordsAndDrops(cantor.paseo)).toEqual([
      ["recordHandOff", "m_001"],
      ["writeDrop", "m_001"],
    ]);
    expect(lines.some((line) => line.includes(MAC) && line.includes("writeDrop against"))).toBe(true);
    expect(cantor.store.outbox().map((mail) => mail.id)).toEqual(["m_001", "m_002"]);
  });

  // Every record write is refused and the sender lookup itself throws, so whether lead-id exists is
  // unknown. Wrong: reading the throw as "gone" (m_001 skipped, m_002's record attempted); reporting
  // the lookup's error instead of the refusal. Positive control: the refusal is logged against the Mac.
  it("a refused record write whose sender lookup throws stops the host and reports the refusal", async () => {
    const { cantor } = await sender();
    await cantor.store.create(outMail("m_001", MAC, "probe-id", "probe@m2-max"));
    await cantor.store.create(outMail("m_002", MAC, "probe-id", "probe@m2-max"));
    cantor.paseo.failRecords = true;
    cantor.paseo.agent = async () => Promise.reject(new Error("agent lookup failed"));
    const lines = await logged(() => cantor.mailer.flushOutbox().catch(() => undefined));
    expect(records(cantor.paseo).map((call) => call.mailId)).toEqual(["m_001"]);
    expect(writes(cantor.paseo)).toEqual([]);
    expect(cantor.store.outbox().map((mail) => mail.id)).toEqual(["m_001", "m_002"]);
    expect(lines.some((line) => line.includes(MAC) && line.includes("metadata write refused"))).toBe(true);
    expect(lines.filter((line) => line.includes("agent lookup failed"))).toEqual([]);
  });
});

describe("handOffDigest (paseo-mail#qkf2)", () => {
  // Every kept field has its own value (threadId and inReplyTo differ from the id, from.name from
  // from.title), and the fields the digest leaves out are set, so leaving one in shows.
  const MAIL = mailOf({
    id: "m_7q",
    threadId: "m_5p",
    inReplyTo: "m_6r",
    from: { agentId: "lead-id", name: "lead", title: "Lead Engineer", serverId: CANTOR },
    to: { agentId: "probe-id", address: "Probe@m2-max", serverId: MAC },
    subject: "Status report",
    body: "All green on cantor",
    createdAt: "2026-11-23T08:15:00.000Z",
  });
  const FIELDS = ["m_7q", "m_5p", "m_6r", "lead-id", "lead", "Lead Engineer", CANTOR, "Probe@m2-max", "Status report", "All green on cantor", "2026-11-23T08:15:00.000Z"];
  const EXPECTED = sha256(FIELDS);

  // Wrong: hashing JSON.stringify(mail); another hash or encoding (sha1, base64, upper-case hex);
  // subject and body, or from.name and from.title, in the other order.
  it("is the lower-case hex SHA-256 of JSON.stringify of the kept fields in their fixed order", () => {
    const swapped = (a: number, b: number) => FIELDS.map((value, index) => (index === a ? FIELDS[b] : index === b ? FIELDS[a] : value));
    // The fixture tells those orders apart.
    expect(EXPECTED).not.toBe(sha256(swapped(8, 9)));
    expect(EXPECTED).not.toBe(sha256(swapped(4, 5)));
    expect(EXPECTED).not.toBe(sha256(MAIL));
    expect(handOffDigest(MAIL)).toBe(EXPECTED);
    expect(handOffDigest(MAIL)).toMatch(/^[0-9a-f]{64}$/);
    // Swapping the subject and body values gives the digest of the swapped list.
    const bodyFirst = { ...MAIL, subject: MAIL.body, body: MAIL.subject };
    expect(handOffDigest(bodyFirst)).toBe(sha256(swapped(8, 9)));
    expect(handOffDigest(bodyFirst)).not.toBe(EXPECTED);
  });

  // Wrong: leaving any kept field out (its change would not show).
  const changes: [string, (mail: Mail) => Mail][] = [
    ["id", (mail) => ({ ...mail, id: "m_7z" })],
    ["threadId", (mail) => ({ ...mail, threadId: "m_5z" })],
    ["inReplyTo", (mail) => ({ ...mail, inReplyTo: null })],
    ["from.agentId", (mail) => ({ ...mail, from: { ...mail.from, agentId: "other-id" } })],
    ["from.name", (mail) => ({ ...mail, from: { ...mail.from, name: null } })],
    ["from.title", (mail) => ({ ...mail, from: { ...mail.from, title: null } })],
    ["from.serverId", (mail) => ({ ...mail, from: { ...mail.from, serverId: ATTIC } })],
    ["to.address", (mail) => ({ ...mail, to: { ...mail.to, address: "probe@m2-max" } })],
    ["subject", (mail) => ({ ...mail, subject: "Status" })],
    ["body", (mail) => ({ ...mail, body: "All green" })],
    ["createdAt", (mail) => ({ ...mail, createdAt: "2026-11-23T08:16:00.000Z" })],
  ];
  it.each(changes)("changes when %s changes", (_field, change) => {
    const changed = change(MAIL);
    expect(handOffDigest(changed)).toBe(digestOf(changed));
    expect(handOffDigest(changed)).not.toBe(EXPECTED);
  });

  // The drop's to.agentId may be stale (the hand-off can re-resolve the holder), and the stamps are
  // not imported. Wrong: hashing the whole mail, or its values in key order (the reordered copy and
  // the stamped copy differ).
  it("ignores to.agentId, to.serverId, the stamps and the key order of the mail object", () => {
    const withStamps = { ...MAIL, to: { ...MAIL.to, agentId: "other-id", serverId: null }, readAt: "2026-11-23T09:00:00.000Z", nudgedAt: "2026-11-23T09:01:00.000Z", bouncedAt: "2026-11-23T09:02:00.000Z", seenAt: "2026-11-23T09:03:00.000Z", handedOffAt: "2026-11-23T09:04:00.000Z" };
    const reordered = reversedKeys(MAIL);
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(MAIL));
    expect(handOffDigest(withStamps)).toBe(EXPECTED);
    expect(handOffDigest(reordered)).toBe(EXPECTED);
  });
});
