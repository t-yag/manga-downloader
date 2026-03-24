import {
  type Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  ComponentType,
  EmbedBuilder,
} from "discord.js";
import { registry } from "../../plugins/registry.js";
import {
  resolveAccountId,
  registerTitle,
  syncTitle,
  findVolume,
  queueSingleDownload,
  getVolumeSummary,
} from "../../services/library.js";
import { trackPendingReply } from "../notify.js";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import { logger } from "../../logger.js";

const log = logger.child({ module: "DiscordUrlHandler" });

// ─── Colors ─────────────────────────────────────────────────────────────

const COLOR_SUCCESS = 0x57f287; // green
const COLOR_INFO = 0x5865f2;    // blurple
const COLOR_WARN = 0xfee75c;    // yellow
const COLOR_ERROR = 0xed4245;   // red

// Match URLs in message text
const URL_REGEX = /https?:\/\/[^\s<>]+/g;

export async function handleUrlMessage(message: Message): Promise<void> {
  const urls = message.content.match(URL_REGEX);
  if (!urls) return;

  // Try each URL - process the first one that a plugin can handle
  for (const url of urls) {
    let parsed;
    try {
      parsed = registry.parseUrl(url);
    } catch {
      continue; // Not a supported URL
    }

    log.info(`URL detected: ${parsed.pluginId}/${parsed.titleId} (type=${parsed.type}, vol=${parsed.volume}) from ${url}`);

    // React to show we're processing
    await message.react("\u23F3").catch(() => {});

    try {
      const accountId = resolveAccountId(parsed.pluginId);

      // Register or find existing
      const registerResult = await registerTitle(parsed.pluginId, parsed.titleId);
      const action = registerResult.alreadyExisted ? "synced" : "created";

      // Sync
      let syncResult;
      try {
        syncResult = await syncTitle(registerResult.libraryId, accountId);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(error, `Sync failed: ${msg}`);
        await reactDone(message, "\u274C");
        const embed = new EmbedBuilder()
          .setColor(COLOR_ERROR)
          .setTitle("\u540C\u671F\u5931\u6557")
          .setDescription(msg);
        await message.reply({ embeds: [embed] });
        return;
      }

      // Get cover URL for embeds
      const lib = db.select().from(schema.library).where(eq(schema.library.id, registerResult.libraryId)).get();
      const coverUrl = lib?.coverUrl ?? null;

      // Determine target volume
      const summary = getVolumeSummary(registerResult.libraryId);
      const isSingleVolume = summary.total === 1;
      const targetVolumeNum = parsed.type === "volume" || parsed.type === "reader"
        ? parsed.volume
        : isSingleVolume
          ? getOnlyVolumeNum(registerResult.libraryId)
          : null;

      if (targetVolumeNum != null) {
        await handleSingleVolume(
          message, registerResult.libraryId, registerResult.title,
          targetVolumeNum, accountId, action, syncResult.newVolumes, coverUrl,
        );
      } else {
        await handleTitleOnly(
          message, registerResult.libraryId, registerResult.title,
          action, syncResult.newVolumes, summary, coverUrl,
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(error, `URL handling failed: ${msg}`);
      await reactDone(message, "\u274C");
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setTitle("\u51E6\u7406\u5931\u6557")
        .setDescription(msg);
      await message.reply({ embeds: [embed] });
    }

    return; // Only process first matching URL
  }
}

// ─── Single volume handling ─────────────────────────────────────────────

async function handleSingleVolume(
  message: Message,
  libraryId: number,
  title: string,
  volumeNum: number,
  accountId: number | null,
  action: "created" | "synced",
  newVolumes: number,
  coverUrl: string | null,
): Promise<void> {
  const info = findVolume(libraryId, volumeNum);
  if (!info) {
    await reactDone(message, "\u274C");
    const embed = new EmbedBuilder()
      .setColor(COLOR_ERROR)
      .setDescription(`**${title}** \u2014 ${volumeNum}\u5DFB\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093`);
    await message.reply({ embeds: [embed] });
    return;
  }

  const vol = info.volume;
  const unitLabel = vol.unit === "ep" ? "\u8A71" : "\u5DFB";
  const volLabel = `${volumeNum}${unitLabel}`;

  switch (vol.status) {
    case "available":
    case "error": {
      const jobId = await queueSingleDownload(vol.id, accountId, { source: "discord" });
      if (jobId) {
        await reactDone(message, "\u2705");
        const embed = new EmbedBuilder()
          .setColor(COLOR_WARN)
          .setTitle(`${title} ${volLabel}`)
          .setDescription(buildSubtitle(action, newVolumes))
          .addFields({ name: "\u30B9\u30C6\u30FC\u30BF\u30B9", value: "\u23F3 \u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u4E2D\u2026", inline: true });
        if (coverUrl) embed.setThumbnail(coverUrl);
        const reply = await message.reply({ embeds: [embed] });
        trackPendingReply(vol.id, reply);
      } else {
        await reactDone(message, "\u274C");
        const embed = new EmbedBuilder()
          .setColor(COLOR_ERROR)
          .setDescription(`**${title}** ${volLabel} \u2014 \u30AD\u30E5\u30FC\u306B\u8FFD\u52A0\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F`);
        await message.reply({ embeds: [embed] });
      }
      break;
    }

    case "done": {
      await reactDone(message, "\u2705");

      const embed = new EmbedBuilder()
        .setColor(COLOR_INFO)
        .setTitle(`${title} ${volLabel}`)
        .setDescription("\u2728 DL\u6E08\u307F");
      if (coverUrl) embed.setThumbnail(coverUrl);

      const fields: { name: string; value: string; inline: boolean }[] = [];
      if (vol.downloadedAt) fields.push({ name: "\uD83D\uDCC5 \u65E5\u4ED8", value: formatDate(vol.downloadedAt), inline: true });
      if (vol.fileSize) fields.push({ name: "\uD83D\uDCE6 \u30B5\u30A4\u30BA", value: formatFileSize(vol.fileSize), inline: true });
      if (fields.length > 0) embed.addFields(fields);
      if (vol.filePath) embed.addFields({ name: "\uD83D\uDCC2 \u30D1\u30B9", value: `\`${vol.filePath}\``, inline: false });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`redownload:${vol.id}`)
          .setLabel("\u518D\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9")
          .setEmoji("\uD83D\uDD04")
          .setStyle(ButtonStyle.Secondary),
      );

      const reply = await message.reply({ embeds: [embed], components: [row] });

      // Listen for button click (5 minutes)
      const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 5 * 60 * 1000,
      });

      collector.on("collect", async (i: ButtonInteraction) => {
        if (!i.customId.startsWith("redownload:")) return;
        const targetVolId = Number(i.customId.split(":")[1]);

        db.update(schema.volumes)
          .set({ status: "available" })
          .where(eq(schema.volumes.id, targetVolId))
          .run();

        const jobId = await queueSingleDownload(targetVolId, accountId, { source: "discord" });

        const updatedEmbed = EmbedBuilder.from(embed).setFields([]);
        if (jobId) {
          updatedEmbed.setColor(COLOR_WARN).setDescription("\u23F3 \u518D\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u4E2D\u2026");
          await i.update({ embeds: [updatedEmbed], components: [] });
          trackPendingReply(targetVolId, reply);
        } else {
          updatedEmbed.setColor(COLOR_ERROR).setDescription("\u274C \u518D\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u306B\u5931\u6557\u3057\u307E\u3057\u305F");
          await i.update({ embeds: [updatedEmbed], components: [] });
        }
      });

      collector.on("end", () => {
        reply.edit({ components: [] }).catch(() => {});
      });
      break;
    }

    case "queued":
    case "downloading": {
      const statusLabel = vol.status === "queued" ? "\u5F85\u6A5F\u4E2D" : "DL\u4E2D";
      await reactDone(message, "\u23F3");
      const embed = new EmbedBuilder()
        .setColor(COLOR_WARN)
        .setTitle(`${title} ${volLabel}`)
        .setDescription(`\u23F3 \u73FE\u5728${statusLabel}\u3067\u3059`);
      if (coverUrl) embed.setThumbnail(coverUrl);
      await message.reply({ embeds: [embed] });
      break;
    }

    case "unavailable": {
      const reason = vol.availabilityReason === "not_purchased" ? "\uFF08\u672A\u8CFC\u5165\uFF09" : "";
      await reactDone(message, "\u274C");
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setTitle(`${title} ${volLabel}`)
        .setDescription(`\u274C \u5229\u7528\u3067\u304D\u307E\u305B\u3093${reason}`);
      if (coverUrl) embed.setThumbnail(coverUrl);
      await message.reply({ embeds: [embed] });
      break;
    }

    default: {
      await reactDone(message, "\u2753");
      const embed = new EmbedBuilder()
        .setColor(COLOR_WARN)
        .setTitle(`${title} ${volLabel}`)
        .setDescription("\u2753 \u307E\u3060\u78BA\u8A8D\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002\u30BF\u30A4\u30C8\u30EBURL\u3092\u518D\u5EA6\u6295\u7A3F\u3057\u3066\u540C\u671F\u3057\u3066\u304F\u3060\u3055\u3044");
      if (coverUrl) embed.setThumbnail(coverUrl);
      await message.reply({ embeds: [embed] });
    }
  }
}

