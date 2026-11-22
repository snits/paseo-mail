import type { HostDirectoryView, HostEntry } from "./types";

/** An address split into its kind, its local part and the host part after the first `@` (null when absent). */
export interface ParsedAddress {
  kind: "name" | "role" | "agent";
  local: string;
  host: string | null;
}

export function parseAddress(_raw: string): ParsedAddress {
  throw new Error("not implemented");
}

/** Where a host part leads: this daemon, or one linked host. */
export type HostMatch = { kind: "local" } | { kind: "remote"; host: HostEntry };

/** This daemon's view of its linked hosts, for resolving and displaying host parts. */
export class HostBook {
  constructor(_directory: HostDirectoryView) {}

  resolve(_hostPart: string): HostMatch {
    throw new Error("not implemented");
  }

  display(_serverId: string): string {
    throw new Error("not implemented");
  }
}
