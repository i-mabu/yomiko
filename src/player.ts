// ==========================================
// 🔊 再生層
// ==========================================
// yomiko の再生層。ギルドごとの読み上げキューと VC 再生を管理する。
// VOICEVOX合成 → TTSキャッシュ → WAV→PCM変換 → @discordjs/voice で再生。
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import { ttsCacheKey, type TtsCache } from "./ttsCache.js";
import type { YomikoStore } from "./store.js";
import type { VoicevoxClient } from "./voicevox.js";
import { wavToDiscordPcm } from "./wav.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// 🔊 再生開始を待つ上限（元の Go 版の文全体 45 秒タイムアウト相当）。
const PLAY_TIMEOUT_MS = 45_000;
// ⏳ VC 接続の Ready 待ち上限。
const JOIN_TIMEOUT_MS = 15_000;
// 🔊 再生失敗時のリトライ回数（初回 + リトライ 1 回 = 最大 2 回試行）と間隔。
const MAX_PLAY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;
// 📋 キュー空・一時停止中のポーリング間隔。
const EMPTY_QUEUE_WAIT_MS = 100;
const PAUSED_WAIT_MS = 200;

export interface QueueItem {
  text: string;
  authorId: string;
}

// 📋 純粋な読み上げキュー。Discord 接続なしでテストできる。
export class SpeechQueue {
  private items: QueueItem[] = [];
  private pausedFlag = false;

  constructor(private capacity = 30) {}

  get length(): number {
    return this.items.length;
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  // 📌 満杯なら false を返し、ブロックしない。
  enqueue(item: QueueItem): boolean {
    if (this.items.length >= this.capacity) return false;
    this.items.push(item);
    return true;
  }

  dequeue(): QueueItem | undefined {
    return this.items.shift();
  }

  // 📌 待機中の全件（コピー）。
  peekAll(): QueueItem[] {
    return [...this.items];
  }

  // 📌 消した件数を返す。
  clear(): number {
    const count = this.items.length;
    this.items = [];
    return count;
  }

  // 📌 0 始まり。範囲外は null。
  remove(index: number): QueueItem | null {
    if (index < 0 || index >= this.items.length) return null;
    const [removed] = this.items.splice(index, 1);
    return removed ?? null;
  }

  pause(): void {
    this.pausedFlag = true;
  }

  resume(): void {
    this.pausedFlag = false;
  }
}

export interface PlayerDeps {
  store: YomikoStore;
  voicevox: VoicevoxClient;
  cache: TtsCache;
  defaultSpeaker: number;
  maxAudioBytes: number;
  notifyError: (guildId: string, channelId: string, message: string) => void;
}

export interface PlayerStatus {
  connected: boolean;
  channelId: string | null;
  queueLength: number;
  paused: boolean;
  current: string | null;
}

export class GuildPlayer {
  readonly guildId: string;
  private deps: PlayerDeps;
  private queue = new SpeechQueue();
  private connection: VoiceConnection | null = null;
  private audioPlayer: AudioPlayer | null = null;
  private channelIdValue: string | null = null;
  private notifyChannelIdValue: string | null = null;
  private currentTextValue: string | null = null;
  private skipRequested = false;
  private destroyed = false;
  private joining = false;
  private autoLeaveTimer: NodeJS.Timeout | null = null;
  // 🔊 再生ループの世代。leave/destroy/join で進め、古いループを終了させる。
  private loopGeneration = 0;

  constructor(guildId: string, deps: PlayerDeps) {
    this.guildId = guildId;
    this.deps = deps;
  }

  get status(): PlayerStatus {
    return {
      connected: this.connection !== null,
      channelId: this.channelIdValue,
      queueLength: this.queue.length,
      paused: this.queue.paused,
      current: this.currentTextValue,
    };
  }

  // 🚪 接続中の VC チャンネル ID。未接続は null。
  get channelId(): string | null {
    return this.channelIdValue;
  }

  get notifyChannelId(): string | null {
    return this.notifyChannelIdValue;
  }

  get paused(): boolean {
    return this.queue.paused;
  }

  get currentText(): string | null {
    return this.currentTextValue;
  }

