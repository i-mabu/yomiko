import { PermissionFlagsBits, type Message } from "discord.js";
import {
  actionRow,
  doChannel,
  doClear,
  doHelp,
  doJoin,
  doLeave,
  doPause,
  doQueue,
  doRemove,
  doResume,
  doSay,
  doSetSpeaker,
  doSetSpeed,
  doSetVolume,
  doSkip,
  doSpeakers,
  doStatus,
  doUser,
  getVoiceChannelId,
  sendPublicEmbed,
  EMBED_COLOR_ERROR,
  EMBED_COLOR_INFO,
  type CommandContext,
  type CommandTarget,
} from "./commands.js";

// ==========================================
// 💬 `!` メッセージコマンド
// ==========================================
// `!` メッセージコマンド（元のGo版の体系を維持）。
// 返信は公開Embed＋ボタン行。処理したコマンドは true、
// `!` で始まらない・未知のコマンドは false を返す
// （呼び出し側はその場合読み上げもしない）。
const MESSAGE_COMMANDS = new Set([
  "join",
  "leave",
  "say",
  "speaker",
  "status",
  "queue",
  "clear",
  "skip",
  "volume",
  "speed",
  "channel",
  "user",
  "help",
  "speakers",
  "pause",
  "resume",
  "remove",
]);

function isIntegerText(value: string): boolean {
  return /^-?\d+$/.test(value);
}

function isNumberText(value: string): boolean {
  if (!value) return false;
  const n = Number(value);
  return Number.isFinite(n);
}

export async function handleMessageCommand(
  message: Message,
  ctx: CommandContext,
): Promise<boolean> {
  const content = message.content;
  if (!content.startsWith("!")) return false;
  const withoutPrefix = content.slice(1);
  const spaceIndex = withoutPrefix.search(/\s/);
  const name = (
    spaceIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, spaceIndex)
  ).toLowerCase();
  const rest = (
    spaceIndex === -1 ? "" : withoutPrefix.slice(spaceIndex + 1)
  ).trim();
  if (!MESSAGE_COMMANDS.has(name)) return false;

  const guild = message.guild;
  if (!guild) return false;

  const target: CommandTarget = {
    guild,
    userId: message.author.id,
    voiceChannelId: getVoiceChannelId(message.member),
    notifyChannelId: message.channelId,
    isAdmin:
      message.member?.permissions.has(PermissionFlagsBits.Administrator) ??
      false,
    respond: (title, description, color = EMBED_COLOR_INFO, components) =>
      sendPublicEmbed(
        message.channel,
        title,
        description,
        color,
        components ?? [actionRow()],
      ),
  };

  switch (name) {
    case "join":
      await doJoin(ctx, target);
      return true;
    case "leave":
      await doLeave(ctx, target);
      return true;
    case "say":
      await doSay(ctx, target, rest);
      return true;
    case "speaker": {
      if (!rest) {
        await sendPublicEmbed(
          message.channel,
          "⚠️ 話者IDを指定してください",
          "話者IDを指定してください。",
          EMBED_COLOR_ERROR,
          [actionRow()],
        );
        return true;
      }
      if (!isIntegerText(rest)) {
        await sendPublicEmbed(
          message.channel,
          "⚠️ 話者IDが正しくありません",
          "話者IDは数値で指定してください。",
          EMBED_COLOR_ERROR,
          [actionRow()],
        );
        return true;
      }
      await doSetSpeaker(ctx, target, Number.parseInt(rest, 10));
      return true;
    }
    case "status":
      await doStatus(ctx, target);
      return true;
    case "queue":
      await doQueue(ctx, target);
      return true;
    case "clear":
      await doClear(ctx, target);
      return true;
    case "skip":
      await doSkip(ctx, target);
      return true;
    case "volume": {
      if (!rest) {
        await sendPublicEmbed(
          message.channel,
          "⚠️ 音量を指定してください",
          "音量を指定してください。",
          EMBED_COLOR_ERROR,
          [actionRow()],
        );
        return true;
      }
      if (!isNumberText(rest)) {
        await sendPublicEmbed(
          message.channel,
          "⚠️ 音量が正しくありません",
          "音量は数値で指定してください。",
          EMBED_COLOR_ERROR,
          [actionRow()],
        );
        return true;
      }
      await doSetVolume(ctx, target, Number(rest));
      return true;
    }
    case "speed": {
      if (!rest) {
        await sendPublicEmbed(
          message.channel,
          "⚠️ 速度を指定してください",
          "速度を指定してください。",
          EMBED_COLOR_ERROR,
          [actionRow()],
        );
        return true;
      }
      if (!isNumberText(rest)) {
        await sendPublicEmbed(
          message.channel,
          "⚠️ 速度が正しくありません",
          "速度は数値で指定してください。",
          EMBED_COLOR_ERROR,
          [actionRow()],
        );
        return true;
      }
      await doSetSpeed(ctx, target, Number(rest));
      return true;
    }
    case "channel": {
      const parts = rest.split(/\s+/).filter(Boolean);
      const [action, channelId] = parts;
      if (
        parts.length < 2 ||
        (action !== "allow" && action !== "block" && action !== "remove") ||
        !channelId ||
        !/^\d+$/.test(channelId)
      ) {
        await sendPublicEmbed(
          message.channel,
          "⚠️ 使い方が正しくありません",
          "使い方: !channel allow|block|remove チャンネルID",
          EMBED_COLOR_ERROR,
          [actionRow()],
        );
        return true;
      }
      await doChannel(ctx, target, action, channelId);
      return true;
    }
    case "user": {
      const parts = rest.split(/\s+/).filter(Boolean);
      const [action, userId] = parts;
      if (
        parts.length < 2 ||
        (action !== "block" && action !== "remove") ||
        !userId ||
        !/^\d+$/.test(userId)
      ) {
        await sendPublicEmbed(
          message.channel,
          "⚠️ 使い方が正しくありません",
          "使い方: !user block|remove ユーザーID",
          EMBED_COLOR_ERROR,
          [actionRow()],
        );
        return true;
      }
      await doUser(ctx, target, action, userId);
      return true;
    }
    case "help":
      await doHelp(ctx, target);
      return true;
    case "speakers":
      await doSpeakers(ctx, target);
      return true;
    case "pause":
      await doPause(ctx, target);
      return true;
    case "resume":
      await doResume(ctx, target);
      return true;
    case "remove": {
      if (!rest) {
        await sendPublicEmbed(
          message.channel,
          "⚠️ キュー番号を指定してください",
          "削除するキュー番号を指定してください。",
          EMBED_COLOR_ERROR,
          [actionRow()],
        );
        return true;
      }
      if (!isIntegerText(rest)) {
        await sendPublicEmbed(
          message.channel,
          "⚠️ キュー番号が正しくありません",
          "削除するキュー番号は数値で指定してください。",
          EMBED_COLOR_ERROR,
          [actionRow()],
        );
        return true;
      }
      await doRemove(ctx, target, Number.parseInt(rest, 10));
      return true;
    }
    default:
      return false;
  }
}
