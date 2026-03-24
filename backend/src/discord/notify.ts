import { EmbedBuilder, type Message } from "discord.js";
import { sendToChannel } from "./bot.js";
import { logger } from "../logger.js";

const log = logger.child({ module: "DiscordNotify" });

// ─── Colors ────────────────────────────────────────────────────────────

const COLOR_SUCCESS = 0x57f287; // green
const COLOR_ERROR = 0xed4245;   // red

// ─── Pending reply tracking ─────────────────────────────────────────────
// Maps volumeId → the bot's reply message so it can be edited on completion.

const pendingReplies = new Map<number, Message>();

export function trackPendingReply(volumeId: number, message: Message): void {
  pendingReplies.set(volumeId, message);
}

export async function resolvePendingReply(
  volumeId: number,
  result: { success: true; filePath?: string; fileSize?: number } | { success: false; error: string },
): Promise<void> {
  const reply = pendingReplies.get(volumeId);
  if (!reply) return;
  pendingReplies.delete(volumeId);

  try {
    const original = reply.embeds[0];
    const embed = EmbedBuilder.from(original);

    // Remove the old status field
    const fields = (original.fields ?? []).filter((f) => f.name !== "\u30B9\u30C6\u30FC\u30BF\u30B9");

    if (result.success) {
      embed.setColor(COLOR_SUCCESS);
      fields.push({ name: "\u30B9\u30C6\u30FC\u30BF\u30B9", value: "\u2705 \u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u5B8C\u4E86", inline: true });
      if (result.fileSize) {
        const size = result.fileSize < 1024 * 1024
          ? `${(result.fileSize / 1024).toFixed(0)}KB`
          : `${(result.fileSize / 1024 / 1024).toFixed(1)}MB`;
        fields.push({ name: "\uD83D\uDCE6 \u30B5\u30A4\u30BA", value: size, inline: true });
      }
    } else {
      embed.setColor(COLOR_ERROR);
      fields.push({ name: "\u30B9\u30C6\u30FC\u30BF\u30B9", value: `\u274C \u5931\u6557: ${result.error}`, inline: false });
    }

    embed.setFields(fields);
    await reply.edit({ embeds: [embed] });
  } catch (e) {
    log.warn(`Failed to edit pending reply for volume ${volumeId}: ${e}`);
  }
}

// ─── Public notification functions ─────────────────────────────────────

export async function notifyDownloadError(info: {
  title: string;
  volume: number;
  unit?: string;
  plugin: string;
  error: string;
}): Promise<void> {
  const unitLabel = info.unit === "ep" ? "話" : "巻";

  const embed = new EmbedBuilder()
    .setColor(COLOR_ERROR)
    .setTitle(`[${info.plugin}] ダウンロード失敗`)
    .setDescription(`${info.title} ${info.volume}${unitLabel}`)
    .addFields({ name: "エラー", value: `\`\`\`${info.error}\`\`\`` });

  const sent = await sendToChannel({ embeds: [embed.toJSON()] });
  if (!sent) log.debug("Bot not running, skipped download error notification");
}

interface CompletedVolume {
  title: string;
  volume: number;
  unit: string;
  filePath?: string;
}

interface FailedVolume {
  title: string;
  volume: number;
  unit: string;
  error: string;
}

export async function notifyQueueEmpty(stats: {
  completed: CompletedVolume[];
  failed: FailedVolume[];
}): Promise<void> {
  const total = stats.completed.length + stats.failed.length;
  if (total === 0) return;

  const hasFailed = stats.failed.length > 0;

  // Group completed by title
  const byTitle = new Map<string, CompletedVolume[]>();
  for (const v of stats.completed) {
    const list = byTitle.get(v.title) ?? [];
    list.push(v);
    byTitle.set(v.title, list);
  }

  const embed = new EmbedBuilder()
    .setColor(hasFailed ? COLOR_ERROR : COLOR_SUCCESS)
    .setTitle("ダウンロードが完了しました");

  if (hasFailed) {
    embed.setDescription(`${stats.completed.length}/${total}成功 (${stats.failed.length}件失敗)`);
  } else if (total > 1) {
    embed.setDescription(`${total}件すべて成功`);
  }

  const fields: { name: string; value: string }[] = [];

  for (const [title, vols] of byTitle) {
    const unitLabel = vols[0].unit === "ep" ? "話" : "巻";
    const volNums = vols.map((v) => v.volume).sort((a, b) => a - b);
    const volStr = volNums.length <= 5
      ? volNums.map((n) => `${n}${unitLabel}`).join(", ")
      : `${volNums[0]}-${volNums[volNums.length - 1]}${unitLabel} (${volNums.length}冊)`;

    let value = volStr;
    if (vols[0].filePath) {
      const dir = vols[0].filePath.replace(/\/[^/]+$/, "/");
      value += `\n\`${dir}\``;
    }
    fields.push({ name: `✅ ${title}`, value });
  }

  for (const v of stats.failed) {
    const unitLabel = v.unit === "ep" ? "話" : "巻";
    fields.push({
      name: `❌ ${v.title} ${v.volume}${unitLabel}`,
      value: `\`\`\`${v.error}\`\`\``,
    });
  }

  if (fields.length > 0) embed.addFields(fields);

  const sent = await sendToChannel({ embeds: [embed.toJSON()] });
  if (!sent) log.debug("Bot not running, skipped queue-empty notification");
}
