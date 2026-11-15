import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";

// TTSキャッシュ。元の yomiage（パッチ0001）の仕様を再現する。
// キー = SHA-256("v1" + 本文 + 話者 + 音量 + 速度 + ピッチ)。
// ファイルは <cacheDir>/<sha256hex>.wav。TTL超過・容量超過は mtime の古いものから削除。
export function formatVoiceFloat(value: number, fallback: number): string {
  if (!Number.isFinite(value)) return String(fallback);
  return String(value);
}

export function ttsCacheKey(
  text: string,
  speaker: number,
  volume: number,
  speed: number,
  pitch: number,
): string {
  const hash = createHash("sha256");
  hash.update("v1\0");
  hash.update(text);
  hash.update("\0");
  hash.update(String(speaker));
  hash.update("\0");
  hash.update(formatVoiceFloat(volume, 1));
  hash.update("\0");
  hash.update(formatVoiceFloat(speed, 1));
  hash.update("\0");
  hash.update(formatVoiceFloat(pitch, 0));
  return hash.digest("hex");
}

export interface TtsCacheOptions {
  ttlMs: number;
  maxBytes: number;
}

export class TtsCache {
  private cacheDir: string;
  private ttlMs: number;
  private maxBytes: number;
  // 合成の直列化（低メモリ環境のピーク抑制。元の synthMu 相当）。
  private mutex: Promise<void> = Promise.resolve();

  constructor(cacheDir: string, opts: TtsCacheOptions) {
    mkdirSync(cacheDir, { recursive: true });
    this.cacheDir = cacheDir;
    this.ttlMs = opts.ttlMs;
    this.maxBytes = opts.maxBytes;
  }

  getPath(key: string): string {
    return join(this.cacheDir, `${key}.wav`);
  }

  private isExpired(mtimeMs: number, nowMs: number): boolean {
    return this.ttlMs > 0 && nowMs - mtimeMs >= this.ttlMs;
  }

  // ヒットしたら mtime を更新（LRUの基準は mtime）してパスを返す。
  get(key: string): string | null {
    const path = this.getPath(key);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return null;
    }
    if (stat.size <= 0) return null;
    const now = new Date();
    if (this.isExpired(stat.mtimeMs, now.getTime())) return null;
    try {
      utimesSync(path, now, now);
    } catch {
      // mtime 更新の失敗はヒット扱いのままにする
    }
    return path;
  }

  // 一時ファイルを正式ファイル名へ原子移動し、GCする。
  put(key: string, tmpPath: string): void {
    const dest = this.getPath(key);
    renameSync(tmpPath, dest);
    this.gc(dest);
  }

  // 期限切れの削除 → 容量超過なら mtime の古いものから削除。
  gc(excludePath?: string): void {
    let entries: string[];
    try {
      entries = readdirSync(this.cacheDir).filter((name) =>
        name.endsWith(".wav"),
      );
    } catch {
      return;
    }
    const nowMs = Date.now();
    const infos: Array<{ path: string; mtimeMs: number; size: number }> = [];
    let total = 0;
    for (const name of entries) {
      const path = join(this.cacheDir, name);
      if (excludePath && path === excludePath) {
        try {
          const s = statSync(path);
          total += s.size;
        } catch {
          // 無視
        }
        continue;
      }
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (this.isExpired(stat.mtimeMs, nowMs)) {
        try {
          unlinkSync(path);
        } catch {
          // 無視
        }
        continue;
      }
      infos.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
      total += stat.size;
    }
    if (this.maxBytes > 0 && total > this.maxBytes) {
      infos.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const info of infos) {
        if (total <= this.maxBytes) break;
        try {
          unlinkSync(info.path);
          total -= info.size;
        } catch {
          // 無視
        }
      }
    }
  }

  // キャッシュが無ければ synth(tmpPath) で合成して保存する。合成は直列化する。
  async ensure(
    key: string,
    synth: (tmpPath: string) => Promise<void>,
  ): Promise<string> {
    const hit = this.get(key);
    if (hit) return hit;
    const run = this.mutex.then(async () => {
      const hitAgain = this.get(key);
      if (hitAgain) return hitAgain;
      const tmpPath = join(this.cacheDir, `.tts-${randomUUID()}.wav.tmp`);
      try {
        await synth(tmpPath);
      } catch (error) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // 無視（synth 側で消している場合もある）
        }
        throw error;
      }
      if (!existsSync(tmpPath)) {
        throw new Error("TTS合成の結果ファイルが作成されませんでした。");
      }
      try {
        this.put(key, tmpPath);
      } catch (error) {
        // rename 等に失敗した場合は一時ファイルを残さない
        // （.tmp は GC 対象外のため、残ると溜まり続ける）。
        try {
          unlinkSync(tmpPath);
        } catch {
          // 無視
        }
        throw error;
      }
      return this.getPath(key);
    });
    // 直列化チェーンが壊れないよう、失敗もチェーンに残さない
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
