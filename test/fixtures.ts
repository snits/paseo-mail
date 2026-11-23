import type { AgentToolContext } from "@getpaseo/plugin/server";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Mailer, type MailerOptions } from "../server/mailer";
import { Registry } from "../server/registry";
import { MailStore } from "../server/store";
import type { AgentInfo, Caller, Drop, HostDirectoryView, HostEntry, Mail, PaseoPort, PortWatcher, PublishedAddress } from "../server/types";

type AsyncMethodKey<T> = {
  [K in keyof T]-?: T[K] extends (...args: never[]) => Promise<unknown> ? K : never;
}[keyof T];

type AsyncMethod = (this: object, ...args: unknown[]) => Promise<unknown>;

function replaceAsyncMethod(target: object, method: PropertyKey, replace: (original: AsyncMethod) => AsyncMethod): () => void {
  const methods = target as Record<PropertyKey, AsyncMethod>;
  const descriptor = Object.getOwnPropertyDescriptor(target, method);
  const replacement = replace(methods[method]);
  methods[method] = replacement;
  return () => {
    if (methods[method] !== replacement) return;
    if (descriptor) Object.defineProperty(target, method, descriptor);
    else Reflect.deleteProperty(target, method);
  };
}

/** Holds calls until settled, optionally capturing their results before they wait. */
export function park<T extends object>(
  target: T,
  method: AsyncMethodKey<T>,
  options?: { after?: boolean; refuseOnRelease?: T extends { release(): Promise<void> } ? Error : never },
): { readonly parked: number; open(): void; refuse(error: Error): void } {
  let parked = 0;
  let settled = false;
  let settleGate!: (error?: Error) => void;
  // A refusal is a gate value so cleanup can refuse even when no calls are waiting.
  const gate = new Promise<Error | undefined>((resolve) => {
    settleGate = resolve;
  });
  const after = options?.after ?? false;
  const restoreMethod = replaceAsyncMethod(target, method, (original) => async function (...args) {
    if (settled) return original.apply(this, args);
    const result = after ? await original.apply(this, args) : undefined;
    if (!settled) parked += 1;
    const error = await gate;
    if (error) throw error;
    return after ? result : original.apply(this, args);
  });

  const releaseError = options?.refuseOnRelease;
  const restoreRelease = releaseError && replaceAsyncMethod(target, "release", (original) => function (...args) {
    settle(releaseError);
    return original.apply(this, args);
  });

  function settle(error?: Error): void {
    if (settled) return;
    settled = true;
    restoreRelease?.();
    restoreMethod();
    settleGate(error);
  }

  return {
    get parked() { return parked; },
    open: () => settle(),
    refuse: settle,
  };
}

/** The port operations `FakeNetwork.fault` can make fail against one host. */
export type FaultOp = "peerAddresses" | "peerAgent" | "writeDrop";

/** One host-side port call, with its arguments copied at call time. */
export interface PortCall {
  op: "hostDirectory" | "publishAddress" | "peerAgent" | "peerAddresses" | "writeDrop" | "localDrops" | "clearDrop" | "watch" | "release";
  args: unknown[];
}

/** The plugin's metadata keys, written out here rather than read from production. */
export const ADDRESS_KEY = "paseo-mail.address";
export const DROP_PREFIX = "paseo-mail.in.";

/** The serverIds of the test hosts: cantor, the Mac and the attic. */
export const CANTOR = "srv_Cantor01";
export const MAC = "srv_EntwLoR9srmD";
export const ATTIC = "srv_Attic01";

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
      if (!address || typeof address.name !== "string" || address.name === "") continue;
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
 * The two daemons of `setupPair`, linked, with no store or `Mailer`: cantor (`srv_Cantor01`,
 * label "cantor") and the Mac (`srv_EntwLoR9srmD`, label "M2 Max"). cantor lists the Mac as
 * "m2-max"; the Mac lists cantor as "cantor".
 */
export function linkedHosts(): { network: FakeNetwork; cantorHost: FakePaseo; macHost: FakePaseo } {
  const network = new FakeNetwork();
  const cantorHost = network.host(CANTOR, "cantor");
  const macHost = network.host(MAC, "M2 Max");
  network.link(CANTOR, MAC, { label: "m2-max" });
  network.link(MAC, CANTOR, { label: "cantor" });
  return { network, cantorHost, macHost };
}

/** The daemons of `linkedHosts`, each with its own store, registry and started `Mailer`. */
export async function setupPair(options: MailerOptions = {}): Promise<{ network: FakeNetwork; cantor: Env; mac: Env }> {
  const { network, cantorHost, macHost } = linkedHosts();
  const cantor = await setup(options, undefined, cantorHost);
  const mac = await setup(options, undefined, macHost);
  await Promise.all([cantor.mailer.start(), mac.mailer.start()]);
  return { network, cantor, mac };
}

/** Makes an agent on `host` publish `name`, as its own mailer would (written as metadata, so two agents may share one). */
export function publish(host: FakePaseo, agentId: string, name: string, title?: string, roles: string[] = []): void {
  host.add(agentId, { title });
  host.setMetadata(agentId, { [ADDRESS_KEY]: { name, roles } });
}

/** Makes the port's directory report `serverId` with the given fields changed (the link itself is untouched); returns the undo. */
export function reportHost(paseo: FakePaseo, serverId: string, change: Partial<HostEntry>): () => void {
  const directory = paseo.hostDirectory.bind(paseo);
  paseo.hostDirectory = async () => {
    const view = await directory();
    return { ...view, hosts: view.hosts.map((host) => (host.serverId === serverId ? { ...host, ...change } : host)) };
  };
  return () => {
    paseo.hostDirectory = directory;
  };
}

/** A tool context for the agent `id`, in workspace "w1". */
export function toolContext(id: string, title: string | null = null): AgentToolContext {
  return {
    agent: { id, workspaceId: "w1", parentAgentId: null, provider: "claude", cwd: "/tmp", title, background: false, metadata: {} },
    paseo: {} as AgentToolContext["paseo"],
    signal: new AbortController().signal,
  };
}

/**
 * An unstamped mail with the given fields; by default it starts its own thread, its subject and
 * body are `subject <id>` and `body <id>`, and it was created 2026-11-22T10:00:00.000Z.
 */
export function mailOf(fields: Pick<Mail, "id" | "from" | "to"> & Partial<Mail>): Mail {
  const { id, from, to, ...rest } = fields;
  return {
    id,
    threadId: id,
    inReplyTo: null,
    from,
    to,
    subject: `subject ${id}`,
    body: `body ${id}`,
    createdAt: "2026-11-22T10:00:00.000Z",
    readAt: null,
    nudgedAt: null,
    bouncedAt: null,
    seenAt: null,
    handedOffAt: null,
    ...rest,
  };
}

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` every 10 ms for at most `ms`; returns its last value. */
export async function until(check: () => boolean, ms = 1000): Promise<boolean> {
  for (let waited = 0; !check() && waited < ms; waited += 10) await wait(10);
  return check();
}
