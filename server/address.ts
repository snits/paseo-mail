import { ADDRESS, normalize } from "./registry";
import { UserError, type HostDirectoryView, type HostEntry } from "./types";

/** An address split into its kind, its local part and the host part after the first `@` (null when absent). */
export interface ParsedAddress {
  kind: "name" | "role" | "agent";
  local: string;
  host: string | null;
}

const ROLE_PREFIX = "role:";
const AGENT_PREFIX = "agent:";

/** Splits on the first `@` before normalizing, so the host part keeps its case (serverIds are case-sensitive). */
export function parseAddress(raw: string): ParsedAddress {
  const trimmed = raw.trim();
  const at = trimmed.indexOf("@");
  const left = at === -1 ? trimmed : trimmed.slice(0, at);
  const host = at === -1 ? null : trimmed.slice(at + 1);
  const lower = left.toLowerCase();
  if (lower.startsWith(AGENT_PREFIX)) return { kind: "agent", local: left.slice(AGENT_PREFIX.length).trim(), host };
  if (lower.startsWith(ROLE_PREFIX)) return { kind: "role", local: normalize(left.slice(ROLE_PREFIX.length), "role"), host };
  return { kind: "name", local: normalize(left, "name"), host };
}

/** Where a host part leads: this daemon, or one linked host. */
export type HostMatch = { kind: "local" } | { kind: "remote"; host: HostEntry };

const labelOf = (entry: HostEntry): string | null => {
  const label = entry.label?.trim().toLowerCase() ?? "";
  return ADDRESS.test(label) ? label : null;
};

/** This daemon's view of its linked hosts, for resolving and displaying host parts. */
export class HostBook {
  private readonly selfLabel: string;
  private readonly linked: HostEntry[];

  constructor(private readonly directory: HostDirectoryView) {
    this.selfLabel = directory.self.label.trim().toLowerCase();
    this.linked = directory.hosts.filter((host) => host.enabled);
  }

  resolve(hostPart: string): HostMatch {
    const typed = hostPart.trim();
    const label = typed.toLowerCase();
    if (typed !== "" && (typed === this.directory.self.serverId || label === this.selfLabel)) return { kind: "local" };
    const byId = this.linked.find((host) => host.serverId === typed);
    if (byId) return { kind: "remote", host: byId };
    if (ADDRESS.test(label)) {
      const byLabel = this.linked.filter((host) => labelOf(host) === label);
      if (byLabel.length === 1) return { kind: "remote", host: byLabel[0]! };
    }
    throw new UserError(`unknown host "${hostPart}": use the label or the serverId of a linked host`);
  }

  /** The host's label when that label reaches the same host, else its serverId. */
  display(serverId: string): string {
    const host = this.linked.find((entry) => entry.serverId === serverId);
    const label = host && labelOf(host);
    if (!label) return serverId;
    try {
      const match = this.resolve(label);
      return match.kind === "remote" && match.host.serverId === serverId ? label : serverId;
    } catch {
      return serverId;
    }
  }
}
