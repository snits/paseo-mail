import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANTOR, FakeNetwork, MAC, mailOf, park, publish, setup, setupPair, until, type FakePaseo } from "../test/fixtures";
import { HostBook } from "./address";
import { nudgeText, type Mailer } from "./mailer";
import { UserError, type Mail } from "./types";

let current: Mailer | null = null;
afterEach(async () => {
  await current?.dispose();
  current = null;
});

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function pair() {
  const env = await setup({ debounceMs: 60_000 });
  current = env.mailer;
  const alice = env.paseo.add("alice-id", { title: "Alice", workspaceId: "w1" });
  const bob = env.paseo.add("bob-id", { title: "Bob", workspaceId: "w1" });
  await env.mailer.register(alice, { name: "alice" });
  await env.mailer.register(bob, { name: "bob" });
  return { ...env, alice, bob };
}

describe("send, list, read", () => {
  it("delivers by name and marks read on read", async () => {
    const { mailer, alice, bob } = await pair();
    const [delivery] = await mailer.send(alice, ["Bob"], "Hello", "Body text");
    expect(delivery).toMatchObject({ agentId: "bob-id", name: "bob", address: "Bob" });
    expect(mailer.unreadCount("bob-id")).toBe(1);
    const [listed] = mailer.list("bob-id", { unreadOnly: true });
    expect(listed).toMatchObject({ subject: "Hello", from: { agentId: "alice-id", name: "alice" } });
    const mail = await mailer.read("bob-id", delivery!.mailId);
    expect(mail.body).toBe("Body text");
    expect(mail.readAt).not.toBeNull();
    expect(mailer.unreadCount("bob-id")).toBe(0);
    expect(mailer.list("bob-id")).toHaveLength(1);
    await expect(mailer.read("alice-id", delivery!.mailId)).rejects.toThrow(/no mail/);
    void bob;
  });

  it("fails on an unknown address and sends nothing", async () => {
    const { mailer, alice } = await pair();
    await expect(mailer.send(alice, ["bob", "nobody"], "s", "b")).rejects.toThrow(/no live agent is registered as "nobody"/);
    await expect(mailer.send(alice, ["role:qa"], "s", "b")).rejects.toThrow(/role "qa"/);
    expect(mailer.unreadCount("bob-id")).toBe(0);
  });

  it("fails for an archived recipient", async () => {
    const { mailer, paseo, alice } = await pair();
    paseo.archive("bob-id");
    await expect(mailer.send(alice, ["bob"], "s", "b")).rejects.toThrow(/no live agent/);
  });

  it("refuses mail to yourself", async () => {
    const { mailer, alice } = await pair();
    await expect(mailer.send(alice, ["alice"], "s", "b")).rejects.toThrow(/yourself/);
  });

  it("gives one copy per agent when addresses overlap", async () => {
    const { mailer, alice, bob } = await pair();
    await mailer.register(bob, { roles: ["qa"] });
    const deliveries = await mailer.send(alice, ["bob", "role:qa"], "s", "b");
    expect(deliveries).toHaveLength(1);
  });
});

describe("alias required to read", () => {
  it("nudges an unnamed agent with the register text, and a named one with the normal text, once per mail", async () => {
    const { mailer, paseo, alice } = await pair();
    paseo.add("child-id", { title: "Child" });
    await mailer.send(alice, ["agent:child-id"], "Task", "Do it");
    expect(await mailer.nudge("child-id")).toBe("sent");
    expect(paseo.sent.at(-1)!.text).toBe(nudgeText(1, false));
    expect(nudgeText(1, false)).toContain("mail_register");
    expect(nudgeText(1, false)).toContain("mail_reply");
    expect(nudgeText(1)).toBe("[paseo-mail] You have 1 unread mail. Call mail_list to see them.");
    // Registering changes the text but never re-nudges mail it was already nudged about.
    await mailer.register({ id: "child-id", workspaceId: null, title: "Child" }, { name: "child" });
    paseo.sent.length = 0;
    mailer.onTurnStarted("child-id");
    mailer.onTurnEnded("child-id");
    expect(await mailer.nudge("child-id")).toBe("nothing");
    await mailer.send(alice, ["child"], "More", "x");
    expect(await mailer.nudge("child-id")).toBe("sent");
    expect(paseo.sent).toEqual([{ agentId: "child-id", text: nudgeText(2) }]);
  });

  it("requires a name, not a role, to read, and the mail is there once named", async () => {
    const { mailer, paseo, alice } = await pair();
    const child = paseo.add("child-id", { title: "Child" });
    await mailer.send(alice, ["agent:child-id"], "Task", "Do it");
    await mailer.send(alice, ["agent:child-id"], "Task 2", "Do it too");
    expect(mailer.hasName("child-id")).toBe(false);
    expect(() => mailer.requireName("child-id")).toThrow(/register a name.*2 unread mails are waiting/);
    await mailer.register(child, { roles: ["worker"] });
    expect(() => mailer.requireName("child-id")).toThrow(/mail_register/);
    await mailer.register(child, { name: "child" });
    expect(() => mailer.requireName("child-id")).not.toThrow();
    expect(mailer.list("child-id").map((m) => m.subject).sort()).toEqual(["Task", "Task 2"]);
    expect(mailer.unreadCount("child-id")).toBe(2);
  });
});

