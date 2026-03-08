import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { runOrchestration } from "../orchestrator/loop.js";
import { saveTask, toStored } from "../storage/store.js";
import { loadConfig, getConfigForChannel } from "../storage/config.js";
import { loadAndApplyModelsConfig } from "../storage/models-config.js";
import { v4 as uuidv4 } from "uuid";

function extractTaskFromEmail(subject: string, body: string): string | null {
  const subj = subject.trim();
  const bodyMatch = body.match(/(?:^|\n)\s*task\s*[:-]\s*(.+?)(?:\n|$)/i) ?? body.match(/(?:^|\n)\s*task\s+(.+?)(?:\n|$)/i);
  if (bodyMatch) return bodyMatch[1].trim();
  if (/^task\s+/i.test(subj)) return subj.replace(/^task\s+/i, "").trim();
  if (/^task\s*[:-]/i.test(subj)) return subj.replace(/^task\s*[:-]\s*/i, "").trim();
  return null;
}

export async function startEmailConnector(): Promise<void> {
  const imapHost = process.env.EMAIL_IMAP_HOST;
  const imapUser = process.env.EMAIL_IMAP_USER;
  const imapPass = process.env.EMAIL_IMAP_PASS;
  const smtpHost = process.env.EMAIL_SMTP_HOST ?? imapHost;
  const smtpUser = process.env.EMAIL_SMTP_USER ?? imapUser;
  const smtpPass = process.env.EMAIL_SMTP_PASS ?? imapPass;
  const pollInterval = parseInt(process.env.EMAIL_POLL_INTERVAL ?? "60", 10) * 1000;

  if (!imapHost || !imapUser || !imapPass) {
    throw new Error("EMAIL_IMAP_HOST, EMAIL_IMAP_USER, EMAIL_IMAP_PASS are required for the email connector.");
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: parseInt(process.env.EMAIL_SMTP_PORT ?? "587", 10),
    secure: process.env.EMAIL_SMTP_SECURE === "true",
    auth: smtpUser && smtpPass ? { user: smtpUser, pass: smtpPass } : undefined,
  });

  const processMailbox = async (): Promise<void> => {
    const client = new ImapFlow({
      host: imapHost,
      port: parseInt(process.env.EMAIL_IMAP_PORT ?? "993", 10),
      secure: process.env.EMAIL_IMAP_SECURE !== "false",
      auth: { user: imapUser, pass: imapPass },
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        for await (const msg of client.fetch({ seen: false }, { envelope: true, source: true })) {
          const envelope = msg.envelope;
          const subject = envelope?.subject ?? "";
          const source = msg.source;
          const body = source?.toString() ?? "";
          const textBody = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

          const description = extractTaskFromEmail(subject, textBody);
          if (!description) continue;

          const fromAddr = envelope?.from?.[0]?.address ?? "unknown";
          await loadAndApplyModelsConfig();
          const cfg = getConfigForChannel(await loadConfig(), "email");
          const qualityProfile = (cfg.qualityProfile ?? "balanced") as "fast" | "balanced" | "max";
          const approvalPolicy = cfg.approvalPolicy ?? "auto";
          const taskId = uuidv4();

          await saveTask(toStored({
            id: taskId,
            description,
            source: "cli",
            sourceId: `email:${fromAddr}`,
            qualityProfile,
            approvalPolicy,
            status: "in_progress",
          }));

          try {
            const result = await runOrchestration({
              taskId,
              taskDescription: description,
              qualityProfile,
              approvalPolicy,
              modelOverrides: cfg.modelOverrides,
              profileRoles: cfg.profileRoles,
              customAgents: cfg.agents,
            });

            const outputsRecord = Object.fromEntries(result.outputs);
            await saveTask(toStored({
              id: result.taskId,
              description,
              source: "cli",
              sourceId: `email:${fromAddr}`,
              qualityProfile,
              approvalPolicy,
              status: result.status,
              plan: result.plan,
            }, {
              completedAt: new Date().toISOString(),
              error: result.error,
              outputs: outputsRecord,
              usage: result.usage,
              usageByModel: result.usageByModel,
            }));

            const builderOut = result.outputs.get("builder");
            const replyBody = result.status === "completed" && builderOut
              ? `Task completed.\n\n--- Deliverable ---\n\n${builderOut}`
              : result.status === "failed"
                ? `Task failed: ${result.error ?? "Unknown error"}`
                : `Task ${result.status}: ${result.error ?? ""}`;

            await transporter.sendMail({
              from: process.env.EMAIL_FROM ?? imapUser,
              to: fromAddr,
              subject: `Re: ${subject}`,
              text: `Skate — ${replyBody}\n\nTask ID: ${result.taskId}`,
            });
            await client.messageFlagsAdd([msg.uid], ["\\Seen"], { uid: true });
          } catch (e) {
            await saveTask(toStored({
              id: taskId,
              description,
              source: "cli",
              sourceId: `email:${fromAddr}`,
              qualityProfile,
              approvalPolicy,
              status: "failed",
            }, {
              error: e instanceof Error ? e.message : String(e),
              completedAt: new Date().toISOString(),
            }));
            await transporter.sendMail({
              from: process.env.EMAIL_FROM ?? imapUser,
              to: fromAddr,
              subject: `Re: ${subject}`,
              text: `Skate — Error: ${e instanceof Error ? e.message : String(e)}`,
            });
            await client.messageFlagsAdd([msg.uid], ["\\Seen"], { uid: true }).catch(() => {});
          }
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (e) {
      console.error("Email connector error:", e instanceof Error ? e.message : String(e));
    }
  };

  console.log("Email connector: polling INBOX every " + pollInterval / 1000 + "s");
  await processMailbox();
  setInterval(processMailbox, pollInterval);
}
