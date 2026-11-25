// ==========================================
// 📡 Discord イベント処理
// ==========================================

import { EmbedBuilder, type Client, type Guild } from "discord.js";
import { normalizeText, runeLength } from "./normalize.js";
import {
  EMBED_COLOR_ERROR,
  normalizeResolvers,
  sendPublicEmbed,
  handleButton,
  handleChatInputCommand,
} from "./commands.js";
import { handleMessageCommand } from "./messageCommands.js";
import type { CommandContext } from "./commands.js";

export function registerEvents(client: Client, ctx: CommandContext): void {
  client.on("messageCreate", async (message) => {
    try {
      if (message.author.bot) return;
      if (!message.guildId || !message.guild) return;
      if (message.content.startsWith("!")) {
        // 🔇 `!` コマンドは読み上げない（未知のコマンドも含む）。
        await handleMessageCommand(message, ctx);
        return;
      }
      // 💬 自動読み上げ
      const player = ctx.players.get(message.guildId);
      if (!player || !player.status.connected) return;
      const settings = ctx.store.getGuildSettings(message.guildId);
      if (!settings.enabled) return;
      if (
        ctx.store.isExcluded(
          message.guildId,
          message.channelId,
          message.author.id,
        )
      )
        return;
      const text = normalizeText(
        message.content,
        ctx.store.listDict(message.guildId),
        normalizeResolvers(message.guild),
      );
      if (!text) return;
      if (runeLength(text) > 120) return;
      // ⚠️ 満杯でも無言で無視する。
      player.enqueue(text, message.author.id);
    } catch (error) {
      console.error("[yomiko] messageCreate の処理に失敗しました:", error);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleChatInputCommand(interaction, ctx);
      } else if (interaction.isButton()) {
        await handleButton(interaction, ctx);
      }
    } catch (error) {
      console.error("interaction failed", error);
      if (!interaction.isRepliable()) return;
      if (interaction.replied) return;
      const embed = new EmbedBuilder()
        .setTitle("⚠️ 処理に失敗しました")
        .setDescription("処理に失敗しました。")
        .setColor(EMBED_COLOR_ERROR)
        .setFooter({ text: "🔊 よみこ" })
        .setTimestamp(new Date());
      // ⏳ defer 済みの場合は reply() できないため editReply でエラーを確定させる
      // （以前はここで return してしまい、応答が「考え中」のまま残っていた）。
      if (interaction.deferred) {
        await interaction.editReply({ embeds: [embed] }).catch(() => undefined);
        return;
      }
      await interaction
        .reply({ embeds: [embed], ephemeral: true })
        .catch(() => undefined);
    }
  });

  // 🚪 VCにBotだけになったときの自動退出タイマーを開始する。
  const scheduleAutoLeave = (guildId: string): void => {
    const player = ctx.players.get(guildId);
    if (!player) return;
    player.startAutoLeaveTimer(ctx.config.autoLeaveDelayMs, () => {
      const current = ctx.players.get(guildId);
      if (!current || !current.status.connected) return;
      // 🧹 leave() で notifyChannelId が消えるため、先に控えておく。
      const notifyChannelId = current.notifyChannelId;
      current.leave();
      if (notifyChannelId) {
        void client.channels
          .fetch(notifyChannelId)
          .then((ch) => {
            if (ch?.isTextBased()) {
              void sendPublicEmbed(
                ch,
                "👋 読み上げを終了しました",
                "VCに誰もいなくなったため、読み上げを終了しました。",
              );
            }
          })
          .catch(() => undefined);
      }
    });
  };

  // 💬 指定チャンネルにいる Bot 以外のメンバー数（チャンネルが取れなければ 0）。
  const humanCountIn = (guild: Guild, channelId: string): number => {
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) return 0;
    return [...channel.members.values()].filter((m) => !m.user.bot).length;
  };

  client.on("voiceStateUpdate", (oldState, newState) => {
    try {
      const guildId = newState.guild.id;
      const isBotSelf = newState.member?.id === client.user?.id;
      if (isBotSelf) {
        const player = ctx.players.get(guildId);
        // 🚪 (a) Bot自身の切断。player があれば後始末する。
        if (newState.channelId == null) {
          if (player) player.leave();
          return;
        }
        // 🚪 (a2) Botが別VCへ移動させられた場合、player が保持するチャンネルIDを
        // 実態に合わせ、移動先の人数で自動退出を再評価する。
        // 以前は移動を無視していたため、自動退出判定が旧チャンネルを見続けていた。
        if (
          player &&
          player.status.connected &&
          oldState.channelId &&
          newState.channelId !== oldState.channelId
        ) {
          player.syncChannelId(newState.channelId);
          const humans = humanCountIn(newState.guild, newState.channelId);
          if (humans === 0) scheduleAutoLeave(guildId);
          else player.cancelAutoLeaveTimer();
        }
        return;
      }
      const player = ctx.players.get(guildId);
      if (!player || !player.status.connected) return;
      const vcId = player.channelId;
      if (!vcId) return;
      // 🚪 (b) Botの接続中VCに誰かが参加したら自動退出タイマーを止める。
      if (newState.channelId === vcId && oldState.channelId !== vcId) {
        if (newState.member && !newState.member.user.bot) {
          player.cancelAutoLeaveTimer();
        }
        return;
      }
      // 🚪 (c) Botの接続中VCから誰かが出て、Bot以外のメンバーが0人になったら
      // 自動退出タイマーを開始する。
      if (oldState.channelId === vcId && newState.channelId !== vcId) {
        if (humanCountIn(newState.guild, vcId) === 0) {
          scheduleAutoLeave(guildId);
        }
      }
    } catch (error) {
      console.error("[yomiko] voiceStateUpdate の処理に失敗しました:", error);
    }
  });
}
