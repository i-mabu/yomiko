import { join } from "node:path";

// yomiko の環境変数を読み取り、正規化して返す。
// 秘密情報（DISCORD_TOKEN 等）の実値はここには書かない。
export interface YomikoConfig {
  token: string;
  applicationId: string | null;
  voicevoxUrl: string;
  defaultSpeaker: number;
  dataDir: string;
  cacheDir: string;
  cacheTtlMs: number;
  cacheMaxBytes: number;
  maxAudioBytes: number;
  guildId: string | null;
  autoLeaveDelayMs: number;
}

export const DEFAULT_VOICEVOX_URL = "http://localhost:50021";
export const DEFAULT_SPEAKER = 3;
export const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 168h
export const DEFAULT_CACHE_MAX_BYTES = 268435456; // 256MiB
export const DEFAULT_MAX_AUDIO_BYTES = 33554432; // 32MiB
export const DEFAULT_AUTO_LEAVE_DELAY_MS = 60_000;

// "168h" / "30m" / "7d" / "1000"（ミリ秒の数値）を受け付ける。
// 不正な値は fallbackMs を返す。
export function parseDurationMs(
  value: string | undefined,
  fallbackMs: number,
): number {
  if (!value) return fallbackMs;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    return Number.isFinite(ms) && ms >= 0 ? ms : fallbackMs;
  }
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([smhd])$/);
  if (!match) return fallbackMs;
  const n = Number(match[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as "s" | "m" | "h" | "d"
  ];
  const ms = n * unit;
  return Number.isFinite(ms) && ms >= 0 ? ms : fallbackMs;
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const trimmed = value.trim();
  // 空白のみの値は Number('') === 0 になってしまい、上限が 0（＝音声上限なら
  // 全件失敗、キャッシュ上限なら無制限）に化けるため、未設定として扱う。
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function loadConfig(): YomikoConfig {
  const token = process.env.DISCORD_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "DISCORD_TOKEN is required. Copy .env.example to .env and set it.",
    );
  }
  const speakerRaw = process.env.VOICEVOX_SPEAKER?.trim();
  let defaultSpeaker = DEFAULT_SPEAKER;
  if (speakerRaw) {
    const n = Number(speakerRaw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `VOICEVOX_SPEAKER is invalid: ${speakerRaw} (must be an integer >= 1)`,
      );
    }
    defaultSpeaker = n;
  }
  const dataDir = process.env.DATA_DIR?.trim() || "./data";
  const voicevoxUrl = (
    process.env.VOICEVOX_URL?.trim() || DEFAULT_VOICEVOX_URL
  ).replace(/\/+$/, "");
  // スキーム漏れ等の設定ミスは、起動時に分かりやすく落とす
  // （従来は再生のたびに「接続できませんでした」になっていた）。
  let parsedVoicevoxUrl: URL;
  try {
    parsedVoicevoxUrl = new URL(voicevoxUrl);
  } catch {
    throw new Error(
      `VOICEVOX_URL is invalid: ${voicevoxUrl} (must be a URL like http://localhost:50021)`,
    );
  }
  if (
    parsedVoicevoxUrl.protocol !== "http:" &&
    parsedVoicevoxUrl.protocol !== "https:"
  ) {
    throw new Error(
      `VOICEVOX_URL is invalid: ${voicevoxUrl} (must start with http:// or https://)`,
    );
  }
  return {
    token,
    applicationId: process.env.DISCORD_APPLICATION_ID?.trim() || null,
    voicevoxUrl,
    defaultSpeaker,
    dataDir,
    cacheDir:
      process.env.YOMIKO_CACHE_DIR?.trim() || join(dataDir, "cache", "tts"),
    cacheTtlMs: parseDurationMs(
      process.env.YOMIKO_CACHE_TTL,
      DEFAULT_CACHE_TTL_MS,
    ),
    cacheMaxBytes: parseIntEnv(
      process.env.YOMIKO_CACHE_MAX_BYTES,
      DEFAULT_CACHE_MAX_BYTES,
    ),
    maxAudioBytes: parseIntEnv(
      process.env.YOMIKO_MAX_AUDIO_BYTES,
      DEFAULT_MAX_AUDIO_BYTES,
    ),
    guildId: process.env.DISCORD_GUILD_ID?.trim() || null,
    autoLeaveDelayMs: parseIntEnv(
      process.env.YOMIKO_AUTO_LEAVE_DELAY_MS,
      DEFAULT_AUTO_LEAVE_DELAY_MS,
    ),
  };
}
