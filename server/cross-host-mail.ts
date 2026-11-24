import { createHash } from "node:crypto";
import { HostBook, parseAddress } from "./address";
import { Queue } from "./files";
import type { MailStore } from "./store";
import { HandOffRecordSchema, MailSchema, rejectionReason, type Drop, type HostDirectoryView, type Mail, type PaseoPort, type PublishedAddress } from "./types";

/** The name an outbox address reaches its recipient by, or null when it has none (`agent:<id>`) or is not a valid name. */
function nameIn(address: string): string | null {
  try {
    const parsed = parseAddress(address);
    return parsed.kind === "name" ? parsed.local : null;
  } catch {
    return null;
  }
}

/**
 * The shape expected on import. The store writes a mail to `<id>.json`, so an
 * id from another daemon must match this before it is stored (no path separators, no dots).
 */
export const MAIL_ID = /^m_[0-9a-z]{1,64}$/;

/**
 * The digest a hand-off record carries: lowercase hex SHA-256 of the JSON array of the fields the
 * importer reads from the drop, in a fixed order, taken from the mail exactly as the drop carries it.
 */
export function handOffDigest(mail: Mail): string {
  const fields = [mail.id, mail.threadId, mail.inReplyTo, mail.from.agentId, mail.from.name, mail.from.title, mail.from.serverId, mail.to.address, mail.subject, mail.body, mail.createdAt];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

export class CrossHostMail {
  /** Hand-off passes run one at a time, so each reads the outbox after the preceding pass settles. */
  private readonly handOffs = new Queue();
  /** Import passes run one at a time, so no drop is stored twice. */
  private readonly imports = new Queue();
  private disposed = false;

  constructor(
    private readonly store: MailStore,
    private readonly paseo: PaseoPort,
    private readonly now: () => string,
    private readonly scheduleNudge: (agentId: string) => void,
  ) {}

  stop(): void {
    this.disposed = true;
  }

  handOffIdle(): Promise<void> {
    return this.handOffs.idle();
  }

  importIdle(): Promise<void> {
    return this.imports.idle();
  }

  flushOutbox(): Promise<void> {
    return this.handOffs.run(() => this.handOff());
  }

  private async handOff(): Promise<void> {
    if (this.disposed) return;
    // A fresh read: if it throws, the pass touches nothing (the rejection reaches the caller).
    const directory = await this.paseo.hostDirectory();
    const online = new Set(new HostBook(directory).onlineHosts().map((host) => host.serverId));
    const byHost = new Map<string, Mail[]>();
    for (const mail of this.store.outbox()) {
      const serverId = mail.to.serverId!;
      if (!online.has(serverId)) continue;
      byHost.set(serverId, [...(byHost.get(serverId) ?? []), mail]);
    }
    for (const [serverId, mails] of byHost) {
      try {
        await this.handOffTo(serverId, mails, directory.self.serverId);
      } catch (error) {
        // Stop this host for the pass, so no later mail to it overtakes the one that failed.
        console.error(`[paseo-mail] handing mail to ${serverId} failed; retrying on the next pass:`, rejectionReason(error));
      }
    }
  }

  /**
   * Hands one host's outbox mail over in id order. Each mail is recorded on its sending agent
   * (`paseo-mail.out.<id>`, naming the recipient agent and the drop's digest) before its drop is
   * written. A mail with no sending agent, or whose sending agent is gone, stays in the outbox
   * and the pass goes on. Any other failed call to the host throws.
   */
  private async handOffTo(serverId: string, mails: Mail[], selfServerId: string): Promise<void> {
    let published: PublishedAddress[] | null = null;
    const publisherOf = async (name: string): Promise<string | null> => {
      published ??= await this.paseo.peerAddresses(serverId);
      const holders = published.filter((entry) => entry.name === name);
      return holders.length === 1 ? holders[0]!.agentId : null;
    };
    for (const mail of mails) {
      let agentId = mail.to.agentId;
      if (agentId !== null) {
        const agent = await this.paseo.peerAgent(serverId, agentId);
        if (!agent || agent.archived) agentId = null;
      }
      if (agentId === null) {
        const name = nameIn(mail.to.address);
        agentId = name === null ? null : await publisherOf(name);
      }
      if (agentId === null) {
        console.error(`[paseo-mail] mail ${mail.id} to "${mail.to.address}" on ${serverId} reaches no single agent; it stays in the outbox`);
        continue;
      }
      const senderId = mail.from.agentId;
      if (senderId === null) {
        console.error(`[paseo-mail] mail ${mail.id} has no sending agent to record the hand-off on; it stays in the outbox`);
        continue;
      }
      const dropMail = { ...mail, from: { ...mail.from, serverId: selfServerId } };
      try {
        await this.paseo.recordHandOff(senderId, mail.id, { to: { serverId, agentId }, digest: handOffDigest(dropMail) });
      } catch (error) {
        let senderExists = true;
        try {
          senderExists = (await this.paseo.agent(senderId)) !== null;
        } catch {
          // The lookup failed too: treat the sender as existing and report the original failure.
        }
        if (senderExists) throw error;
        console.error(`[paseo-mail] mail ${mail.id}: its sending agent ${senderId} no longer exists, so the hand-off cannot be recorded; it stays in the outbox`);
        continue;
      }
      await this.paseo.writeDrop(serverId, agentId, dropMail);
      const handedOffAt = this.now();
      await this.store.update([mail.id], (current) => {
        current.handedOffAt ??= handedOffAt;
      });
    }
  }

  importDrops(): Promise<void> {
    return this.imports.run(() => this.importPass());
  }

  private async importPass(): Promise<void> {
    if (this.disposed) return;
    // A fresh read: if it throws, the pass touches nothing (the rejection reaches the caller).
    const directory = await this.paseo.hostDirectory();
    for (const drop of await this.paseo.localDrops()) {
      try {
        await this.importDrop(drop, directory);
      } catch (error) {
        console.error(`[paseo-mail] importing mail ${drop.mailId} on ${drop.agentId} failed; it stays for the next pass:`, rejectionReason(error));
      }
    }
  }

  /**
   * Stores one drop in the holder's inbox, leaves it for a later pass (park), or clears it unstored.
   * A drop is stored only when its claimed sender's agent holds a matching hand-off record (naming
   * this host and the holder, with the digest of this mail). When it clears an unconfirmed drop,
   * it writes nothing to the claimed host. After storing, it attempts to clear the sender's
   * record before clearing the local drop.
   */
  private async importDrop(drop: Drop, directory: HostDirectoryView): Promise<void> {
    const where = `mail ${drop.mailId} on ${drop.agentId}`;
    const parsed = MailSchema.safeParse(drop.value);
    if (!parsed.success) return this.discard(drop, `${where} is not a mail`);
    const mail = parsed.data;
    // The id becomes a file name in the store, so check its shape before using it.
    if (!MAIL_ID.test(mail.id)) return this.discard(drop, `${where} has an id that is not a mail id (${JSON.stringify(mail.id)})`);
    const { serverId, agentId: senderId } = mail.from;
    const host = serverId === null ? undefined : directory.hosts.find((entry) => entry.serverId === serverId);
    if (serverId === null || !host) return this.discard(drop, `${where} comes from a host this daemon has no link to`);
    if (senderId === null) return this.discard(drop, `${where} has no sender agent`);
    if (!host.enabled || !host.online) {
      console.error(`[paseo-mail] ${where} waits: its sender's host ${serverId} is ${host.enabled ? "offline" : "disabled"}`);
      return;
    }
    // Throws when the host cannot be reached: the drop waits (logged by the pass).
    const sender = await this.paseo.peerAgent(serverId, senderId);
    if (sender === null) return this.discard(drop, `${where} comes from agent ${senderId}, which does not exist on ${serverId}`);
    // The sender confirms the drop: its agent holds a hand-off record for this mail that names this
    // daemon and this agent and carries the digest of exactly this mail.
    const record = HandOffRecordSchema.safeParse(sender.handOffs[mail.id]);
    const confirmed =
      record.success &&
      record.data.to.serverId === directory.self.serverId &&
      record.data.to.agentId === drop.agentId &&
      record.data.digest === handOffDigest(mail);
    if (this.store.get(mail.id)) {
      if (confirmed) await this.clearHandOffBestEffort(serverId, senderId, mail.id);
      await this.paseo.clearDrop(drop.agentId, drop.mailId);
      return;
    }
    if (!confirmed) return this.discard(drop, `${where} claims host ${serverId}, whose agent ${senderId} holds no matching hand-off record`);
    // A create that throws leaves the drop for the next pass (logged by the pass).
    await this.store.create({
      ...mail,
      to: { agentId: drop.agentId, address: mail.to.address.split("@", 1)[0]!.trim(), serverId: null },
      readAt: null,
      nudgedAt: null,
      seenAt: null,
      bouncedAt: null,
      handedOffAt: null,
    });
    this.scheduleNudge(drop.agentId);
    await this.clearHandOffBestEffort(serverId, senderId, mail.id);
    await this.paseo.clearDrop(drop.agentId, drop.mailId);
  }

  /** Attempts to clear the sender's hand-off record once its mail is stored here. */
  private async clearHandOffBestEffort(serverId: string, senderId: string, mailId: string): Promise<void> {
    try {
      await this.paseo.clearHandOff(serverId, senderId, mailId);
    } catch (error) {
      console.error(`[paseo-mail] clearing the hand-off record of mail ${mailId} on ${senderId} (${serverId}) failed:`, rejectionReason(error));
    }
  }

  /** Attempts to clear a drop that failed its checks on this pass. */
  private async discard(drop: Drop, why: string): Promise<void> {
    console.error(`[paseo-mail] ${why}; clearing it unstored`);
    await this.paseo.clearDrop(drop.agentId, drop.mailId);
  }
}
