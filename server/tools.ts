import { defineAgentTool, type AgentToolContext, type AgentToolDefinition, type AgentToolResult } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { Delivery, Mailer } from "./mailer";
import { UserError, type Caller, type Mail } from "./types";

export const TOOL_NAMES = ["mail_register", "mail_directory", "mail_send", "mail_list", "mail_read", "mail_reply"];

function caller(context: AgentToolContext): Caller {
  return { id: context.agent.id, workspaceId: context.agent.workspaceId, title: context.agent.title };
}

/** A party on a linked host, as an address that reaches it from here. */
function remoteParty(mailer: Mailer, serverId: string, name: string | null, agentId: string | null, fallback: string): string {
  return `${name ?? (agentId === null ? fallback : `agent:${agentId}`)}@${mailer.hosts().display(serverId)}`;
}

function sender(mailer: Mailer, mail: Mail): string {
  if (mail.from.serverId !== null) return remoteParty(mailer, mail.from.serverId, mail.from.name, mail.from.agentId, "unknown");
  if (mail.from.agentId === null) return mail.from.name ?? "paseo-mail";
  return mail.from.name ?? (mail.from.title ? `"${mail.from.title}" (unregistered)` : `${mail.from.agentId} (unregistered)`);
}

function unreadLine(mailer: Mailer, agentId: string, unread: number): string {
  return mailer.hasName(agentId) ? `Unread: ${unread}` : `Unread: ${unread} (you cannot read mail until you register a name with mail_register)`;
}

const NO_NAME_WARNING = "Note: you have no registered name, so recipients cannot reply to you by alias until you call mail_register { name }.";

/** The recipient as the tools show it: name@host for a remote one, else the name its mail reaches. */
function recipient(mailer: Mailer, d: Delivery): string | null {
  return d.serverId === null ? d.name : remoteParty(mailer, d.serverId, d.name, d.agentId, d.address);
}

/** One line per delivery: prefer the recipient's name once it has one. `typed`: the address came from the caller (a reply's did not). */
function deliveryLine(mailer: Mailer, d: Delivery, typed: boolean): string {
  if (d.serverId !== null) {
    const shown = recipient(mailer, d)!;
    const via = typed && d.address !== shown ? ` (via ${d.address})` : "";
    return `${shown}${via}${d.name ? ` — use "${shown}" from now on` : ""}`;
  }
  const via = d.address !== d.name ? ` (via ${d.address})` : "";
  return `${d.name ?? d.title ?? d.agentId}${via}${d.name ? ` — use "${d.name}" from now on` : ""}`;
}

