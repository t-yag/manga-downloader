import {
  type ChatInputCommandInteraction,
  type Client,
  SlashCommandBuilder,
  REST,
  Routes,
} from "discord.js";
import { db, schema } from "../../db/index.js";
import { eq, and, like, or } from "drizzle-orm";
import {
  getVolumeSummary,
} from "../../services/library.js";
import { logger } from "../../logger.js";
import { getSettingValue } from "../../api/routes/settings.js";

const log = logger.child({ module: "DiscordCommands" });

// ─── Command definitions ───────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName("ls")
    .setDescription("ライブラリ一覧を表示")
    .addStringOption((o) => o.setName("search").setDescription("タイトル/著者で検索"))
    .addStringOption((o) => o.setName("plugin").setDescription("プラグインで絞込"))
    .addIntegerOption((o) => o.setName("limit").setDescription("表示件数").setMinValue(1).setMaxValue(20)),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("キュー状態を表示"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("コマンド一覧を表示"),
];

export async function registerCommands(client: Client<true>): Promise<void> {
  const token = getSettingValue<string>("discord.botToken");
  if (!token) throw new Error("discord.botToken is not set");

  const channelId = getSettingValue<string>("discord.channelId");
  if (!channelId) throw new Error("discord.channelId is not set");

  const channel = await client.channels.fetch(channelId);
  if (!channel || !("guildId" in channel) || !channel.guildId) {
    throw new Error(`Channel ${channelId} is not a guild channel`);
  }

  const rest = new REST().setToken(token);

  await rest.put(Routes.applicationGuildCommands(client.user.id, channel.guildId), {
    body: commands.map((c) => c.toJSON()),
  });

  log.info(`Registered ${commands.length} guild slash commands for guild ${channel.guildId}`);
}

// ─── Command handler ───────────────────────────────────────────────────

export async function handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    switch (interaction.commandName) {
      case "ls":
        await handleLs(interaction);
        break;
      case "status":
        await handleStatus(interaction);
        break;
      case "help":
        await handleHelp(interaction);
        break;
      default:
        await interaction.reply({ content: "不明なコマンドです", ephemeral: true });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(error, `Command /${interaction.commandName} failed: ${msg}`);
    const reply = interaction.replied || interaction.deferred
      ? interaction.followUp.bind(interaction)
      : interaction.reply.bind(interaction);
    await reply({ content: `エラー: ${msg}`, ephemeral: true }).catch(() => {});
  }
}

// ─── /ls ───────────────────────────────────────────────────────────────

async function handleLs(interaction: ChatInputCommandInteraction): Promise<void> {
  const search = interaction.options.getString("search");
  const pluginFilter = interaction.options.getString("plugin");
  const limit = interaction.options.getInteger("limit") ?? 10;

  const conditions = [];
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(or(like(schema.library.title, pattern), like(schema.library.author, pattern)));
  }
  if (pluginFilter) {
    conditions.push(eq(schema.library.pluginId, pluginFilter));
  }

  const where = conditions.length > 1 ? and(...conditions) : conditions[0];
  const titles = db
    .select()
    .from(schema.library)
    .where(where)
    .limit(limit)
    .all();

  const total = db
    .select({ id: schema.library.id })
    .from(schema.library)
    .all().length;

  if (titles.length === 0) {
    await interaction.reply("ライブラリは空です");
    return;
  }

  const lines = [`**ライブラリ** (${titles.length}/${total}件表示)`, "───────────────────"];
  for (let i = 0; i < titles.length; i++) {
    const t = titles[i];
    const summary = getVolumeSummary(t.id);
    const parts = [`DL: ${summary.done}`];
    if (summary.available > 0) parts.push(`可: ${summary.available}`);
    if (summary.unavailable > 0) parts.push(`不可: ${summary.unavailable}`);
    if (summary.queued + summary.downloading > 0) parts.push(`処理中: ${summary.queued + summary.downloading}`);
    lines.push(`${i + 1}. **${t.title}** [${t.pluginId}] ${summary.total}巻 (${parts.join(" / ")})`);
  }

  await interaction.reply(lines.join("\n"));
}

// ─── /status ───────────────────────────────────────────────────────────

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const running = db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.status, "running"))
    .all();

  const pending = db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.status, "pending"))
    .all();

  const lines = ["**キュー状態**", "───────────────────"];
  lines.push(`実行中: ${running.length}件`);
  lines.push(`待機中: ${pending.length}件`);

  if (running.length > 0) {
    lines.push("", "**実行中のジョブ:**");
    for (const job of running) {
      let detail = `#${job.id} [${job.pluginId}]`;
      if (job.volumeId) {
        const vol = db.select().from(schema.volumes).where(eq(schema.volumes.id, job.volumeId)).get();
        if (vol?.libraryId) {
          const lib = db.select({ title: schema.library.title }).from(schema.library).where(eq(schema.library.id, vol.libraryId)).get();
          if (lib) detail += ` ${lib.title} ${vol.volumeNum}巻`;
        }
      }
      const progress = job.progress ? ` (${Math.round((job.progress ?? 0) * 100)}%)` : "";
      lines.push(`  ${detail}${progress}`);
    }
  }

  await interaction.reply(lines.join("\n"));
}

// ─── /help ─────────────────────────────────────────────────────────────

async function handleHelp(interaction: ChatInputCommandInteraction): Promise<void> {
  const lines = [
    "**manga-downloader Bot**",
    "───────────────────",
    "**URL投稿**:",
    "  巻URL → 登録・同期・その巻をDL",
    "  タイトルURL → 登録・同期のみ（単巻作品は自動DL）",
    "",
    "**コマンド:**",
    "`/ls [search] [plugin] [limit]` — ライブラリ一覧",
    "`/status` — キュー状態",
    "`/help` — このヘルプ",
  ];
  await interaction.reply(lines.join("\n"));
}

