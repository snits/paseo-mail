# Cross-host mail: hand-off and import rules

Status: Accepted

## Context

`2026-11-21-cross-host-delivery.md` sets how a mail crosses hosts: the sender keeps it in an
outbox, hands it off as a metadata drop on the recipient agent, and the recipient's plugin
imports it. Building it showed three gaps in that ADR.

- The hand-off resolves only mail that is not resolved yet. A mail resolved at send time, or a
  reply addressed to the agent that sent the original, can find that agent archived or gone by
  the time its host is reachable. The ADR's own reply rule ("If the agent is archived, it sends
  to its name there") needs a re-resolution step that the hand-off rule does not give.
- The importer's rewrite list sets `to.serverId` and `to.agentId` but leaves `to.address` as the
  sender typed it, `probe@m2-max`. The Mail screen can name an archived agent's mailbox after
  the address its mail was sent to, so `probe@m2-max` would become a local mailbox name.
- The importer stores a mail under its own id, and the store writes each mail to `<id>.json`.
  An id from another daemon is input this daemon did not make.

## Decision

- This adds to `2026-11-21-cross-host-delivery.md`: to its **Hand-off** and **Importer**
  rules. Nothing else in it is superseded.
- **Re-resolve at hand-off.** Before writing a drop for a resolved outbox mail, the hand-off
  looks the recipient up on its host by agent id. A live agent receives the mail even if it
  never registered a name. An archived or missing recipient is re-resolved by the name in
  `to.address`, as an unresolved mail is: the one non-archived agent on that host that
  publishes the name. A recipient with no name (`to.address` is `agent:<id>`) is unresolvable.
  This applies to every outbox mail, sent or replied. It is what lets a reply to an archived
  sender reach whoever now holds its name. An unresolvable mail stays in the outbox, is logged,
  and does not hold back later mail to the same host. A lookup that throws stops hand-offs to
  that host for the pass, so no later mail overtakes it.
- **Rewrite `to.address` on import.** On import, `to.address` becomes the text before its first
  `@`, trimmed and not normalized. `probe@m2-max` is stored as `probe`.
- **Validate the mail id on import.** An imported mail whose id does not match
  `^m_[0-9a-z]{1,64}$` (`MAIL_ID` in `server/mailer.ts`, the shape this plugin's ids take) is
  cleared unstored and logged, before any host lookup, because the id becomes a file name in
  the store. This adds a fourth reason to the delivery ADR's list of drops cleared without
  being stored.

## Consequences

- A reply to an archived sender goes to the agent that now holds the sender's name on that
  host, which may be a different agent from the one that wrote the original.
- A reply to an archived sender that had no name is refused at reply time when its host is
  online. When the host is offline the reply is accepted and becomes unresolvable at hand-off.
- Unresolvable mail waits in the outbox and is retried on every pass. The outbox bounces of
  the delivery ADR (24 hours, and an address that no longer resolves) are not built yet, nor
  is the archive bounce across hosts, so such mail does not go back to its sender.
- A daemon whose plugin has not attached (no hook or tool call since the daemon started) does
  not import drops until it does.
- Mail ids are generated per host. If two hosts generate the same id, the second mail to reach
  a daemon is dropped there as a duplicate.