/** Runs a tool body, appends the caller's unread count, and turns refusals into tool errors. */
async function run(mailer: Mailer, context: AgentToolContext, fn: (me: Caller) => Promise<{ text: string; data?: unknown }>): Promise<AgentToolResult> {
  const me = caller(context);
  try {
    const { text, data } = await fn(me);
    const unread = mailer.unreadCount(me.id);
    const result: AgentToolResult = { text: `${text}\n\n${unreadLine(mailer, me.id, unread)}` };
    if (data !== undefined) result.structuredContent = { ...(data as object), unread };
    return result;
  } catch (error) {
    if (!(error instanceof UserError)) console.error("[paseo-mail] tool failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, text: `${message}\n\n${unreadLine(mailer, me.id, mailer.unreadCount(me.id))}` };
  }
}

export function mailTools(mailer: Mailer): AgentToolDefinition[] {
  return [
    defineAgentTool({
      name: "mail_register",
      title: "Register a mail name and roles",
      description:
        "Paseo Mail: claim the address other agents use to mail you. `name` is unique across agents (a-z, 0-9, '.', '_', '-'); `roles` can be shared, and mail to `role:<role>` reaches every holder. You MUST register a name before you can read your mail. Given fields replace your current ones; `name: \"\"` releases your name, `roles: []` clears your roles. Call with no arguments to see your registration.",
      input: z.object({
        name: z.string().optional().describe("Your unique mail name, or \"\" to release it"),
        roles: z.array(z.string()).optional().describe("Roles you hold; replaces the current list"),
      }),
      execute: (input, context) =>
        run(mailer, context, async (me) => {
          const entry = await mailer.register(me, input);
          if (!entry) return { text: "You are not registered: other agents cannot mail you until you claim a name or a role.", data: { registration: null } };
          const roles = entry.roles.length ? entry.roles.map((role) => `role:${role}`).join(", ") : "none";
          return { text: `Registered. Name: ${entry.name ?? "none"}. Roles: ${roles}.`, data: { registration: { name: entry.name, roles: entry.roles } } };
        }),
    }),
    defineAgentTool({
      name: "mail_directory",
      title: "List mail addresses",
      description: "Paseo Mail: list the names and roles live agents have registered, to find who to mail, and the name@host addresses published on linked hosts.",
      input: z.object({}),
      execute: (_input, context) =>
        run(mailer, context, async () => {
          const [entries, remote] = await Promise.all([mailer.directory(), mailer.remoteDirectory()]);
          if (entries.length === 0 && remote.length === 0) return { text: "No agent has registered a mail name or role yet.", data: { agents: [], remote: [] } };
          const lines = entries.map(({ registration, agent }) => {
            const roles = registration.roles.length ? ` roles: ${registration.roles.join(", ")}` : "";
            return `- ${registration.name ?? "(no name)"}${roles}${agent.title ? ` — "${agent.title}"` : ""}`;
          });
          const remoteLines = remote.map((entry) => `- ${entry.address}${entry.title ? ` — "${entry.title}"` : ""}`);
          const sections = lines.length > 0 ? [`Addresses (mail a name, or role:<role>):\n${lines.join("\n")}`] : [];
          if (remoteLines.length > 0) sections.push(`On linked hosts (mail name@host):\n${remoteLines.join("\n")}`);
          return {
            text: sections.join("\n\n"),
            data: {
              agents: entries.map(({ registration, agent }) => ({ name: registration.name, roles: registration.roles, title: agent.title, workspaceId: registration.workspaceId })),
              remote,
            },
          };
        }),
    }),
    defineAgentTool({
      name: "mail_send",
      title: "Send mail",
      description:
        "Paseo Mail: send mail to other agents instead of interrupting them. `to` is a registered name, `role:<role>`, or `agent:<agent id>` for a live agent that has not registered (e.g. a child you just created), `name@host` for an agent on a linked host (see mail_directory), or a list of them (see mail_directory). A role reaches its holders in your workspace, else your project, else anywhere. The recipient is told once it is idle, never in the middle of a turn.",
      input: z.object({
        to: z.union([z.string(), z.array(z.string()).min(1)]).describe("A name, role:<role>, agent:<agent id>, or a list of them"),
        subject: z.string().min(1),
        body: z.string(),
      }),
      execute: (input, context) =>
        run(mailer, context, async (me) => {
          const deliveries = await mailer.send(me, Array.isArray(input.to) ? input.to : [input.to], input.subject.trim(), input.body);
          const lines = deliveries.map((d) => `- ${d.mailId} → ${deliveryLine(mailer, d, true)}`);
          const warning = mailer.hasName(me.id) ? "" : `\n${NO_NAME_WARNING}`;
          return { text: `Sent ${deliveries.length} mail${deliveries.length === 1 ? "" : "s"}:\n${lines.join("\n")}${warning}`, data: { sent: deliveries.map((d) => ({ id: d.mailId, to: recipient(mailer, d), via: d.address })) } };
        }),
    }),
    defineAgentTool({
      name: "mail_list",
      title: "List your mail",
      description: "Paseo Mail: list your mailbox, newest first (headers only; use mail_read for a body). Requires a registered name (mail_register) first. Check it when you start work and when told you have unread mail.",
      input: z.object({
        unread_only: z.boolean().optional().describe("Only unread mail (default false)"),
        limit: z.number().int().min(1).max(200).optional().describe("Most mails to list (default 20)"),
      }),
      execute: (input, context) =>
        run(mailer, context, async (me) => {
          mailer.requireName(me.id);
          const mails = mailer.list(me.id, { unreadOnly: input.unread_only, limit: input.limit });
          if (mails.length === 0) return { text: input.unread_only ? "No unread mail." : "Your mailbox is empty.", data: { mails: [] } };
          const lines = mails.map((m) => `- ${m.readAt ? " " : "*"} ${m.id} ${m.createdAt} from ${sender(mailer, m)}: ${m.subject}`);
          return {
            text: `Mail (* = unread):\n${lines.join("\n")}`,
            data: { mails: mails.map((m) => ({ id: m.id, from: sender(mailer, m), subject: m.subject, createdAt: m.createdAt, read: m.readAt !== null, threadId: m.threadId })) },
          };
        }),
    }),
    defineAgentTool({
      name: "mail_read",
      title: "Read a mail",
      description: "Paseo Mail: read one of your mails in full, and mark it read. Requires a registered name (mail_register) first.",
      input: z.object({ id: z.string().min(1) }),
      execute: (input, context) =>
        run(mailer, context, async (me) => {
          mailer.requireName(me.id);
          const m = await mailer.read(me.id, input.id);
          const text = [`From: ${sender(mailer, m)}`, `To: ${m.to.address}`, `Date: ${m.createdAt}`, `Subject: ${m.subject}`, `Id: ${m.id} (thread ${m.threadId})`, "", m.body].join("\n");
          return { text, data: { mail: { id: m.id, threadId: m.threadId, inReplyTo: m.inReplyTo, from: sender(mailer, m), subject: m.subject, body: m.body, createdAt: m.createdAt } } };
        }),
    }),
    defineAgentTool({
      name: "mail_reply",
      title: "Reply to a mail",
      description: "Paseo Mail: reply to the sender of one of your mails, in the same thread. Once a recipient has a name, use it instead of agent:<id>; a recipient on a linked host is shown as name@host.",
      input: z.object({ id: z.string().min(1), body: z.string() }),
      execute: (input, context) =>
        run(mailer, context, async (me) => {
          const d = await mailer.reply(me, input.id, input.body);
          return { text: `Replied: ${d.mailId} → ${deliveryLine(mailer, d, false)}${mailer.hasName(me.id) ? "" : `\n${NO_NAME_WARNING}`}`, data: { sent: [{ id: d.mailId, to: recipient(mailer, d), via: d.address }] } };
        }),
    }),
  ];
}