  // 🚪 VC に参加する。既に接続中なら false。
  // adapterCreator は discord.js の guild.voiceAdapterCreator をそのまま渡す。
  // 型は joinVoiceChannel が要求する DiscordGatewayAdapterCreator へキャストする。
  async join(
    voiceChannelId: string,
    adapterCreator: unknown,
    notifyChannelId: string,
  ): Promise<boolean> {
    if (this.connection || this.joining) return false;
    this.joining = true;
    this.destroyed = false;
    try {
      let connection: VoiceConnection;
      try {
        connection = joinVoiceChannel({
          channelId: voiceChannelId,
          guildId: this.guildId,
          adapterCreator: adapterCreator as DiscordGatewayAdapterCreator,
          selfDeaf: true,
          selfMute: false,
        });
      } catch (error) {
        console.error(
          `[yomiko] VCへの参加に失敗しました guild=${this.guildId}:`,
          error,
        );
        return false;
      }
      const audioPlayer = createAudioPlayer();
      // ⚠️ AudioPlayer / VoiceConnection は 'error' を emit する。リスナーが無いと
      // Node の EventEmitter が例外を投げ、プロセスごと落ちるため必ず登録する。
      audioPlayer.on("error", (error) => {
        console.error(
          `[yomiko] AudioPlayerでエラーが発生しました guild=${this.guildId}:`,
          error,
        );
      });
      connection.on("error", (error) => {
        console.error(
          `[yomiko] VoiceConnectionでエラーが発生しました guild=${this.guildId}:`,
          error,
        );
      });
      connection.on(VoiceConnectionStatus.Disconnected, () => {
        void this.handleDisconnected(connection);
      });
      connection.subscribe(audioPlayer);
      try {
        await entersState(
          connection,
          VoiceConnectionStatus.Ready,
          JOIN_TIMEOUT_MS,
        );
      } catch {
        connection.destroy();
        return false;
      }
      // ⏳ Ready 待ちの間に leave/destroy されていたら接続を確定しない。
      if (this.destroyed) {
        connection.destroy();
        return false;
      }
      this.connection = connection;
      this.audioPlayer = audioPlayer;
      this.channelIdValue = voiceChannelId;
      this.notifyChannelIdValue = notifyChannelId;
      this.loopGeneration++;
      void this.playLoop();
      return true;
    } finally {
      this.joining = false;
    }
  }

  // ⏳ 切断状態になったら、再接続中（Signalling/Connecting）への遷移を少し待ち、
  // 戻らなければゾンビ接続を残さず後始末する（@discordjs/voice の推奨パターン）。
  private async handleDisconnected(connection: VoiceConnection): Promise<void> {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      if (this.connection === connection) {
        this.cleanup();
      } else {
        try {
          connection.destroy();
        } catch {
          // ⚠️ 破棄中のエラーは無視する
        }
      }
    }
  }

  // 🚪 Bot が管理者の操作等で別VCへ移動させられたときに、保持している
  // チャンネルIDを実態へ合わせる（自動退出判定が旧チャンネルを見ないように）。
  syncChannelId(channelId: string): void {
    this.channelIdValue = channelId;
  }

  // 🚪 VC から切断する。未接続なら false。再生ループも終了させる。
  leave(): boolean {
    if (!this.connection) return false;
    this.cleanup();
    return true;
  }

  enqueue(text: string, authorId: string): "ok" | "full" | "not-connected" {
    if (!this.connection) return "not-connected";
    return this.queue.enqueue({ text, authorId }) ? "ok" : "full";
  }

  // 📋 再生中の文が無ければ false。あれば AudioPlayer を止めて true（待機キューは残る）。
  skip(): boolean {
    if (!this.currentTextValue) return false;
    this.skipRequested = true;
    if (this.audioPlayer) {
      this.audioPlayer.stop();
    }
    return true;
  }

  // 📋 待機キューをすべて破棄する（再生中の文は止めない）。消した件数を返す。
  clearQueue(): number {
    return this.queue.clear();
  }

  // 📌 0 始まり。範囲外は null。
  removeFromQueue(index: number): QueueItem | null {
    return this.queue.remove(index);
  }

  pause(): void {
    this.queue.pause();
  }

  resume(): void {
    this.queue.resume();
  }

  queueList(): QueueItem[] {
    return this.queue.peekAll();
  }

  // 🚪 自動退出タイマー。既存タイマーがあれば置き換える。
  startAutoLeaveTimer(delayMs: number, onTimeout: () => void): void {
    this.cancelAutoLeaveTimer();
    this.autoLeaveTimer = setTimeout(() => {
      this.autoLeaveTimer = null;
      onTimeout();
    }, delayMs);
  }

  cancelAutoLeaveTimer(): void {
    if (this.autoLeaveTimer) {
      clearTimeout(this.autoLeaveTimer);
      this.autoLeaveTimer = null;
    }
  }

  // 📌 leave と同じ後始末。プロセス終了時用。
  destroy(): void {
    this.destroyed = true;
    this.cleanup();
  }

  private cleanup(): void {
    this.loopGeneration++;
    this.cancelAutoLeaveTimer();
    this.queue.clear();
    this.currentTextValue = null;
    this.skipRequested = false;
    const player = this.audioPlayer;
    this.audioPlayer = null;
    if (player) {
      try {
        player.stop();
      } catch {
        // ⚠️ 破棄中のエラーは無視する
      }
    }
    const connection = this.connection;
    this.connection = null;
    this.channelIdValue = null;
    this.notifyChannelIdValue = null;
    if (connection) {
      try {
        connection.destroy();
      } catch {
        // ⚠️ 破棄中のエラーは無視する
      }
    }
  }