describe("agent:<id> addressing", () => {
  it("reaches a live agent with no registry entry, and nudges it", async () => {
    const { mailer, paseo, registry, alice } = await pair();
    const child = paseo.add("child-id", { title: "Child" });
    const [delivery] = await mailer.send(alice, ["agent:child-id"], "Task", "Do it");
    expect(delivery).toMatchObject({ agentId: "child-id", name: null, title: "Child", address: "agent:child-id" });
    expect(registry.get("child-id")).toBeUndefined();
    expect(mailer.list("child-id")[0]).toMatchObject({ subject: "Task", to: { agentId: "child-id", address: "agent:child-id" }, from: { agentId: "alice-id", name: "alice" } });
    expect(await mailer.nudge("child-id")).toBe("sent");
    expect(paseo.sent).toEqual([{ agentId: "child-id", text: nudgeText(1, false) }]);
    void child;
  });

  it("is case-insensitive in the prefix only, and also reaches registered agents", async () => {
    const { mailer, paseo, alice } = await pair();
    paseo.add("Mixed-ID");
    expect((await mailer.send(alice, ["AGENT: Mixed-ID "], "s", "b"))[0]!.agentId).toBe("Mixed-ID");
    await expect(mailer.send(alice, ["agent:mixed-id"], "s", "b")).rejects.toThrow(/no live agent has the id/);
    const [d] = await mailer.send(alice, ["agent:bob-id"], "s", "b");
    expect(d).toMatchObject({ agentId: "bob-id", name: "bob" });
  });

  it("errors for a missing or archived id and sends nothing", async () => {
    const { mailer, paseo, alice } = await pair();
    paseo.add("gone-id");
    paseo.archive("gone-id");
    await expect(mailer.send(alice, ["bob", "agent:gone-id"], "s", "b")).rejects.toThrow(/no live agent has the id "gone-id"/);
    await expect(mailer.send(alice, ["agent:nope"], "s", "b")).rejects.toThrow(/no live agent has the id "nope"/);
    await expect(mailer.send(alice, ["agent:"], "s", "b")).rejects.toThrow(/agent id/);
    await expect(mailer.send(alice, ["agent:alice-id"], "s", "b")).rejects.toThrow(/yourself/);
    expect(mailer.unreadCount("bob-id")).toBe(0);
  });

  it("lets an unnamed recipient reply, and returns mail when it is archived", async () => {
    const { mailer, paseo, alice } = await pair();
    const child = paseo.add("child-id");
    const [first] = await mailer.send(alice, ["agent:child-id"], "Q", "?");
    const reply = await mailer.reply(child, first!.mailId, "A");
    expect(reply).toMatchObject({ agentId: "alice-id", address: "alice" });
    // Alice replies back to the unnamed child by agent id.
    const again = await mailer.reply(alice, mailer.list("alice-id")[0]!.id, "B");
    expect(again).toMatchObject({ agentId: "child-id", address: "agent:child-id" });
    paseo.archive("child-id");
    await mailer.onArchived("child-id");
    expect(mailer.list("alice-id").map((m) => m.subject)).toContain("Returned: Q");
  });
});

describe("roles", () => {
  it("reaches holders in the sender's workspace, else project, else anywhere", async () => {
    const env = await setup({ debounceMs: 60_000 });
    current = env.mailer;
    const { paseo, mailer } = env;
    paseo.projects.set("w1", "p1");
    paseo.projects.set("w2", "p1");
    paseo.projects.set("w3", "p2");
    const sender = paseo.add("s", { workspaceId: "w1" });
    const sameProject = paseo.add("q2", { workspaceId: "w2" });
    const elsewhere = paseo.add("q3", { workspaceId: "w3" });
    await mailer.register(sameProject, { roles: ["qa"] });
    await mailer.register(elsewhere, { roles: ["qa"] });
    expect((await mailer.resolve(sender, "role:qa")).map((t) => t.agentId)).toEqual(["q2"]);
    const sameWorkspace = paseo.add("q1", { workspaceId: "w1" });
    await mailer.register(sameWorkspace, { roles: ["qa"] });
    expect((await mailer.resolve(sender, "role:QA")).map((t) => t.agentId)).toEqual(["q1"]);
    const outsider = paseo.add("o", { workspaceId: "w9" });
    expect((await mailer.resolve(outsider, "role:qa")).map((t) => t.agentId).sort()).toEqual(["q1", "q2", "q3"]);
  });
});

describe("reply", () => {
  it("goes to the sender in the same thread", async () => {
    const { mailer, alice, bob } = await pair();
    const [first] = await mailer.send(alice, ["bob"], "Question", "?");
    const reply = await mailer.reply(bob, first!.mailId, "Answer");
    expect(reply.agentId).toBe("alice-id");
    const [mail] = mailer.list("alice-id");
    expect(mail).toMatchObject({ subject: "Re: Question", threadId: first!.mailId, inReplyTo: first!.mailId });
    const again = await mailer.reply(alice, mail!.id, "Thanks");
    expect(mailer.list("bob-id")[0]?.subject).toBe("Re: Question");
    expect(again.agentId).toBe("bob-id");
  });

  it("follows the sender's name when the sender was archived", async () => {
    const { mailer, paseo, alice, bob } = await pair();
    const [first] = await mailer.send(alice, ["bob"], "Q", "?");
    paseo.archive("alice-id");
    await mailer.onArchived("alice-id");
    await expect(mailer.reply(bob, first!.mailId, "A")).rejects.toThrow(/no live agent is registered as "alice"/);
    const alice2 = paseo.add("alice2-id");
    await mailer.register(alice2, { name: "alice" });
    expect((await mailer.reply(bob, first!.mailId, "A")).agentId).toBe("alice2-id");
  });

  it("errors when an archived sender had no name", async () => {
    const { mailer, paseo, bob } = await pair();
    const anon = paseo.add("anon");
    const [first] = await mailer.send(anon, ["bob"], "Q", "?");
    paseo.archive("anon");
    await expect(mailer.reply(bob, first!.mailId, "A")).rejects.toThrow(/no registered name/);
  });
});

