import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

// ==========================================
// 💾 永続化設定
// ==========================================
// yomiko の永続化設定。Node 標準 SQLite（node:sqlite）を使う。
// 元の settings.json の内容をそのまま SQLite 化したもの。
export interface GuildSettings {
  guildId: string;
  speaker: number;
  volume: number;
  speed: number;
  pitch: number;
  enabled: boolean;
}

export interface UserVoice {
  guildId: string;
  userId: string;
  speaker: number | null;
  volume: number | null;
  speed: number | null;
  pitch: number | null;
}

export interface DictEntry {
  guildId: string;
  word: string;
  reading: string;
}

export type ChannelMode = "allow" | "block";

export const DEFAULT_VOLUME = 1.0;
export const DEFAULT_SPEED = 1.0;
export const DEFAULT_PITCH = 0;

export class YomikoStore {
  private db: DatabaseSync;
  private defaultSpeaker: number;
  private closed = false;
  // 💾 prepare 済み文のキャッシュ。メッセージごとの判定（isExcluded 等）で
  // 同じ SQL を毎回パースし直さないようにする。
  private statements = new Map<string, StatementSync>();

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  constructor(dataDir: string, defaultSpeaker: number) {
    mkdirSync(dataDir, { recursive: true });
    this.defaultSpeaker = defaultSpeaker;
    this.db = new DatabaseSync(join(dataDir, "yomiko.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        speaker INTEGER NOT NULL,
        volume REAL NOT NULL,
        speed REAL NOT NULL,
        pitch REAL NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS guild_channels (
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS guild_users (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        blocked INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS user_voices (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        speaker INTEGER,
        volume REAL,
        speed REAL,
        pitch REAL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS dict (
        guild_id TEXT NOT NULL,
        word TEXT NOT NULL,
        reading TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, word)
      );
    `);
  }

  private now(): string {
    return new Date().toISOString();
  }

  getGuildSettings(guildId: string): GuildSettings {
    const row = this.stmt(
      "SELECT speaker, volume, speed, pitch, enabled FROM guild_settings WHERE guild_id = ?",
    ).get(guildId) as
      | {
          speaker: number;
          volume: number;
          speed: number;
          pitch: number;
          enabled: number;
        }
      | undefined;
    if (!row) {
      return {
        guildId,
        speaker: this.defaultSpeaker,
        volume: DEFAULT_VOLUME,
        speed: DEFAULT_SPEED,
        pitch: DEFAULT_PITCH,
        enabled: true,
      };
    }
    return {
      guildId,
      speaker: row.speaker,
      volume: row.volume,
      speed: row.speed,
      pitch: row.pitch,
      enabled: row.enabled !== 0,
    };
  }

  setGuildSettings(
    guildId: string,
    patch: Partial<Omit<GuildSettings, "guildId">>,
  ): GuildSettings {
    const current = this.getGuildSettings(guildId);
    const next: GuildSettings = { ...current, ...patch, guildId };
    this.stmt(
      `INSERT INTO guild_settings (guild_id, speaker, volume, speed, pitch, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET
           speaker = excluded.speaker, volume = excluded.volume,
           speed = excluded.speed, pitch = excluded.pitch,
           enabled = excluded.enabled, updated_at = excluded.updated_at`,
    ).run(
      guildId,
      next.speaker,
      next.volume,
      next.speed,
      next.pitch,
      next.enabled ? 1 : 0,
      this.now(),
    );
    return next;
  }

  getChannelMode(guildId: string, channelId: string): ChannelMode | null {
    const row = this.stmt(
      "SELECT mode FROM guild_channels WHERE guild_id = ? AND channel_id = ?",
    ).get(guildId, channelId) as { mode: ChannelMode } | undefined;
    return row?.mode ?? null;
  }

  setChannelMode(guildId: string, channelId: string, mode: ChannelMode): void {
    this.stmt(
      `INSERT INTO guild_channels (guild_id, channel_id, mode, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id, channel_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
    ).run(guildId, channelId, mode, this.now());
  }

  removeChannel(guildId: string, channelId: string): void {
    this.stmt(
      "DELETE FROM guild_channels WHERE guild_id = ? AND channel_id = ?",
    ).run(guildId, channelId);
  }

  listChannels(
    guildId: string,
  ): Array<{ channelId: string; mode: ChannelMode }> {
    const rows = this.stmt(
      "SELECT channel_id AS channelId, mode FROM guild_channels WHERE guild_id = ? ORDER BY mode, channel_id",
    ).all(guildId) as Array<{ channelId: string; mode: ChannelMode }>;
    // 📌 node:sqlite の行はプロトタイプが特殊なため、プレーンなオブジェクトに変換する
    return rows.map((r) => ({ channelId: r.channelId, mode: r.mode }));
  }

  isUserBlocked(guildId: string, userId: string): boolean {
    const row = this.stmt(
      "SELECT blocked FROM guild_users WHERE guild_id = ? AND user_id = ?",
    ).get(guildId, userId) as { blocked: number } | undefined;
    return row?.blocked === 1;
  }

  setUserBlocked(guildId: string, userId: string, blocked: boolean): void {
    if (blocked) {
      this.stmt(
        `INSERT INTO guild_users (guild_id, user_id, blocked, updated_at) VALUES (?, ?, 1, ?)
           ON CONFLICT(guild_id, user_id) DO UPDATE SET blocked = 1, updated_at = excluded.updated_at`,
      ).run(guildId, userId, this.now());
    } else {
      this.stmt(
        "DELETE FROM guild_users WHERE guild_id = ? AND user_id = ?",
      ).run(guildId, userId);
    }
  }

  // 🚫 除外判定（元の isExcluded と同じ優先順）:
  // ①禁止ユーザー → ②禁止チャンネル → ③許可チャンネルが1件以上あり当該チャンネルが未登録
  isExcluded(guildId: string, channelId: string, userId: string): boolean {
    if (this.isUserBlocked(guildId, userId)) return true;
    const mode = this.getChannelMode(guildId, channelId);
    if (mode === "block") return true;
    if (mode === "allow") return false;
    const rows = this.stmt(
      "SELECT 1 FROM guild_channels WHERE guild_id = ? AND mode = 'allow' LIMIT 1",
    ).all(guildId);
    return rows.length > 0;
  }

  getUserVoice(guildId: string, userId: string): UserVoice {
    const row = this.stmt(
      "SELECT speaker, volume, speed, pitch FROM user_voices WHERE guild_id = ? AND user_id = ?",
    ).get(guildId, userId) as
      | {
          speaker: number | null;
          volume: number | null;
          speed: number | null;
          pitch: number | null;
        }
      | undefined;
    return {
      guildId,
      userId,
      speaker: row?.speaker ?? null,
      volume: row?.volume ?? null,
      speed: row?.speed ?? null,
      pitch: row?.pitch ?? null,
    };
  }

  setUserVoice(
    guildId: string,
    userId: string,
    patch: Partial<Omit<UserVoice, "guildId" | "userId">>,
  ): UserVoice {
    const current = this.getUserVoice(guildId, userId);
    const next: UserVoice = { ...current, ...patch, guildId, userId };
    this.stmt(
      `INSERT INTO user_voices (guild_id, user_id, speaker, volume, speed, pitch, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, user_id) DO UPDATE SET
           speaker = excluded.speaker, volume = excluded.volume,
           speed = excluded.speed, pitch = excluded.pitch, updated_at = excluded.updated_at`,
    ).run(
      guildId,
      userId,
      next.speaker,
      next.volume,
      next.speed,
      next.pitch,
      this.now(),
    );
    return next;
  }

  resetUserVoice(guildId: string, userId: string): void {
    this.stmt("DELETE FROM user_voices WHERE guild_id = ? AND user_id = ?").run(
      guildId,
      userId,
    );
  }

  addDict(guildId: string, word: string, reading: string): void {
    this.stmt(
      `INSERT INTO dict (guild_id, word, reading, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id, word) DO UPDATE SET reading = excluded.reading, updated_at = excluded.updated_at`,
    ).run(guildId, word, reading, this.now());
  }

  removeDict(guildId: string, word: string): boolean {
    const result = this.stmt(
      "DELETE FROM dict WHERE guild_id = ? AND word = ?",
    ).run(guildId, word);
    return result.changes > 0;
  }

  listDict(guildId: string): DictEntry[] {
    const rows = this.stmt(
      "SELECT guild_id AS guildId, word, reading FROM dict WHERE guild_id = ? ORDER BY word",
    ).all(guildId) as unknown as DictEntry[];
    // 📌 node:sqlite の行はプロトタイプが特殊なため、プレーンなオブジェクトに変換する
    return rows.map((r) => ({
      guildId: r.guildId,
      word: r.word,
      reading: r.reading,
    }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }
}
