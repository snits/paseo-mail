import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeNetwork, setup, setupPair, type FakePaseo } from "../test/fixtures";
import type { Mailer, MailerOptions } from "./mailer";
import type { HostEntry, Mail } from "./types";

// Task 6 of paseo-mail#xsbz: the importer (design step 8) and the two-daemon end-to-end cases
// (acceptance 8, 9 and 12). The archive-bounce half of step 9 is in mailer.test.ts.

const CANTOR = "srv_Cantor01";
const MAC = "srv_EntwLoR9srmD";
const DROP_PREFIX = "paseo-mail.in.";
/** The named idle nudge for one mail, written out here rather than read from nudgeText(). */
const NUDGE_ONE = "[paseo-mail] You have 1 unread mail. Call mail_list to see them.";

const mailers: Mailer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(mailers.splice(0).map((mailer) => mailer.dispose()));
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` every 10 ms for at most `ms`; returns its last value. */
async function until(check: () => boolean, ms = 1000): Promise<boolean> {
  for (let waited = 0; !check() && waited < ms; waited += 10) await wait(10);
  return check();
}

/** cantor and the Mac, both started; "lead-id" lives on cantor, "probe-id" on the Mac, registered there as "probe". */
async function pairOf(options: MailerOptions = {}) {
  const pair = await setupPair({ debounceMs: 60_000, ...options });
  mailers.push(pair.cantor.mailer, pair.mac.mailer);
  const lead = pair.cantor.paseo.add("lead-id", { title: "Lead" });
  const probe = pair.mac.paseo.add("probe-id", { title: "Probe" });
  await pair.mac.mailer.register(probe, { name: "probe" });
  return { ...pair, lead, probe };
}

/** As pairOf, but the Mac's Mailer is built and not started. */
async function macUnstarted() {
  const network = new FakeNetwork();
  const cantorHost = network.host(CANTOR, "cantor");
  const macHost = network.host(MAC, "M2 Max");
  network.link(CANTOR, MAC, { label: "m2-max" });
  network.link(MAC, CANTOR, { label: "cantor" });
  const cantor = await setup({ debounceMs: 60_000 }, undefined, cantorHost);
  const mac = await setup({ debounceMs: 60_000 }, undefined, macHost);
  mailers.push(cantor.mailer, mac.mailer);
  await cantor.mailer.start();
  cantor.paseo.add("lead-id", { title: "Lead" });
  mac.paseo.add("probe-id", { title: "Probe" });
  return { network, cantor, mac };
}

/** A mail from lead on cantor to probe on the Mac, as cantor's hand-off writes it into the drop. */
function dropped(id: string): Mail {
  return {
    id,
    threadId: id,
    inReplyTo: null,
    from: { agentId: "lead-id", name: "lead", title: "Lead", serverId: CANTOR },
    to: { agentId: "probe-id", address: "probe@m2-max", serverId: MAC },
    subject: `subject ${id}`,
    body: `body ${id}`,
    createdAt: "2026-11-22T10:00:00.000Z",
    readAt: null,
    nudgedAt: null,
    bouncedAt: null,
    seenAt: null,
    handedOffAt: null,
  };
}

/** Writes a drop straight into the host's metadata (no watcher fires, so only an import pass sees it). */
function place(host: FakePaseo, agentId: string, mailId: string, value: unknown): void {
  host.setMetadata(agentId, { [`${DROP_PREFIX}${mailId}`]: structuredClone(value) });
}

function hasDrop(host: FakePaseo, agentId: string, mailId: string): boolean {
  return `${DROP_PREFIX}${mailId}` in (host.metadata.get(agentId) ?? {});
}

/** The clearDrop calls the port recorded, as [agentId, mailId]. */
function clears(host: FakePaseo): unknown[][] {
  return host.calls.filter((call) => call.op === "clearDrop").map((call) => call.args);
}

/** Makes the port's directory report `serverId` with the given fields changed; returns the undo. */
function reportHost(paseo: FakePaseo, serverId: string, change: Partial<HostEntry>): () => void {
  const directory = paseo.hostDirectory.bind(paseo);
  paseo.hostDirectory = async () => {
    const view = await directory();
    return { ...view, hosts: view.hosts.map((host) => (host.serverId === serverId ? { ...host, ...change } : host)) };
  };
  return () => {
    paseo.hostDirectory = directory;
  };
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
  // address untrimmed or with its host part.
  it.each([
    { typed: "agent:Anon-ID", stored: "agent:Anon-ID" },
    { typed: " agent:Anon-ID@m2-max ", stored: "agent:Anon-ID" },
  ])("rewrites to.address $typed to $stored", async ({ typed, stored }) => {
    const { mac } = await pairOf();
    place(mac.paseo, "probe-id", "m_100", { ...dropped("m_100"), to: { agentId: "probe-id", address: typed, serverId: MAC } });
    await mac.mailer.importDrops();
    expect(mac.store.get("m_100")?.to).toEqual({ agentId: "probe-id", address: stored, serverId: null });
  });

  // Wrong: storing without scheduling a nudge (none is sent). The second, empty pass only shows that
  // nothing more arrives; the nudgedAt stamp would hold back a repeat anyway.
  it("nudges the recipient exactly once", async () => {
    const { mac } = await pairOf({ debounceMs: 5 });
    place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
    await mac.mailer.importDrops();
    expect(await until(() => mac.paseo.sent.length > 0)).toBe(true);
    await mac.mailer.importDrops();
    await wait(50);
    expect(mac.paseo.sent).toEqual([{ agentId: "probe-id", text: NUDGE_ONE }]);
  });

  // The fake lists drops on every agent, so the background case is a smoke check (the include
  // flags are Task 3's adapter tests). Wrong: skipping a holder a live lookup reports archived.
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
  // treating archived as missing (m_old cleared unstored).
  it("clears a drop whose sender does not exist on its host, and accepts one whose sender is archived", async () => {
    const { cantor, mac } = await pairOf();
    cantor.paseo.add("old-id");
    cantor.paseo.archive("old-id");
    place(mac.paseo, "probe-id", "m_ghost", { ...dropped("m_ghost"), from: { agentId: "ghost-id", name: "ghost", title: null, serverId: CANTOR } });
    place(mac.paseo, "probe-id", "m_old", { ...dropped("m_old"), from: { agentId: "old-id", name: "old", title: null, serverId: CANTOR } });
    await mac.mailer.importDrops();
    expect(mac.store.get("m_ghost")).toBeUndefined();
    expect(hasDrop(mac.paseo, "probe-id", "m_ghost")).toBe(false);
    expect(mac.store.get("m_old")?.from).toEqual({ agentId: "old-id", name: "old", title: null, serverId: CANTOR });
    expect(hasDrop(mac.paseo, "probe-id", "m_old")).toBe(false);
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
});

describe("importDrops: duplicate vs failure (design step 8)", () => {
  // The same drop arrives twice; probe read the first copy in between. Wrong: no store.get check
  // (create throws "already exists", so the second drop parks for ever); overwriting the stored mail
  // (readAt back to null); storing a second copy.
  it("clears a duplicate drop and stores one mail", async () => {
    const { mac } = await pairOf();
    place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
    await mac.mailer.importDrops();
    const read = await mac.mailer.read("probe-id", "m_100");
    expect(read.readAt).not.toBeNull();
    place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
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

  // Wrong: dropsChanged left a no-op.
  it("a dropsChanged event imports", async () => {
    const { mac } = await pairOf();
    place(mac.paseo, "probe-id", "m_100", dropped("m_100"));
    for (const watcher of [...mac.paseo.watchers]) watcher.dropsChanged();
    expect(await until(() => mac.store.get("m_100") !== undefined)).toBe(true);
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
});
