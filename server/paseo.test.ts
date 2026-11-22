import { describe, expect, it, vi } from "vitest";
import { PaseoAdapter, type PaseoApi } from "./paseo";
import type { Mail, PortWatcher } from "./types";

// A stub of the 0.16.2 daemon API, faithful where the adapter's properties live: `agents.list`
// pages by cursor and honours `filter.includeArchived` / `filter.includeBackground` (archived and
// background agents are listed only when the matching filter flag is true), subscriptions follow
// OwnedSubscription (snapshot on subscribe, then updates), and `hosts.client` hands out a separate
// stub per peer so a call on the wrong daemon shows.

interface StubAgent {
  id: string;
  title?: string | null;
  archived?: boolean;
  background?: boolean;
  metadata?: Record<string, unknown>;
}

type ListOptions = { filter?: { includeArchived?: boolean; includeBackground?: boolean }; page?: { limit?: number; cursor?: string }; subscribe?: object };
type Observer = { snapshot(value: unknown): void; update(message: unknown): void };

const PAGE_SIZE = 2;
const MAX_LIST_CALLS = 6;

class StubSubscription {
  readonly subscriptionId: string;
  readonly ready: Promise<unknown>;
  readonly observers = new Set<Observer>();
  readonly release = vi.fn(async () => {
    this.observers.clear();
  });

  constructor(
    id: string,
    private readonly snapshot: unknown,
  ) {
    this.subscriptionId = id;
    this.ready = Promise.resolve(snapshot);
  }

  subscribe(observer: Observer): () => void {
    this.observers.add(observer);
    observer.snapshot(this.snapshot);
    return () => this.observers.delete(observer);
  }

  emit(message: unknown): void {
    for (const observer of [...this.observers]) observer.update(message);
  }
}

function snapshotOf(agent: StubAgent) {
  return {
    id: agent.id,
    title: agent.title ?? null,
    status: "idle",
    archivedAt: agent.archived ? "2026-11-20T10:00:00.000Z" : null,
    background: agent.background ?? false,
    labels: {},
    ...(agent.metadata ? { metadata: agent.metadata } : {}),
  };
}

function hostEntry(serverId: string | null, label: string | null, status: string, enabled = true) {
  return {
    registrationId: `reg-${serverId ?? label}`,
    serverId,
    label,
    source: { id: "src", key: "key" },
    metadata: {},
    enabled,
    status,
    targetDescription: "",
    lastOnlineAt: null,
    nextRetryAt: null,
    error: null,
  };
}

type Directory = { self: { serverId: string; label: string }; hosts: ReturnType<typeof hostEntry>[] };

