# Cross-host mail size cap

Status: Accepted

## Context

Both the subject and the body travel in the recipient agent's Paseo metadata. Jerry ruled in
kata paseo-mail#6d9k that the same size limit applies at send and import.

## Decision

This supersedes the **Size cap** rule in [Cross-host delivery](2026-11-21-cross-host-delivery.md)
and adds a reason to refuse an import. It extends step 6 of the import order and the acceptance
criterion in [Cross-host sender confirmation](2026-11-23-cross-host-sender-confirmation.md)
with the size check below.

- The sum of the subject's and the body's separate UTF-8 byte lengths may be at most 32 KiB
  (32768 bytes). The limit measures those two fields. Local-only mail is uncapped.
- A send with any remote recipient must fit before any recipient's copy is stored. A remote
  reply must fit with its final subject, including any generated `Re: ` prefix.
- The importer checks the limit after duplicate handling and sender confirmation, before
  storing the mail. For an oversized drop it logs the refusal and attempts to clear the local
  drop. If the clear fails, the drop stays for a later pass.

## Consequences

At the limit, the subject and body can be sent and imported. When a confirmed drop is
oversized, its refusal leaves the sender's hand-off record in place. A duplicate of mail
already stored can still clear its matching record as part of duplicate handling.
