import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTIC, CANTOR, MAC, linkedHosts, mailOf, publish, reportHost, setup, toolContext, type FakePaseo } from "../test/fixtures";
import type { Mailer } from "./mailer";
import { mailTools } from "./tools";
import type { Mail } from "./types";

// Task 7 of paseo-mail#xsbz: the tools show a remote party as name@host (design step 10,
// acceptance 11). Every tool runs on cantor; the remote parties live on the Mac and the attic.
// An agent acts on what the tool text says, so a wrong host part sends its next mail astray.

const mailers: Mailer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(mailers.splice(0).map((mailer) => mailer.dispose()));
});

/**
 * cantor (started Mailer, tools), linked to the Mac as "m2-max" and to the attic as "attic". Only
 * cantor runs a Mailer: the peers answer the port's calls from their agents and metadata.
 * The Mac publishes "probe" (roles qa), the attic "scout". cantor's "lead-id" is registered as
 * "lead" unless `registerLead` is false.
 */
async function cantorTools(options: { registerLead?: boolean } = {}) {
  const { network, cantorHost, macHost: mac } = linkedHosts();
  const attic = network.host(ATTIC, "attic");
  network.link(CANTOR, ATTIC, { label: "attic" });
  network.link(ATTIC, CANTOR, { label: "cantor" });
  publish(mac, "probe-id", "probe", "Probe", ["qa"]);
  publish(attic, "scout-id", "scout", "Scout");
  const env = await setup({ debounceMs: 60_000 }, undefined, cantorHost);
  mailers.push(env.mailer);
  await env.mailer.start();
  const lead = env.paseo.add("lead-id", { title: "Lead", workspaceId: "w1" });
  if (options.registerLead ?? true) await env.mailer.register(lead, { name: "lead" });
  const byName = Object.fromEntries(mailTools(env.mailer).map((tool) => [tool.name, tool]));
  const call = (name: string, input: unknown, agent = "lead-id") => byName[name]!.execute(byName[name]!.input.parse(input), toolContext(agent, env.paseo.agents.get(agent)?.title ?? null));
  return { ...env, network, mac, attic, lead, call };
}

/** A mail in lead's inbox on cantor, from the given sender. */
function received(id: string, from: Mail["from"], subject: string): Mail {
  return mailOf({ id, from, to: { agentId: "lead-id", address: "lead", serverId: null }, subject, body: `body of ${subject}` });
}

const FROM_PROBE: Mail["from"] = { agentId: "probe-id", name: "probe", title: "Probe", serverId: MAC };
/** Nameless, titled, mixed-case id: kills "append @host to today's sender()" and lower-casing. */
const FROM_ANON: Mail["from"] = { agentId: "Anon-ID", name: null, title: "Anon", serverId: MAC };

interface RemoteEntry {
  address: string;
  host: string;
  serverId: string;
  title: string | null;
}

/** `structuredContent.remote` sorted by address; undefined stays undefined (so a missing field fails). */
function remoteOf(result: { structuredContent?: unknown }): RemoteEntry[] | undefined {
  const remote = (result.structuredContent as { remote?: RemoteEntry[] } | undefined)?.remote;
  return remote === undefined ? undefined : [...remote].sort((a, b) => a.address.localeCompare(b.address));
}

const PROBE_ENTRY: RemoteEntry = { address: "probe@m2-max", host: "m2-max", serverId: MAC, title: "Probe" };
const SCOUT_ENTRY: RemoteEntry = { address: "scout@attic", host: "attic", serverId: ATTIC, title: "Scout" };
const LEAD_AGENTS = [{ name: "lead", roles: [], title: "Lead", workspaceId: "w1" }];

/** The peerAddresses calls the port recorded from `from` on, by serverId. */
function listed(paseo: FakePaseo, from: number): unknown[] {
  return paseo.calls.slice(from).filter((call) => call.op === "peerAddresses").map((call) => call.args[0]);
}

