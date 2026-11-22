import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mailOf, tempDir } from "../test/fixtures";
import { isLocal, MailStore } from "./store";
import type { Mail } from "./types";

const PEER = "srv_EntwLoR9srmD";

/** A mail from a local sender; `to` and any other field are the test's to set. */
function mail(id: string, to: Mail["to"], extra: Partial<Mail> = {}): Mail {
  return mailOf({ id, from: { agentId: "alice-id", name: "alice", title: null, serverId: null }, to, subject: id, body: "b", createdAt: "2026-11-21T10:00:00.000Z", ...extra });
}

async function emptyStore(): Promise<MailStore> {
  const store = new MailStore(path.join(await tempDir(), "mail"));
  await store.init();
  return store;
}

describe("stored identity", () => {
  it("reads a mail file written before cross-host fields existed as local mail", async () => {
    const dir = path.join(await tempDir(), "mail");
    await mkdir(dir, { recursive: true });
    const old = {
      id: "m_old",
      threadId: "m_old",
      inReplyTo: null,
      from: { agentId: "a", name: "a", title: null },
      to: { agentId: "b", address: "b" },
      subject: "s",
      body: "b",
      createdAt: "2026-11-01T00:00:00.000Z",
      readAt: null,
      nudgedAt: null,
      bouncedAt: null,
      seenAt: null,
    };
    await writeFile(path.join(dir, "m_old.json"), JSON.stringify(old));
    const store = new MailStore(dir);
    await store.init();
    // Wrong: fields added as `.optional()` (no default) leave them undefined, not null.
    expect(store.get("m_old")).toMatchObject({ from: { serverId: null }, to: { agentId: "b", serverId: null }, handedOffAt: null });
    expect(isLocal(store.get("m_old")!)).toBe(true);
    expect(store.inbox("b").map((m) => m.id)).toEqual(["m_old"]);
    expect(store.outbox()).toEqual([]);
  });

  it("keeps from.serverId, to.serverId, a null to.agentId and handedOffAt across a reload", async () => {
    const store = await emptyStore();
    // An imported mail: from another daemon, now local (to.serverId null).
    await store.create(mail("m_10", { agentId: "bob-id", address: "bob", serverId: null }, { from: { agentId: "mac-id", name: "probe", title: null, serverId: PEER } }));
    // Outbox mail to a recipient whose id equals a local agent's id.
    await store.create(mail("m_20", { agentId: "bob-id", address: "bob@m2-max", serverId: PEER }));
    // Outbox mail not resolved yet.
    await store.create(mail("m_30", { agentId: null, address: "carol@m2-max", serverId: PEER }));
    // Outbox mail already handed off.
    await store.create(mail("m_40", { agentId: "dana-id", address: "dana@m2-max", serverId: PEER }, { handedOffAt: "2026-11-21T10:05:00.000Z" }));
    const reopened = new MailStore(store.dir);
    await reopened.init();
    // Wrong: a schema without one of the new keys strips it on parse (zod drops unknown keys), so
    // m_20 turns local, m_40 rejoins the outbox, m_10 loses its sender's host; a schema with
    // `to.agentId` still non-null skips m_30 as unreadable.
    expect(reopened.get("m_10")?.from.serverId).toBe(PEER);
    expect(reopened.get("m_20")?.to).toEqual({ agentId: "bob-id", address: "bob@m2-max", serverId: PEER });
    expect(reopened.get("m_30")?.to).toEqual({ agentId: null, address: "carol@m2-max", serverId: PEER });
    expect(reopened.get("m_40")?.handedOffAt).toBe("2026-11-21T10:05:00.000Z");
    expect(reopened.inbox("bob-id").map((m) => m.id)).toEqual(["m_10"]);
    expect(reopened.outbox().map((m) => m.id)).toEqual(["m_20", "m_30"]);
  });
});

