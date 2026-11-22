import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Mailer, type MailerOptions } from "../server/mailer";
import { Registry } from "../server/registry";
import { MailStore } from "../server/store";
import type { AgentInfo, Caller, Drop, HostDirectoryView, Mail, PaseoPort, PortWatcher, PublishedAddress } from "../server/types";

/** The port operations `FakeNetwork.fault` can make fail against one host. */
export type FaultOp = "peerAddresses" | "peerAgent" | "writeDrop";

/** One host-side port call, with its arguments copied at call time. */
export interface PortCall {
  op: "hostDirectory" | "publishAddress" | "peerAgent" | "peerAddresses" | "writeDrop" | "localDrops" | "clearDrop" | "watch" | "release";
  args: unknown[];
}

const ADDRESS_KEY = "paseo-mail.address";
const DROP_PREFIX = "paseo-mail.in.";

/**
 * An in-memory daemon: agents with a status, workspaces with a project, recorded sends, plugin
 * metadata per agent, and (through a `FakeNetwork`) linked hosts. A `FakePaseo` made directly has
 * no network: its directory is empty and every call to another host throws.
 */
export class FakePaseo implements PaseoPort {
  readonly agents = new Map<string, AgentInfo>();
  readonly projects = new Map<string, string>();
  readonly sent: { agentId: string; text: string }[] = [];
  /** Plugin metadata per agent, as `setMetadata` leaves it (a `null` value removes the key). */
  readonly metadata = new Map<string, Record<string, unknown>>();
  /** Agents marked with `background(id)`. */
  readonly backgroundIds = new Set<string>();
  /** Every host-side port call made on this daemon, in order. */
  readonly calls: PortCall[] = [];
  /** Watchers registered with `watch`, until `release`. */
  readonly watchers: PortWatcher[] = [];
  /** This daemon's directory entries for linked hosts, by serverId (set by `FakeNetwork.link`). */
  readonly links = new Map<string, { label: string; enabled: boolean }>();
  failSends = false;
  /** Makes `publishAddress` throw (after recording the call). */
  failPublish = false;

  constructor(
    readonly self: { serverId: string; label: string } = { serverId: "srv_local", label: "local" },
    private readonly network: FakeNetwork | null = null,
  ) {}

  add(id: string, options: { title?: string; workspaceId?: string; status?: string } = {}): Caller {
    this.agents.set(id, { id, title: options.title ?? null, workspaceId: options.workspaceId ?? null, status: options.status ?? "idle", archived: false });
    return { id, workspaceId: options.workspaceId ?? null, title: options.title ?? null };
  }

  archive(id: string): void {
    this.agents.get(id)!.archived = true;
  }

  status(id: string, status: string): void {
    this.agents.get(id)!.status = status;
  }

  /** Marks the agent as a background agent (listed only with `includeBackground`). */
  background(id: string): void {
    this.backgroundIds.add(id);
  }

  async agent(id: string) {
    const agent = this.agents.get(id);
    return agent ? { ...agent } : null;
  }

  async projectOf(workspaceId: string) {
    return this.projects.get(workspaceId) ?? null;
  }

  async send(agentId: string, text: string) {
    if (this.failSends) throw new Error("send failed");
    this.sent.push({ agentId, text });
  }

  async hostDirectory(): Promise<HostDirectoryView> {
    this.record("hostDirectory");
    const hosts = [...this.links].map(([serverId, link]) => ({
      serverId,
      label: link.label,
      enabled: link.enabled,
      online: link.enabled && (this.network?.reachable(this.self.serverId, serverId) ?? false),
    }));
    return { self: { ...this.self }, hosts };
  }

  async publishAddress(agentId: string, address: { name: string | null; roles: string[] } | null): Promise<void> {
    this.record("publishAddress", agentId, address);
    if (this.failPublish) throw new Error("publishAddress failed");
    this.setMetadata(agentId, { [ADDRESS_KEY]: address === null ? null : structuredClone(address) });
  }

  async peerAgent(serverId: string, agentId: string): Promise<AgentInfo | null> {
    this.record("peerAgent", serverId, agentId);
    return this.peer(serverId, "peerAgent").agent(agentId);
  }

  async peerAddresses(serverId: string): Promise<PublishedAddress[]> {
    this.record("peerAddresses", serverId);
    const peer = this.peer(serverId, "peerAddresses");
    const result: PublishedAddress[] = [];
    for (const agent of peer.agents.values()) {
      if (agent.archived) continue;
      const address = peer.metadata.get(agent.id)?.[ADDRESS_KEY] as { name?: unknown; roles?: unknown } | null | undefined;
      if (!address || typeof address.name !== "string") continue;
      const roles = Array.isArray(address.roles) ? address.roles.filter((role): role is string => typeof role === "string") : [];
      result.push({ agentId: agent.id, name: address.name, roles, title: agent.title });
    }
    return result;
  }

  async writeDrop(serverId: string, agentId: string, mail: Mail): Promise<void> {
    this.record("writeDrop", serverId, agentId, mail);
    const peer = this.peer(serverId, "writeDrop");
    if (!peer.agents.has(agentId)) throw new Error(`agent ${agentId} does not exist on ${serverId}`);
    peer.setMetadata(agentId, { [`${DROP_PREFIX}${mail.id}`]: structuredClone(mail) });
    for (const watcher of [...peer.watchers]) watcher.dropsChanged();
  }

