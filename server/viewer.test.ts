import { afterEach, describe, expect, it } from "vitest";
import { FullMailSchema, listMailboxesRpc, listMailsRpc, MailHeaderSchema, markSeenRpc, viewMailRpc } from "../shared/contracts";
import { setup } from "../test/fixtures";
import type { Mailer } from "./mailer";
import { MailStore } from "./store";
import { MailViewer } from "./viewer";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

let current: Mailer | null = null;
afterEach(async () => {
  await current?.dispose();
  current = null;
});

async function world() {
  const env = await setup({ debounceMs: 60_000 });
  current = env.mailer;
  const alice = env.paseo.add("alice-id", { title: "Alice", workspaceId: "w1" });
  const bob = env.paseo.add("bob-id", { title: "Bob", workspaceId: "w1" });
  await env.mailer.register(alice, { name: "alice", roles: ["lead"] });
  await env.mailer.register(bob, { name: "bob" });
  const viewer = new MailViewer(env.store, env.registry, env.paseo, () => "2026-11-10T12:00:00.000Z");
  return { ...env, alice, bob, viewer };
}

describe("mailboxes", () => {
  it("marks the whole mailbox seen beyond the list limit, leaving other mailboxes and agent unread state alone", async () => {
    const { viewer, mailer, store, alice, bob } = await world();
    await mailer.send(alice, ["bob"], "Incoming", "body");
    await mailer.send(bob, ["alice"], "Other mailbox", "body");
    const original = store.inbox("bob-id")[0]!;
    for (let i = 0; i < 201; i++) await store.create({ ...original, id: `bulk-${i}` });
    await viewer.setSeen(original.id, true);
    expect(await viewer.setAllSeen("bob-id")).toBe(201);
    expect(store.inbox("bob-id").every((mail) => mail.seenAt !== null && mail.readAt === null && mail.bouncedAt === null)).toBe(true);
    expect(store.inbox("alice-id")[0]!.seenAt).toBeNull();
    const revision = viewer.revision();
    expect(await viewer.setAllSeen("bob-id")).toBe(0);
    expect(viewer.revision()).toBe(revision);
    const reopened = new MailStore(store.dir);
    await reopened.init();
    expect(reopened.inbox("bob-id").every((mail) => mail.seenAt !== null)).toBe(true);
  });

  it("persists mailbox archiving without changing registration, delivery, or agent read state", async () => {
    const { viewer, store, mailer, alice, registry, paseo } = await world();
    const revision = viewer.revision();
    await viewer.setArchived("bob-id", true);
    expect(viewer.revision()).not.toBe(revision);
    expect((await viewer.mailboxes()).find((box) => box.agentId === "bob-id")).toMatchObject({ archived: false, mailboxArchived: true });
    expect(registry.get("bob-id")?.name).toBe("bob");
    expect((await paseo.agent("bob-id"))?.archived).toBe(false);
    await mailer.send(alice, ["bob"], "Still delivered", "body");
    expect(viewer.list("bob-id").mails[0]).toMatchObject({ readAt: null, bouncedAt: null });
    const reopened = new MailStore(store.dir);
    await reopened.init();
    expect(reopened.isMailboxArchived("bob-id")).toBe(true);
    expect(reopened.inbox("bob-id")).toHaveLength(1);
    await reopened.setMailboxArchived("bob-id", false);
    const restored = new MailStore(store.dir);
    await restored.init();
    expect(restored.isMailboxArchived("bob-id")).toBe(false);
    await expect(viewer.setArchived("missing", true)).rejects.toThrow(/no mailbox/);
  });

  it("lists registered agents, empty ones included, with agent-unread and human-unseen counts", async () => {
    const { mailer, viewer, alice } = await world();
    await mailer.send(alice, ["bob"], "One", "1");
    const [second] = await mailer.send(alice, ["bob"], "Two", "2");
    await mailer.read("bob-id", second!.mailId);
    const boxes = listMailboxesRpc.output.parse({ revision: viewer.revision(), mailboxes: await viewer.mailboxes() }).mailboxes;
    expect(boxes.map((box) => box.name)).toEqual(["alice", "bob"]);
    expect(boxes[0]).toMatchObject({ agentId: "alice-id", title: "Alice", roles: ["lead"], archived: false, total: 0, unread: 0, lastMailAt: null });
    expect(boxes[1]).toMatchObject({ agentId: "bob-id", total: 2, unread: 1, unseen: 2, bounced: 0, archived: false });
  });

  it("lists an unregistered recipient of an agent:<id> address by its title, not the address", async () => {
    const { mailer, viewer, paseo, alice } = await world();
    paseo.add("child-id", { title: "Child task" });
    await mailer.send(alice, ["agent:child-id"], "Task", "do it");
    const boxes = await viewer.mailboxes();
    const child = boxes.find((box) => box.agentId === "child-id")!;
    expect(child).toMatchObject({ name: null, title: "Child task", roles: [], total: 1, unread: 1, archived: false });
    expect(viewer.list("child-id").mails[0]).toMatchObject({ subject: "Task", to: { agentId: "child-id", address: "agent:child-id" } });
    // Once archived the mailbox stays, still without the address as a name.
    paseo.archive("child-id");
    await mailer.onArchived("child-id");
    const after = (await viewer.mailboxes()).find((box) => box.agentId === "child-id")!;
    expect(after).toMatchObject({ name: null, archived: true, bounced: 1 });
  });

  it("keeps an archived agent's mailbox, last, under its last name, with its returned mail", async () => {
    const { mailer, viewer, paseo, alice, bob } = await world();
    await mailer.send(bob, ["alice"], "From bob", "x");
    await mailer.send(alice, ["bob"], "Never read", "y");
    paseo.archive("bob-id");
    await mailer.onArchived("bob-id");
    const boxes = await viewer.mailboxes();
    expect(boxes.map((box) => [box.name, box.archived])).toEqual([
      ["alice", false],
      ["bob", true],
    ]);
    expect(boxes[1]).toMatchObject({ roles: [], unread: 0, bounced: 1, total: 1 });
    // The bounce reached alice, from paseo-mail itself.
    expect(boxes[0]).toMatchObject({ total: 1 + 1, unread: 2 });
  });

  it("asks the daemon about an archived agent only once", async () => {
    const { mailer, viewer, paseo, alice } = await world();
    await mailer.send(alice, ["bob"], "s", "b");
    paseo.archive("bob-id");
    let calls = 0;
    const agent = paseo.agent.bind(paseo);
    paseo.agent = async (id: string) => {
      if (id === "bob-id") calls += 1;
      return agent(id);
    };
    await viewer.mailboxes();
    await viewer.mailboxes();
    expect(calls).toBe(1);
  });

  it("moves the revision on mail and registry changes only", async () => {
    const { mailer, viewer, alice } = await world();
    const before = viewer.revision();
    expect(viewer.revision()).toBe(before);
    await mailer.send(alice, ["bob"], "s", "b");
    const afterSend = viewer.revision();
    expect(afterSend).not.toBe(before);
    await mailer.register(alice, { roles: [] });
    expect(viewer.revision()).not.toBe(afterSend);
  });
});

