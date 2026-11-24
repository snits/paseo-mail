import { randomBytes } from "node:crypto";
import { AGENT_PREFIX, HostBook, parseAddress, unknownHost, type ParsedAddress } from "./address";
import { CrossHostMail } from "./cross-host-mail";
import { Queue } from "./files";
import { normalize, type Registry } from "./registry";
import { isLocal, type MailStore } from "./store";
import { UserError, type AgentInfo, type Caller, type HostDirectoryView, type HostEntry, type Mail, type PaseoPort, type PublishedAddress, type Registration } from "./types";

export { MAIL_ID, handOffDigest } from "./cross-host-mail";

export interface MailerOptions {
  /** Delay before a nudge after new mail or a turn end, so a burst gives one nudge. */
  debounceMs?: number;
  /** How long a nudge the plugin sent counts as "busy" if no turn starts after it. */
  sendGraceMs?: number;
  /** Retries when an agent still reads as running though no turn start was seen. */
  maxRetries?: number;
  /** How often the outbox hand-off and the drop import run on their own. Default 60 s. */
  sweepMs?: number;
  now?: () => string;
}

/** Most UTF-8 bytes a mail body may have when it goes to another daemon. */
export const CROSS_HOST_BODY_LIMIT = 32 * 1024;

/** One recipient of a send: the address as typed and the agent it reached (null: not resolved yet, on another host). */
export interface Delivery {
  address: string;
  agentId: string | null;
  /** null for this daemon; else the host the mail waits to be handed to. */
  serverId: string | null;
  name: string | null;
  title: string | null;
  mailId: string;
}

/** One recipient an address reaches: a live local agent, or an agent (resolved or not yet) on a linked host. */
export type ResolvedTarget =
  | { kind: "local"; agentId: string; registration: Registration | null; agent: AgentInfo }
  | { kind: "remote"; serverId: string; agentId: string | null; name: string | null; title: string | null };

/** A recipient on a linked host, with the address as typed. */
interface RemoteTarget {
  address: string;
  serverId: string;
  agentId: string | null;
  name: string | null;
  title: string | null;
}

/** Refuses a body over the cross-host cap, measured in UTF-8 bytes. */
function checkCrossHostBody(body: string): void {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > CROSS_HOST_BODY_LIMIT) {
    throw new UserError(`the body is ${bytes} bytes; mail to an agent on a linked host may have at most ${CROSS_HOST_BODY_LIMIT} bytes (UTF-8)`);
  }
}

export function nudgeText(count: number, named = true): string {
  const mails = `${count} unread mail${count === 1 ? "" : "s"}`;
  if (named) return `[paseo-mail] You have ${mails}. Call mail_list to see them.`;
  return `[paseo-mail] Automatic notice from the Paseo Mail plugin installed on this daemon (your user enabled it; it is part of your toolset, not a request from another agent). You have ${mails} you cannot read until you register. This is expected of you: call the mail_register tool with a name that says what you do, then mail_list / mail_read, and mail_reply to each sender so it learns your alias. It is safe to do this even in the middle of other work; it takes a few seconds.`;
}

let lastStamp = 0;
let counter = 0;

/** Ids sort in creation order (time, then a counter), so mails sent in the same millisecond list in order. Each matches MAIL_ID. */
function newId(): string {
  const stamp = Date.now();
  counter = stamp === lastStamp ? counter + 1 : 0;
  lastStamp = stamp;
  return `m_${stamp.toString(36)}${counter.toString(36).padStart(3, "0")}${randomBytes(3).toString("hex")}`;
}

/**
 * Mailboxes, the registry of names and roles, and the idle nudge. Mail never goes into a
 * running turn: a nudge is sent only to an agent that reads as idle, and only for unread
 * mail it has not been nudged about (docs/adrs/2026-11-10-idle-nudge.md).
 */