describe("archived recipients", () => {
  it("returns unread mail to the sender", async () => {
    const { mailer, paseo, alice } = await pair();
    const [read] = await mailer.send(alice, ["bob"], "Read one", "x");
    await mailer.send(alice, ["bob"], "Unread one", "y");
    await mailer.read("bob-id", read!.mailId);
    paseo.archive("bob-id");
    await mailer.onArchived("bob-id");
    const inbox = mailer.list("alice-id");
    expect(inbox.map((m) => m.subject)).toEqual(["Returned: Unread one"]);
    expect(inbox[0]!.from).toMatchObject({ agentId: null, name: "paseo-mail" });
    expect(inbox[0]!.body).toContain('was not read: the recipient was archived');
    await expect(mailer.reply(alice, inbox[0]!.id, "?")).rejects.toThrow(/paseo-mail itself/);
    await mailer.onArchived("bob-id");
    expect(mailer.list("alice-id")).toHaveLength(1);
  });

  // Design step 9 (bounce half), acceptance 10; Task 6 of paseo-mail#xsbz. The remote sender's id is
  // also a live local agent's id, so a local lookup of it finds someone. Wrong: stamping bouncedAt on
  // every unread mail (m_remote stamped); looking the remote sender up locally (the lookup is recorded,
  // and a "Returned:" mail lands with the local probe-id). Positive control: alice's mail still bounces.
  it("leaves unread mail from a remote sender unbounced, with no local lookup; local senders still bounce", async () => {
    const { mailer, paseo, store, alice } = await pair();
    paseo.add("probe-id", { title: "Local Probe" });
    await store.create(
      mailOf({
        id: "m_remote",
        from: { agentId: "probe-id", name: "probe", title: "Probe", serverId: "srv_EntwLoR9srmD" },
        to: { agentId: "bob-id", address: "bob", serverId: null },
        subject: "From afar",
        body: "x",
      }),
    );
    const [local] = await mailer.send(alice, ["bob"], "From alice", "y");
    const lookups: string[] = [];
    const agent = paseo.agent.bind(paseo);
    paseo.agent = async (id: string) => {
      lookups.push(id);
      return agent(id);
    };
    paseo.archive("bob-id");
    await mailer.onArchived("bob-id");
    expect(store.get("m_remote")?.bouncedAt).toBeNull();
    expect(lookups).not.toContain("probe-id");
    expect(store.all().filter((mail) => mail.subject === "Returned: From afar")).toEqual([]);
    expect(mailer.list("probe-id")).toEqual([]);
    expect(store.get(local!.mailId)?.bouncedAt).not.toBeNull();
    expect(mailer.list("alice-id").map((mail) => mail.subject)).toEqual(["Returned: From alice"]);
  });
});