describe("mails", () => {
  it("lists a mailbox newest first, without bodies, with a one-line preview", async () => {
    const { mailer, viewer, alice } = await world();
    await mailer.send(alice, ["bob"], "Old", "first\n\nline");
    await mailer.send(alice, ["bob"], "New", "x".repeat(500));
    const result = listMailsRpc.output.parse(viewer.list("bob-id"));
    expect(result.total).toBe(2);
    expect(result.mails.map((mail) => mail.subject)).toEqual(["New", "Old"]);
    expect(result.mails[1]!.preview).toBe("first line");
    expect(result.mails[0]!.preview).toHaveLength(140);
    expect(result.mails[0]).not.toHaveProperty("body");
    expect(viewer.list("bob-id", 1)).toMatchObject({ total: 2, mails: [{ subject: "New" }] });
    expect(viewer.list("nobody")).toEqual({ mails: [], total: 0 });
  });

  it("views a mail with its whole thread, oldest first, across mailboxes, and marks nothing", async () => {
    const { mailer, viewer, alice, bob } = await world();
    const [first] = await mailer.send(alice, ["bob"], "Question", "why?");
    await mailer.read("bob-id", first!.mailId);
    const reply = await mailer.reply(bob, first!.mailId, "because");
    await mailer.send(alice, ["bob"], "Other", "unrelated");
    const result = viewMailRpc.output.parse(viewer.view(reply.mailId));
    expect(result.mail).toMatchObject({ subject: "Re: Question", body: "because", readAt: null, seenAt: null });
    expect(result.thread.map((mail) => [mail.to.agentId, mail.body])).toEqual([
      ["bob-id", "why?"],
      ["alice-id", "because"],
    ]);
    expect(mailer.unreadCount("alice-id")).toBe(1);
    expect(() => viewer.view("m_missing")).toThrow(/no mail/);
  });

  it("marks a mail seen and unseen without the agent having read it", async () => {
    const { mailer, viewer, alice } = await world();
    const [delivery] = await mailer.send(alice, ["bob"], "s", "b");
    const seenAt = markSeenRpc.output.parse({ seenAt: await viewer.setSeen(delivery!.mailId, true) }).seenAt;
    expect(seenAt).toBe("2026-11-10T12:00:00.000Z");
    expect(mailer.unreadCount("bob-id")).toBe(1);
    expect(mailer.list("bob-id", { unreadOnly: true })).toHaveLength(1);
    const [box] = (await viewer.mailboxes()).filter((b) => b.agentId === "bob-id");
    expect(box).toMatchObject({ unread: 1, unseen: 0 });
    // Still nudged about: being seen by a human is not being read.
    expect(mailer.list("bob-id")[0]).toMatchObject({ readAt: null, nudgedAt: null });
    expect(await viewer.setSeen(delivery!.mailId, false)).toBeNull();
    await expect(viewer.setSeen("m_missing", true)).rejects.toThrow(/no mail/);
  });

  it("validates the RPC inputs", () => {
    expect(listMailsRpc.input.parse({ agentId: "a" })).toEqual({ agentId: "a", limit: 200 });
    expect(() => listMailsRpc.input.parse({ agentId: "" })).toThrow();
    expect(() => listMailsRpc.input.parse({ agentId: "a", limit: 5000 })).toThrow();
    expect(() => viewMailRpc.input.parse({})).toThrow();
    expect(() => markSeenRpc.input.parse({ id: "m", seen: "yes" })).toThrow();
  });
});