export class Mailer {
  /** Agents in a turn: turn hooks, or a nudge we sent (with the time we sent it). */
  private readonly inTurn = new Set<string>();
  private readonly sentAt = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Name claims run one at a time, so two agents cannot take the same name. */
  private readonly claims = new Queue();
  private readonly crossHostMail: CrossHostMail;
  private sweep: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  /** The last host directory snapshot; empty (own serverId and label empty, so nothing resolves) until the first read. */
  private hostBook = new HostBook({ self: { serverId: "", label: "" }, hosts: [] });
  private readonly debounceMs: number;
  private readonly sendGraceMs: number;
  private readonly maxRetries: number;
  private readonly sweepMs: number;
  private readonly now: () => string;

  constructor(
    private readonly store: MailStore,
    private readonly registry: Registry,
    private readonly paseo: PaseoPort,
    options: MailerOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 1000;
    this.sendGraceMs = options.sendGraceMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 5;
    this.sweepMs = options.sweepMs ?? 60_000;
    this.now = options.now ?? (() => new Date().toISOString());
    this.crossHostMail = new CrossHostMail(store, paseo, () => this.now(), (agentId) => this.schedule(agentId));
  }

  // ---------------------------------------------------------------- registry

  /** Applies a registration change for the caller and returns the result. */
  register(caller: Caller, input: { name?: string; roles?: string[] }): Promise<Registration | null> {
    return this.claims.run(async () => {
      const current = this.registry.get(caller.id);
      let name = current?.name ?? null;
      if (input.name !== undefined) {
        name = input.name.trim() === "" ? null : normalize(input.name, "name");
        if (name !== null && name !== current?.name) {
          const holder = this.registry.holderOf(name);
          if (holder && holder.agentId !== caller.id) {
            const agent = await this.live(holder.agentId);
            if (agent) throw new UserError(`the name "${name}" is held by another agent (${describe(agent)}); pick another name`);
          }
        }
      }
      const roles = input.roles === undefined ? (current?.roles ?? []) : [...new Set(input.roles.map((role) => normalize(role, "role")))].sort();
      if (input.name === undefined && input.roles === undefined) return current ?? null;
      const projectId = current?.projectId ?? (caller.workspaceId ? await this.paseo.projectOf(caller.workspaceId).catch(() => null) : null);
      const entry: Registration = { agentId: caller.id, name, roles, workspaceId: caller.workspaceId, projectId, updatedAt: this.now() };
      await this.registry.set(entry);
      const stored = name === null && roles.length === 0 ? null : entry;
      await this.publish(caller.id, stored);
      return stored;
    });
  }

  /** Registered agents that are still live. Dead entries are dropped on the way. */
  async directory(): Promise<{ registration: Registration; agent: AgentInfo }[]> {
    const result: { registration: Registration; agent: AgentInfo }[] = [];
    for (const registration of this.registry.list()) {
      const agent = await this.live(registration.agentId);
      if (agent) result.push({ registration, agent });
    }
    return result;
  }

  /** The published addresses of every enabled, online linked host, as name@host. A host whose listing throws is skipped and logged. */
  async remoteDirectory(): Promise<{ address: string; host: string; serverId: string; title: string | null }[]> {
    const book = await this.refreshHosts();
    const perHost = await Promise.all(
      book.onlineHosts().map(async ({ serverId }) => {
        const host = book.display(serverId);
        try {
          return (await this.paseo.peerAddresses(serverId)).map((entry) => ({ address: `${entry.name}@${host}`, host, serverId, title: entry.title }));
        } catch (error) {
          console.error(`[paseo-mail] listing the addresses on ${host} failed:`, (error as Error).message);
          return [];
        }
      }),
    );
    return perHost.flat();
  }