describe("idle nudge", () => {
  it("nudges an idle agent once, with the unread count", async () => {
    const { mailer, paseo, alice } = await pair();
    await mailer.send(alice, ["bob"], "One", "1");
    await mailer.send(alice, ["bob"], "Two", "2");
    expect(await mailer.nudge("bob-id")).toBe("sent");
    expect(paseo.sent).toEqual([{ agentId: "bob-id", text: nudgeText(2) }]);
    mailer.onTurnStarted("bob-id");
    mailer.onTurnEnded("bob-id");
    expect(await mailer.nudge("bob-id")).toBe("nothing");
    expect(paseo.sent).toHaveLength(1);
  });

  it("does not wake an agent for mail it has read", async () => {
    const { mailer, paseo, alice } = await pair();
    const [d] = await mailer.send(alice, ["bob"], "One", "1");
    await mailer.read("bob-id", d!.mailId);
    expect(await mailer.nudge("bob-id")).toBe("nothing");
    expect(paseo.sent).toEqual([]);
  });

  it("nudges again only for new mail", async () => {
    const { mailer, paseo, alice } = await pair();
    await mailer.send(alice, ["bob"], "One", "1");
    await mailer.nudge("bob-id");
    mailer.onTurnStarted("bob-id");
    mailer.onTurnEnded("bob-id");
    await mailer.send(alice, ["bob"], "Two", "2");
    expect(await mailer.nudge("bob-id")).toBe("sent");
    expect(paseo.sent.map((s) => s.text)).toEqual([nudgeText(1), nudgeText(2)]);
  });

  it("holds while the agent is in a turn and sends when it ends", async () => {
    const env = await setup({ debounceMs: 5 });
    current = env.mailer;
    const { mailer, paseo } = env;
    const alice = paseo.add("a");
    const bob = paseo.add("b", { status: "running" });
    await mailer.register(bob, { name: "bob" });
    mailer.onTurnStarted("b");
    await mailer.send(alice, ["bob"], "s", "b");
    await wait();
    expect(paseo.sent).toEqual([]);
    paseo.status("b", "idle");
    mailer.onTurnEnded("b");
    await wait();
    expect(paseo.sent).toEqual([{ agentId: "b", text: nudgeText(1) }]);
  });

  it("holds an agent whose status is running and retries", async () => {
    const env = await setup({ debounceMs: 5, maxRetries: 3 });
    current = env.mailer;
    const { mailer, paseo } = env;
    const alice = paseo.add("a");
    const bob = paseo.add("b", { status: "running" });
    await mailer.register(bob, { name: "bob" });
    await mailer.send(alice, ["bob"], "s", "b");
    await wait(15);
    expect(paseo.sent).toEqual([]);
    paseo.status("b", "idle");
    await wait(80);
    expect(paseo.sent).toHaveLength(1);
  });

  it("counts its own nudge as busy until the turn ends", async () => {
    const { mailer, paseo, alice } = await pair();
    await mailer.send(alice, ["bob"], "One", "1");
    await mailer.nudge("bob-id");
    await mailer.send(alice, ["bob"], "Two", "2");
    expect(await mailer.nudge("bob-id")).toBe("held");
    expect(paseo.sent).toHaveLength(1);
  });

  it("forgets its own nudge as busy after the grace period", async () => {
    const env = await setup({ debounceMs: 60_000, sendGraceMs: 0 });
    current = env.mailer;
    const { mailer, paseo } = env;
    const alice = paseo.add("a");
    await mailer.register(paseo.add("b"), { name: "bob" });
    await mailer.send(alice, ["bob"], "One", "1");
    await mailer.nudge("b");
    await mailer.send(alice, ["bob"], "Two", "2");
    expect(await mailer.nudge("b")).toBe("sent");
  });

  it("clears its stamps when the send fails, so it retries", async () => {
    const { mailer, paseo, alice } = await pair();
    await mailer.send(alice, ["bob"], "One", "1");
    paseo.failSends = true;
    await expect(mailer.nudge("bob-id")).rejects.toThrow(/send failed/);
    paseo.failSends = false;
    expect(await mailer.nudge("bob-id")).toBe("sent");
  });

  it("debounces a burst into one nudge", async () => {
    const env = await setup({ debounceMs: 10 });
    current = env.mailer;
    const { mailer, paseo } = env;
    const alice = paseo.add("a");
    await mailer.register(paseo.add("b"), { name: "bob" });
    for (let i = 0; i < 3; i++) await mailer.send(alice, ["bob"], `m${i}`, "x");
    await wait(60);
    expect(paseo.sent).toEqual([{ agentId: "b", text: nudgeText(3) }]);
  });

  it("nudges held mail after a restart", async () => {
    const first = await setup({ debounceMs: 60_000 });
    const alice = first.paseo.add("a");
    await first.mailer.register(first.paseo.add("b"), { name: "bob" });
    await first.mailer.send(alice, ["bob"], "s", "b");
    await first.mailer.dispose();
    const second = await setup({ debounceMs: 5 }, first.root);
    current = second.mailer;
    second.paseo.add("b");
    expect(second.mailer.unreadCount("b")).toBe(1);
    second.mailer.start();
    await wait();
    expect(second.paseo.sent).toEqual([{ agentId: "b", text: nudgeText(1) }]);
  });

  // Wrong: scheduling held nudges after the registry backfill, so a slow publish delays the nudge.
  it("nudges held mail on restart while the registry backfill is parked", async () => {
    const first = await setup({ debounceMs: 60_000 });
    current = first.mailer;
    const alice = first.paseo.add("a");
    await first.mailer.register(first.paseo.add("b"), { name: "bob" });
    await first.mailer.send(alice, ["bob"], "s", "b");
    await first.mailer.dispose();
    expect(first.paseo.sent).toEqual([]);

    const second = await setup({ debounceMs: 5 }, first.root);
    current = second.mailer;
    second.paseo.add("b");
    const publishing = park(second.paseo, "publishAddress");
    const started = second.mailer.start();
    try {
      expect(await until(() => publishing.parked === 1)).toBe(true);
      await until(() => second.paseo.sent.length > 0);
      expect(second.paseo.sent).toEqual([{ agentId: "b", text: "[paseo-mail] You have 1 unread mail. Call mail_list to see them." }]);
    } finally {
      publishing.open();
      await started;
    }
  });
});

describe("outbox mail", () => {
  const PEER = "srv_EntwLoR9srmD";

  /** A mail from alice to bob-id; `serverId` says whether it is local (null) or waiting to cross. */
  function mailToBob(id: string, serverId: string | null): Mail {
    return mailOf({
      id,
      from: { agentId: "alice-id", name: "alice", title: "Alice", serverId: null },
      to: { agentId: "bob-id", address: serverId === null ? "bob" : "bob@m2-max", serverId },
      subject: id,
      body: "b",
      createdAt: "2026-11-21T10:00:00.000Z",
    });
  }

  // docs/adrs/2026-11-21-cross-host-delivery.md: outbox mail is not in any local inbox.
  // Wrong: an ownership check on to.agentId alone lets a local agent whose id matches the remote
  // recipient's read (stamping readAt) and reply to mail that is waiting to cross to another daemon.
  // Wrong: the check added to read but not reply (or the reverse); each call is asserted on its own.
  it("cannot be read or replied to by a local agent whose id matches its recipient", async () => {
    const { mailer, store, bob } = await pair();
    await store.create(mailToBob("m_out", PEER));
    await expect(mailer.read("bob-id", "m_out")).rejects.toThrow('no mail "m_out" in your mailbox');
    expect(store.get("m_out")?.readAt).toBeNull();
    await expect(mailer.reply(bob, "m_out", "A")).rejects.toThrow('no mail "m_out" in your mailbox');
    expect(mailer.list("alice-id")).toEqual([]);
  });

  // Positive control, and wrong: a check that refuses every store-created mail.
  it("is readable and repliable by that agent once to.serverId is null", async () => {
    const { mailer, store, bob } = await pair();
    await store.create(mailToBob("m_local", null));
    expect((await mailer.read("bob-id", "m_local")).readAt).not.toBeNull();
    expect(await mailer.reply(bob, "m_local", "A")).toMatchObject({ agentId: "alice-id" });
    expect(mailer.list("alice-id").map((m) => m.subject)).toEqual(["Re: m_local"]);
  });
});

