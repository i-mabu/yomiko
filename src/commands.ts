import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type TextBasedChannel,
} from "discord.js";
import {
  normalizeText,
  runeLength,
  truncateRunes,
  type NormalizeContext,
} from "./normalize.js";
import type { YomikoConfig } from "./config.js";
import type { YomikoStore } from "./store.js";
import type { PlayerManager } from "./player.js";
import { VoicevoxError, type VoicevoxClient } from "./voicevox.js";

export interface CommandContext {
  store: YomikoStore;
  players: PlayerManager;
  voicevox: VoicevoxClient;
  config: YomikoConfig;
}

export const EMBED_COLOR_INFO = 0x5865f2;
export const EMBED_COLOR_SUCCESS = 0x57f287;
export const EMBED_COLOR_ERROR = 0xed4245;

const EMBED_FOOTER = "🔊 よみこ";
const ADMIN_ONLY_MESSAGE = "この操作はサーバー管理者のみ実行できます。";
const NOT_CONNECTED_MESSAGE = "現在、このサーバーでは読み上げをしていません。";

export async function replyEmbed(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  title: string,
  description: string,
  color: number = EMBED_COLOR_INFO,
  ephemeral = true,
  components?: ActionRowBuilder<ButtonBuilder>[],
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: EMBED_FOOTER })
    .setTimestamp(new Date());
  const rows = components ?? [];
  // 応答済み・defer 済みの interaction に reply() すると
  // InteractionAlreadyReplied で失敗するため、状態に応じて振り分ける。
  // 時間のかかるコマンド（join / speakers / voicevox）は呼び出し側で
  // deferReply してから処理し、ここで editReply で確定させる。
  if (interaction.deferred) {
    await interaction.editReply({ embeds: [embed], components: rows });
  } else if (interaction.replied) {
    await interaction.followUp({
      embeds: [embed],
      ephemeral,
      components: rows,
    });
  } else {
    await interaction.reply({ embeds: [embed], ephemeral, components: rows });
  }
}

export async function sendPublicEmbed(
  channel: TextBasedChannel,
  title: string,
  description: string,
  color: number = EMBED_COLOR_INFO,
  components?: ActionRowBuilder<ButtonBuilder>[],
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: EMBED_FOOTER })
    .setTimestamp(new Date());
  // TextBasedChannel には send を持たない一部チャンネル（PartialGroupDMChannel）が
  // 含まれるため、send できる場合のみ送る。
  if ("send" in channel) {
    await channel.send({ embeds: [embed], components: components ?? [] });
  }
}

export function actionRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("join_button")
      .setLabel("接続")
      .setEmoji("🎙️")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("leave_button")
      .setLabel("終了")
      .setEmoji("🛑")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("status_button")
      .setLabel("状態")
      .setEmoji("📊")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("queue_button")
      .setLabel("キュー")
      .setEmoji("📚")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("clear_button")
      .setLabel("全消去")
      .setEmoji("🧹")
      .setStyle(ButtonStyle.Danger),
  );
}

// メンション解決（キャッシュのみ。表示名が分からなければ normalize 側が
// 「メンション」/「チャンネル」に読み替える）。
export function normalizeResolvers(guild: Guild | null): NormalizeContext {
  return {
    resolveUser: (id) => guild?.members.cache.get(id)?.displayName ?? null,
    resolveChannel: (id) => guild?.channels.cache.get(id)?.name ?? null,
    resolveRole: (id) => guild?.roles.cache.get(id)?.name ?? null,
  };
}

export function getVoiceChannelId(
  member: GuildMember | null | undefined,
): string | null {
  return member?.voice.channelId ?? null;
}

// スラッシュ・ボタン・`!` コマンドで共通の応答口。
// respond は呼び出し側の返信方法（ephemeral / 公開Embed）を隠す。
export interface CommandTarget {
  guild: Guild;
  userId: string;
  voiceChannelId: string | null;
  notifyChannelId: string;
  isAdmin: boolean;
  respond: (
    title: string,
    description: string,
    color?: number,
    components?: ActionRowBuilder<ButtonBuilder>[],
  ) => Promise<void>;
}

function adminError(target: CommandTarget): Promise<void> {
  return target.respond(
    "🛡️ 権限がありません",
    ADMIN_ONLY_MESSAGE,
    EMBED_COLOR_ERROR,
  );
}

