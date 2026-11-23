# Cross-host mail: the importer confirms each drop with its sender's host

Status: Accepted

## Context

`2026-11-21-cross-host-delivery.md` accepts a drop when its `from.serverId` is a linked host and
the claimed sender agent exists there. On Paseo 0.16.2 a metadata write does not identify its
writer:

- the wire request carries only `agentId`, `patch` and `requestId` (@getpaseo/protocol
  `dist/messages.js:849-855`);
- the daemon applies the patch with no client or principal (@getpaseo/server
  `dist/server/server/session.js:3096-3100`, `agent/agent-manager.js:1745-1760`).

So any linked host can write a drop on a local agent that claims to come from a third host.
Jerry ruled on kata paseo-mail#qkf2 that the importer confirms with the claimed sender host,
over the existing link, that it handed off that mail, before storing the drop.

Plugin RPC between daemons is not on the `PaseoApi` plugins get, and the sender's outbox is in
its plugin's own store, which a peer cannot read. A peer can read an agent's metadata: the
snapshot `refresh()` returns carries it, for live and for archived agents (@getpaseo/server
`agent/agent-projections.js:102`, `:222`).

## Decision

This adds to the **Hand-off** and **Importer** rules of `2026-11-21-cross-host-delivery.md`, as
`2026-11-21-cross-host-slice-1-rules.md` does. It supersedes one rule there: the importer's
accept criterion (last bullet below). Nothing else in either ADR is superseded.

- **Hand-off record.** Before writing a drop, the sending daemon writes a record on its own
  sending agent (`from.agentId`), under the flat metadata key `paseo-mail.out.<mailId>`:
  `{ to: { serverId, agentId }, digest }`.
  - `to` names the recipient host and the agent the drop is written on.
  - `digest` is the lowercase hex SHA-256 of `JSON.stringify` of `[id, threadId, inReplyTo,
    from.agentId, from.name, from.title, from.serverId, to.address, subject, body, createdAt]`,
    taken from the mail as the drop carries it. These are the fields the importer reads from the
    drop (it rewrites `to.address` to its local part, and sets `to` and the stamps itself). Without
    them, a host that can read the drop could overwrite its content under the genuine id.
  - The record is written, then the drop, then `handedOffAt` is stamped. A failed record write
    stops hand-offs to that host for the pass, as a failed drop write does, unless the sending
    agent no longer exists on the sending daemon. Then the mail stays in the outbox, logged, and
    later mail still goes. A mail with no sending agent is treated the same way.
- **Confirmation.** The importer's existing lookup of the claimed sender on its host returns that
  agent's records too, so confirming adds no peer read. A record matches a drop when it parses,
  names this daemon as `to.serverId` and the agent holding the drop as `to.agentId`, and carries
  the digest of the drop's mail.
- **Forward-compatible records.** The importer ignores fields of a record it does not know, so a
  later version may add one without older importers clearing its mail (Jerry's ruling on kata
  paseo-mail#qkf2).
- **Import order.**
  1. Parse, id shape, claimed host in the directory, non-null sender: as before; failures are
     cleared unstored.
  2. Claimed host disabled or offline, or the sender lookup throws: the drop parks, as before.
  3. Sender missing on its host: cleared unstored, as before.
  4. Already stored: clear the record if it matches, then clear the drop.
  5. **No matching record: the drop is cleared unstored and logged.** This adds a reason to the
     delivery ADR's list of drops cleared without being stored. Nothing is written to the
     claimed host.
  6. Otherwise store the mail, schedule its nudge, clear the record on the claimed host, and
     clear the drop.
  - Clearing the record is best-effort: a failure is logged and the drop is still cleared.
  - Only a matching record is ever cleared, so a forged drop cannot remove a genuine one's record.
- **Supersedes** the delivery ADR's accept criterion, which becomes: the mail parses, `from.serverId` is a
  linked host, the claimed sender exists there, **and it holds a matching record**.

## Consequences

- **A sender is confirmed, not proven.** The delivery ADR's "A sender is checked, not proven"
  is narrowed, not retired. The record is ordinary agent metadata, so a host with
  `workspace.write` on the claimed sender's host can write a record there and a drop here. The
  check stops a forger that is linked to the recipient's host but not to the claimed sender's.
- **Rejected carrier.** Plugin timeline items are stamped with the writing plugin's id by the
  server (@getpaseo/server `session.js:6474-6483`), so a peer probably cannot forge one. But the
  client's timeline handle can only append, refetch and subscribe (@getpaseo/client
  `dist/index.d.ts:278-297`): an item, one per mail, would stay in the sending agent's timeline
  with no way for the plugin to remove it, and confirming would need a timeline fetch per drop. So
  this ADR does not use them.
- **Cost per mail.** The sender adds one local metadata write. The importer adds no peer read and
  one peer write, the record clear. A host that reads online but never answers can hold that
  write for up to 60 s (@getpaseo/client `daemon-client.js:184`; kata paseo-mail#252j), and the
  import pass is serial, so it can delay later drops in the same pass.
- **The importer now writes to the sender's host on every import.** Before, it only read there
  (replies already wrote). A link that allows reads but refuses writes still imports; the
  records then stay on the sender.
- **Orphaned records.** A record whose drop is never imported (the recipient is deleted, the link
  is removed for good, the drop is cleared unstored on the far side, or the record clear failed)
  stays on the sending agent, one small key per mail. Nothing clears it: the mail is already
  stamped `handedOffAt`, so the planned 24 h outbox bounce would not see it either. A sweeper,
  if one is wanted, is deferred to slice 2 (kata paseo-mail#jx7e).
- **Gone senders.** An outbox mail whose sending agent no longer exists stays in the outbox and is
  logged on each pass, until the planned 24 h outbox bounce removes it (slice 2).
- **No compatibility shim.** A drop from a build without this change carries no record and is
  cleared unstored. 0.3.0 is unreleased, so no released version is affected.
- **Slice 2 loses an option.** The jx7e foreclosure note let cross-host bounces either carry a
  non-null sender or rely on a version floor ruling out 0.3.0 receivers. The version floor no
  longer helps: every receiver with this change needs a record on a real agent of the bouncing
  host. Proposed, not decided: send a cross-host bounce from the archived recipient, whose
  metadata Paseo still writes (`agent-manager.js:1745-1760`). Jerry rules on it when slice 2
  starts (FORECLOSURE NOTE on kata paseo-mail#jx7e).