describe("cross-host mail on the screen", () => {
  const PEER = "srv_EntwLoR9srmD";

  /** A real alice -> bob mail, plus copies re-addressed to bob's id and to dana's id on `serverId`. */
  async function seeded(serverId: string | null) {
    const env = await world();
    const [delivery] = await env.mailer.send(env.alice, ["bob"], "Local", "x");
    const original = env.store.get(delivery!.mailId)!;
    await env.store.create({ ...original, id: `${original.id}-bob`, to: { agentId: "bob-id", address: "bob@m2-max", serverId } });
    await env.store.create({ ...original, id: `${original.id}-dana`, to: { agentId: "dana-id", address: "dana@m2-max", serverId } });
    return { ...env, original };
  }

  it("builds mailboxes from local mail only: outbox mail makes no mailbox and adds to no count", async () => {
    // Positive control: with to.serverId null the copies are local, so bob counts 2 and dana gets a box.
    const control = await seeded(null);
    const controlBoxes = await control.viewer.mailboxes();
    expect(controlBoxes.map((box) => box.agentId).sort()).toEqual(["alice-id", "bob-id", "dana-id"]);
    expect(controlBoxes.find((box) => box.agentId === "bob-id")).toMatchObject({ total: 2, unread: 2, unseen: 2 });
    await control.mailer.dispose();

    const { store, viewer, original } = await seeded(PEER);
    await store.create({ ...original, id: `${original.id}-carol`, to: { agentId: null, address: "carol@m2-max", serverId: PEER } });
    const boxes = await viewer.mailboxes();
    // Wrong: grouping on to.agentId alone adds bob's outbox copy to bob's counts, gives dana-id a
    // mailbox, and makes a mailbox with agentId null for the unresolved mail.
    expect(boxes.map((box) => box.agentId).sort()).toEqual(["alice-id", "bob-id"]);
    expect(boxes.find((box) => box.agentId === "bob-id")).toMatchObject({ total: 1, unread: 1, unseen: 1 });
    expect(listMailboxesRpc.output.safeParse({ revision: viewer.revision(), mailboxes: boxes }).success).toBe(true);
  });

  it("shows a thread holding an unresolved outbox mail through the mails.view contract, keeping the new fields", async () => {
    const { store, viewer, original } = await seeded(PEER);
    await store.create({ ...original, id: `${original.id}-carol`, to: { agentId: null, address: "carol@m2-max", serverId: PEER } });
    const parsed = viewMailRpc.output.safeParse(viewer.view(original.id));
    // Wrong: a contract with `to.agentId` still non-null rejects the thread; one without the new
    // keys strips them (zod drops unknown keys).
    expect(parsed.success).toBe(true);
    const carol = parsed.data?.thread.find((mail) => mail.id === `${original.id}-carol`);
    expect(carol?.to).toEqual({ agentId: null, address: "carol@m2-max", serverId: PEER });
  });

  it("accepts and keeps from.serverId, to.serverId, handedOffAt and a null to.agentId in a mail header", () => {
    const header = {
      id: "m_1",
      threadId: "m_1",
      inReplyTo: null,
      from: { agentId: "mac-id", name: "probe", title: null, serverId: PEER },
      to: { agentId: null, address: "carol@m2-max", serverId: "srv_Cantor01" },
      subject: "s",
      preview: "p",
      createdAt: "2026-11-21T10:00:00.000Z",
      readAt: null,
      nudgedAt: null,
      bouncedAt: null,
      seenAt: null,
      handedOffAt: "2026-11-21T10:05:00.000Z",
    };
    const parsed = MailHeaderSchema.safeParse(header);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(header);
    const full = FullMailSchema.safeParse({ ...header, body: "b" });
    expect(full.data).toEqual({ ...header, body: "b" });
  });
});

describe("store", () => {
  it("reads mail written before seenAt existed", async () => {
    const { root } = await world();
    const dir = path.join(root, "old");
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
    };
    await writeFile(path.join(dir, "m_old.json"), JSON.stringify(old));
    const store = new MailStore(dir);
    await store.init();
    expect(store.get("m_old")).toMatchObject({ seenAt: null });
  });
});
