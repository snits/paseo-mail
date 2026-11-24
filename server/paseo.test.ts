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
  /** The last non-empty page still carries a cursor (hasMore false); the page past the end has none. */
  let cursorOnLastPage = false;
  const dispose = vi.fn(async () => {});
  /** When set, every `setMetadata` rejects with it (after recording the patch), as the daemon refuses a write. */
  let metadataFailure: Error | null = null;

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
    const hasMore = end < visible.length;
    const nextCursor = hasMore || (cursorOnLastPage && start < visible.length) ? `p${end}` : null;
    return {
      requestId: "req",
      entries: visible.slice(start, end).map((agent) => ({ agent: snapshotOf(agent) })),
      pageInfo: { nextCursor, prevCursor: start === 0 ? null : `p${Math.max(0, start - PAGE_SIZE)}`, hasMore },
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
            if (metadataFailure) throw metadataFailure;
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
    refuseMetadata(error: Error) {
      metadataFailure = error;
    },
    keepCursorOnLastPage() {
      cursorOnLastPage = true;
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

  // paseo-mail#qkf2. A routable peer is registered, so a write through a peer client would show.
  // Wrong: the drop prefix ("paseo-mail.in.m_77") as the key; agentId and mailId swapped (distinct
  // literals show it); the bare prefix as the key; a stringified record; extra fields in the value;
  // writing on the peer named in record.to instead of on this daemon's agent.
  it("recordHandOff sends { paseo-mail.out.<mailId>: record } on the local agent", async () => {
    const local = stubDaemon("srv_Self1");
    const peer = stubDaemon("srv_Peer9", [{ id: "a-remote" }]);
    local.peers.set("srv_Peer9", peer);
    const record = { to: { serverId: "srv_Peer9", agentId: "a-remote" }, digest: "4f1c0e9a7b2d3c5e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6" };
    await expect(attached(local).recordHandOff("a-local", "m_77", record)).resolves.toBeUndefined();
    expect(local.patches).toStrictEqual([
      { agentId: "a-local", patch: { "paseo-mail.out.m_77": { to: { serverId: "srv_Peer9", agentId: "a-remote" }, digest: "4f1c0e9a7b2d3c5e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6" } } },
    ]);
    expect(local.clientCalls).toEqual([]);
    expect(peer.patches).toEqual([]);
  });

  // The hand-off tells "sender gone" from other failures only by a write that rejects. Wrong:
  // swallowing the daemon's refusal (resolves); replacing it with an error of its own. Positive
  // control: the patch was attempted.
  it("recordHandOff rejects with the daemon's error when the write is refused", async () => {
    const local = stubDaemon("srv_Self1");
    local.refuseMetadata(new Error("agent a-gone not found"));
    const record = { to: { serverId: "srv_Peer9", agentId: "a-remote" }, digest: "4f1c0e9a7b2d3c5e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6" };
    await expect(attached(local).recordHandOff("a-gone", "m_77", record)).rejects.toThrow("agent a-gone not found");
    expect(local.patches.map((entry) => entry.agentId)).toEqual(["a-gone"]);
  });

  // paseo-mail#qkf2. Two routable peers hold an a-remote. Wrong: writing on the local daemon (the record
  // lives on the sender's host) or through another peer's client; the drop prefix; agentId and mailId
  // swapped (distinct literals show it); a value other than null.
  it("clearHandOff sends { paseo-mail.out.<mailId>: null } on the peer's agent", async () => {
    const local = stubDaemon("srv_Self1");
    const peer = stubDaemon("srv_Peer9", [{ id: "a-remote" }]);
    const other = stubDaemon("srv_Peer7", [{ id: "a-remote" }]);
    local.peers.set("srv_Peer9", peer);
    local.peers.set("srv_Peer7", other);
    await expect(attached(local).clearHandOff("srv_Peer9", "a-remote", "m_77")).resolves.toBeUndefined();
    expect(local.clientCalls).toEqual(["srv_Peer9"]);
    expect(peer.patches).toStrictEqual([{ agentId: "a-remote", patch: { "paseo-mail.out.m_77": null } }]);
    expect({ local: local.patches, other: other.patches }).toEqual({ local: [], other: [] });
  });

  // The importer logs a refused record clear, so it must see it. Wrong: swallowing the peer's refusal
  // (resolves); replacing it with an error of its own. Positive control: the patch was attempted.
  it("clearHandOff rejects with the peer's error when the write is refused", async () => {
    const local = stubDaemon("srv_Self1");
    const peer = stubDaemon("srv_Peer9", [{ id: "a-remote" }]);
    local.peers.set("srv_Peer9", peer);
    peer.refuseMetadata(new Error("workspace.write denied"));
    await expect(attached(local).clearHandOff("srv_Peer9", "a-remote", "m_77")).rejects.toThrow("workspace.write denied");
    expect(peer.patches.map((entry) => entry.agentId)).toEqual(["a-remote"]);
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
    expect(await adapter.peerAgent("srv_Peer9", "a-remote")).toEqual({ id: "a-remote", title: "Remote", workspaceId: null, status: "idle", archived: true, handOffs: {} });
    expect(await adapter.peerAgent("srv_Peer9", "a-gone")).toBeNull();
    expect(peer.refreshed).toEqual(["a-remote", "a-gone"]);
  });

  // paseo-mail#qkf2. The archived a-remote holds two records (one whose value is no record: the
  // adapter passes values through raw), a cleared one (null), a drop, its address, another plugin's
  // key and "paseo-mail.outbox" (no dot after "out"). Wrong: no handOffs; "paseo-mail.out" without its
  // dot as the prefix (outbox kept) or "paseo-mail." (address and drop kept); keeping the null;
  // keeping the prefix in the mail id; parsing or filtering the values; a second read of the peer
  // (a list call, or a second refresh); reading the local daemon.
  it("returns the agent's hand-off records by mail id, from the same refresh", async () => {
    const record = { to: { serverId: "srv_Self1", agentId: "a-local" }, digest: "9a0b1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f" };
    const { local, peer, adapter } = pair([
      {
        id: "a-remote",
        title: "Remote",
        archived: true,
        metadata: {
          "paseo-mail.out.m_1": record,
          "paseo-mail.out.m_2": "not a record",
          "paseo-mail.out.m_3": null,
          "paseo-mail.in.m_4": { subject: "x" },
          "paseo-mail.address": { name: "remote", roles: [] },
          "other.plugin.out.m_5": 5,
          "paseo-mail.outbox": 6,
        },
      },
    ]);
    expect(await adapter.peerAgent("srv_Peer9", "a-remote")).toStrictEqual({
      id: "a-remote",
      title: "Remote",
      workspaceId: null,
      status: "idle",
      archived: true,
      handOffs: { m_1: { to: { serverId: "srv_Self1", agentId: "a-local" }, digest: "9a0b1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f" }, m_2: "not a record" },
    });
    expect({ refreshed: peer.refreshed, listed: peer.listCalls.length, local: local.refreshed }).toEqual({ refreshed: ["a-remote"], listed: 0, local: [] });
  });

  // A peer's key "paseo-mail.out.__proto__" holds an object. Wrong: assigning it on a plain object,
  // which sets handOffs' prototype, so a record for m_1 inside that value reads as handOffs.m_1.
  it("keeps a record key named __proto__ as an own entry, not as the prototype", async () => {
    const record = { to: { serverId: "srv_Self1", agentId: "a-local" }, digest: "9a0b1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f" };
    const { adapter } = pair([{ id: "a-remote", metadata: { "paseo-mail.out.__proto__": { m_1: record } } }]);
    const handOffs = (await adapter.peerAgent("srv_Peer9", "a-remote"))!.handOffs;
    expect(Object.getPrototypeOf(handOffs)).toBe(Object.prototype);
    expect(Object.hasOwn(handOffs, "__proto__")).toBe(true);
    expect(handOffs.m_1).toBeUndefined();
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

  // Wrong: caching the rejected client promise (the second call rejects "host offline" without
  // asking hosts.client again).
  it("does not keep a failed hosts.client: the next call connects again", async () => {
    const { local, adapter } = pair([{ id: "a-remote", title: "Remote" }]);
    local.clientFailure.set("srv_Peer9", new Error("host offline"));
    await expect(adapter.peerAgent("srv_Peer9", "a-remote")).rejects.toThrow("host offline");
    local.clientFailure.delete("srv_Peer9");
    await expect(adapter.peerAgent("srv_Peer9", "a-remote")).resolves.toMatchObject({ id: "a-remote", title: "Remote" });
    expect(local.clientCalls).toEqual(["srv_Peer9", "srv_Peer9"]);
  });

  // Wrong: no cache (one hosts.client per call, so two here).
  it("connects to a peer once across calls", async () => {
    const { local, peer, adapter } = pair([{ id: "a-remote" }]);
    await adapter.peerAgent("srv_Peer9", "a-remote");
    await adapter.peerAgent("srv_Peer9", "a-remote");
    expect(peer.refreshed).toEqual(["a-remote", "a-remote"]);
    expect(local.clientCalls).toEqual(["srv_Peer9"]);
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

  // Wrong: accepting "" as a name (a-empty comes back with name ""). Positive control: a-named.
  it("drops a row that publishes an empty name", async () => {
    const local = stubDaemon("srv_Self1");
    const peer = stubDaemon("srv_Peer9", [
      { id: "a-empty", metadata: { "paseo-mail.address": { name: "", roles: ["qa"] } } },
      { id: "a-named", metadata: { "paseo-mail.address": { name: "named", roles: ["qa"] } } },
    ]);
    local.peers.set("srv_Peer9", peer);
    expect(await attached(local).peerAddresses("srv_Peer9")).toEqual([{ agentId: "a-named", name: "named", roles: ["qa"], title: null }]);
  });

  // Wrong: passing roles through unfiltered (["qa", 7]); dropping the whole row for one bad role.
  it("keeps only the string roles", async () => {
    const local = stubDaemon("srv_Self1");
    const peer = stubDaemon("srv_Peer9", [{ id: "a-mixed", metadata: { "paseo-mail.address": { name: "mixed", roles: ["qa", 7] } } }]);
    local.peers.set("srv_Peer9", peer);
    expect(await attached(local).peerAddresses("srv_Peer9")).toEqual([{ agentId: "a-mixed", name: "mixed", roles: ["qa"], title: null }]);
  });
});

describe("PaseoAdapter paging", () => {
  // Wrong: a page limit above the protocol's maximum (the daemon rejects fetch_agents with
  // page.limit > 200, @getpaseo/protocol messages.js); no page limit at all.
  it("asks for at most 200 agents per page", async () => {
    const local = stubDaemon("srv_Self1", [{ id: "a-1" }, { id: "a-2" }, { id: "a-3" }]);
    const peer = stubDaemon("srv_Peer9", [{ id: "a-4" }, { id: "a-5" }, { id: "a-6" }]);
    local.peers.set("srv_Peer9", peer);
    const adapter = attached(local);
    await adapter.localDrops();
    await adapter.peerAddresses("srv_Peer9");
    const limits = [...local.listCalls, ...peer.listCalls].map((call) => call.page?.limit);
    expect(limits.length).toBeGreaterThanOrEqual(4);
    for (const limit of limits) {
      expect(typeof limit).toBe("number");
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(200);
    }
  });

  // Wrong: stopping only on a null nextCursor (a third call, for the empty page past the end);
  // stopping on a page shorter than the limit (one call, and the hit on page 2 is lost). Four
  // agents at two per page: page 2 says hasMore false but still carries a cursor.
  it("stops when hasMore is false even if a cursor is present", async () => {
    const local = stubDaemon("srv_Self1", [{ id: "a-1" }, { id: "a-2" }, { id: "a-3" }, { id: "a-4", metadata: { "paseo-mail.in.m_4": { n: 4 } } }]);
    const peer = stubDaemon("srv_Peer9", [{ id: "a-5" }, { id: "a-6" }, { id: "a-7" }, { id: "a-8", metadata: { "paseo-mail.address": { name: "eight", roles: [] } } }]);
    local.keepCursorOnLastPage();
    peer.keepCursorOnLastPage();
    local.peers.set("srv_Peer9", peer);
    const adapter = attached(local);
    expect(await adapter.localDrops()).toEqual([{ agentId: "a-4", mailId: "m_4", value: { n: 4 } }]);
    expect(await adapter.peerAddresses("srv_Peer9")).toEqual([{ agentId: "a-8", name: "eight", roles: [], title: null }]);
    expect({ local: local.listCalls.length, peer: peer.listCalls.length }).toEqual({ local: 2, peer: 2 });
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

  // Wrong: keeping a cleared (null) drop key. Positive control: the live drop on the same agent.
  it("skips a drop key whose value is null", async () => {
    const local = stubDaemon("srv_Self1", [{ id: "a-1", metadata: { "paseo-mail.in.m_x": null, "paseo-mail.in.m_y": { n: 1 } } }]);
    expect(await attached(local).localDrops()).toEqual([{ agentId: "a-1", mailId: "m_y", value: { n: 1 } }]);
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

  // Wrong: the observe snapshot notifies (a host already online at watch time calls hostOnline).
  // Positive control: a later offline-then-online change does.
  it("does not call hostOnline for a host already online in the snapshot", async () => {
    const local = stubDaemon("srv_Self1");
    const offline = { self: { serverId: "srv_Self1", label: "cantor" }, hosts: [hostEntry("srv_Peer9", "m2-max", "offline")] };
    const online = { self: { serverId: "srv_Self1", label: "cantor" }, hosts: [hostEntry("srv_Peer9", "m2-max", "online")] };
    local.setDirectory(online);
    const w = watcher();
    attached(local).watch(w.value);
    await settle();
    expect(w.hostOnline).not.toHaveBeenCalled();
    local.emitHosts(offline);
    local.emitHosts(online);
    await settle();
    expect(w.hostOnline.mock.calls).toEqual([["srv_Peer9"]]);
  });

  // Wrong: reading payload.agent on every agent_update (a remove carries only agentId, so it
  // throws). Positive control: an upsert with a drop key afterwards still calls dropsChanged.
  it("ignores an agent remove update", async () => {
    const local = stubDaemon("srv_Self1", [{ id: "a-1" }]);
    const w = watcher();
    attached(local).watch(w.value);
    await settle();
    expect(() => local.emitAgentUpdate({ kind: "remove", agentId: "a-1" })).not.toThrow();
    expect(w.dropsChanged).not.toHaveBeenCalled();
    local.emitAgentUpdate({ kind: "upsert", agent: snapshotOf({ id: "a-1", metadata: { "paseo-mail.in.m_5": { subject: "x" } } }) });
    expect(w.dropsChanged).toHaveBeenCalledTimes(1);
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

  // Wrong: a subscription that settles after release() is kept, not released. Only the agent-list
  // subscription takes that path: hosts.observe() is kept synchronously inside watch(), before
  // release() runs, so release() itself releases it either way.
  it("releases a subscription that settles after release()", async () => {
    const local = stubDaemon("srv_Self1");
    const adapter = attached(local);
    adapter.watch(watcher().value);
    await adapter.release();
    await settle();
    expect(local.released()).toEqual({ hosts: 1, agents: 1 });
  });

  // Wrong: peer() opening (and caching) a client after release(), which nothing then disposes;
  // guarding one public method but not the others; opening the client and then refusing. Both
  // peers are routable, so a rejection cannot come from "no route". Positive control: the same
  // adapter connects to srv_Peer9 before release().
  it("refuses every peer call after release() and opens no client", async () => {
    const local = stubDaemon("srv_Self1");
    const peerA = stubDaemon("srv_Peer9", [{ id: "a-remote" }]);
    const peerB = stubDaemon("srv_Peer7", [{ id: "a-other" }]);
    local.peers.set("srv_Peer9", peerA);
    local.peers.set("srv_Peer7", peerB);
    const adapter = attached(local);
    await expect(adapter.peerAgent("srv_Peer9", "a-remote")).resolves.toMatchObject({ id: "a-remote" });
    expect(local.clientCalls).toEqual(["srv_Peer9"]);
    await adapter.release();
    for (const serverId of ["srv_Peer9", "srv_Peer7"]) {
      await expect(adapter.peerAgent(serverId, "a-remote")).rejects.toThrow();
      await expect(adapter.peerAddresses(serverId)).rejects.toThrow();
      await expect(adapter.writeDrop(serverId, "a-remote", mail)).rejects.toThrow();
      await expect(adapter.clearHandOff(serverId, "a-remote", "m_77")).rejects.toThrow();
    }
    expect(local.clientCalls).toEqual(["srv_Peer9"]);
    expect({ peerA: peerA.patches, peerB: peerB.patches }).toEqual({ peerA: [], peerB: [] });
  });

  // Wrong: Promise.all instead of allSettled (release() rejects when one dispose does).
  it("resolves and disposes the other peer when one peer's dispose rejects", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const local = stubDaemon("srv_Self1");
      const peerA = stubDaemon("srv_Peer9", [{ id: "a-remote" }]);
      const peerB = stubDaemon("srv_Peer7", [{ id: "a-other" }]);
      local.peers.set("srv_Peer9", peerA);
      local.peers.set("srv_Peer7", peerB);
      peerA.dispose.mockRejectedValueOnce(new Error("socket closed"));
      const adapter = attached(local);
      await adapter.peerAgent("srv_Peer9", "a-remote");
      await adapter.peerAgent("srv_Peer7", "a-other");
      await expect(adapter.release()).resolves.toBeUndefined();
      expect({ peerA: peerA.dispose.mock.calls.length, peerB: peerB.dispose.mock.calls.length }).toEqual({ peerA: 1, peerB: 1 });
    } finally {
      error.mockRestore();
    }
  });
});