function stubDaemon(serverId: string, agents: StubAgent[] = []) {
  const listCalls: ListOptions[] = [];
  const patches: { agentId: string; patch: Record<string, unknown> }[] = [];
  const refreshed: string[] = [];
  const clientCalls: string[] = [];
  const refreshResult = new Map<string, () => Promise<unknown>>();
  const clientFailure = new Map<string, Error>();
  const peers = new Map<string, { api: PaseoApi }>();
  const agentHandlers = new Set<(update: unknown) => void>();
  let directory: Directory = { self: { serverId, label: serverId }, hosts: [] };
  let agentSubscription: StubSubscription | null = null;
  let hostSubscription: StubSubscription | null = null;
  const dispose = vi.fn(async () => {});

  function page(options: ListOptions = {}) {
    const { signal: _signal, ...recorded } = options as ListOptions & { signal?: unknown };
    listCalls.push(structuredClone(recorded));
    if (listCalls.length > MAX_LIST_CALLS) throw new Error("too many agents.list calls (is the cursor ignored?)");
    const filter = options.filter ?? {};
    const visible = agents.filter((agent) => (!agent.archived || filter.includeArchived === true) && (!agent.background || filter.includeBackground === true));
    const cursor = options.page?.cursor;
    if (cursor !== undefined && !/^p\d+$/.test(cursor)) throw new Error(`unknown cursor ${cursor}`);
    const start = cursor === undefined ? 0 : Number(cursor.slice(1));
    const end = start + PAGE_SIZE;
    const nextCursor = end < visible.length ? `p${end}` : null;
    return {
      requestId: "req",
      entries: visible.slice(start, end).map((agent) => ({ agent: snapshotOf(agent) })),
      pageInfo: { nextCursor, prevCursor: start === 0 ? null : `p${Math.max(0, start - PAGE_SIZE)}`, hasMore: nextCursor !== null },
    };
  }

  const api = {
    agents: {
      async list(options?: ListOptions) {
        const result = page(options);
        if (!options?.subscribe) return result;
        agentSubscription = new StubSubscription("agents-sub", { ...result, subscriptionId: "agents-sub" });
        return { ...result, subscriptionId: "agents-sub", subscription: agentSubscription };
      },
      subscribe(handler: (update: unknown) => void) {
        agentHandlers.add(handler);
        return () => agentHandlers.delete(handler);
      },
      ref(id: string) {
        return {
          id,
          async refresh() {
            refreshed.push(id);
            const override = refreshResult.get(id);
            if (override) return override();
            const agent = agents.find((candidate) => candidate.id === id);
            return agent ? { agent: snapshotOf(agent), project: null } : null;
          },
          async setMetadata(patch: Record<string, unknown>) {
            patches.push({ agentId: id, patch: structuredClone(patch) });
          },
          async send() {},
        };
      },
    },
    hosts: {
      async list() {
        return structuredClone(directory);
      },
      observe() {
        hostSubscription = new StubSubscription("hosts-sub", { ...structuredClone(directory), subscriptionId: "hosts-sub" });
        return hostSubscription;
      },
      async client(peerId: string) {
        clientCalls.push(peerId);
        const failure = clientFailure.get(peerId);
        if (failure) throw failure;
        const peer = peers.get(peerId);
        if (!peer) throw new Error(`no route to ${peerId}`);
        return peer.api;
      },
    },
    dispose,
  };

  return {
    api: api as unknown as PaseoApi,
    listCalls,
    patches,
    refreshed,
    clientCalls,
    refreshResult,
    clientFailure,
    peers,
    dispose,
    setDirectory(next: Directory) {
      directory = next;
    },
    /** Delivers a directory change the way the SDK does (`hosts.changed` on the observe subscription). */
    emitHosts(next: Directory) {
      directory = next;
      hostSubscription?.emit({ type: "hosts.changed", payload: { subscriptionId: "hosts-sub", directory: structuredClone(next) } });
    },
    /** Delivers an agent update to whichever channel the adapter registered, as the SDK does for both. */
    emitAgentUpdate(payload: unknown) {
      agentSubscription?.emit({ type: "agent_update", payload });
      for (const handler of [...agentHandlers]) handler(payload);
    },
    released() {
      return { hosts: hostSubscription?.release.mock.calls.length ?? 0, agents: agentSubscription?.release.mock.calls.length ?? 0 };
    },
  };
}

function attached(daemon: ReturnType<typeof stubDaemon>): PaseoAdapter {
  const adapter = new PaseoAdapter();
  adapter.attach(daemon.api);
  return adapter;
}