  /** Resolves one address to the agents it reaches, here or on a linked host. Throws when it reaches none. */
  async resolve(caller: Caller, address: string): Promise<ResolvedTarget[]> {
    const parsed = parseAddress(address);
    if (parsed.host === null) return this.resolveLocal(caller, parsed);
    if (parsed.kind === "role") throw new UserError("addressing a role at a host (role:x@host) is planned, not available yet");
    if (parsed.kind === "agent") throw new UserError("addressing an agent id at a host (agent:x@host) is unsupported; use its name");
    const match = (await this.refreshHosts()).resolve(parsed.host);
    if (match.kind === "local") return this.resolveLocal(caller, parsed);
    const { serverId, online } = match.host;
    if (online) {
      let published: PublishedAddress[] | null = null;
      try {
        published = await this.paseo.peerAddresses(serverId);
      } catch {
        // The host reads online but cannot be listed: accept the mail unresolved, as for an offline host.
      }
      if (published) {
        const holders = published.filter((entry) => entry.name === parsed.local);
        if (holders.length === 0) throw new UserError(`no agent on host "${parsed.host}" is registered as "${parsed.local}"`);
        if (holders.length > 1) {
          const who = holders.map((holder) => (holder.title ? `${holder.agentId} ("${holder.title}")` : holder.agentId)).join(", ");
          throw new UserError(`several agents on host "${parsed.host}" are registered as "${parsed.local}": ${who}`);
        }
        const [holder] = holders;
        return [{ kind: "remote", serverId, agentId: holder!.agentId, name: holder!.name, title: holder!.title }];
      }
    }
    return [{ kind: "remote", serverId, agentId: null, name: parsed.local, title: null }];
  }

  /** Resolves a parsed address on this daemon; its host part, if any, is already known to be this daemon. */
  private async resolveLocal(caller: Caller, { kind, local }: ParsedAddress): Promise<(ResolvedTarget & { kind: "local" })[]> {
    if (kind === "agent") {
      // An agent id needs no registry entry (docs/adrs/2026-11-10-agent-id-addressing.md). Ids are case-sensitive.
      const id = local;
      if (id === "") throw new UserError('give an agent id after "agent:"');
      const agent = await this.live(id);
      if (!agent) throw new UserError(`no live agent has the id "${id}" (it does not exist or is archived)`);
      if (agent.id === caller.id) throw new UserError("you cannot send mail to yourself");
      return [{ kind: "local", agentId: agent.id, registration: this.registry.get(agent.id) ?? null, agent }];
    }
    if (kind === "role") {
      const role = local;
      const holders: { kind: "local"; agentId: string; registration: Registration; agent: AgentInfo }[] = [];
      for (const registration of this.registry.withRole(role)) {
        if (registration.agentId === caller.id) continue;
        const agent = await this.live(registration.agentId);
        if (agent) holders.push({ kind: "local", agentId: agent.id, registration, agent });
      }
      if (holders.length === 0) throw new UserError(`no live agent holds the role "${role}"`);
      const sameWorkspace = caller.workspaceId ? holders.filter((holder) => holder.registration.workspaceId === caller.workspaceId) : [];
      if (sameWorkspace.length > 0) return sameWorkspace;
      const project = await this.projectOfCaller(caller);
      const sameProject = project ? holders.filter((holder) => holder.registration.projectId === project) : [];
      return sameProject.length > 0 ? sameProject : holders;
    }
    const name = local;
    const registration = this.registry.holderOf(name);
    const agent = registration ? await this.live(registration.agentId) : null;
    if (!registration || !agent) throw new UserError(`no live agent is registered as "${name}" (see mail_directory)`);
    if (agent.id === caller.id) throw new UserError("you cannot send mail to yourself");
    return [{ kind: "local", agentId: agent.id, registration, agent }];
  }

  /** The last host directory snapshot; before the first successful refresh, an empty one. */
  hosts(): HostBook {
    return this.hostBook;
  }

  /** Re-reads the host directory; keeps the previous snapshot when the read throws. */
  async refreshHosts(): Promise<HostBook> {
    try {
      this.hostBook = new HostBook(await this.paseo.hostDirectory());
    } catch (error) {
      console.error("[paseo-mail] reading the host directory failed:", (error as Error).message);
    }
    return this.hostBook;
  }

  // ---------------------------------------------------------------- mail