  async localDrops(): Promise<Drop[]> {
    this.record("localDrops");
    const drops: Drop[] = [];
    for (const [agentId, entries] of this.metadata) {
      for (const [key, value] of Object.entries(entries)) {
        if (key.startsWith(DROP_PREFIX)) drops.push({ agentId, mailId: key.slice(DROP_PREFIX.length), value: structuredClone(value) });
      }
    }
    return drops;
  }

  async clearDrop(agentId: string, mailId: string): Promise<void> {
    this.record("clearDrop", agentId, mailId);
    this.setMetadata(agentId, { [`${DROP_PREFIX}${mailId}`]: null });
  }

  watch(watcher: PortWatcher): void {
    this.record("watch");
    this.watchers.push(watcher);
  }

  async release(): Promise<void> {
    this.record("release");
    this.watchers.length = 0;
  }

  /** Top-level keys replace; `null` removes the key (as the SDK's `setMetadata`). */
  setMetadata(agentId: string, patch: Record<string, unknown>): void {
    const entries = { ...this.metadata.get(agentId) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete entries[key];
      else entries[key] = value;
    }
    this.metadata.set(agentId, entries);
  }

  private record(op: PortCall["op"], ...args: unknown[]): void {
    this.calls.push({ op, args: structuredClone(args) });
  }

  private peer(serverId: string, op: FaultOp): FakePaseo {
    if (!this.network) throw new Error(`host ${serverId} is not linked (no network)`);
    const link = this.links.get(serverId);
    if (!link) throw new Error(`host ${serverId} is not linked`);
    if (!link.enabled) throw new Error(`host ${serverId} is disabled`);
    return this.network.reach(this.self.serverId, serverId, op);
  }
}

/**
 * Several `FakePaseo` daemons of one user. Reachability is per direction; a fault makes one
 * operation against a host throw while that host still reads online.
 */
export class FakeNetwork {
  private readonly daemons = new Map<string, FakePaseo>();
  /** `from>to` pairs whose calls fail. */
  private readonly down = new Set<string>();
  /** `to:op` pairs that throw. */
  private readonly faults = new Set<string>();

  host(serverId: string, label: string): FakePaseo {
    const daemon = new FakePaseo({ serverId, label }, this);
    this.daemons.set(serverId, daemon);
    return daemon;
  }

  /** Adds (or replaces) `to` in `from`'s directory under the link's own label. */
  link(from: string, to: string, options: { label: string; enabled?: boolean }): void {
    this.daemon(from).links.set(to, { label: options.label, enabled: options.enabled ?? true });
  }

  /** A change to reachable calls `hostOnline(to)` on `from`'s watchers (when the link is enabled). */
  setReachable(from: string, to: string, reachable: boolean): void {
    const key = `${from}>${to}`;
    const was = !this.down.has(key);
    if (reachable) this.down.delete(key);
    else this.down.add(key);
    const source = this.daemon(from);
    if (reachable && !was && source.links.get(to)?.enabled) {
      for (const watcher of [...source.watchers]) watcher.hostOnline(to);
    }
  }

  fault(to: string, op: FaultOp, failing: boolean): void {
    const key = `${to}:${op}`;
    if (failing) this.faults.add(key);
    else this.faults.delete(key);
  }

  reachable(from: string, to: string): boolean {
    return this.daemons.has(to) && !this.down.has(`${from}>${to}`);
  }

  /** The daemon `to`, as `from` reaches it for `op`; throws when unreachable or faulted. */
  reach(from: string, to: string, op: FaultOp): FakePaseo {
    if (!this.reachable(from, to)) throw new Error(`host ${to} is unreachable from ${from}`);
    if (this.faults.has(`${to}:${op}`)) throw new Error(`${op} against ${to} failed`);
    return this.daemon(to);
  }

  private daemon(serverId: string): FakePaseo {
    const daemon = this.daemons.get(serverId);
    if (!daemon) throw new Error(`no host ${serverId} on the network`);
    return daemon;
  }
}

export async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "paseo-mail-"));
}

export async function setup(options: MailerOptions = {}, dir?: string, paseo: FakePaseo = new FakePaseo()) {
  const root = dir ?? (await tempDir());
  const store = new MailStore(path.join(root, "mail"));
  const registry = new Registry(path.join(root, "registry.json"));
  await Promise.all([store.init(), registry.init()]);
  const mailer = new Mailer(store, registry, paseo, { debounceMs: 5, maxRetries: 0, ...options });
  return { root, store, registry, paseo, mailer };
}

export type Env = Awaited<ReturnType<typeof setup>>;

/**
 * Two linked daemons: cantor (`srv_Cantor01`, label "cantor") and the Mac (`srv_EntwLoR9srmD`,
 * label "M2 Max"). cantor lists the Mac as "m2-max"; the Mac lists cantor as "cantor".
 * Each has its own store, registry and started `Mailer`.
 */
export async function setupPair(options: MailerOptions = {}): Promise<{ network: FakeNetwork; cantor: Env; mac: Env }> {
  const network = new FakeNetwork();
  const cantorHost = network.host("srv_Cantor01", "cantor");
  const macHost = network.host("srv_EntwLoR9srmD", "M2 Max");
  network.link("srv_Cantor01", "srv_EntwLoR9srmD", { label: "m2-max" });
  network.link("srv_EntwLoR9srmD", "srv_Cantor01", { label: "cantor" });
  const cantor = await setup(options, undefined, cantorHost);
  const mac = await setup(options, undefined, macHost);
  await Promise.all([cantor.mailer.start(), mac.mailer.start()]);
  return { network, cantor, mac };
}
