import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AgentInfo, Drop, HandOffRecord, HostDirectoryView, Mail, PaseoPort, PortWatcher, PublishedAddress } from "./types";

/** The daemon API handed to hooks and tools (typed via the SDK). */
export type PaseoApi = PluginHandlerContext["paseo"];

type HostDirectory = Awaited<ReturnType<PaseoApi["hosts"]["list"]>>;
type JsonValue = Parameters<ReturnType<PaseoApi["agents"]["ref"]>["setMetadata"]>[0][string];

/** Adapts the daemon API to the mailer's port. The API is attached by the first hook or tool. */
export class PaseoAdapter implements PaseoPort {
  private api: PaseoApi | null = null;
  /** Peer clients by serverId, kept so each peer is connected once. */
  private readonly peers = new Map<string, Promise<PaseoApi>>();
  private readonly subscriptions: { release(): Promise<void> }[] = [];
  private released = false;

  attach(api: PaseoApi): boolean {
    if (this.api) return false;
    this.api = api;
    return true;
  }

  private paseo(): PaseoApi {
    if (!this.api) throw new Error("Paseo API not attached yet");
    return this.api;
  }

  async agent(id: string) {
    return agentInfo(await this.paseo().agents.ref(id).refresh());
  }

  async projectOf(workspaceId: string) {
    const workspace = await this.paseo().workspaces.ref(workspaceId).refresh();
    return workspace?.projectId ?? null;
  }

  send(agentId: string, text: string) {
    return this.paseo().agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
  }

  async hostDirectory(): Promise<HostDirectoryView> {
    return directoryView(await this.paseo().hosts.list());
  }

  async publishAddress(agentId: string, address: { name: string | null; roles: string[] } | null): Promise<void> {
    await this.paseo().agents.ref(agentId).setMetadata({ [ADDRESS_KEY]: address });
  }

  /** Null when the peer has no such agent; throws when the peer cannot be reached. */
  async peerAgent(serverId: string, agentId: string): Promise<AgentInfo | null> {
    return agentInfo(await (await this.peer(serverId)).agents.ref(agentId).refresh());
  }

  async peerAddresses(serverId: string): Promise<PublishedAddress[]> {
    const peer = await this.peer(serverId);
    const found: PublishedAddress[] = [];
    for await (const { agent } of pages(peer, { includeBackground: true })) {
      const address = readAddress(agent.metadata?.[ADDRESS_KEY]);
      if (address) found.push({ agentId: agent.id, name: address.name, roles: address.roles, title: agent.title ?? null });
    }
    return found;
  }

  async writeDrop(serverId: string, agentId: string, mail: Mail): Promise<void> {
    await (await this.peer(serverId)).agents.ref(agentId).setMetadata({ [DROP_PREFIX + mail.id]: mail as unknown as JsonValue });
  }

  async recordHandOff(agentId: string, mailId: string, record: HandOffRecord): Promise<void> {
    await this.paseo().agents.ref(agentId).setMetadata({ [OUT_PREFIX + mailId]: record as unknown as JsonValue });
  }

  async localDrops(): Promise<Drop[]> {
    const drops: Drop[] = [];
    for await (const { agent } of pages(this.paseo(), { includeArchived: true, includeBackground: true })) {
      for (const [key, value] of Object.entries(agent.metadata ?? {})) {
        if (key.startsWith(DROP_PREFIX) && value !== null) drops.push({ agentId: agent.id, mailId: key.slice(DROP_PREFIX.length), value });
      }
    }
    return drops;
  }

  async clearDrop(agentId: string, mailId: string): Promise<void> {
    await this.paseo().agents.ref(agentId).setMetadata({ [DROP_PREFIX + mailId]: null });
  }

  /** Setup runs in the background: a failure is logged, and the sweep still covers what a missed event would. */
  watch(watcher: PortWatcher): void {
    const api = this.paseo();
    void this.watchHosts(api, watcher).catch((error) => console.error("[paseo-mail] watching hosts failed:", error));
    void this.watchDrops(api, watcher).catch((error) => console.error("[paseo-mail] watching agents failed:", error));
  }