  async send(caller: Caller, to: string[], subject: string, body: string, thread?: { threadId: string; inReplyTo: string }): Promise<Delivery[]> {
    if (to.length === 0) throw new UserError("give at least one address");
    // Resolve everything first, so a bad address sends nothing.
    const targets = new Map<string, { address: string; registration: Registration | null; agent: AgentInfo }>();
    const remotes = new Map<string, RemoteTarget>();
    for (const address of to) {
      for (const target of await this.resolve(caller, address)) {
        if (target.kind === "remote") {
          const key = `${target.serverId}/${target.agentId ?? `name:${target.name}`}`;
          if (!remotes.has(key)) remotes.set(key, { address: address.trim(), serverId: target.serverId, agentId: target.agentId, name: target.name, title: target.title });
          continue;
        }
        if (!targets.has(target.agentId)) targets.set(target.agentId, { address: address.trim(), registration: target.registration, agent: target.agent });
      }
    }
    // The cap covers every copy of the send, so it is checked before any copy is stored.
    if (remotes.size > 0) checkCrossHostBody(body);
    const deliveries = await this.deliver(caller, [...targets.values()], subject, body, thread);
    if (remotes.size > 0) deliveries.push(...(await this.queueRemote(caller, [...remotes.values()], subject, body, thread)));
    return deliveries;
  }

  list(agentId: string, options: { unreadOnly?: boolean; limit?: number } = {}): Mail[] {
    const mails = options.unreadOnly ? this.store.unread(agentId) : this.store.inbox(agentId);
    return mails.slice(0, options.limit ?? 20);
  }

  /** Whether the agent has a registered name (a role alone does not count): required to read mail. */
  hasName(agentId: string): boolean {
    return this.registry.get(agentId)?.name != null;
  }

  /** Refuses reading to an agent with no name (docs/adrs/2026-11-10-alias-required-to-read.md). */
  requireName(agentId: string): void {
    if (this.hasName(agentId)) return;
    const count = this.unreadCount(agentId);
    throw new UserError(
      `You must register a name before you can read your mail: call mail_register { name } first, then read.${count > 0 ? ` ${count} unread mail${count === 1 ? " is" : "s are"} waiting.` : ""}`,
    );
  }

  unreadCount(agentId: string): number {
    return this.store.unread(agentId).length;
  }

  /** Returns a mail to its recipient and marks it read. */
  async read(agentId: string, id: string): Promise<Mail> {
    const mail = this.ownMail(agentId, id);
    if (mail.readAt !== null) return mail;
    const readAt = this.now();
    const [updated] = await this.store.update([id], (current) => {
      current.readAt ??= readAt;
    });
    return updated ?? mail;
  }

  /** Replies to a mail's sender: its agent if live, else whoever holds its name now. */
  async reply(caller: Caller, id: string, body: string): Promise<Delivery> {
    const original = this.ownMail(caller.id, id);
    if (original.from.agentId === null) throw new UserError("this mail came from paseo-mail itself; there is nobody to reply to");
    const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
    const thread = { threadId: original.threadId, inReplyTo: original.id };
    if (original.from.serverId !== null) {
      const { serverId, agentId, name, title } = original.from;
      checkCrossHostBody(body);
      let directory: HostDirectoryView | null;
      try {
        directory = await this.paseo.hostDirectory();
      } catch {
        directory = null;
      }
      const host = directory?.hosts.find((entry) => entry.serverId === serverId);
      if (directory !== null && !host) throw unknownHost(serverId);
      // The hand-off re-resolves an archived sender by name, so only a nameless one is refused here.
      if (name === null && (await this.goneOnPeer(host, agentId))) {
        throw new UserError("the sender was archived or no longer exists on its host and had no registered name; the reply cannot be delivered");
      }
      const [delivery] = await this.queueRemote(caller, [{ address: name ?? `${AGENT_PREFIX}${agentId}`, serverId, agentId, name, title }], subject, body, thread);
      return delivery!;
    }
    const sender = await this.live(original.from.agentId);
    if (sender) {
      const [delivery] = await this.deliver(caller, [{ address: original.from.name ?? `${AGENT_PREFIX}${sender.id}`, registration: this.registry.get(sender.id) ?? null, agent: sender }], subject, body, thread);
      return delivery!;
    }
    if (!original.from.name) throw new UserError("the sender was archived and had no registered name; the reply cannot be delivered");
    const [delivery] = await this.send(caller, [original.from.name], subject, body, thread);
    return delivery!;
  }