describe("isLocal", () => {
  it("is true exactly when to.serverId is null, whatever from.serverId says", () => {
    const cases = [
      mail("m_1", { agentId: "bob-id", address: "bob", serverId: null }),
      // Imported: the sender is remote, the mail is local. Wrong: "both serverIds null".
      mail("m_2", { agentId: "bob-id", address: "bob", serverId: null }, { from: { agentId: "mac-id", name: "probe", title: null, serverId: PEER } }),
      // Outbox, resolved, to an id that a local agent also has. Wrong: "to.agentId !== null".
      mail("m_3", { agentId: "bob-id", address: "bob@m2-max", serverId: PEER }),
      // Outbox, unresolved.
      mail("m_4", { agentId: null, address: "carol@m2-max", serverId: PEER }),
    ];
    // Wrong: "from.serverId === null" gives [true, false, true, true]; the stub gives all true.
    expect(cases.map(isLocal)).toEqual([true, true, false, false]);
  });
});

describe("local-only views", () => {
  /** One local mail to bob, outbox mail to bob's id and to dana's id, all unread and not nudged. */
  async function seed(serverId: string | null): Promise<MailStore> {
    const store = await emptyStore();
    await store.create(mail("m_10", { agentId: "bob-id", address: "bob", serverId: null }));
    await store.create(mail("m_20", { agentId: "bob-id", address: "bob@m2-max", serverId }, { createdAt: "2026-11-21T11:00:00.000Z" }));
    await store.create(mail("m_30", { agentId: "dana-id", address: "dana@m2-max", serverId }));
    return store;
  }

  it("leaves outbox mail out of inbox, unread and pendingNudges, even to a local agent's id", async () => {
    // Positive control: the same mails with to.serverId null are local and show everywhere.
    const local = await seed(null);
    expect(local.inbox("bob-id").map((m) => m.id)).toEqual(["m_20", "m_10"]);
    expect(local.unread("bob-id").map((m) => m.id)).toEqual(["m_20", "m_10"]);
    expect(local.pendingNudges().sort()).toEqual(["bob-id", "dana-id"]);

    const store = await seed(PEER);
    // Wrong: filtering on to.agentId alone keeps m_20 in bob's inbox.
    expect(store.inbox("bob-id").map((m) => m.id)).toEqual(["m_10"]);
    expect(store.unread("bob-id").map((m) => m.id)).toEqual(["m_10"]);
    expect(store.inbox("dana-id")).toEqual([]);
    // Wrong: pendingNudges scanning every mail adds dana-id, whose only mail is in the outbox
    // (bob-id is listed either way, through m_10).
    expect(store.pendingNudges()).toEqual(["bob-id"]);
  });

  it("leaves an unresolved outbox mail out of pendingNudges", async () => {
    const store = await emptyStore();
    await store.create(mail("m_10", { agentId: null, address: "carol@m2-max", serverId: PEER }));
    // Wrong: no local-only filter yields [null], a nudge to no agent.
    expect(store.pendingNudges()).toEqual([]);
  });
});

describe("outbox", () => {
  it("lists non-local mail not yet handed off, in id order rather than createdAt order", async () => {
    const store = await emptyStore();
    // Inserted out of id order; createdAt ascending is m_20, m_10, m_30 and descending m_30, m_10, m_20.
    await store.create(mail("m_30", { agentId: null, address: "carol@m2-max", serverId: PEER }, { createdAt: "2026-11-21T11:00:00.000Z" }));
    await store.create(mail("m_10", { agentId: "bob-id", address: "bob@m2-max", serverId: PEER }, { createdAt: "2026-11-21T10:00:00.000Z" }));
    await store.create(mail("m_20", { agentId: "dana-id", address: "dana@m2-max", serverId: PEER }, { createdAt: "2026-11-21T09:00:00.000Z" }));
    // Excluded: handed off (would sort first), and local (would sort between).
    await store.create(mail("m_05", { agentId: "bob-id", address: "bob@m2-max", serverId: PEER }, { handedOffAt: "2026-11-21T09:30:00.000Z" }));
    await store.create(mail("m_15", { agentId: "bob-id", address: "bob", serverId: null }));
    const ids = store.outbox().map((m) => m.id);
    // Wrong orders this fixture tells apart: insertion [m_30, m_10, m_20], createdAt ascending
    // [m_20, m_10, m_30], createdAt descending [m_30, m_10, m_20].
    expect(ids).toEqual(["m_10", "m_20", "m_30"]);
  });
});
