import {
  Client,
  GatewayIntentBits,
  Events,
  type Message,
  type Interaction,
} from "discord.js";
import { logger } from "../logger.js";
import { getSettingValue } from "../api/routes/settings.js";
import { handleUrlMessage } from "./handlers/url-handler.js";
import { handleSlashCommand, registerCommands } from "./handlers/command-handler.js";

const log = logger.child({ module: "DiscordBot" });

let client: Client | null = null;
let notifyChannelId: string | null = null;

export async function startDiscordBot(): Promise<void> {
  const token = getSettingValue<string>("discord.botToken");
  const channelId = getSettingValue<string>("discord.channelId");
  const enabled = getSettingValue<boolean>("discord.botEnabled") ?? false;

  if (!enabled) {
    log.info("Discord bot is disabled");
    return;
  }
  if (!token) {
    log.warn("discord.botToken not set, skipping bot startup");
    return;
  }
  if (!channelId) {
    log.warn("discord.channelId not set, skipping bot startup");
    return;
  }

  notifyChannelId = channelId;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, async (c) => {
    log.info(`Discord bot logged in as ${c.user.tag}`);
    try {
      await registerCommands(c);
    } catch (e) {
      log.error(e, "Failed to register slash commands");
    }
  });

  // URL message handler
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (message.channelId !== channelId) return;
    await handleUrlMessage(message);
  });

  // Slash command handler
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.channelId !== channelId) {
      await interaction.reply({
        content: "このチャンネルではコマンドを使用できません",
        ephemeral: true,
      });
      return;
    }
    await handleSlashCommand(interaction);
  });

  await client.login(token);
}

export async function stopDiscordBot(): Promise<void> {
  if (client) {
    client.destroy();
    client = null;
    notifyChannelId = null;
    log.info("Discord bot stopped");
  }
}

/**
 * Send a message to the configured Discord channel via the Bot client.
 * Returns false if the bot is not running.
 */
export async function sendToChannel(options: {
  content?: string;
  embeds?: unknown[];
}): Promise<boolean> {
  if (!client || !notifyChannelId) return false;

  try {
    const channel = await client.channels.fetch(notifyChannelId);
    if (!channel || !("send" in channel)) return false;
    await (channel as any).send(options);
    return true;
  } catch (error) {
    log.warn(`Failed to send message to channel: ${error}`);
    return false;
  }
}

export async function restartDiscordBot(): Promise<void> {
  log.info("Restarting Discord bot due to settings change...");
  await stopDiscordBot();
  await startDiscordBot();
}