  private ownMail(agentId: string, id: string): Mail {
    const mail = this.store.get(id.trim());
    if (!mail || !isLocal(mail) || mail.to.agentId !== agentId) throw new UserError(`no mail "${id}" in your mailbox`);
    return mail;
  }

  private async deliver(
    caller: Caller,
    targets: { address: string; registration: Registration | null; agent: AgentInfo }[],
    subject: string,
    body: string,
    thread?: { threadId: string; inReplyTo: string },
  ): Promise<Delivery[]> {
    const from = this.senderOf(caller);
    const deliveries: Delivery[] = [];
    for (const target of targets) {
      const id = await this.storeNew(from, { agentId: target.agent.id, address: target.address, serverId: null }, subject, body, thread);
      deliveries.push({ address: target.address, agentId: target.agent.id, name: target.registration?.name ?? null, title: target.agent.title, mailId: id, serverId: null });
      this.schedule(target.agent.id);
    }
    return deliveries;
  }

  /** Stores one outbox mail per remote target, then starts a hand-off the caller does not wait for. */
  private async queueRemote(caller: Caller, targets: RemoteTarget[], subject: string, body: string, thread?: { threadId: string; inReplyTo: string }): Promise<Delivery[]> {
    const from = this.senderOf(caller);
    const deliveries: Delivery[] = [];
    for (const target of targets) {
      const id = await this.storeNew(from, { agentId: target.agentId, address: target.address, serverId: target.serverId }, subject, body, thread);
      deliveries.push({ address: target.address, agentId: target.agentId, serverId: target.serverId, name: target.name, title: target.title, mailId: id });
    }
    void this.flushOutbox().catch((error) => console.error("[paseo-mail] handing off the outbox failed:", (error as Error).message));
    return deliveries;
  }

  /**
   * Whether a remote agent is known to be archived or missing: its host reads online in a fresh
   * directory read and the lookup by id says so. A read or lookup that throws, or a host that is
   * disabled or offline, tells nothing, so the answer is false.
   */
  private async goneOnPeer(host: HostEntry | undefined, agentId: string): Promise<boolean> {
    if (!host?.enabled || !host.online) return false;
    try {
      const agent = await this.paseo.peerAgent(host.serverId, agentId);
      return agent === null || agent.archived;
    } catch {
      return false;
    }
  }

  /**
   * Hands outbox mail to the linked hosts it is for (design step 7). Passes run one at a time;
   * a call made after a mail is stored runs a pass that sees it.
   */
  flushOutbox(): Promise<void> {
    return this.crossHostMail.flushOutbox();
  }