function watcher() {
  const hostOnline = vi.fn<(serverId: string) => void>();
  const dropsChanged = vi.fn<() => void>();
  const value: PortWatcher = { hostOnline, dropsChanged };
  return { value, hostOnline, dropsChanged };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const mail: Mail = {
  id: "m_abc",
  threadId: "m_abc",
  inReplyTo: null,
  from: { agentId: "a-local", name: "sender", title: "Sender", serverId: "srv_Self1" },
  to: { agentId: "a-remote", address: "probe@m2-max", serverId: "srv_Peer9" },
  subject: "Hello",
  body: "Body",
  createdAt: "2026-11-22T10:00:00.000Z",
  readAt: null,
  nudgedAt: null,
  bouncedAt: null,
  seenAt: null,
  handedOffAt: null,
};

describe("PaseoAdapter.hostDirectory", () => {
  // Wrong: keeping the null-serverId entry; online = enabled, or online = status !== "offline"
  // (both read the "connecting" host as online).
  it("drops entries whose serverId is null and reads online from the status", async () => {
    const local = stubDaemon("srv_Self1");
    local.setDirectory({
      self: { serverId: "srv_Self1", label: "cantor" },
      hosts: [hostEntry("srv_A1", "m2-max", "online"), hostEntry(null, "pending", "connecting"), hostEntry("srv_B2", null, "connecting"), hostEntry("srv_C3", "off", "disabled", false)],
    });
    expect(await attached(local).hostDirectory()).toEqual({
      self: { serverId: "srv_Self1", label: "cantor" },
      hosts: [
        { serverId: "srv_A1", label: "m2-max", enabled: true, online: true },
        { serverId: "srv_B2", label: null, enabled: true, online: false },
        { serverId: "srv_C3", label: "off", enabled: false, online: false },
      ],
    });
  });
});

describe("PaseoAdapter metadata writes", () => {
  // Wrong: a stringified value; a per-agent key suffix; clearing as {name: null, roles: []}.
  it("publishAddress sends { paseo-mail.address: {name, roles} }, or null to clear", async () => {
    const local = stubDaemon("srv_Self1");
    const adapter = attached(local);
    await adapter.publishAddress("a-local", { name: "probe", roles: ["qa", "review"] });
    await adapter.publishAddress("a-local", null);
    expect(local.patches).toStrictEqual([
      { agentId: "a-local", patch: { "paseo-mail.address": { name: "probe", roles: ["qa", "review"] } } },
      { agentId: "a-local", patch: { "paseo-mail.address": null } },
    ]);
  });

  // Wrong: agentId and mailId swapped (distinct literals show it); the bare prefix as the key.
  it("clearDrop sends { paseo-mail.in.<mailId>: null } on the local agent", async () => {
    const local = stubDaemon("srv_Self1");
    await attached(local).clearDrop("a-local", "m_77");
    expect(local.patches).toStrictEqual([{ agentId: "a-local", patch: { "paseo-mail.in.m_77": null } }]);
  });

  // Wrong: writing on the local daemon instead of the peer; JSON.stringify(mail) as the value.
  it("writeDrop sends { paseo-mail.in.<mail.id>: <mail object> } on the peer's agent", async () => {
    const local = stubDaemon("srv_Self1");
    const peer = stubDaemon("srv_Peer9", [{ id: "a-remote" }]);
    local.peers.set("srv_Peer9", peer);
    await attached(local).writeDrop("srv_Peer9", "a-remote", mail);
    expect(local.clientCalls).toEqual(["srv_Peer9"]);
    expect(peer.patches).toStrictEqual([{ agentId: "a-remote", patch: { "paseo-mail.in.m_abc": mail } }]);
    expect(local.patches).toEqual([]);
  });
});

describe("PaseoAdapter.peerAgent", () => {
  function pair(remote: StubAgent[]) {
    const local = stubDaemon("srv_Self1");
    const peer = stubDaemon("srv_Peer9", remote);
    local.peers.set("srv_Peer9", peer);
    return { local, peer, adapter: attached(local) };
  }

  // Positive control: an archived agent is found (not folded into null); a missing one is null.
  it("returns the agent when found (archived too) and null when refresh() resolves null", async () => {
    const { peer, adapter } = pair([{ id: "a-remote", title: "Remote", archived: true }]);
    expect(await adapter.peerAgent("srv_Peer9", "a-remote")).toEqual({ id: "a-remote", title: "Remote", workspaceId: null, status: "idle", archived: true });
    expect(await adapter.peerAgent("srv_Peer9", "a-gone")).toBeNull();
    expect(peer.refreshed).toEqual(["a-remote", "a-gone"]);
  });

  // Wrong: `.catch(() => null)` folds an unreachable host into "missing", which would clear a drop that should park.
  it("rejects when refresh() rejects", async () => {
    const { peer, adapter } = pair([{ id: "a-remote" }]);
    peer.refreshResult.set("a-remote", () => Promise.reject(new Error("route lost")));
    await expect(adapter.peerAgent("srv_Peer9", "a-remote")).rejects.toThrow("route lost");
  });

  it("rejects when hosts.client rejects", async () => {
    const { local, adapter } = pair([{ id: "a-remote" }]);
    local.clientFailure.set("srv_Peer9", new Error("host offline"));
    await expect(adapter.peerAgent("srv_Peer9", "a-remote")).rejects.toThrow("host offline");
  });
});

describe("PaseoAdapter.peerAddresses", () => {
  // Wrong: reading one page (page 1 has no publisher: result []); keeping the nameless or the
  // archived publisher; reading the local daemon instead of the peer.
  it("reads every page and keeps non-archived agents that publish a name", async () => {
    const local = stubDaemon("srv_Self1", [{ id: "a-local", metadata: { "paseo-mail.address": { name: "local", roles: [] } } }]);
    const peer = stubDaemon("srv_Peer9", [
      { id: "a-plain" },
      { id: "a-old", archived: true, metadata: { "paseo-mail.address": { name: "old", roles: [] } } },
      { id: "a-roles", metadata: { "paseo-mail.address": { name: null, roles: ["qa"] } } },
      { id: "a-probe", title: "Probe", metadata: { "paseo-mail.address": { name: "probe", roles: ["qa", "review"] }, "other.plugin": 1 } },
    ]);
    local.peers.set("srv_Peer9", peer);
    expect(await attached(local).peerAddresses("srv_Peer9")).toEqual([{ agentId: "a-probe", name: "probe", roles: ["qa", "review"], title: "Probe" }]);
    // Page 1 (a-plain, a-roles) holds no publisher, so a one-page reader returns [].
    expect(peer.listCalls.length).toBeGreaterThanOrEqual(2);
  });

  // Wrong: includeBackground at the top level instead of under filter (the stub then hides the agent).
  it("passes filter.includeBackground: true on every list call", async () => {
    const local = stubDaemon("srv_Self1");
    const peer = stubDaemon("srv_Peer9", [{ id: "a-bg", background: true, metadata: { "paseo-mail.address": { name: "worker", roles: [] } } }]);
    local.peers.set("srv_Peer9", peer);
    expect(await attached(local).peerAddresses("srv_Peer9")).toEqual([{ agentId: "a-bg", name: "worker", roles: [], title: null }]);
    expect(peer.listCalls.length).toBeGreaterThan(0);
    for (const call of peer.listCalls) expect(call.filter?.includeBackground).toBe(true);
  });
});

describe("PaseoAdapter.localDrops", () => {
  // Wrong: one page (the only drop is on page 2); "paseo-mail." as the prefix (picks up the
  // address key on page 1); keeping the prefix in mailId.
  it("reads every page and returns each paseo-mail.in.* key", async () => {
    const local = stubDaemon("srv_Self1", [
      { id: "a-1", metadata: { "paseo-mail.address": { name: "one", roles: [] } } },
      { id: "a-2" },
      { id: "a-3", metadata: { "paseo-mail.address": { name: "three", roles: [] }, "paseo-mail.in.m_9": { subject: "hi" } } },
    ]);
    expect(await attached(local).localDrops()).toEqual([{ agentId: "a-3", mailId: "m_9", value: { subject: "hi" } }]);
  });

  // Wrong: either flag missing or at the top level (the stub then hides that agent's drop).
  it("passes filter.includeArchived and filter.includeBackground on every list call, and so sees archived and background agents", async () => {
    const local = stubDaemon("srv_Self1", [
      { id: "a-arch", archived: true, metadata: { "paseo-mail.in.m_1": { n: 1 } } },
      { id: "a-bg", background: true, metadata: { "paseo-mail.in.m_2": { n: 2 } } },
      { id: "a-live", metadata: { "paseo-mail.in.m_3": { n: 3 } } },
    ]);
    const drops = await attached(local).localDrops();
    expect([...drops].sort((a, b) => a.mailId.localeCompare(b.mailId))).toEqual([
      { agentId: "a-arch", mailId: "m_1", value: { n: 1 } },
      { agentId: "a-bg", mailId: "m_2", value: { n: 2 } },
      { agentId: "a-live", mailId: "m_3", value: { n: 3 } },
    ]);
    expect(local.listCalls.length).toBeGreaterThan(0);
    for (const call of local.listCalls) {
      expect(call.filter?.includeArchived).toBe(true);
      expect(call.filter?.includeBackground).toBe(true);
    }
  });
});

describe("PaseoAdapter.watch", () => {
  it("subscribes to the agent list with filter.includeArchived and filter.includeBackground", async () => {
    const local = stubDaemon("srv_Self1");
    attached(local).watch(watcher().value);
    await settle();
    const subscribed = local.listCalls.find((call) => call.subscribe !== undefined);
    expect(subscribed).toBeDefined();
    expect(subscribed?.filter?.includeArchived).toBe(true);
    expect(subscribed?.filter?.includeBackground).toBe(true);
  });

  // Wrong: hostOnline on every directory event that reads online (two calls for two events);
  // never re-arming after offline (one call at the end instead of two).
  it("calls hostOnline on a transition to online only", async () => {
    const local = stubDaemon("srv_Self1");
    const offline = { self: { serverId: "srv_Self1", label: "cantor" }, hosts: [hostEntry("srv_Peer9", "m2-max", "offline")] };
    const online = { self: { serverId: "srv_Self1", label: "cantor" }, hosts: [hostEntry("srv_Peer9", "m2-max", "online")] };
    local.setDirectory(offline);
    const w = watcher();
    attached(local).watch(w.value);
    await settle();
    local.emitHosts(online);
    local.emitHosts(online);
    await settle();
    expect(w.hostOnline.mock.calls).toEqual([["srv_Peer9"]]);
    local.emitHosts(offline);
    local.emitHosts(online);
    await settle();
    expect(w.hostOnline.mock.calls).toEqual([["srv_Peer9"], ["srv_Peer9"]]);
  });

  // Wrong: dropsChanged on every agent update, or on any "paseo-mail." key (the negative case
  // carries only paseo-mail.address). Positive control: the same agent with a drop key.
  it("calls dropsChanged on an agent update carrying a paseo-mail.in.* key, and not on one without", async () => {
    const local = stubDaemon("srv_Self1", [{ id: "a-1" }]);
    const w = watcher();
    attached(local).watch(w.value);
    await settle();
    local.emitAgentUpdate({ kind: "upsert", agent: snapshotOf({ id: "a-1", metadata: { "paseo-mail.address": { name: "one", roles: [] } } }) });
    await settle();
    expect(w.dropsChanged).not.toHaveBeenCalled();
    local.emitAgentUpdate({ kind: "upsert", agent: snapshotOf({ id: "a-1", metadata: { "paseo-mail.in.m_5": { subject: "x" } } }) });
    await settle();
    expect(w.dropsChanged).toHaveBeenCalled();
  });
});

describe("PaseoAdapter.release", () => {
  // Wrong: releasing the subscriptions but not the peer clients (or only the last one cached).
  it("releases the host and agent-list subscriptions and every peer client", async () => {
    const local = stubDaemon("srv_Self1");
    const peerA = stubDaemon("srv_Peer9", [{ id: "a-remote" }]);
    const peerB = stubDaemon("srv_Peer7", []);
    local.peers.set("srv_Peer9", peerA);
    local.peers.set("srv_Peer7", peerB);
    const adapter = attached(local);
    adapter.watch(watcher().value);
    await settle();
    await adapter.peerAgent("srv_Peer9", "a-remote");
    await adapter.peerAddresses("srv_Peer7");
    await adapter.release();
    expect({ ...local.released(), peerA: peerA.dispose.mock.calls.length, peerB: peerB.dispose.mock.calls.length }).toEqual({ hosts: 1, agents: 1, peerA: 1, peerB: 1 });
  });
});