describe("mail_list and mail_read: the sender (design step 10)", () => {
  // Wrong: today's sender() ("probe", '"Anon" (unregistered)'); @host appended to today's form
  // ('"Anon" (unregistered)@m2-max'); the serverId instead of the label (probe@srv_EntwLoR9srmD);
  // the Mac's own label ("M2 Max"); the agent id lower-cased; @host on a local sender (bob@cantor).
  it("shows a remote sender as name@label, a nameless one as agent:<id>@label, and a local one as today", async () => {
    const { store, call } = await cantorTools();
    await store.create(received("m_0001", { agentId: "bob-id", name: "bob", title: "Bob", serverId: null }, "Local named"));
    await store.create(received("m_0002", { agentId: "carol-id", name: null, title: "Carol", serverId: null }, "Local unregistered"));
    await store.create(received("m_0003", FROM_PROBE, "Remote named"));
    await store.create(received("m_0004", FROM_ANON, "Remote nameless"));

    const list = await call("mail_list", {});
    expect(list.isError).toBeUndefined();
    expect(list.text).toContain("from bob: Local named");
    expect(list.text).toContain('from "Carol" (unregistered): Local unregistered');
    expect(list.text).toContain("from probe@m2-max: Remote named");
    expect(list.text).toContain("from agent:Anon-ID@m2-max: Remote nameless");
    const mails = (list.structuredContent as { mails: { id: string; from: string }[] }).mails;
    expect(Object.fromEntries(mails.map((mail) => [mail.id, mail.from]))).toEqual({
      m_0001: "bob",
      m_0002: '"Carol" (unregistered)',
      m_0003: "probe@m2-max",
      m_0004: "agent:Anon-ID@m2-max",
    });

    const named = await call("mail_read", { id: "m_0003" });
    expect(named.text).toContain("From: probe@m2-max\nTo: lead\n");
    expect((named.structuredContent as { mail: { from: string } }).mail.from).toBe("probe@m2-max");
    const nameless = await call("mail_read", { id: "m_0004" });
    expect(nameless.text).toContain("From: agent:Anon-ID@m2-max\nTo: lead\n");
    expect((nameless.structuredContent as { mail: { from: string } }).mail.from).toBe("agent:Anon-ID@m2-max");
    const local = await call("mail_read", { id: "m_0001" });
    expect(local.text).toContain("From: bob\nTo: lead\n");
  });

  // cantor relists the Mac under its own label "cantor": the label fits the pattern but resolves to
  // cantor itself, so it must not be shown. Wrong: the link label (probe@cantor would mail cantor's
  // own "probe"); the serverId lower-cased; the Mac's own label.
  it("shows the serverId, case kept, when the host's label does not resolve back to it", async () => {
    const { network, store, mailer, call } = await cantorTools();
    network.link(CANTOR, MAC, { label: "cantor" });
    await mailer.refreshHosts();
    await store.create(received("m_0003", FROM_PROBE, "Remote named"));
    await store.create(received("m_0004", FROM_ANON, "Remote nameless"));
    const list = await call("mail_list", {});
    expect(list.text).toContain("from probe@srv_EntwLoR9srmD: Remote named");
    expect(list.text).toContain("from agent:Anon-ID@srv_EntwLoR9srmD: Remote nameless");
    expect(list.text).not.toContain("@cantor");
    const read = await call("mail_read", { id: "m_0003" });
    expect(read.text).toContain("From: probe@srv_EntwLoR9srmD\n");
  });
});