describe("stored identity of written mail", () => {
  /** The mail as written to disk, before any schema default fills a missing key in. */
  async function onDisk(dir: string, id: string): Promise<unknown> {
    return JSON.parse(await readFile(path.join(dir, `${id}.json`), "utf8"));
  }

  // Wrong: a writer that leaves the keys out and relies on the schema defaults reads back as
  // null after a reload, but the file lacks them; only the raw file tells the two apart.
  it("writes from.serverId, to.serverId and handedOffAt as null on a local send", async () => {
    const { mailer, store, alice } = await pair();
    const [delivery] = await mailer.send(alice, ["bob"], "Hello", "Body");
    const written = await onDisk(store.dir, delivery!.mailId);
    expect(written).toHaveProperty("from.serverId", null);
    expect(written).toHaveProperty("to.serverId", null);
    expect(written).toHaveProperty("handedOffAt", null);
  });

  it("writes from.serverId, to.serverId and handedOffAt as null on an archive bounce", async () => {
    const { mailer, store, paseo, alice } = await pair();
    await mailer.send(alice, ["bob"], "Unread", "y");
    paseo.archive("bob-id");
    await mailer.onArchived("bob-id");
    const [bounce] = mailer.list("alice-id");
    expect(bounce).toMatchObject({ subject: "Returned: Unread", from: { agentId: null } });
    const written = await onDisk(store.dir, bounce!.id);
    expect(written).toHaveProperty("from.serverId", null);
    expect(written).toHaveProperty("to.serverId", null);
    expect(written).toHaveProperty("handedOffAt", null);
  });
});