export async function doJoin(
  ctx: CommandContext,
  target: CommandTarget,
): Promise<void> {
  const { guild } = target;
  if (!target.voiceChannelId) {
    await target.respond(
      "🎙️ ボイスチャンネルに参加してください",
      "先にボイスチャンネルへ参加してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const player = ctx.players.getOrCreate(guild.id);
  if (player.status.connected) {
    await target.respond(
      "🎙️ 接続済みです",
      "すでにボイスチャンネルに接続しています。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const joined = await player.join(
    target.voiceChannelId,
    guild.voiceAdapterCreator,
    target.notifyChannelId,
  );
  if (!joined) {
    await target.respond(
      "❌ 接続できませんでした",
      "ボイスチャンネルに接続できませんでした。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  await target.respond(
    "🎙️ 読み上げを開始しました",
    "読み上げを開始しました。",
    EMBED_COLOR_SUCCESS,
    [actionRow()],
  );
}

export async function doLeave(
  ctx: CommandContext,
  target: CommandTarget,
): Promise<void> {
  const player = ctx.players.get(target.guild.id);
  if (!player || !player.status.connected) {
    await target.respond(
      "🎙️ 読み上げをしていません",
      "現在このサーバーでは読み上げをしていません。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  player.leave();
  await target.respond(
    "👋 読み上げを終了しました",
    "読み上げを終了しました。",
    EMBED_COLOR_SUCCESS,
    [actionRow()],
  );
}

export async function doSay(
  ctx: CommandContext,
  target: CommandTarget,
  rawText: string,
): Promise<void> {
  const text = rawText.trim();
  if (!text) {
    await target.respond(
      "⚠️ 文章を指定してください",
      "読み上げる文章を指定してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  if (runeLength(text) > 120) {
    await target.respond(
      "⚠️ 文章が長すぎます",
      "120 文字以内で指定してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const player = ctx.players.get(target.guild.id);
  if (!player || !player.status.connected) {
    await target.respond(
      "🎙️ 読み上げをしていません",
      NOT_CONNECTED_MESSAGE,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const settings = ctx.store.getGuildSettings(target.guild.id);
  if (!settings.enabled) {
    await target.respond(
      "⏸️ 読み上げはOFFです",
      "現在、読み上げはOFFになっています。`/toggle on` で有効にしてください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const normalized = normalizeText(
    text,
    ctx.store.listDict(target.guild.id),
    normalizeResolvers(target.guild),
  );
  if (!normalized) {
    await target.respond(
      "⚠️ 文章を指定してください",
      "読み上げる文章を指定してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  // 辞書置換で読みが原文より長くなる場合があるため、正規化後にも上限を確認する
  // （自動読み上げ側は正規化後の長さで判定しており、ここも揃える）。
  if (runeLength(normalized) > 120) {
    await target.respond(
      "⚠️ 文章が長すぎます",
      "120 文字以内で指定してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const result = player.enqueue(normalized, target.userId);
  if (result === "not-connected") {
    await target.respond(
      "🎙️ 読み上げをしていません",
      NOT_CONNECTED_MESSAGE,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  if (result === "full") {
    await target.respond(
      "📚 キューがいっぱいです",
      "読み上げキューがいっぱいです。少し待ってから再度お試しください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  await target.respond(
    "📣 キューに追加しました",
    "キューに追加しました。",
    EMBED_COLOR_SUCCESS,
    [actionRow()],
  );
}

export async function doSetSpeaker(
  ctx: CommandContext,
  target: CommandTarget,
  id: number,
): Promise<void> {
  if (!target.isAdmin) {
    await adminError(target);
    return;
  }
  if (!Number.isInteger(id) || id < 1) {
    await target.respond(
      "⚠️ 話者IDが正しくありません",
      "話者IDは1以上で指定してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  ctx.store.setGuildSettings(target.guild.id, { speaker: id });
  await target.respond(
    "🗣️ 話者を変更しました",
    `話者IDを ${id} に設定しました。`,
    EMBED_COLOR_SUCCESS,
  );
}

export async function doStatus(
  ctx: CommandContext,
  target: CommandTarget,
): Promise<void> {
  const player = ctx.players.get(target.guild.id);
  const settings = ctx.store.getGuildSettings(target.guild.id);
  const connected = player?.status.connected ?? false;
  const lines = [
    `**接続状態**　${connected && player?.channelId ? `<#${player.channelId}>` : "未接続"}`,
    `**読み上げ**　${settings.enabled ? "ON" : "OFF"}`,
    `**話者ID**　${settings.speaker}`,
    `**音量**　${settings.volume.toFixed(2)}`,
    `**速度**　${settings.speed.toFixed(2)}`,
    `**ピッチ**　${settings.pitch.toFixed(2)}`,
    `**待機**　${player?.status.queueLength ?? 0}件`,
  ];
  const current = player?.currentText;
  if (current) {
    lines.push(`**現在の文**　${truncateRunes(current, 40)}`);
  }
  await target.respond(
    "📊 読み上げBOTの状態",
    lines.join("\n"),
    EMBED_COLOR_INFO,
    [actionRow()],
  );
}

export async function doQueue(
  ctx: CommandContext,
  target: CommandTarget,
): Promise<void> {
  const player = ctx.players.get(target.guild.id);
  if (!player || !player.status.connected) {
    await target.respond(
      "🎙️ 読み上げをしていません",
      NOT_CONNECTED_MESSAGE,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const items = player.queueList();
  if (items.length === 0) {
    await target.respond(
      "📚 読み上げキュー",
      "📚 読み上げキューには 0 件の待機があります。",
      EMBED_COLOR_INFO,
      [actionRow()],
    );
    return;
  }
  const list = items.map((item, i) => `${i + 1}. ${item.text}`).join("\n");
  await target.respond(
    "📚 読み上げキュー",
    truncateRunes(
      `📚 読み上げキューには ${items.length} 件の待機があります。\n${list}`,
      1900,
    ),
    EMBED_COLOR_INFO,
    [actionRow()],
  );
}

export async function doClear(
  ctx: CommandContext,
  target: CommandTarget,
): Promise<void> {
  if (!target.isAdmin) {
    await adminError(target);
    return;
  }
  const player = ctx.players.get(target.guild.id);
  if (!player || !player.status.connected) {
    await target.respond(
      "🎙️ 読み上げをしていません",
      NOT_CONNECTED_MESSAGE,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const count = player.clearQueue();
  await target.respond(
    "🧹 キューを消去しました",
    `待機中の読み上げを ${count} 件取り消しました。`,
    EMBED_COLOR_SUCCESS,
  );
}

export async function doSkip(
  ctx: CommandContext,
  target: CommandTarget,
): Promise<void> {
  if (!target.isAdmin) {
    await adminError(target);
    return;
  }
  const player = ctx.players.get(target.guild.id);
  if (!player || !player.status.connected) {
    await target.respond(
      "🎙️ 読み上げをしていません",
      NOT_CONNECTED_MESSAGE,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  if (!player.currentText) {
    await target.respond(
      "⏭️ 読み上げ中ではありません",
      "現在読み上げ中の文章はありません。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  player.skip();
  await target.respond(
    "⏭️ スキップしました",
    "現在の読み上げをスキップしました。",
    EMBED_COLOR_SUCCESS,
  );
}

export async function doSetVolume(
  ctx: CommandContext,
  target: CommandTarget,
  value: number,
): Promise<void> {
  if (!target.isAdmin) {
    await adminError(target);
    return;
  }
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    await target.respond(
      "⚠️ 音量が正しくありません",
      "音量は 0.0〜2.0 の範囲で指定してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  ctx.store.setGuildSettings(target.guild.id, { volume: value });
  await target.respond(
    "🔊 音量を変更しました",
    `音量を ${value.toFixed(2)} に設定しました。`,
    EMBED_COLOR_SUCCESS,
  );
}

export async function doSetSpeed(
  ctx: CommandContext,
  target: CommandTarget,
  value: number,
): Promise<void> {
  if (!target.isAdmin) {
    await adminError(target);
    return;
  }
  if (!Number.isFinite(value) || value < 0.5 || value > 2) {
    await target.respond(
      "⚠️ 速度が正しくありません",
      "速度は 0.5〜2.0 の範囲で指定してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  ctx.store.setGuildSettings(target.guild.id, { speed: value });
  await target.respond(
    "⏩ 速度を変更しました",
    `読み上げ速度を ${value.toFixed(2)} に設定しました。`,
    EMBED_COLOR_SUCCESS,
  );
}

export async function doSetPitch(
  ctx: CommandContext,
  target: CommandTarget,
  value: number,
): Promise<void> {
  if (!target.isAdmin) {
    await adminError(target);
    return;
  }
  if (!Number.isFinite(value) || value < -0.15 || value > 0.15) {
    await target.respond(
      "⚠️ ピッチが正しくありません",
      "ピッチは -0.15〜0.15 の範囲で指定してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  ctx.store.setGuildSettings(target.guild.id, { pitch: value });
  await target.respond(
    "🎵 ピッチを変更しました",
    `ピッチを ${value.toFixed(2)} に設定しました。`,
    EMBED_COLOR_SUCCESS,
  );
}

export async function doChannel(
  ctx: CommandContext,
  target: CommandTarget,
  action: string,
  channelId: string,
): Promise<void> {
  if (!target.isAdmin) {
    await adminError(target);
    return;
  }
  if (action === "allow") {
    ctx.store.setChannelMode(target.guild.id, channelId, "allow");
    await target.respond(
      "📢 チャンネルを設定しました",
      `チャンネル <#${channelId}> を読み上げ対象に追加しました。`,
      EMBED_COLOR_SUCCESS,
    );
  } else if (action === "block") {
    ctx.store.setChannelMode(target.guild.id, channelId, "block");
    await target.respond(
      "📢 チャンネルを設定しました",
      `チャンネル <#${channelId}> を読み上げ対象から除外しました。`,
      EMBED_COLOR_SUCCESS,
    );
  } else if (action === "remove") {
    ctx.store.removeChannel(target.guild.id, channelId);
    await target.respond(
      "📢 チャンネルを設定しました",
      `チャンネル <#${channelId}> の設定を解除しました。`,
      EMBED_COLOR_SUCCESS,
    );
  } else {
    await target.respond(
      "⚠️ 使い方が正しくありません",
      "使い方: !channel allow|block|remove チャンネルID",
      EMBED_COLOR_ERROR,
    );
  }
}

export async function doUser(
  ctx: CommandContext,
  target: CommandTarget,
  action: string,
  userId: string,
): Promise<void> {
  if (!target.isAdmin) {
    await adminError(target);
    return;
  }
  if (action === "block") {
    ctx.store.setUserBlocked(target.guild.id, userId, true);
    await target.respond(
      "🚫 ユーザーを設定しました",
      `ユーザー <@${userId}> の読み上げを除外しました。`,
      EMBED_COLOR_SUCCESS,
    );
  } else if (action === "remove") {
    ctx.store.setUserBlocked(target.guild.id, userId, false);
    await target.respond(
      "🚫 ユーザーを設定しました",
      `ユーザー <@${userId}> の除外を解除しました。`,
      EMBED_COLOR_SUCCESS,
    );
  } else {
    await target.respond(
      "⚠️ 使い方が正しくありません",
      "ユーザー操作は block / remove のいずれかで指定してください。",
      EMBED_COLOR_ERROR,
    );
  }
}

export async function doHelp(
  _ctx: CommandContext,
  target: CommandTarget,
): Promise<void> {
  const description = [
    "**基本**",
    "`/join` ボイスチャンネルに接続して読み上げを開始します。",
    "`/leave` ボイスチャンネルから切断して読み上げを終了します。",
    "`/say <文章>` 指定したテキストを読み上げます。",
    "`/status` 読み上げBOTの現在状態を表示します。",
    "",
    "**キュー**",
    "`/queue` 待機中の読み上げ件数を表示します。",
    "`/remove <番号>` 待機キューから指定番号の文を削除します（管理者）。",
    "`/clear` 待機中の読み上げをすべて取り消します（管理者）。",
    "`/skip` 現在の読み上げをスキップします（管理者）。",
    "`/pause` 次の読み上げを一時停止します（管理者）。",
    "`/resume` 読み上げを再開します（管理者）。",
    "",
    "**設定（管理者）**",
    "`/speaker <ID>` 話者IDを変更します。",
    "`/volume <0.0-2.0>` 音量を変更します。",
    "`/speed <0.5-2.0>` 読み上げ速度を変更します。",
    "`/pitch <-0.15-0.15>` ピッチを変更します。",
    "`/toggle on|off` 読み上げのON/OFFを切り替えます。",
    "",
    "**除外（管理者）**",
    "`/channel allow|block|remove <#チャンネル>` 読み上げ対象チャンネルを設定します。",
    "`/user block|remove <@ユーザー>` 読み上げ対象ユーザーを設定します。",
    "",
    "**自分の声**",
    "`/myvoice set|show|reset` 自分の声（話者・音量・速度・ピッチ）を設定します。",
    "",
    "**辞書（管理者）**",
    "`/dict add|remove|list` 読み替え辞書を設定します。",
    "",
    "**その他**",
    "`/speakers` VOICEVOXの話者一覧を表示します。",
    "`/voicevox` VOICEVOX Engineへの接続を確認します。",
    "`/ping` Botの応答状態を確認します。",
    "",
    "`!` から始まるメッセージコマンド（`!join` / `!say 文章` など）も使えます。",
  ].join("\n");
  await target.respond("📖 ヘルプ", description, EMBED_COLOR_INFO);
}

export async function doSpeakers(
  ctx: CommandContext,
  target: CommandTarget,
): Promise<void> {
  let speakers;
  try {
    speakers = await ctx.voicevox.listSpeakers();
  } catch (error) {
    const message =
      error instanceof VoicevoxError
        ? error.message
        : "話者一覧の取得に失敗しました。";
    await target.respond(
      "⚠️ 話者一覧を取得できませんでした",
      message,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  if (speakers.length === 0) {
    await target.respond(
      "🗣️ 話者一覧",
      "利用可能な話者がありません。",
      EMBED_COLOR_INFO,
    );
    return;
  }
  const lines = ["利用可能な話者:"];
  for (const speaker of speakers) {
    for (const style of speaker.styles) {
      lines.push(`${style.id}: ${speaker.name}（${style.name}）`);
    }
  }
  await target.respond(
    "🗣️ 話者一覧",
    truncateRunes(lines.join("\n"), 1900),
    EMBED_COLOR_INFO,
  );
}

export async function doPause(
  ctx: CommandContext,
  target: CommandTarget,
): Promise<void> {
  if (!target.isAdmin) {
    await adminError(target);
    return;
  }
  const player = ctx.players.get(target.guild.id);
  if (!player || !player.status.connected) {
    await target.respond(
      "🎙️ 読み上げをしていません",
      NOT_CONNECTED_MESSAGE,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  player.pause();
  await target.respond(
    "⏸️ 一時停止しました",
    "次の読み上げを一時停止しました。再開するには `/resume` を実行してください。",
    EMBED_COLOR_SUCCESS,
  );
}

export async function doResume(
  ctx: CommandContext,
  target: CommandTarget,
): Promise<void> {
  if (!target.isAdmin) {
    await adminError(target);
    return;
  }
  const player = ctx.players.get(target.guild.id);
  if (!player || !player.status.connected) {
    await target.respond(
      "🎙️ 読み上げをしていません",
      NOT_CONNECTED_MESSAGE,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  player.resume();
  await target.respond(
    "▶️ 再開しました",
    "読み上げを再開しました。",
    EMBED_COLOR_SUCCESS,
  );
}

export async function doRemove(
  ctx: CommandContext,
  target: CommandTarget,
  index: number,
): Promise<void> {
  if (!target.isAdmin) {
    await adminError(target);
    return;
  }
  const player = ctx.players.get(target.guild.id);
  if (!player || !player.status.connected) {
    await target.respond(
      "🎙️ 読み上げをしていません",
      NOT_CONNECTED_MESSAGE,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const count = player.queueList().length;
  if (!Number.isInteger(index) || index < 1 || index > count) {
    await target.respond(
      "⚠️ キュー番号が正しくありません",
      `キュー番号は 1〜${count} で指定してください。`,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const removed = player.removeFromQueue(index - 1);
  if (!removed) {
    await target.respond(
      "⚠️ キュー番号が正しくありません",
      `キュー番号は 1〜${count} で指定してください。`,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  await target.respond(
    "🗑️ キューを削除しました",
    `キュー ${index} 番を削除しました: ${removed.text}`,
    EMBED_COLOR_SUCCESS,
  );
}

function formatUserVoiceLines(
  settings: { speaker: number; volume: number; speed: number; pitch: number },
  userVoice: {
    speaker: number | null;
    volume: number | null;
    speed: number | null;
    pitch: number | null;
  },
): string[] {
  const speaker = userVoice.speaker ?? settings.speaker;
  const volume = userVoice.volume ?? settings.volume;
  const speed = userVoice.speed ?? settings.speed;
  const pitch = userVoice.pitch ?? settings.pitch;
  return [
    `**話者ID**　${userVoice.speaker ?? "サーバー既定"}（実効: ${speaker}）`,
    `**音量**　${userVoice.volume === null ? "サーバー既定" : userVoice.volume.toFixed(2)}（実効: ${volume.toFixed(2)}）`,
    `**速度**　${userVoice.speed === null ? "サーバー既定" : userVoice.speed.toFixed(2)}（実効: ${speed.toFixed(2)}）`,
    `**ピッチ**　${userVoice.pitch === null ? "サーバー既定" : userVoice.pitch.toFixed(2)}（実効: ${pitch.toFixed(2)}）`,
  ];
}

export async function doMyVoiceSet(
  ctx: CommandContext,
  target: CommandTarget,
  opts: {
    speaker?: number | null;
    volume?: number | null;
    speed?: number | null;
    pitch?: number | null;
  },
): Promise<void> {
  const { speaker, volume, speed, pitch } = opts;
  if (speaker == null && volume == null && speed == null && pitch == null) {
    await target.respond(
      "⚠️ 項目を指定してください",
      "設定する項目を指定してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  if (speaker != null && (!Number.isInteger(speaker) || speaker < 1)) {
    await target.respond(
      "⚠️ 話者IDが正しくありません",
      "話者IDは1以上で指定してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  if (
    volume != null &&
    (!Number.isFinite(volume) || volume < 0 || volume > 2)
  ) {
    await target.respond(
      "⚠️ 音量が正しくありません",
      "音量は 0.0〜2.0 の範囲で指定してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  if (speed != null && (!Number.isFinite(speed) || speed < 0.5 || speed > 2)) {
    await target.respond(
      "⚠️ 速度が正しくありません",
      "速度は 0.5〜2.0 の範囲で指定してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  if (
    pitch != null &&
    (!Number.isFinite(pitch) || pitch < -0.15 || pitch > 0.15)
  ) {
    await target.respond(
      "⚠️ ピッチが正しくありません",
      "ピッチは -0.15〜0.15 の範囲で指定してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const patch: {
    speaker?: number | null;
    volume?: number | null;
    speed?: number | null;
    pitch?: number | null;
  } = {};
  if (speaker != null) patch.speaker = speaker;
  if (volume != null) patch.volume = volume;
  if (speed != null) patch.speed = speed;
  if (pitch != null) patch.pitch = pitch;
  ctx.store.setUserVoice(target.guild.id, target.userId, patch);
  const settings = ctx.store.getGuildSettings(target.guild.id);
  const userVoice = ctx.store.getUserVoice(target.guild.id, target.userId);
  await target.respond(
    "🎤 自分の声を設定しました",
    `自分の声を設定しました。\n${formatUserVoiceLines(settings, userVoice).join("\n")}`,
    EMBED_COLOR_SUCCESS,
  );
}

export async function doMyVoiceShow(
  ctx: CommandContext,
  target: CommandTarget,
): Promise<void> {
  const settings = ctx.store.getGuildSettings(target.guild.id);
  const userVoice = ctx.store.getUserVoice(target.guild.id, target.userId);
  await target.respond(
    "🎤 自分の声",
    formatUserVoiceLines(settings, userVoice).join("\n"),
    EMBED_COLOR_INFO,
  );
}

export async function doMyVoiceReset(
  ctx: CommandContext,
  target: CommandTarget,
): Promise<void> {
  ctx.store.resetUserVoice(target.guild.id, target.userId);
  await target.respond(
    "🎤 自分の声をリセットしました",
    "自分の声の設定をリセットしました。サーバー既定の声を使います。",
    EMBED_COLOR_SUCCESS,
  );
}

export async function doDictAdd(
  ctx: CommandContext,
  target: CommandTarget,
  word: string,
  reading: string,
): Promise<void> {
  if (!target.isAdmin) {
    await adminError(target);
    return;
  }
  if (!word || !reading) {
    await target.respond(
      "⚠️ 単語と読みを指定してください",
      "単語と読みを指定してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const existed = ctx.store
    .listDict(target.guild.id)
    .some((entry) => entry.word === word);
  ctx.store.addDict(target.guild.id, word, reading);
  await target.respond(
    "📖 辞書",
    existed
      ? `辞書を更新しました: ${word} → ${reading}`
      : `辞書に登録しました: ${word} → ${reading}`,
    EMBED_COLOR_SUCCESS,
  );
}

export async function doDictRemove(
  ctx: CommandContext,
  target: CommandTarget,
  word: string,
): Promise<void> {
  if (!target.isAdmin) {
    await adminError(target);
    return;
  }
  const removed = ctx.store.removeDict(target.guild.id, word);
  if (!removed) {
    await target.respond(
      "📖 辞書",
      `辞書に ${word} は登録されていません。`,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  await target.respond(
    "📖 辞書",
    `辞書から削除しました: ${word}`,
    EMBED_COLOR_SUCCESS,
  );
}

export async function doDictList(
  ctx: CommandContext,
  target: CommandTarget,
): Promise<void> {
  if (!target.isAdmin) {
    await adminError(target);
    return;
  }
  const entries = ctx.store.listDict(target.guild.id);
  if (entries.length === 0) {
    await target.respond("📖 辞書", "辞書は空です。", EMBED_COLOR_INFO);
    return;
  }
  const lines = entries.map((entry) => `${entry.word} → ${entry.reading}`);
  await target.respond(
    "📖 辞書",
    truncateRunes(lines.join("\n"), 1900),
    EMBED_COLOR_INFO,
  );
}

export async function doToggle(
  ctx: CommandContext,
  target: CommandTarget,
  enabled: boolean,
): Promise<void> {
  if (!target.isAdmin) {
    await adminError(target);
    return;
  }
  ctx.store.setGuildSettings(target.guild.id, { enabled });
  await target.respond(
    enabled ? "🔊 読み上げをONにしました" : "🔇 読み上げをOFFにしました",
    enabled ? "読み上げをONにしました。" : "読み上げをOFFにしました。",
    EMBED_COLOR_SUCCESS,
  );
}

export async function doVoicevox(
  ctx: CommandContext,
  target: CommandTarget,
): Promise<void> {
  try {
    const version = await ctx.voicevox.getVersion();
    const speakers = await ctx.voicevox.listSpeakers();
    await target.respond(
      "✅ VOICEVOXに接続できました",
      `VOICEVOXに接続できました。\nバージョン: ${version}\n話者数: ${speakers.length}件\nURL: ${ctx.voicevox.url}`,
      EMBED_COLOR_SUCCESS,
    );
  } catch (error) {
    const message =
      error instanceof VoicevoxError
        ? error.message
        : "VOICEVOXへの接続に失敗しました。";
    await target.respond(
      "⚠️ VOICEVOXに接続できませんでした",
      message,
      EMBED_COLOR_ERROR,
    );
  }
}

export async function doPing(
  _ctx: CommandContext,
  target: CommandTarget,
  pingMs: number,
): Promise<void> {
  await target.respond(
    "🏓 Pong!",
    `応答速度: ${pingMs}ms`,
    EMBED_COLOR_SUCCESS,
  );
}

const ADMIN = PermissionFlagsBits.Administrator;

export const yomikoCommands: SlashCommandBuilder[] = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("ボイスチャンネルに接続して読み上げを開始します。"),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("ボイスチャンネルから切断して読み上げを終了します。"),
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("現在のボイスチャンネルで指定したテキストを読み上げます。")
    .addStringOption((opt) =>
      opt
        .setName("text")
        .setDescription("読み上げるテキスト")
        .setRequired(true)
        .setMaxLength(120),
    ),
  new SlashCommandBuilder()
    .setName("speaker")
    .setDescription("このサーバーで使うVOICEVOXの話者IDを変更します。")
    .setDefaultMemberPermissions(ADMIN)
    .addIntegerOption((opt) =>
      opt
        .setName("id")
        .setDescription("話者ID")
        .setRequired(true)
        .setMinValue(1),
    ),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("読み上げBOTの現在状態を表示します。"),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("現在の読み上げキューの件数を表示します。"),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("待機中の読み上げをすべて取り消します。")
    .setDefaultMemberPermissions(ADMIN),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("現在の読み上げをスキップします。")
    .setDefaultMemberPermissions(ADMIN),
  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("このサーバーの音量を変更します（0.0〜2.0）。")
    .setDefaultMemberPermissions(ADMIN)
    .addNumberOption((opt) =>
      opt
        .setName("value")
        .setDescription("音量（0.0〜2.0）")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(2),
    ),
  new SlashCommandBuilder()
    .setName("speed")
    .setDescription("このサーバーの読み上げ速度を変更します（0.5〜2.0）。")
    .setDefaultMemberPermissions(ADMIN)
    .addNumberOption((opt) =>
      opt
        .setName("value")
        .setDescription("速度（0.5〜2.0）")
        .setRequired(true)
        .setMinValue(0.5)
        .setMaxValue(2),
    ),
  new SlashCommandBuilder()
    .setName("pitch")
    .setDescription("このサーバーのピッチを変更します（-0.15〜0.15）。")
    .setDefaultMemberPermissions(ADMIN)
    .addNumberOption((opt) =>
      opt
        .setName("value")
        .setDescription("ピッチ（-0.15〜0.15）")
        .setRequired(true)
        .setMinValue(-0.15)
        .setMaxValue(0.15),
    ),
  new SlashCommandBuilder()
    .setName("channel")
    .setDescription("読み上げ対象チャンネルを設定します（管理者専用）。")
    .setDefaultMemberPermissions(ADMIN)
    .addStringOption((opt) =>
      opt
        .setName("action")
        .setDescription("操作")
        .setRequired(true)
        .addChoices(
          { name: "allow（読み上げ対象に追加）", value: "allow" },
          { name: "block（読み上げ対象から除外）", value: "block" },
          { name: "remove（設定を解除）", value: "remove" },
        ),
    )
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("対象チャンネル")
        .setRequired(true)
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.GuildPublicThread,
          ChannelType.GuildPrivateThread,
        ),
    ),
  new SlashCommandBuilder()
    .setName("user")
    .setDescription("読み上げ対象ユーザーを設定します（管理者専用）。")
    .setDefaultMemberPermissions(ADMIN)
    .addStringOption((opt) =>
      opt
        .setName("action")
        .setDescription("操作")
        .setRequired(true)
        .addChoices(
          { name: "block（読み上げを除外）", value: "block" },
          { name: "remove（除外を解除）", value: "remove" },
        ),
    )
    .addUserOption((opt) =>
      opt.setName("user").setDescription("対象ユーザー").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("利用できるコマンドを表示します。"),
  new SlashCommandBuilder()
    .setName("speakers")
    .setDescription("VOICEVOXの話者一覧を表示します。"),
  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("次の読み上げを一時停止します。")
    .setDefaultMemberPermissions(ADMIN),
  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("読み上げを再開します。")
    .setDefaultMemberPermissions(ADMIN),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("待機キューから指定番号の文を削除します（管理者専用）。")
    .setDefaultMemberPermissions(ADMIN)
    .addIntegerOption((opt) =>
      opt
        .setName("index")
        .setDescription("キュー番号（1始まり）")
        .setRequired(true)
        .setMinValue(1),
    ),
  new SlashCommandBuilder()
    .setName("myvoice")
    .setDescription("自分の声（話者・音量・速度・ピッチ）を設定します。")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("自分の声を設定します")
        .addIntegerOption((opt) =>
          opt.setName("speaker").setDescription("話者ID").setMinValue(1),
        )
        .addNumberOption((opt) =>
          opt
            .setName("volume")
            .setDescription("音量（0.0〜2.0）")
            .setMinValue(0)
            .setMaxValue(2),
        )
        .addNumberOption((opt) =>
          opt
            .setName("speed")
            .setDescription("速度（0.5〜2.0）")
            .setMinValue(0.5)
            .setMaxValue(2),
        )
        .addNumberOption((opt) =>
          opt
            .setName("pitch")
            .setDescription("ピッチ（-0.15〜0.15）")
            .setMinValue(-0.15)
            .setMaxValue(0.15),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("show").setDescription("自分の声の設定を表示します"),
    )
    .addSubcommand((sub) =>
      sub.setName("reset").setDescription("自分の声の設定をリセットします"),
    ),
  new SlashCommandBuilder()
    .setName("dict")
    .setDescription("読み替え辞書を設定します（管理者専用）。")
    .setDefaultMemberPermissions(ADMIN)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("読み替え辞書に登録します")
        .addStringOption((opt) =>
          opt
            .setName("word")
            .setDescription("単語")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(50),
        )
        .addStringOption((opt) =>
          opt
            .setName("reading")
            .setDescription("読み")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(100),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("読み替え辞書から削除します")
        .addStringOption((opt) =>
          opt
            .setName("word")
            .setDescription("単語")
            .setRequired(true)
            .setMinLength(1),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("読み替え辞書の一覧を表示します"),
    ),
  new SlashCommandBuilder()
    .setName("toggle")
    .setDescription("読み上げのON/OFFを切り替えます（管理者専用）。")
    .setDefaultMemberPermissions(ADMIN)
    .addSubcommand((sub) =>
      sub.setName("on").setDescription("読み上げをONにします"),
    )
    .addSubcommand((sub) =>
      sub.setName("off").setDescription("読み上げをOFFにします"),
    ),
  new SlashCommandBuilder()
    .setName("voicevox")
    .setDescription("VOICEVOX Engineへの接続を確認します。"),
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Botの応答状態を確認します。"),
  // addXxxOption / addSubcommand を呼ぶと推論型が SlashCommandBuilder では
  // なくなる（discord.js の仕様）ため、配列全体をキャストする。
] as unknown as SlashCommandBuilder[];

function slashTarget(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
): CommandTarget {
  return {
    guild,
    userId: interaction.user.id,
    voiceChannelId: getVoiceChannelId(interaction.member as GuildMember | null),
    notifyChannelId: interaction.channelId ?? "",
    isAdmin:
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ??
      false,
    respond: (title, description, color = EMBED_COLOR_INFO, components) =>
      replyEmbed(interaction, title, description, color, true, components),
  };
}

export async function handleChatInputCommand(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyEmbed(
      interaction,
      "⚠️ サーバー内で使用してください",
      "サーバー内で使用してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const guild = interaction.guild;
  if (!guild) {
    await replyEmbed(
      interaction,
      "⚠️ サーバー内で使用してください",
      "サーバー内で使用してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const target = slashTarget(interaction, guild);
  switch (interaction.commandName) {
    case "join":
      // VC接続の Ready 待ちは Discord の応答期限（3秒）を超えうるため先に defer する。
      // defer しないと接続できても応答だけ失敗する（Unknown Interaction）。
      await interaction.deferReply({ ephemeral: true });
      await doJoin(ctx, target);
      return;
    case "leave":
      await doLeave(ctx, target);
      return;
    case "say":
      await doSay(ctx, target, interaction.options.getString("text", true));
      return;
    case "speaker":
      await doSetSpeaker(
        ctx,
        target,
        interaction.options.getInteger("id", true),
      );
      return;
    case "status":
      await doStatus(ctx, target);
      return;
    case "queue":
      await doQueue(ctx, target);
      return;
    case "clear":
      await doClear(ctx, target);
      return;
    case "skip":
      await doSkip(ctx, target);
      return;
    case "volume":
      await doSetVolume(
        ctx,
        target,
        interaction.options.getNumber("value", true),
      );
      return;
    case "speed":
      await doSetSpeed(
        ctx,
        target,
        interaction.options.getNumber("value", true),
      );
      return;
    case "pitch":
      await doSetPitch(
        ctx,
        target,
        interaction.options.getNumber("value", true),
      );
      return;
    case "channel":
      await doChannel(
        ctx,
        target,
        interaction.options.getString("action", true),
        interaction.options.getChannel("channel", true).id,
      );
      return;
    case "user":
      await doUser(
        ctx,
        target,
        interaction.options.getString("action", true),
        interaction.options.getUser("user", true).id,
      );
      return;
    case "help":
      await doHelp(ctx, target);
      return;
    case "speakers":
      // VOICEVOX の応答が遅いと応答期限（3秒）を超えるため先に defer する。
      await interaction.deferReply({ ephemeral: true });
      await doSpeakers(ctx, target);
      return;
    case "pause":
      await doPause(ctx, target);
      return;
    case "resume":
      await doResume(ctx, target);
      return;
    case "remove":
      await doRemove(
        ctx,
        target,
        interaction.options.getInteger("index", true),
      );
      return;
    case "myvoice": {
      const sub = interaction.options.getSubcommand();
      if (sub === "set") {
        await doMyVoiceSet(ctx, target, {
          speaker: interaction.options.getInteger("speaker"),
          volume: interaction.options.getNumber("volume"),
          speed: interaction.options.getNumber("speed"),
          pitch: interaction.options.getNumber("pitch"),
        });
      } else if (sub === "show") {
        await doMyVoiceShow(ctx, target);
      } else if (sub === "reset") {
        await doMyVoiceReset(ctx, target);
      }
      return;
    }
    case "dict": {
      const sub = interaction.options.getSubcommand();
      if (sub === "add") {
        await doDictAdd(
          ctx,
          target,
          interaction.options.getString("word", true),
          interaction.options.getString("reading", true),
        );
      } else if (sub === "remove") {
        await doDictRemove(
          ctx,
          target,
          interaction.options.getString("word", true),
        );
      } else if (sub === "list") {
        await doDictList(ctx, target);
      }
      return;
    }
    case "toggle": {
      const sub = interaction.options.getSubcommand();
      if (sub === "on") await doToggle(ctx, target, true);
      else if (sub === "off") await doToggle(ctx, target, false);
      return;
    }
    case "voicevox":
      // speakers と同様、VOICEVOX の応答待ちで応答期限を超えないよう defer する。
      await interaction.deferReply({ ephemeral: true });
      await doVoicevox(ctx, target);
      return;
    case "ping":
      await doPing(ctx, target, interaction.client.ws.ping);
      return;
    default:
      await replyEmbed(
        interaction,
        "⚠️ 不明なコマンドです",
        "不明なコマンドです。",
        EMBED_COLOR_ERROR,
      );
      return;
  }
}

function buttonTarget(
  interaction: ButtonInteraction,
  guild: Guild,
): CommandTarget {
  return {
    guild,
    userId: interaction.user.id,
    voiceChannelId: getVoiceChannelId(interaction.member as GuildMember | null),
    notifyChannelId: interaction.channelId ?? "",
    isAdmin:
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ??
      false,
    respond: (title, description, color = EMBED_COLOR_INFO, components) =>
      replyEmbed(interaction, title, description, color, true, components),
  };
}

export async function handleButton(
  interaction: ButtonInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyEmbed(
      interaction,
      "⚠️ サーバー内で使用してください",
      "サーバー内で使用してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const guild = interaction.guild;
  if (!guild) {
    await replyEmbed(
      interaction,
      "⚠️ サーバー内で使用してください",
      "サーバー内で使用してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const target = buttonTarget(interaction, guild);
  switch (interaction.customId) {
    case "join_button":
      // スラッシュ版 join と同じく、接続待ちが応答期限を超えうるため defer する。
      await interaction.deferReply({ ephemeral: true });
      await doJoin(ctx, target);
      return;
    case "leave_button":
      await doLeave(ctx, target);
      return;
    case "status_button":
      await doStatus(ctx, target);
      return;
    case "queue_button":
      await doQueue(ctx, target);
      return;
    case "clear_button":
      // 元のGo版では権限チェックが無かった不具合を修正する。
      await doClear(ctx, target);
      return;
    default:
      await replyEmbed(
        interaction,
        "⚠️ 不明なボタンです",
        "不明なボタンです。",
        EMBED_COLOR_ERROR,
      );
      return;
  }
}
