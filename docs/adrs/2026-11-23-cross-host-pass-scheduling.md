# Cross-host pass scheduling

## Status

Accepted

## Context

A stalled peer can keep a hand-off or import pass busy while sweep and event
requests accumulate. Jerry chose to merge waiting passes in kata paseo-mail#252j.

## Decision

Hand-off and import each run serially in their own queue. Each queue can have
one running pass and one waiting pass. A request joins a pass that has yet to
start, and its caller receives that pass's result. The waiting pass can start
after the running pass settles, including when the running pass rejects.

This adds to [Cross-host delivery](2026-11-21-cross-host-delivery.md). Its
**Hand-off** rule says, “A hand-off is retried when `hosts.observe()` reports
the host online, and on the plugin’s sweep.” Its **Importer** rule specifies
“at start, after each turn, and when agent state changes or on the sweep.”
Those events request passes, and a pass can serve several requests.

## Consequences

A pass that reaches the outbox read or drop listing reads the current data at
that point. A pass that starts after shutdown returns before I/O. A stalled peer
can still delay later work within a pass for up to the SDK deadline on each RPC.