  async release(): Promise<void> {
    this.released = true;
    const peers = [...this.peers.values()];
    this.peers.clear();
    const subscriptions = this.subscriptions.splice(0);
    const results = await Promise.allSettled([
      ...subscriptions.map((subscription) => subscription.release()),
      ...peers.map(async (peer) => (await peer).dispose()),
    ]);
    for (const result of results) if (result.status === "rejected") console.error("[paseo-mail] release failed:", result.reason);
  }

  private peer(serverId: string): Promise<PaseoApi> {
    if (this.released) return Promise.reject(new Error(`the paseo adapter is released; no connection to ${serverId}`));
    let peer = this.peers.get(serverId);
    if (!peer) {
      peer = this.paseo().hosts.client(serverId);
      this.peers.set(serverId, peer);
      // A failed connection is not cached: the next call tries again.
      peer.catch(() => this.peers.delete(serverId));
    }
    return peer;
  }

  private async keep<S extends { release(): Promise<void> }>(subscription: S): Promise<S | null> {
    if (this.released) {
      await subscription.release();
      return null;
    }
    this.subscriptions.push(subscription);
    return subscription;
  }

  private async watchHosts(api: PaseoApi, watcher: PortWatcher): Promise<void> {
    const subscription = await this.keep(api.hosts.observe());
    if (!subscription) return;
    // The snapshot sets the baseline: only a later change to online counts as a transition.
    let online = new Set<string>();
    const track = (directory: HostDirectory, notify: boolean) => {
      const now = new Set(directoryView(directory).hosts.filter((host) => host.online).map((host) => host.serverId));
      if (notify) for (const serverId of now) if (!online.has(serverId)) watcher.hostOnline(serverId);
      online = now;
    };
    subscription.subscribe({
      snapshot: (directory) => track(directory, false),
      update: (message) => {
        if (message.type === "hosts.changed") track(message.payload.directory, true);
      },
    });
  }

  private async watchDrops(api: PaseoApi, watcher: PortWatcher): Promise<void> {
    const { subscription } = await api.agents.list({ filter: { includeArchived: true, includeBackground: true }, subscribe: {} });
    const kept = await this.keep(subscription);
    if (!kept) return;
    kept.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type !== "agent_update" || message.payload.kind !== "upsert") return;
        if (Object.keys(message.payload.agent.metadata ?? {}).some((key) => key.startsWith(DROP_PREFIX))) watcher.dropsChanged();
      },
    });
  }
}

const ADDRESS_KEY = "paseo-mail.address";
const DROP_PREFIX = "paseo-mail.in.";
const OUT_PREFIX = "paseo-mail.out.";
/** The daemon accepts at most 200 agents per page (@getpaseo/protocol messages.js, fetch_agents page.limit). */
const PAGE_LIMIT = 200;

function agentInfo(result: { agent: { id: string; title?: string | null; workspaceId?: string | null; status: string; archivedAt?: string | null } } | null): AgentInfo | null {
  if (!result) return null;
  const { agent } = result;
  return { id: agent.id, title: agent.title ?? null, workspaceId: agent.workspaceId ?? null, status: agent.status, archived: Boolean(agent.archivedAt) };
}

function directoryView(directory: HostDirectory): HostDirectoryView {
  return {
    self: { serverId: directory.self.serverId, label: directory.self.label },
    hosts: directory.hosts.flatMap((host) => (host.serverId === null ? [] : [{ serverId: host.serverId, label: host.label, enabled: host.enabled, online: host.status === "online" }])),
  };
}

/** A published address with a name, or null. */
function readAddress(value: unknown): { name: string; roles: string[] } | null {
  if (typeof value !== "object" || value === null) return null;
  const { name, roles } = value as { name?: unknown; roles?: unknown };
  if (typeof name !== "string" || name === "") return null;
  return { name, roles: Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : [] };
}

/** Every non-archived-by-default agent entry, page by page. */
async function* pages(api: PaseoApi, filter: { includeArchived?: boolean; includeBackground?: boolean }) {
  let cursor: string | undefined;
  do {
    const result = await api.agents.list({ filter, page: { limit: PAGE_LIMIT, cursor } });
    yield* result.entries;
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor !== undefined);
}