describe("publishing paseo-mail.address (design step 4)", () => {
  /** The publishAddress calls recorded by the fake, as [agentId, address]. */
  function published(paseo: FakePaseo): unknown[][] {
    return paseo.calls.filter((call) => call.op === "publishAddress").map((call) => call.args);
  }

  async function fresh() {
    const env = await setup({ debounceMs: 60_000 });
    current = env.mailer;
    const alice = env.paseo.add("alice-id", { title: "Alice", workspaceId: "w1" });
    const bob = env.paseo.add("bob-id", { title: "Bob", workspaceId: "w1" });
    return { ...env, alice, bob };
  }

  // Wrong: publishing the raw input (" Alice ", unsorted duplicate roles) instead of the stored
  // entry; a roles-only update publishing { name: null } instead of keeping the name; the wrong agent.
  it("register publishes the caller's stored {name, roles}", async () => {
    const { mailer, paseo, alice, bob } = await fresh();
    await mailer.register(alice, { name: " Alice ", roles: ["Review", "qa", "review"] });
    await mailer.register(bob, { name: "bob" });
    await mailer.register(alice, { roles: ["ops"] });
    expect(published(paseo)).toEqual([
      ["alice-id", { name: "alice", roles: ["qa", "review"] }],
      ["bob-id", { name: "bob", roles: [] }],
      ["alice-id", { name: "alice", roles: ["ops"] }],
    ]);
  });

  // Wrong: publishing { name: null, roles: [] } instead of null; publishing null whenever the name
  // is cleared (the middle call, roles still held, is the positive control).
  it("register publishes null once name and roles are both cleared", async () => {
    const { mailer, paseo, alice } = await fresh();
    await mailer.register(alice, { name: "alice", roles: ["qa"] });
    await mailer.register(alice, { name: "" });
    await mailer.register(alice, { roles: [] });
    expect(published(paseo)).toEqual([
      ["alice-id", { name: "alice", roles: ["qa"] }],
      ["alice-id", { name: null, roles: ["qa"] }],
      ["alice-id", null],
    ]);
  });

  // Wrong: no publish on archive; clearing the wrong agent (bob stays published).
  it("onArchived publishes null for the archived agent", async () => {
    const { mailer, paseo, alice, bob } = await fresh();
    await mailer.register(alice, { name: "alice" });
    await mailer.register(bob, { name: "bob", roles: ["qa"] });
    paseo.archive("alice-id");
    await mailer.onArchived("alice-id");
    expect(published(paseo)).toEqual([
      ["alice-id", { name: "alice", roles: [] }],
      ["bob-id", { name: "bob", roles: ["qa"] }],
      ["alice-id", null],
    ]);
  });

  // Wrong: skipping the nameless (roles-only) entry; publishing names without roles; publishing
  // only the first entry; not awaiting the backfill inside start(). Entries are written straight
  // to the registry so register's own publishing does not pollute the record. The fake records a
  // publish only after a timer tick, so the record is empty after `await start()` unless start()
  // waited for the publishes.
  it("start() publishes every registry entry (backfill)", async () => {
    const env = await setup({ debounceMs: 60_000 });
    current = env.mailer;
    const publishAddress = env.paseo.publishAddress.bind(env.paseo);
    env.paseo.publishAddress = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return publishAddress(...args);
    };
    const entries = [
      { agentId: "a-carol", name: "carol", roles: ["ops"] },
      { agentId: "a-dave", name: null, roles: ["qa", "review"] },
      { agentId: "a-erin", name: "erin", roles: [] },
    ];
    for (const entry of entries) {
      env.paseo.add(entry.agentId);
      await env.registry.set({ ...entry, workspaceId: null, projectId: null, updatedAt: "2026-11-22T10:00:00.000Z" });
    }
    await env.mailer.start();
    const calls = published(env.paseo).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(calls).toEqual([
      ["a-carol", { name: "carol", roles: ["ops"] }],
      ["a-dave", { name: null, roles: ["qa", "review"] }],
      ["a-erin", { name: "erin", roles: [] }],
    ]);
  });

  // The backfill races a register that lands while start() is still publishing. "a-abel" (name
  // "abel") sorts before "a-xena" (name "alice") in registry.list(), so the backfill parks on abel
  // while xena re-registers. Wrong: publishing each entry from the list copied when start() began
  // (xena's stale { name: "alice" } lands after register's publish, so the daemon keeps "alice");
  // publishing { name: null, roles: [] } for an entry that is gone (the "clears" case). Waiting for
  // two parked publishes makes the race certain on that wrong version; a fix that runs the
  // backfill inside the register queue never lets register park, so the wait is bounded.
  it.each([
    { change: "renames", input: { name: "bob" }, final: { name: "bob", roles: ["qa"] } },
    { change: "clears", input: { name: "", roles: [] }, final: null },
  ])("start() publishes an agent's current registration when it $change itself during the backfill", async ({ input, final }) => {
    const env = await setup({ debounceMs: 60_000 });
    current = env.mailer;
    env.paseo.add("a-abel");
    const xena = env.paseo.add("a-xena");
    await env.registry.set({ agentId: "a-abel", name: "abel", roles: [], workspaceId: null, projectId: null, updatedAt: "2026-11-22T10:00:00.000Z" });
    await env.registry.set({ agentId: "a-xena", name: "alice", roles: ["qa"], workspaceId: null, projectId: null, updatedAt: "2026-11-22T10:00:00.000Z" });
    expect(env.registry.list().map((entry) => entry.agentId)).toEqual(["a-abel", "a-xena"]);
    const publishing = park(env.paseo, "publishAddress");
    const started = env.mailer.start();
    try {
      expect(await until(() => publishing.parked === 1)).toBe(true);
      const registered = env.mailer.register(xena, input);
      await until(() => publishing.parked >= 2);
      publishing.open();
      await Promise.all([started, registered]);
    } finally {
      publishing.open();
      await started;
    }
    const xenaPublishes = published(env.paseo).filter(([agentId]) => agentId === "a-xena");
    const settled = env.registry.get("a-xena");
    expect(settled === undefined ? null : { name: settled.name, roles: settled.roles }).toEqual(final);
    expect(xenaPublishes.at(-1)?.[1]).toEqual(final);
    expect(env.paseo.metadata.get("a-xena")?.["paseo-mail.address"] ?? null).toEqual(final);
    // Positive control: the backfill still publishes the entry nobody touched.
    expect(published(env.paseo)).toContainEqual(["a-abel", { name: "abel", roles: [] }]);
  });

  // Wrong: awaiting the publish without a catch (register rejects); publishing before the registry
  // write and letting the throw skip it. The recorded attempt shows the publish was reached.
  it("a publishAddress failure does not fail register, and the registration lands", async () => {
    const { mailer, paseo, registry, alice } = await fresh();
    paseo.failPublish = true;
    const entry = await mailer.register(alice, { name: "alice", roles: ["qa"] });
    expect(entry).toMatchObject({ agentId: "alice-id", name: "alice", roles: ["qa"] });
    expect(registry.get("alice-id")).toMatchObject({ name: "alice", roles: ["qa"] });
    expect(published(paseo)).toEqual([["alice-id", { name: "alice", roles: ["qa"] }]]);
  });

  // Wrong: start() publishing without the per-entry catch (start() rejects on the first failure),
  // or one catch around the whole loop (start() resolves after one attempt instead of three).
  it("a publishAddress failure does not fail start(), and every entry is still attempted", async () => {
    const env = await setup({ debounceMs: 60_000 });
    current = env.mailer;
    const entries = [
      { agentId: "a-carol", name: "carol", roles: ["ops"] },
      { agentId: "a-dave", name: null, roles: ["qa"] },
      { agentId: "a-erin", name: "erin", roles: [] },
    ];
    for (const entry of entries) {
      env.paseo.add(entry.agentId);
      await env.registry.set({ ...entry, workspaceId: null, projectId: null, updatedAt: "2026-11-22T10:00:00.000Z" });
    }
    env.paseo.failPublish = true;
    await expect(env.mailer.start()).resolves.toBeUndefined();
    expect(published(env.paseo).map(([agentId]) => agentId).sort()).toEqual(["a-carol", "a-dave", "a-erin"]);
  });

  // Wrong: dispose() closing the store and registry but not releasing the port.
  it("dispose() releases the port", async () => {
    const env = await setup({ debounceMs: 60_000 });
    await env.mailer.dispose();
    expect(env.paseo.calls.map((call) => call.op)).toEqual(["release"]);
  });
});

