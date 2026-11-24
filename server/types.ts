import { z } from "zod";

export const MailSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  inReplyTo: z.string().nullable(),
  /** `agentId` is null for mail the plugin itself sends (bounces). */
  from: z.object({ agentId: z.string().nullable(), name: z.string().nullable(), title: z.string().nullable(), serverId: z.string().nullable().default(null) }),
  /** `serverId` null means this daemon; `agentId` is null for mail addressed to another daemon's agent by name. */
  to: z.object({ agentId: z.string().nullable(), address: z.string(), serverId: z.string().nullable().default(null) }),
  subject: z.string(),
  body: z.string(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
  nudgedAt: z.string().nullable(),
  bouncedAt: z.string().nullable(),
  /**
   * When a human opened the mail on the Mail screen. Separate from `readAt`, which only the
   * recipient agent sets: a human looking does not count as the agent having read it.
   * Absent in mail written before the screen existed.
   */
  seenAt: z.string().nullable().default(null),
  /** When mail for another daemon was handed to it; null until then (and always null for local mail). */
  handedOffAt: z.string().nullable().default(null),
});
export type Mail = z.infer<typeof MailSchema>;

/**
 * The record a sending daemon writes on its sending agent (key `paseo-mail.out.<mailId>`) before it
 * hands a mail off: the recipient host, the agent the drop is written on, and the drop's digest.
 */
export const HandOffRecordSchema = z.object({
  to: z.object({ serverId: z.string(), agentId: z.string() }),
  digest: z.string(),
});
export type HandOffRecord = z.infer<typeof HandOffRecordSchema>;

export const RegistrationSchema = z.object({
  agentId: z.string(),
  name: z.string().nullable(),
  roles: z.array(z.string()),
  workspaceId: z.string().nullable(),
  projectId: z.string().nullable(),
  updatedAt: z.string(),
});
export type Registration = z.infer<typeof RegistrationSchema>;

/** What the mailer needs to know about an agent. */
export interface AgentInfo {
  id: string;
  title: string | null;
  workspaceId: string | null;
  status: string;
  archived: boolean;
}

/** An agent on a peer daemon, with its hand-off records: mailId → the raw value of each non-null `paseo-mail.out.<mailId>` key. */
export type PeerAgent = AgentInfo & { handOffs: Record<string, unknown> };

/** A linked host as this daemon's directory lists it. */
export interface HostEntry {
  serverId: string;
  label: string | null;
  enabled: boolean;
  online: boolean;
}

/** This daemon and its linked hosts; entries with a null `serverId` are dropped. */
export interface HostDirectoryView {
  self: { serverId: string; label: string };
  hosts: HostEntry[];
}

/** An agent on a peer daemon that publishes `paseo-mail.address` with a name. */
export interface PublishedAddress {
  agentId: string;
  name: string;
  roles: string[];
  title: string | null;
}

/** A `paseo-mail.in.<mailId>` key found on a local agent. */
export interface Drop {
  agentId: string;
  mailId: string;
  value: unknown;
}

/** Callbacks for host and drop changes (see `PaseoPort.watch`). */
export interface PortWatcher {
  hostOnline(serverId: string): void;
  dropsChanged(): void;
}

/** The slice of the daemon API the mailer uses (adapter in paseo.ts, fake in tests). */
export interface PaseoPort {
  /** null when the agent does not exist (any more). */
  agent(id: string): Promise<AgentInfo | null>;
  projectOf(workspaceId: string): Promise<string | null>;
  send(agentId: string, text: string): Promise<void>;
  hostDirectory(): Promise<HostDirectoryView>;
  publishAddress(agentId: string, address: { name: string | null; roles: string[] } | null): Promise<void>;
  /** Found (archived or not), with its hand-off records from the same read, or null when missing; THROWS when the host cannot be reached. */
  peerAgent(serverId: string, agentId: string): Promise<PeerAgent | null>;
  /** Every page of the peer's non-archived agents (filter.includeBackground: true) that publish
   *  `paseo-mail.address` with a name. Throws when unreachable. */
  peerAddresses(serverId: string): Promise<PublishedAddress[]>;
  /** Writes key `paseo-mail.in.<mail.id>` on the peer's agent. */
  writeDrop(serverId: string, agentId: string, mail: Mail): Promise<void>;
  /** Writes key `paseo-mail.out.<mailId>` on this daemon's agent (archived or not); throws when the write is refused. */
  recordHandOff(agentId: string, mailId: string, record: HandOffRecord): Promise<void>;
  /** Clears key `paseo-mail.out.<mailId>` on the peer's agent (the sender's hand-off record, once the mail is stored); throws when the host cannot be reached or refuses the write. */
  clearHandOff(serverId: string, agentId: string, mailId: string): Promise<void>;
  /** `paseo-mail.in.*` keys on every local agent (includeArchived + includeBackground, all pages). */
  localDrops(): Promise<Drop[]>;
  clearDrop(agentId: string, mailId: string): Promise<void>;
  /** hosts.observe() → hostOnline on a transition to online; an agent-list subscription (includeArchived +
   *  includeBackground) update carrying a paseo-mail.in.* key → dropsChanged. */
  watch(watcher: PortWatcher): void;
  /** Releases every subscription and cached peer client the port opened. Called by Mailer.dispose(). */
  release(): Promise<void>;
}

/** The agent calling a tool. */
export interface Caller {
  id: string;
  workspaceId: string | null;
  title: string | null;
}

/** A refusal the agent can act on, returned as a tool error rather than logged. */
export class UserError extends Error {}

export function rejectionReason(error: unknown): string {
  return (error as Error).message;
}
