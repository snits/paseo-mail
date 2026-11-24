# Cross-host delivery: an outbox and a metadata drop

Status: Accepted. The **Size cap** rule is superseded by
[Cross-host mail size cap](2026-11-23-cross-host-size-cap.md), which also adds an import refusal.

## Context

`2026-11-21-cross-host-addressing.md` lets a sender name an agent on a linked host. The mail
still has to reach the other daemon's store. On Paseo 0.16.2 a plugin can open a client to a
linked daemon (`hosts.client(serverId)`) over the host link Paseo already keeps, but it cannot
call that daemon's plugin. `invokePluginRpc` exists on the low-level `DaemonClient` but not on
the `PaseoApi` plugins get. What a plugin can do over the link is write an agent's plugin
metadata (`agents.ref(id).setMetadata(patch)`). That needs `workspace.write`, where plugin RPC
would need `daemon.manage`.

The Paseo 0.16.2 packages show how metadata behaves:

- Top-level keys replace and `null` removes a key (server `record-patch.js`).
- Writes to one agent are serialized (`AgentManager.setMetadata`).
- The write is persisted, in the live agent's snapshot or its stored record, before the server
  answers. The client's `setMetadata` waits for that answer.
- The value goes out in the agent's state to every connected client.
- A search of the server code found no size limit specific to metadata.

## Decision

- **Transport.** A mail crosses hosts as a drop in the recipient agent's metadata. Each mail
  gets its own top-level key, `paseo-mail.in.<mailId>`, holding the mail as JSON. Keys must
  not be nested under one `paseo-mail` key: top-level replace would let two senders overwrite
  each other. The transport sits behind one interface, so a plugin-to-plugin call can replace
  it if Paseo exposes one. Jerry ruled to ask Paseo for that call in parallel (kata
  paseo-mail#m2f2).
- **Outbox.** A cross-host send stores the mail in the sender's own store, with `to.serverId`
  set and a new nullable `handedOffAt`. Outbox mail never counts as local mail: it is not in
  any local inbox, it is not nudged, and the archive bounce does not touch it.
- **Hand-off.** The sender's plugin resolves the recipient, if not already resolved, and writes
  the drop. It sets `handedOffAt` once `setMetadata` resolves. That is the last state the
  sender tracks. The write is persisted on the peer before it resolves, and the importer
  ignores duplicates, so there is no remote polling for "delivered".
  - Hand-offs are tried in id order, so mail from one sender arrives in the order it was sent.
  - A hand-off is retried when `hosts.observe()` reports the host online, and on the plugin's
    sweep.
- **Bounce from the outbox.** A mail not handed off within 24 hours goes back to the sender as
  a bounce (`Returned: <subject>`, as today). So does a mail whose address no longer resolves
  once its host is reachable. 24 hours is Jerry's ruling (kata paseo-mail#m2f2).
- **Size cap.** A cross-host body is at most 32 KiB, because it sits in the peer's agent
  snapshot until picked up. A larger one is an error at send time, and nothing is stored.
  Local mail stays uncapped. 32 KiB is Jerry's ruling (kata paseo-mail#m2f2).
- **Importer.** The recipient's plugin reads its local agents' `paseo-mail.in.*` keys at start,
  after each turn, and when agent state changes or on the sweep.
  - It accepts a drop when the mail parses, its `from.serverId` is a linked host, and the
    claimed sender exists on that host, checked through `hosts.client`. The sender may have
    been archived since it sent: mail can wait a day in the outbox.
  - When the sender's host cannot be reached, the drop stays parked and is checked again on
    the next sweep. It is cleared without being stored only when it does not parse, or its
    `from.serverId` is not a linked host, or the sender agent does not exist there.
  - An accepted mail is stored as received mail:
    - `to.serverId` becomes `null` and `to.agentId` becomes the local agent.
    - `readAt`, `nudgedAt`, `seenAt`, `bouncedAt` and `handedOffAt` are cleared.
    - `from.serverId` is kept.
  - It then gets the usual idle nudge. A `create` refused for a known id counts as done.
  - The key is cleared with `null` once the mail is stored.
- **Replies and bounces go back the way they came.**
  - `mail_reply` to a mail with `from.serverId` set sends to that agent on that host. If the
    agent is archived, it sends to its name there.
  - The archive bounce sends a remote sender's unread mail back across instead of skipping it.
- **Sweep.** The outbox retry and the importer run on one timer. Its interval is an
  implementation constant. No existing bound covers it.

## Consequences

- **Both link directions must work.** The importer's sender check, replies and bounces all
  need the recipient's daemon to reach the sender's. With the reverse link down, mail is
  handed off but stays parked, unread, until it comes back.
- **A sender is checked, not proven.** Anyone with `workspace.write` on the peer can write a
  drop naming any sender who really is live on a linked host. Local mail is stronger: the
  sender is the tool caller.
- **Until pickup, a body sits in Paseo's agent record on disk and in every connected client's
  agent state**, the phone app included. Not checked: whether any older copy outlives the
  clearing write.
- **A peer without paseo-mail leaves drops parked.** Resolution goes only through published
  addresses, so this needs a peer that published and then lost the plugin.
- **Clock skew can misorder.** Inboxes sort by the sender's `createdAt`, so skew between hosts
  can misorder mail from different hosts. Threads still link by `inReplyTo`.
- **Unverified before implementation.** That cantor's link to the Mac carries `workspace.write`.
  The design doc infers it from the link authenticating as the daemon owner. The first
  implementation step is a spike that writes and clears one key on a peer agent.
