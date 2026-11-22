import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AgentInfo, Drop, HostDirectoryView, Mail, PaseoPort, PortWatcher, PublishedAddress } from "./types";

/** The daemon API handed to hooks and tools (typed via the SDK). */
export type PaseoApi = PluginHandlerContext["paseo"];

/** Adapts the daemon API to the mailer's port. The API is attached by the first hook or tool. */
export class PaseoAdapter implements PaseoPort {
  private api: PaseoApi | null = null;

  attach(api: PaseoApi): boolean {
    if (this.api) return false;
    this.api = api;
    return true;
  }

  private paseo(): PaseoApi {
    if (!this.api) throw new Error("Paseo API not attached yet");
    return this.api;
  }

  async agent(id: string) {
    const result = await this.paseo().agents.ref(id).refresh();
    if (!result) return null;
    const { agent } = result;
    return { id: agent.id, title: agent.title, workspaceId: agent.workspaceId ?? null, status: agent.status, archived: Boolean(agent.archivedAt) };
  }

  async projectOf(workspaceId: string) {
    const workspace = await this.paseo().workspaces.ref(workspaceId).refresh();
    return workspace?.projectId ?? null;
  }

  send(agentId: string, text: string) {
    return this.paseo().agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
  }

  // Red-phase stubs (paseo-mail#xsbz Task 3): signatures only.
  async hostDirectory(): Promise<HostDirectoryView> {
    return { self: { serverId: "", label: "" }, hosts: [] };
  }

  async publishAddress(_agentId: string, _address: { name: string | null; roles: string[] } | null): Promise<void> {}

  async peerAgent(_serverId: string, _agentId: string): Promise<AgentInfo | null> {
    return null;
  }

  async peerAddresses(_serverId: string): Promise<PublishedAddress[]> {
    return [];
  }

  async writeDrop(_serverId: string, _agentId: string, _mail: Mail): Promise<void> {}

  async localDrops(): Promise<Drop[]> {
    return [];
  }

  async clearDrop(_agentId: string, _mailId: string): Promise<void> {}

  watch(_watcher: PortWatcher): void {}

  async release(): Promise<void> {}
}