// ─── Title-only handling (multi-volume, no download) ────────────────────

async function handleTitleOnly(
  message: Message,
  libraryId: number,
  title: string,
  action: "created" | "synced",
  newVolumes: number,
  summary: ReturnType<typeof getVolumeSummary>,
  coverUrl: string | null,
): Promise<void> {
  await reactDone(message, "\u2705");

  const embed = new EmbedBuilder()
    .setColor(COLOR_INFO)
    .setTitle(title)
    .setDescription(buildSubtitle(action, newVolumes));
  if (coverUrl) embed.setThumbnail(coverUrl);

  const fields: { name: string; value: string; inline: boolean }[] = [];
  if (summary.total > 0) fields.push({ name: "\u5168\u5DFB", value: `${summary.total}`, inline: true });
  if (summary.done > 0) fields.push({ name: "DL\u6E08", value: `${summary.done}`, inline: true });
  if (summary.available > 0) fields.push({ name: "DL\u53EF", value: `${summary.available}`, inline: true });
  if (summary.unavailable > 0) fields.push({ name: "\u672A\u8CFC\u5165", value: `${summary.unavailable}`, inline: true });
  if (summary.queued + summary.downloading > 0) fields.push({ name: "\u51E6\u7406\u4E2D", value: `${summary.queued + summary.downloading}`, inline: true });
  if (fields.length > 0) embed.addFields(fields);

  if (summary.available > 0) {
    embed.setFooter({ text: "DL\u3059\u308B\u5834\u5408\u306F\u5DFB\u306EURL\u3092\u8CBC\u3063\u3066\u304F\u3060\u3055\u3044" });
  }

  await message.reply({ embeds: [embed] });
}

// ─── Helpers ────────────────────────────────────────────────────────────

function buildSubtitle(action: "created" | "synced", newVolumes: number): string {
  if (action === "created") return "\u2705 \u30E9\u30A4\u30D6\u30E9\u30EA\u306B\u767B\u9332\u3057\u307E\u3057\u305F";
  if (newVolumes > 0) return `\uD83D\uDCDA \u65B0\u3057\u304F${newVolumes}\u5DFB\u8FFD\u52A0\u3055\u308C\u307E\u3057\u305F`;
  return "\uD83D\uDD04 \u540C\u671F\u5B8C\u4E86";
}

function getOnlyVolumeNum(libraryId: number): number | null {
  const vol = db
    .select({ volumeNum: schema.volumes.volumeNum })
    .from(schema.volumes)
    .where(eq(schema.volumes.libraryId, libraryId))
    .limit(1)
    .get();
  return vol?.volumeNum ?? null;
}

async function reactDone(message: Message, emoji: string): Promise<void> {
  await message.reactions.removeAll().catch(() => {});
  await message.react(emoji).catch(() => {});
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