describe("mail_send and mail_reply: the result lines (design step 10)", () => {
  // Typed by serverId, so the shown host must come from Delivery.serverId through display(), not
  // from the typed text. Local lines come first and are unchanged. Wrong: today's
  // 'probe (via ...) — use "probe" from now on' (a bare "probe" resolves on cantor); the typed host
  // part (probe@srv_EntwLoR9srmD); @cantor on the local line.
  it("names a remote recipient at its host and advises that address; a local line is unchanged", async () => {
    const { paseo, mailer, call } = await cantorTools();
    await mailer.register(paseo.add("bob-id", { title: "Bob", workspaceId: "w1" }), { name: "bob" });
    const sent = await call("mail_send", { to: ["probe@srv_EntwLoR9srmD", "bob"], subject: "Hi", body: "x" });
    expect(sent.isError).toBeUndefined();
    expect(sent.text).toMatch(/^Sent 2 mails:\n- m_\w+ → bob — use "bob" from now on\n- m_\w+ → probe@m2-max \(via probe@srv_EntwLoR9srmD\) — use "probe@m2-max" from now on\n\nUnread: 0$/);
  });

  // Typed exactly as shown: no "(via ...)". Wrong: today's address !== name check adds
  // "(via probe@m2-max)"; today's advice "probe".
  it("adds no via when the address was typed as shown", async () => {
    const { call } = await cantorTools();
    const sent = await call("mail_send", { to: "probe@m2-max", subject: "Hi", body: "x" });
    expect(sent.text).toMatch(/^Sent 1 mail:\n- m_\w+ → probe@m2-max — use "probe@m2-max" from now on\n\nUnread: 0$/);
  });

  // The Mac is offline from cantor, so the mail is accepted unresolved (agentId null). Wrong:
  // "null@m2-max" or "undefined"; the bare name; today's advice "probe".
  it("names an unresolved recipient by the name it was addressed by, at its host", async () => {
    const { network, store, call } = await cantorTools();
    network.setReachable(CANTOR, MAC, false);
    const sent = await call("mail_send", { to: "probe@m2-max", subject: "Hi", body: "x" });
    expect(store.all().map((mail) => mail.to)).toEqual([{ agentId: null, address: "probe@m2-max", serverId: MAC }]);
    expect(sent.text).toMatch(/^Sent 1 mail:\n- m_\w+ → probe@m2-max — use "probe@m2-max" from now on\n\nUnread: 0$/);
    expect(sent.text).not.toMatch(/null|undefined/);
  });

  // Reading for the lead: structuredContent.sent[].to carries the same address as the advice.
  // Wrong: today's to: "probe" (a bare name resolves on cantor). The local entry is unchanged.
  it("gives a remote recipient's address as name@host in structuredContent", async () => {
    const { paseo, mailer, call } = await cantorTools();
    await mailer.register(paseo.add("bob-id", { title: "Bob", workspaceId: "w1" }), { name: "bob" });
    const sent = await call("mail_send", { to: ["probe@srv_EntwLoR9srmD", "bob"], subject: "Hi", body: "x" });
    const entries = (sent.structuredContent as { sent: { to: string | null; via: string }[] }).sent;
    expect(entries.map(({ to, via }) => ({ to, via }))).toEqual([
      { to: "bob", via: "bob" },
      { to: "probe@m2-max", via: "probe@srv_EntwLoR9srmD" },
    ]);
  });

  // The reply's Delivery.address is the bare name "probe" (not typed by anyone). Wrong: today's
  // 'probe — use "probe" from now on'; "(via probe)", which names an address that resolves on cantor.
  it("replies to a named remote sender with its address at its host", async () => {
    const { store, call } = await cantorTools();
    await store.create(received("m_0003", FROM_PROBE, "Remote named"));
    const replied = await call("mail_reply", { id: "m_0003", body: "Answer" });
    expect(replied.isError).toBeUndefined();
    expect(replied.text).toMatch(/^Replied: m_\w+ → probe@m2-max — use "probe@m2-max" from now on\n\nUnread: 1$/);
    // Wrong: sent[].to the bare name "probe", which resolves on cantor.
    const sent = (replied.structuredContent as { sent: { to: string | null; via: string }[] }).sent;
    expect(sent.map(({ to, via }) => ({ to, via }))).toEqual([{ to: "probe@m2-max", via: "probe" }]);
  });

  // A nameless remote sender (live on the Mac, so the reply is accepted). Its address agent:<id>@host
  // cannot be mailed (agent:x@host is refused), so no advice. Wrong: today's 'Anon (via agent:Anon-ID)';
  // "(via agent:Anon-ID)", which names a local address; the id lower-cased; advice of any kind.
  it("replies to a nameless remote sender as agent:<id>@host, with no advice", async () => {
    const { mac, store, call } = await cantorTools();
    mac.add("Anon-ID", { title: "Anon" });
    await store.create(received("m_0004", FROM_ANON, "Remote nameless"));
    const replied = await call("mail_reply", { id: "m_0004", body: "Answer" });
    expect(replied.isError).toBeUndefined();
    expect(replied.text).toMatch(/^Replied: m_\w+ → agent:Anon-ID@m2-max\n\nUnread: 1$/);
    expect(replied.text).not.toContain('use "');
    expect(replied.text).not.toMatch(/null|undefined/);
    // Wrong: sent[].to the bare name (null here) instead of the shown address.
    const sent = (replied.structuredContent as { sent: { to: string | null; via: string }[] }).sent;
    expect(sent.map(({ to, via }) => ({ to, via }))).toEqual([{ to: "agent:Anon-ID@m2-max", via: "agent:Anon-ID" }]);
  });
});