  // 📋 接続中かつ破棄されていない間、キューを1件ずつ再生する。
  private async playLoop(): Promise<void> {
    const connection = this.connection;
    const generation = this.loopGeneration;
    while (
      this.connection === connection &&
      this.connection !== null &&
      this.loopGeneration === generation &&
      !this.destroyed
    ) {
      try {
        if (this.queue.paused) {
          await sleep(PAUSED_WAIT_MS);
          continue;
        }
        const item = this.queue.dequeue();
        if (!item) {
          await sleep(EMPTY_QUEUE_WAIT_MS);
          continue;
        }
        this.currentTextValue = item.text;
        this.skipRequested = false;
        try {
          let lastError: unknown = null;
          for (let attempt = 0; attempt < MAX_PLAY_ATTEMPTS; attempt++) {
            // 🔁 leave/destroy されたらリトライせずループを抜ける。
            if (this.connection !== connection || this.destroyed) {
              lastError = null;
              break;
            }
            if (this.skipRequested) {
              this.skipRequested = false;
              lastError = null;
              break;
            }
            try {
              await this.playItem(item);
              lastError = null;
              break;
            } catch (error) {
              lastError = error;
              // 🔁 スキップされた場合はリトライしない。
              if (this.skipRequested) {
                this.skipRequested = false;
                lastError = null;
                break;
              }
              if (attempt + 1 < MAX_PLAY_ATTEMPTS) {
                await sleep(RETRY_DELAY_MS);
              }
            }
          }
          if (
            lastError !== null &&
            this.connection === connection &&
            !this.destroyed
          ) {
            const notifyChannelId = this.notifyChannelIdValue;
            if (notifyChannelId) {
              this.deps.notifyError(
                this.guildId,
                notifyChannelId,
                "音声の生成または再生に失敗しました。VOICEVOXの状態を確認してください。",
              );
            }
          }
        } finally {
          this.currentTextValue = null;
        }
      } catch (error) {
        // ⚠️ ループ内の例外はログに出し、ループを止めない。
        console.error(
          `[yomiko] 再生ループでエラーが発生しました guild=${this.guildId}:`,
          error,
        );
      }
    }
  }

  // 🔊 1文を合成して再生し、再生完了（Idle）まで待つ。
  private async playItem(item: QueueItem): Promise<void> {
    const settings = this.deps.store.getGuildSettings(this.guildId);
    const userVoice = this.deps.store.getUserVoice(this.guildId, item.authorId);
    const speaker = userVoice.speaker ?? settings.speaker;
    const volume = userVoice.volume ?? settings.volume;
    const speed = userVoice.speed ?? settings.speed;
    const pitch = userVoice.pitch ?? settings.pitch;
    const key = ttsCacheKey(item.text, speaker, volume, speed, pitch);
    const wavPath = await this.deps.cache.ensure(key, (tmp) =>
      this.deps.voicevox.synthesizeToFile(
        item.text,
        { speaker, volume, speed, pitch },
        tmp,
        this.deps.maxAudioBytes,
      ),
    );
    // 🔊 合成中にスキップされた場合は再生しない。
    if (this.skipRequested) {
      this.skipRequested = false;
      return;
    }
    const pcm = wavToDiscordPcm(readFileSync(wavPath));
    if (this.skipRequested) {
      this.skipRequested = false;
      return;
    }
    const player = this.audioPlayer;
    if (!player) {
      throw new Error("AudioPlayer がありません。");
    }
    const resource = createAudioResource(Readable.from([pcm]), {
      inputType: StreamType.Raw,
    });
    player.play(resource);
    // ⏭️ スキップ時は stop により Idle になるのでそのまま次へ進む。
    try {
      await entersState(player, AudioPlayerStatus.Idle, PLAY_TIMEOUT_MS);
    } catch (error) {
      // ⏳ タイムアウト等で待ちを諦めた場合、再生は止まっていない。
      // 止めずにリトライすると同じ文が重なって再生されるため、必ず止める
      // （元の Go 版はコンテキストのキャンセルで再生自体が止まっていた）。
      try {
        player.stop();
      } catch {
        // ⚠️ 破棄中のエラーは無視する
      }
      throw error;
    }
  }
}

export class PlayerManager {
  private players = new Map<string, GuildPlayer>();
  private deps: PlayerDeps;

  constructor(deps: PlayerDeps) {
    this.deps = deps;
  }

  get(guildId: string): GuildPlayer | undefined {
    return this.players.get(guildId);
  }

  getOrCreate(guildId: string): GuildPlayer {
    let player = this.players.get(guildId);
    if (!player) {
      player = new GuildPlayer(guildId, this.deps);
      this.players.set(guildId, player);
    }
    return player;
  }

  destroyAll(): void {
    for (const player of this.players.values()) {
      player.destroy();
    }
    this.players.clear();
  }
}