describe("remote addresses (design steps 5 and 6, resolution half)", () => {
  const mailers: Mailer[] = [];
  afterEach(async () => {
    await Promise.all(mailers.splice(0).map((mailer) => mailer.dispose()));
  });

  /** cantor and the Mac (cantor lists it as "m2-max"), with "lead" registered on cantor. */
  async function linked() {
    const pair = await setupPair({ debounceMs: 60_000 });
    mailers.push(pair.cantor.mailer, pair.mac.mailer);
    const lead = pair.cantor.paseo.add("lead-id", { title: "Lead" });
    await pair.cantor.mailer.register(lead, { name: "lead" });
    return { ...pair, lead };
  }

  /** The peerAddresses calls cantor's port recorded, as [serverId]. */
  function listings(paseo: FakePaseo): unknown[][] {
    return paseo.calls.filter((call) => call.op === "peerAddresses").map((call) => call.args);
  }

  const unresolved = (serverId: string, name: string) => ({ kind: "remote", serverId, agentId: null, name, title: null });

  // "other" publishes first. Wrong: taking the first publisher regardless of name (other-id); the
  // name as typed ("Probe"); the link label ("m2-max") or the caller's title in place of the serverId
  // or the recipient's title.
  it("resolves name@label to the one Mac agent publishing that name", async () => {
    const { cantor, mac, lead } = await linked();
    await mac.mailer.register(mac.paseo.add("other-id", { title: "Other" }), { name: "other" });
    await mac.mailer.register(mac.paseo.add("probe-id", { title: "Probe" }), { name: "probe" });
    expect(await cantor.mailer.resolve(lead, "Probe@m2-max")).toEqual([{ kind: "remote", serverId: MAC, agentId: "probe-id", name: "probe", title: "Probe" }]);
  });

  // A normalize error ("invalid name") would also be a UserError, but comes before any listing.
  // Wrong: accepting the mail unresolved when nobody publishes the name; one branch for "not
  // exactly one" that tells the sender several agents hold a name nobody holds.
  it("refuses a name nobody on the online host publishes", async () => {
    const { cantor, mac, lead } = await linked();
    await mac.mailer.register(mac.paseo.add("other-id", { title: "Other" }), { name: "other" });
    const error = await cantor.mailer.resolve(lead, "probe@m2-max").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UserError);
    expect((error as Error).message).not.toMatch(/invalid name/);
    expect((error as Error).message).not.toMatch(/several|more than one|multiple/i);
    expect(listings(cantor.paseo)).toContainEqual([MAC]);
    // Positive control: once probe publishes the name, the same address resolves.
    await mac.mailer.register(mac.paseo.add("probe-id", { title: "Probe" }), { name: "probe" });
    expect(await cantor.mailer.resolve(lead, "probe@m2-max")).toMatchObject([{ kind: "remote", agentId: "probe-id" }]);
  });

  // Two publishers of "probe", both untitled, so the message has to carry their ids. Written as
  // metadata because the Mac's registry refuses a second holder. Wrong: the first publisher wins;
  // an error that does not say who holds the name.
  it("refuses a name two agents on the host publish, naming both", async () => {
    const { cantor, mac, lead } = await linked();
    for (const id of ["p-one-id", "p-two-id"]) publish(mac.paseo, id, "probe");
    const error = await cantor.mailer.resolve(lead, "probe@m2-max").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UserError);
    expect((error as Error).message).toContain("p-one-id");
    expect((error as Error).message).toContain("p-two-id");
  });

  // Wrong: refusing mail to a host that is not online; the name as typed ("Probe"); trying the
  // listing anyway (the fake records the call before it throws).
  it("accepts name@host unresolved when the host is not online, without listing it", async () => {
    const { network, cantor, mac, lead } = await linked();
    await mac.mailer.register(mac.paseo.add("probe-id", { title: "Probe" }), { name: "probe" });
    network.setReachable(CANTOR, MAC, false);
    expect(await cantor.mailer.resolve(lead, "Probe@m2-max")).toEqual([unresolved(MAC, "probe")]);
    expect(listings(cantor.paseo)).toEqual([]);
  });

  // The Mac reads online, but its listing throws. Wrong: folding the throw into "nobody publishes
  // the name" (an error); letting the throw escape.
  it("accepts name@host unresolved when the online host's listing throws", async () => {
    const { network, cantor, mac, lead } = await linked();
    await mac.mailer.register(mac.paseo.add("probe-id", { title: "Probe" }), { name: "probe" });
    network.fault(MAC, "peerAddresses", true);
    expect((await cantor.paseo.hostDirectory()).hosts).toContainEqual(expect.objectContaining({ serverId: MAC, online: true }));
    expect(await cantor.mailer.resolve(lead, "Probe@m2-max")).toEqual([unresolved(MAC, "probe")]);
    // Positive control: with the listing back, the same address resolves to probe.
    network.fault(MAC, "peerAddresses", false);
    expect(await cantor.mailer.resolve(lead, "Probe@m2-max")).toMatchObject([{ kind: "remote", agentId: "probe-id" }]);
  });

  // Wrong: treating every host part as remote (cantor does not list itself, so "cantor" would be
  // unknown); a local target without its kind.
  it("resolves the own label or serverId, and a plain name, to a local target", async () => {
    const { cantor, lead } = await linked();
    await cantor.mailer.register(cantor.paseo.add("bob-id", { title: "Bob" }), { name: "bob" });
    expect(await cantor.mailer.resolve(lead, "Bob@cantor")).toMatchObject([{ kind: "local", agentId: "bob-id" }]);
    expect(await cantor.mailer.resolve(lead, "bob@srv_Cantor01")).toMatchObject([{ kind: "local", agentId: "bob-id" }]);
    expect(await cantor.mailer.resolve(lead, "bob")).toMatchObject([{ kind: "local", agentId: "bob-id" }]);
  });

  // probe holds the role "qa" and is reachable by id. Wrong: resolving role:qa@host or
  // agent:<id>@host on the remote host (or locally) instead of refusing them.
  it("refuses role:x@host as planned and agent:x@host as unsupported", async () => {
    const { cantor, mac, lead } = await linked();
    await mac.mailer.register(mac.paseo.add("probe-id", { title: "Probe" }), { name: "probe", roles: ["qa"] });
    await expect(cantor.mailer.resolve(lead, "role:qa@m2-max")).rejects.toBeInstanceOf(UserError);
    await expect(cantor.mailer.resolve(lead, "role:qa@m2-max")).rejects.toThrow(/planned/);
    await expect(cantor.mailer.resolve(lead, "agent:probe-id@m2-max")).rejects.toBeInstanceOf(UserError);
    await expect(cantor.mailer.resolve(lead, "agent:probe-id@m2-max")).rejects.toThrow(/unsupported|not supported/);
  });

  // The same refusals with the own host. cantor has an agent named "qa" holding the role "qa".
  // Wrong: refusing only after the host part resolves remote, so role:qa@cantor falls through to
  // the local lookup of the name "qa" (and agent:<id>@cantor to a lookup of the id as a name).
  it("refuses role:x@host and agent:x@host when the host is this daemon", async () => {
    const { cantor, lead } = await linked();
    await cantor.mailer.register(cantor.paseo.add("qa-id", { title: "QA" }), { name: "qa", roles: ["qa"] });
    await expect(cantor.mailer.resolve(lead, "role:qa@cantor")).rejects.toThrow(/planned/);
    await expect(cantor.mailer.resolve(lead, "agent:qa-id@cantor")).rejects.toThrow(/unsupported|not supported/);
    // Positive control: the plain name reaches the agent through the same host part.
    expect(await cantor.mailer.resolve(lead, "qa@cantor")).toMatchObject([{ kind: "local", agentId: "qa-id" }]);
  });

  // design step 6: a mixed send stores bob's local copy and one outbox copy in cantor's store; the
  // Mac's store is untouched (hand-off writes a drop, never the peer's store). Wrong: still refusing
  // remote targets; the remote copy stored as local (to.serverId null, so it lands in an inbox);
  // the remote copy dropped.
  it("send stores a mixed local + remote send as a local copy and an outbox copy", async () => {
    const { network, cantor, mac, lead } = await linked();
    await cantor.mailer.register(cantor.paseo.add("bob-id", { title: "Bob" }), { name: "bob" });
    await mac.mailer.register(mac.paseo.add("probe-id", { title: "Probe" }), { name: "probe" });
    network.fault(MAC, "writeDrop", true);
    const deliveries = await cantor.mailer.send(lead, ["bob", "probe@m2-max"], "s", "b");
    expect(deliveries).toHaveLength(2);
    const local = deliveries.find((delivery) => delivery.serverId === null);
    const remote = deliveries.find((delivery) => delivery.serverId === MAC);
    expect(local).toMatchObject({ address: "bob", agentId: "bob-id" });
    expect(remote).toMatchObject({ address: "probe@m2-max", agentId: "probe-id" });
    expect(cantor.mailer.list("bob-id").map((mail) => mail.id)).toEqual([local!.mailId]);
    expect(cantor.store.outbox().map((mail) => mail.id)).toEqual([remote!.mailId]);
    expect(cantor.store.all()).toHaveLength(2);
    expect(mac.store.all()).toEqual([]);
  });

  // Wrong: hosts() undefined or throwing before a refresh; refreshHosts() returning the new book
  // without keeping it as the snapshot.
  it("hosts() is an empty book until refreshHosts() reads the directory", async () => {
    const network = new FakeNetwork();
    const host = network.host(CANTOR, "cantor");
    network.host(MAC, "M2 Max");
    network.link(CANTOR, MAC, { label: "m2-max" });
    const env = await setup({ debounceMs: 60_000 }, undefined, host);
    mailers.push(env.mailer);
    expect(env.mailer.hosts()).toBeInstanceOf(HostBook);
    expect(env.mailer.hosts().display(MAC)).toBe(MAC);
    expect((await env.mailer.refreshHosts()).display(MAC)).toBe("m2-max");
    expect(env.mailer.hosts().display(MAC)).toBe("m2-max");
  });

  // Wrong: start() not refreshing the snapshot (the Mac's display stays its serverId).
  it("start() refreshes the host snapshot", async () => {
    const { mac } = await linked();
    expect(mac.mailer.hosts().display(CANTOR)).toBe("cantor");
  });

  // Wrong: replacing the snapshot with an empty book when the read throws; a refreshHosts() that
  // never reads the directory (the read count shows it did); rethrowing the read's error.
  it("refreshHosts() keeps the previous snapshot when the directory read throws, and resolves", async () => {
    const { cantor } = await linked();
    expect(cantor.mailer.hosts().display(MAC)).toBe("m2-max");
    let reads = 0;
    cantor.paseo.hostDirectory = async () => {
      reads += 1;
      throw new Error("directory down");
    };
    const kept = await cantor.mailer.refreshHosts();
    expect(reads).toBeGreaterThan(0);
    expect(kept.display(MAC)).toBe("m2-max");
    expect(cantor.mailer.hosts().display(MAC)).toBe("m2-max");
  });

  // Wrong: a refreshHosts() that rethrows, or start() reading the directory unguarded: start()
  // then rejects before the backfill and nothing is published.
  it("start() still publishes the registry when the directory read throws", async () => {
    const env = await setup({ debounceMs: 60_000 });
    mailers.push(env.mailer);
    env.paseo.add("a-carol");
    await env.registry.set({ agentId: "a-carol", name: "carol", roles: [], workspaceId: null, projectId: null, updatedAt: "2026-11-22T10:00:00.000Z" });
    let reads = 0;
    env.paseo.hostDirectory = async () => {
      reads += 1;
      throw new Error("directory down");
    };
    await expect(env.mailer.start()).resolves.toBeUndefined();
    expect(reads).toBeGreaterThan(0);
    const published = env.paseo.calls.filter((call) => call.op === "publishAddress").map((call) => call.args);
    expect(published).toEqual([["a-carol", { name: "carol", roles: [] }]]);
  });

  // The attic is linked after start() and unreachable, so only a fresh read knows it. Wrong:
  // resolving against the snapshot start() took ("attic" is then an unknown host).
  it("resolve refreshes the host snapshot for a remote address", async () => {
    const { network, cantor, lead } = await linked();
    network.host("srv_Attic01", "attic");
    network.link(CANTOR, "srv_Attic01", { label: "attic" });
    network.setReachable(CANTOR, "srv_Attic01", false);
    expect(await cantor.mailer.resolve(lead, "probe@attic")).toEqual([unresolved("srv_Attic01", "probe")]);
  });
});