describe("mail_directory: remote entries (design step 10)", () => {
  // Wrong: no remote entries (today); a bare "probe" line (mails cantor's own probe); the serverId
  // instead of the label; remote entries merged into data.agents; the local entries changed.
  it("lists each online linked host's published names as name@host, with the host in data", async () => {
    const { call } = await cantorTools();
    const result = await call("mail_directory", {});
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('\n- lead — "Lead"');
    expect(result.text).toContain('\n- probe@m2-max — "Probe"');
    expect(result.text).toContain('\n- scout@attic — "Scout"');
    expect(result.text).not.toMatch(/^- (probe|scout)(?!@)/m);
    expect((result.structuredContent as { agents: unknown }).agents).toEqual(LEAD_AGENTS);
    expect(remoteOf(result)).toEqual([PROBE_ENTRY, SCOUT_ENTRY]);
  });

  // The directory reports the Mac offline while the network still answers it, so only a filter on
  // `online` keeps it out. Wrong: listing every linked host and relying on the call to fail. The
  // attic stays listed, and the Mac returns once it reports online (positive control).
  it("leaves out a host that is not online, and lists it once it is", async () => {
    const { paseo, mailer, call } = await cantorTools();
    const undo = reportHost(paseo, MAC, { online: false });
    await mailer.refreshHosts();
    const mark = paseo.calls.length;
    const offline = await call("mail_directory", {});
    expect(remoteOf(offline)).toEqual([SCOUT_ENTRY]);
    expect(offline.text).not.toContain("probe");
    expect(listed(paseo, mark)).not.toContain(MAC);
    undo();
    await mailer.refreshHosts();
    expect(remoteOf(await call("mail_directory", {}))).toEqual([PROBE_ENTRY, SCOUT_ENTRY]);
  });

  // The directory reports the Mac disabled but online, and the network still answers it, so only a
  // filter on `enabled` keeps it out. Wrong: a filter on `online` alone. Positive control: re-enabled.
  it("leaves out a disabled host, and lists it once it is enabled", async () => {
    const { paseo, mailer, call } = await cantorTools();
    const undo = reportHost(paseo, MAC, { enabled: false, online: true });
    await mailer.refreshHosts();
    const mark = paseo.calls.length;
    const disabled = await call("mail_directory", {});
    expect(remoteOf(disabled)).toEqual([SCOUT_ENTRY]);
    expect(disabled.text).not.toContain("probe");
    expect(listed(paseo, mark)).not.toContain(MAC);
    undo();
    await mailer.refreshHosts();
    expect(remoteOf(await call("mail_directory", {}))).toEqual([PROBE_ENTRY, SCOUT_ENTRY]);
  });

  // One host reads online but its listing throws. The Mac is linked first and the attic last, so
  // faulting each in turn puts the failure before and after the host that answers. Wrong: the whole
  // tool failing; the local entries dropped; no log; the hosts after a failure dropped (killed by
  // the Mac case); the hosts before a failure dropped (killed by the attic case).
  it.each([
    { faulted: MAC, label: "m2-max", kept: SCOUT_ENTRY },
    { faulted: ATTIC, label: "attic", kept: PROBE_ENTRY },
  ])("skips and logs a host whose listing throws ($label), and still returns the rest", async ({ faulted, label, kept }) => {
    const { network, call } = await cantorTools();
    network.fault(faulted, "peerAddresses", true);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await call("mail_directory", {});
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('\n- lead — "Lead"');
    expect((result.structuredContent as { agents: unknown }).agents).toEqual(LEAD_AGENTS);
    expect(remoteOf(result)).toEqual([kept]);
    const logs = error.mock.calls.map((args) => args.map(String).join(" "));
    expect(logs.some((line) => line.startsWith("[paseo-mail]") && (line.includes(faulted) || line.includes(label)))).toBe(true);
  });

  // Exact text, local only (every peer faulted) and both lists. Wrong: the linked-hosts header
  // shown with no remote entry; the local header dropped when remote entries follow.
  it("prints the local section alone, and the linked-hosts section after it", async () => {
    const { network, call } = await cantorTools();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const both = await call("mail_directory", {});
    expect(both.text).toBe('Addresses (mail a name, or role:<role>):\n- lead — "Lead"\n\nOn linked hosts (mail name@host):\n- probe@m2-max — "Probe"\n- scout@attic — "Scout"\n\nUnread: 0');
    network.fault(MAC, "peerAddresses", true);
    network.fault(ATTIC, "peerAddresses", true);
    const localOnly = await call("mail_directory", {});
    expect(localOnly.text).toBe('Addresses (mail a name, or role:<role>):\n- lead — "Lead"\n\nUnread: 0');
  });

  // No local registration and every peer faulted. Wrong: the empty-directory message dropped (an
  // empty text); data missing either list.
  it("says nobody has registered when neither list has an entry", async () => {
    const { network, call } = await cantorTools({ registerLead: false });
    network.fault(MAC, "peerAddresses", true);
    network.fault(ATTIC, "peerAddresses", true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await call("mail_directory", {});
    expect(result.text).toBe("No agent has registered a mail name or role yet.\n\nUnread: 0 (you cannot read mail until you register a name with mail_register)");
    const { agents, remote } = result.structuredContent as { agents: unknown; remote: unknown };
    expect({ agents, remote }).toEqual({ agents: [], remote: [] });
  });

  // The attic also publishes "probe". Two hosts can carry the same name, and name@host tells them
  // apart. Wrong: remote entries deduplicated by name across hosts.
  it("lists the same name on two hosts as two entries", async () => {
    const { attic, call } = await cantorTools();
    publish(attic, "probe2-id", "probe", "Attic Probe");
    const result = await call("mail_directory", {});
    expect(remoteOf(result)).toEqual([{ address: "probe@attic", host: "attic", serverId: ATTIC, title: "Attic Probe" }, PROBE_ENTRY, SCOUT_ENTRY]);
  });

  // A host linked after the mailer started, with no refresh before the call. Wrong: listing from
  // the hosts() snapshot taken at start (the den is missing).
  it("reads the host directory fresh: a host linked after start is listed", async () => {
    const { network, call } = await cantorTools();
    const den = network.host("srv_Den01", "den");
    network.link(CANTOR, "srv_Den01", { label: "den" });
    publish(den, "rook-id", "rook", "Rook");
    const result = await call("mail_directory", {});
    expect(remoteOf(result)).toEqual([PROBE_ENTRY, { address: "rook@den", host: "den", serverId: "srv_Den01", title: "Rook" }, SCOUT_ENTRY]);
  });

  // Every peer listing throws, then the host directory read throws too. Wrong: the tool failing;
  // the local entries dropped.
  it("still returns the local agents when every host fails", async () => {
    const { network, paseo, call } = await cantorTools();
    network.fault(MAC, "peerAddresses", true);
    network.fault(ATTIC, "peerAddresses", true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const peersFail = await call("mail_directory", {});
    expect(peersFail.isError).toBeUndefined();
    expect((peersFail.structuredContent as { agents: unknown }).agents).toEqual(LEAD_AGENTS);
    expect(remoteOf(peersFail)).toEqual([]);
    paseo.hostDirectory = async () => {
      throw new Error("hostDirectory failed");
    };
    const directoryFails = await call("mail_directory", {});
    expect(directoryFails.isError).toBeUndefined();
    expect(directoryFails.text).toContain('\n- lead — "Lead"');
    expect((directoryFails.structuredContent as { agents: unknown }).agents).toEqual(LEAD_AGENTS);
    expect(remoteOf(directoryFails)).toEqual([]);
  });

  // Wrong: today's early return "No agent has registered..." when the local list is empty.
  it("lists remote names when no local agent has registered", async () => {
    const { call } = await cantorTools({ registerLead: false });
    const result = await call("mail_directory", {});
    expect(result.text).toContain('\n- probe@m2-max — "Probe"');
    expect((result.structuredContent as { agents: unknown }).agents).toEqual([]);
    expect(remoteOf(result)).toEqual([PROBE_ENTRY, SCOUT_ENTRY]);
  });

  // The Mac's label "cantor" resolves to cantor itself, so the entry must use the serverId, as
  // mail_list does. Wrong: the link label (probe@cantor mails cantor's own "probe").
  it("uses the same host form as mail_list when a label does not resolve back", async () => {
    const { network, mailer, call } = await cantorTools();
    network.link(CANTOR, MAC, { label: "cantor" });
    await mailer.refreshHosts();
    const result = await call("mail_directory", {});
    expect(result.text).toContain('\n- probe@srv_EntwLoR9srmD — "Probe"');
    expect(result.text).not.toContain("probe@cantor");
    expect(remoteOf(result)).toEqual([{ address: "probe@srv_EntwLoR9srmD", host: "srv_EntwLoR9srmD", serverId: MAC, title: "Probe" }, SCOUT_ENTRY]);
  });
});
