# Cross-host addressing: `<name>@<host>`

Status: Accepted

## Context

Every address resolves on one daemon. An agent on one host cannot mail an agent on a host its
daemon is linked to: the registry and the store are per daemon, and every liveness check asks
only the local daemon. A daemon already knows its linked hosts (`hosts.list()` in the plugin
API, Paseo 0.16.2), and each entry has a `serverId` and a label, which may be null.
Registration names cannot contain `@` (`[a-z0-9][a-z0-9._-]{0,63}`), so the character is free
to separate a host.

## Decision

- This adds to the **Addresses** rule of `2026-11-10-mail-registry.md`, and to its "Unknown
  address" and "`mail_directory`" lines. Nothing else in it is superseded.
- **Address forms.** Two new forms: `<name>@<host>` and `role:<role>@<host>`. A form without
  `@<host>` resolves on the sender's own daemon, as today. `role:<role>` never reaches another
  host unless it is written with `@<host>`.
- **Host part.** `<host>` is a linked host's Paseo label, lower-cased and trimmed, provided it
  then matches `[a-z0-9][a-z0-9._-]{0,63}`. A host has no label address when its label is null
  or does not match, or when two linked hosts share it. Such a host is addressed by its
  `serverId` instead. `serverId` works for any enabled link; a disabled link is ignored. A
  label belongs to the sender daemon's registration of the link, not to the host itself, so
  one host can carry different labels on different daemons. cantor's link calls the Mac
  `m2-max`, while the Mac's own label is `M2 Max`. Mail shown on the recipient's side uses the recipient daemon's label for the
  sender's host. `<name>@<own host>`, by the daemon's own label once normalized or by its
  `serverId`, resolves locally.
- **Published addresses.** `mail_register` still writes the local registry, and also sets the
  agent's Paseo metadata key `paseo-mail.address` to `{ name, roles }`. Release sets it to
  `null`. At start, the plugin writes the key for registrations made before this change. A
  peer finds the addresses on a host by listing that host's agents through
  `hosts.client(serverId)` and reading the key on non-archived agents. Liveness comes from the
  daemon that owns the agent. Names stay unique per daemon, not across hosts.
- **Resolution.** A remote address resolves at send time to the one non-archived agent on that
  host that publishes the name. If more than one does, because the key and that host's
  registry disagree, the send fails with an error naming them. A remote role resolves to its holders on that host, without
  the workspace and project scoping, which are meaningful only on the sender's own daemon.
  Nobody publishes the name: an error, nothing stored, as for an unknown local name. The host
  is unknown or not linked: an error. The host is linked but not online: the send is accepted
  and the mail waits in the sender's outbox, still unresolved. It is resolved when the host
  comes back, and bounced to the sender if nobody publishes the name then
  (`2026-11-21-cross-host-delivery.md`).
- **Stored identity.** `from` and `to` in a mail gain `serverId`, nullable, where `null` means
  this daemon. Mail files written before this change parse as local. `to.agentId` becomes
  nullable, for an outbox mail whose recipient is not resolved yet. A local mail always has
  one.
- **Display.** Tools and the Mail screen show a remote party as `<name>@<host>`, so an agent can
  tell a mail came from another machine. `mail_directory` lists remote entries in that form,
  with their host.

## Consequences

- Two hosts can carry the same name. `name` and `name@host` are different addresses.
- A host's label address changes when its label does, or when another linked host takes the
  same label. `serverId` addresses do not change.
- A send to an offline peer cannot check the name, so a typo there shows up as a later bounce,
  not as an error at send time.
- Paseo routes are one hop only, so a host reaches only the hosts it links to directly.
