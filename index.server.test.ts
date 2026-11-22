import type { PluginServerContext } from "@getpaseo/plugin/server";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import contribute from "./index.server";
import { MAIL_NOTE } from "./server/system-prompt";
import { tempDir } from "./test/fixtures";

type Handler = (payload: unknown, context: unknown) => Promise<unknown>;

/** A daemon API with idle agents, recording the messages sent to them and the metadata patches. */
function fakeApi(sent: { id: string; text: string }[], patches: { id: string; patch: unknown }[] = []) {
  const agent = (id: string) => ({ id, title: id.toUpperCase(), workspaceId: "w1", status: "idle", archivedAt: null });
  return {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({ agent: agent(id), project: null }),
        send: async (text: string) => {
          sent.push({ id, text });
        },
        setMetadata: async (patch: unknown) => {
          patches.push({ id, patch });
        },
      }),
    },
    workspaces: { ref: () => ({ refresh: async () => ({ projectId: "p1" }) }) },
  };
}

describe("contribute", () => {
  let previousHome: string | undefined;
  beforeEach(async () => {
    previousHome = process.env.PASEO_HOME;
    process.env.PASEO_HOME = await tempDir();
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
  });

  it("appends the mailbox note to a new agent's system prompt, once", async () => {
    const hooks = new Map<string, Handler>();
    const server = { addHook: (name: string, handler: Handler) => (hooks.set(name, handler), () => hooks.delete(name)), handle: () => undefined } as unknown as PluginServerContext;
    const cleanup = contribute(server) as () => Promise<void>;
    const create = hooks.get("agent.create.before")!;
    const context = { paseo: {}, signal: new AbortController().signal };
    const config = { provider: "claude", cwd: "/tmp", systemPrompt: "Set by another plugin." };
    const result = (await create({ request: { config, env: { A: "1" } } }, context)) as { config: typeof config; env: unknown };
    expect(result.config.systemPrompt).toBe(`Set by another plugin.\n\n${MAIL_NOTE}`);
    expect(result.config).toMatchObject({ provider: "claude", cwd: "/tmp" });
    expect(result.env).toEqual({ A: "1" });
    expect(await create({ request: result }, context)).toBeUndefined();
    expect(((await create({ request: { config: { provider: "claude", cwd: "/tmp" } } }, context)) as { config: typeof config }).config.systemPrompt).toBe(MAIL_NOTE);
    expect(await create({ request: { config: { ...config, internal: true } } }, context)).toBeUndefined();
    expect(await create({ request: { config: { ...config, systemPrompt: 7 } } }, context)).toBeUndefined();
    expect(await create({ request: null }, context)).toBeUndefined();
    await cleanup();
  });

  it("adds the mail tools to interactive sessions and nudges after a turn", async () => {
    const hooks = new Map<string, Handler>();
    const rpcs = new Map<string, Handler>();
    const server = {
      addHook: (name: string, handler: Handler) => (hooks.set(name, handler), () => hooks.delete(name)),
      handle: (contract: { name: string }, handler: Handler) => rpcs.set(contract.name, handler),
    } as unknown as PluginServerContext;
    const cleanup = contribute(server) as () => Promise<void>;
    expect([...hooks.keys()].sort()).toEqual(["agent.archive.after", "agent.create.before", "agent.open.before", "agent.turn.after", "agent.turn.before"]);
    expect([...rpcs.keys()].sort()).toEqual(["mail.revision", "mailboxes.archive", "mailboxes.list", "mails.list", "mails.seen", "mails.seen-all", "mails.view"]);

    const sent: { id: string; text: string }[] = [];
    const patches: { id: string; patch: unknown }[] = [];
    const context = { paseo: fakeApi(sent, patches), signal: new AbortController().signal };
    const request = { agentId: "a", workspaceId: "w1", provider: "claude", cwd: "/tmp", reason: "create", purpose: "interactive", title: null, labels: {}, tools: [], env: {}, mcpServers: {} };
    expect(await hooks.get("agent.open.before")!({ request: { ...request, purpose: "history" } }, context)).toBeUndefined();
    const opened = (await hooks.get("agent.open.before")!({ request }, context)) as { tools: { name: string; execute: (input: unknown, context: unknown) => Promise<{ text: string }> }[] };
    const tool = (name: string) => opened.tools.find((t) => t.name === name)!;
    expect(opened.tools.map((t) => t.name)).toContain("mail_send");

    const toolContext = (id: string) => ({ ...context, agent: { id, workspaceId: "w1", parentAgentId: null, provider: "claude", cwd: "/tmp", title: id.toUpperCase(), background: false, metadata: {} } });
    await tool("mail_register").execute({ name: "bob" }, toolContext("b"));
    // Wrong: the tool's publish not reaching the daemon's setMetadata, or landing on the wrong agent.
    expect(patches).toEqual([{ id: "b", patch: { "paseo-mail.address": { name: "bob", roles: [] } } }]);
    await hooks.get("agent.turn.before")!({ agent: { id: "b" }, turnId: null }, context);
    expect((await tool("mail_send").execute({ to: "bob", subject: "Hi", body: "x" }, toolContext("a"))).text).toContain("→ bob");
    await hooks.get("agent.turn.after")!({ agent: { id: "b" }, turnId: null, outcome: { kind: "completed" }, timeline: [] }, context);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(sent).toEqual([{ id: "b", text: "[paseo-mail] You have 1 unread mail. Call mail_list to see them." }]);

    // The screen's RPCs see the mail; marking it seen leaves it unread for bob.
    const { mailboxes } = (await rpcs.get("mailboxes.list")!({}, context)) as { mailboxes: { agentId: string; name: string; unread: number }[] };
    expect(mailboxes.map((box) => [box.name, box.unread])).toEqual([["bob", 1]]);
    const { mails } = (await rpcs.get("mails.list")!({ agentId: "b", limit: 10 }, context)) as { mails: { id: string }[] };
    expect(((await rpcs.get("mails.view")!({ id: mails[0]!.id }, context)) as { mail: { body: string } }).mail.body).toBe("x");
    await rpcs.get("mails.seen")!({ id: mails[0]!.id, seen: true }, context);
    expect((await tool("mail_list").execute({ unread_only: true }, toolContext("b"))).text).toContain("Unread: 1");
    await cleanup();
  });

  // Wrong: attaching the API without calling mailer.start() (the stored entry is never published).
  // The entry is written before contribute(), so only start()'s backfill can publish it.
  it("publishes the stored registry once the first hook attaches the API", async () => {
    const dataDir = path.join(process.env.PASEO_HOME!, "plugin-data", "lerenn", "mail");
    await mkdir(dataDir, { recursive: true });
    const stored = [{ agentId: "a-carol", name: "carol", roles: ["ops"], workspaceId: "w1", projectId: "p1", updatedAt: "2026-11-22T10:00:00.000Z" }];
    await writeFile(path.join(dataDir, "registry.json"), `${JSON.stringify(stored, null, 2)}\n`);
    const hooks = new Map<string, Handler>();
    const server = { addHook: (name: string, handler: Handler) => (hooks.set(name, handler), () => hooks.delete(name)), handle: () => undefined } as unknown as PluginServerContext;
    const cleanup = contribute(server) as () => Promise<void>;
    const patches: { id: string; patch: unknown }[] = [];
    const context = { paseo: fakeApi([], patches), signal: new AbortController().signal };
    await hooks.get("agent.turn.before")!({ agent: { id: "b" }, turnId: null }, context);
    await vi.waitFor(() => expect(patches).toEqual([{ id: "a-carol", patch: { "paseo-mail.address": { name: "carol", roles: ["ops"] } } }]));
    await cleanup();
  });
});