  /**
   * Imports the mail linked hosts dropped on local agents (design step 8). Passes run one at a
   * time; a call made after a drop lands runs a pass that sees it.
   */
  importDrops(): Promise<void> {
    return this.crossHostMail.importDrops();
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * After a (re)start: nudge agents holding mail they were not nudged about, publish every
   * registry entry, watch the hosts and drops, start the sweep, import waiting drops and hand
   * off the outbox. Each step is best-effort on its own, so one that fails never skips another.
   */
  async start(): Promise<void> {
    for (const agentId of this.store.pendingNudges()) this.schedule(agentId);
    await this.refreshHosts();
    // Re-read each entry just before publishing: an agent may rename or clear itself while earlier publishes are in flight.
    for (const { agentId } of this.registry.list()) {
      const current = this.registry.get(agentId);
      if (current) await this.publish(agentId, current);
    }
    // dispose() may run before a start() nobody awaits gets here; a sweep armed now would outlive it.
    if (this.disposed) return;
    try {
      this.paseo.watch({
        hostOnline: () => void this.refreshHosts().then(() => this.flushOutbox()).catch((error) => console.error("[paseo-mail] hand-off on host online failed:", (error as Error).message)),
        dropsChanged: () => void this.importDrops().catch((error) => console.error("[paseo-mail] import on new drops failed:", (error as Error).message)),
      });
    } catch (error) {
      console.error("[paseo-mail] watching hosts failed:", (error as Error).message);
    }
    this.startSweep();
    await this.importDrops().catch((error) => console.error("[paseo-mail] importing drops failed:", (error as Error).message));
    await this.flushOutbox().catch((error) => console.error("[paseo-mail] handing off the outbox failed:", (error as Error).message));
  }

  private startSweep(): void {
    if (this.sweep) return;
    this.sweep = setInterval(() => {
      void this.importDrops().catch((error) => console.error("[paseo-mail] sweep import failed:", (error as Error).message));
      void this.flushOutbox().catch((error) => console.error("[paseo-mail] sweep hand-off failed:", (error as Error).message));
    }, this.sweepMs);
    (this.sweep as { unref?: () => void }).unref?.();
  }

  onTurnStarted(agentId: string): void {
    this.inTurn.add(agentId);
    this.sentAt.delete(agentId);
  }

  onTurnEnded(agentId: string): void {
    this.inTurn.delete(agentId);
    this.sentAt.delete(agentId);
    this.schedule(agentId);
  }

  /**
   * Releases the agent's name and roles and returns its unread mail to the senders on this
   * daemon. Mail from another daemon's agent is left as it is (not stamped, not returned).
   */
  async onArchived(agentId: string): Promise<void> {
    this.cancel(agentId);
    this.inTurn.delete(agentId);
    this.sentAt.delete(agentId);
    await this.registry.remove(agentId);
    await this.publish(agentId, null);
    const unread = this.store.unread(agentId).filter((mail) => mail.bouncedAt === null && mail.from.serverId === null);
    if (unread.length === 0) return;
    const bouncedAt = this.now();
    await this.store.update(
      unread.map((mail) => mail.id),
      (mail) => {
        mail.bouncedAt = bouncedAt;
      },
    );
    for (const mail of unread) {
      if (mail.from.agentId === null || mail.from.agentId === agentId) continue;
      const sender = await this.live(mail.from.agentId);
      if (!sender) continue;
      await this.storeNew(
        { agentId: null, name: "paseo-mail", title: null, serverId: null },
        { agentId: sender.id, address: mail.from.name ?? sender.id, serverId: null },
        `Returned: ${mail.subject}`,
        `Your mail to "${mail.to.address}" was not read: the recipient was archived.\n\n--- original mail ---\n${mail.body}`,
        { threadId: mail.threadId, inReplyTo: mail.id },
      );
      this.schedule(sender.id);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.crossHostMail.stop();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    // release() comes first: it closes the peer clients, so a running pass's calls on a connected peer
    // fail rather than wait out their deadline; the stores close only after the running passes finish.
    await this.paseo.release();
    await this.crossHostMail.handOffIdle();
    await this.crossHostMail.importIdle();
    await Promise.all([this.store.close(), this.registry.close()]);
  }

  // ---------------------------------------------------------------- nudge

  private schedule(agentId: string, attempt = 0, delay = this.debounceMs): void {
    if (this.disposed) return;
    this.cancel(agentId);
    const timer = setTimeout(() => {
      this.timers.delete(agentId);
      void this.nudge(agentId, attempt).catch((error) => console.error(`[paseo-mail] nudge of ${agentId} failed:`, (error as Error).message));
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(agentId, timer);
  }

  private cancel(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (timer) clearTimeout(timer);
    this.timers.delete(agentId);
  }

  private busy(agentId: string): boolean {
    if (this.inTurn.has(agentId)) return true;
    const sent = this.sentAt.get(agentId);
    if (sent === undefined) return false;
    if (Date.now() - sent < this.sendGraceMs) return true;
    // Our nudge never started a turn we saw: fall back to the agent's status.
    this.sentAt.delete(agentId);
    return false;
  }

  /** Sends a one-line nudge if the agent is idle and has unread mail it was not nudged about. */
  async nudge(agentId: string, attempt = 0): Promise<"sent" | "held" | "nothing"> {
    if (this.disposed || this.inFlight.has(agentId) || this.busy(agentId)) return "held";
    if (!this.store.unread(agentId).some((mail) => mail.nudgedAt === null && mail.bouncedAt === null)) return "nothing";
    this.inFlight.add(agentId);
    try {
      const agent = await this.paseo.agent(agentId).catch(() => null);
      if (!agent) return "nothing";
      if (agent.archived) {
        await this.onArchived(agentId);
        return "nothing";
      }
      if (agent.status !== "idle") {
        // A turn we saw starting will end with turn.after, which retries. Otherwise (a status
        // that lags the turn end, or a turn running since before the plugin started) retry a
        // few times, backing off.
        if (!this.inTurn.has(agentId) && attempt < this.maxRetries) this.schedule(agentId, attempt + 1, this.debounceMs * 2 ** (attempt + 1));
        return "held";
      }
      const unread = this.store.unread(agentId).filter((mail) => mail.bouncedAt === null);
      const stamped = unread.filter((mail) => mail.nudgedAt === null).map((mail) => mail.id);
      const nudgedAt = this.now();
      await this.store.update(stamped, (mail) => {
        mail.nudgedAt = nudgedAt;
      });
      this.sentAt.set(agentId, Date.now());
      try {
        // Steer only covers the gap between the status check and this send, in which a turn
        // may have started: a one-line note beats the default, which interrupts the turn.
        await this.paseo.send(agentId, nudgeText(unread.length, this.hasName(agentId)));
      } catch (error) {
        this.sentAt.delete(agentId);
        await this.store.update(stamped, (mail) => {
          if (mail.nudgedAt === nudgedAt) mail.nudgedAt = null;
        });
        throw error;
      }
      return "sent";
    } finally {
      this.inFlight.delete(agentId);
    }
  }

  // ---------------------------------------------------------------- helpers

  /** The caller as the sender of mail it sends now. */
  private senderOf(caller: Caller): Mail["from"] {
    return { agentId: caller.id, name: this.registry.get(caller.id)?.name ?? null, title: caller.title, serverId: null };
  }

  /** Stores a new, unstamped mail and returns its id; it starts its own thread unless `thread` is given. */
  private async storeNew(from: Mail["from"], to: Mail["to"], subject: string, body: string, thread?: { threadId: string; inReplyTo: string }): Promise<string> {
    const id = newId();
    await this.store.create({
      id,
      threadId: thread?.threadId ?? id,
      inReplyTo: thread?.inReplyTo ?? null,
      from,
      to,
      subject,
      body,
      createdAt: this.now(),
      readAt: null,
      nudgedAt: null,
      bouncedAt: null,
      seenAt: null,
      handedOffAt: null,
    });
    return id;
  }

  /** Publishes the agent's address to the daemon. Best-effort: a failure is logged and never fails the caller. */
  private async publish(agentId: string, entry: { name: string | null; roles: string[] } | null): Promise<void> {
    try {
      await this.paseo.publishAddress(agentId, entry && { name: entry.name, roles: entry.roles });
    } catch (error) {
      console.error(`[paseo-mail] publishing the address of ${agentId} failed:`, (error as Error).message);
    }
  }

  /** The agent if it exists and is not archived; a dead registration is dropped. */
  private async live(agentId: string): Promise<AgentInfo | null> {
    const agent = await this.paseo.agent(agentId).catch(() => null);
    if (agent && !agent.archived) return agent;
    if (this.registry.get(agentId)) await this.registry.remove(agentId);
    return null;
  }

  private async projectOfCaller(caller: Caller): Promise<string | null> {
    const registered = this.registry.get(caller.id)?.projectId;
    if (registered) return registered;
    return caller.workspaceId ? this.paseo.projectOf(caller.workspaceId).catch(() => null) : null;
  }
}

export function describe(agent: AgentInfo): string {
  return agent.title ? `"${agent.title}"` : agent.id;
}
