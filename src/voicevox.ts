import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// VOICEVOX Engine との通信。audio_query → synthesis の2段階。
// VOICEVOXに接続できなくても例外を投げるだけで、Bot本体は落とさない。
export interface VoicevoxSpeakerStyle {
  id: number;
  name: string;
}

export interface VoicevoxSpeaker {
  name: string;
  styles: VoicevoxSpeakerStyle[];
}

export interface SynthOptions {
  speaker: number;
  volume: number;
  speed: number;
  pitch: number;
}

export class VoicevoxError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "VoicevoxError";
    this.status = status;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
const SPEAKERS_TIMEOUT_MS = 10_000;
// 合成音声のダウンロード全体（生成待ち＋受信）に許す上限。
// ヘッダだけ届いてボディが止まるケースでも合成待ちのまま固まらないようにする。
const SYNTH_TIMEOUT_MS = 120_000;

export interface VoicevoxTimeouts {
  requestMs?: number;
  speakersMs?: number;
  synthMs?: number;
}

export class VoicevoxClient {
  private baseUrl: string;
  private requestTimeoutMs: number;
  private speakersTimeoutMs: number;
  private synthTimeoutMs: number;

  constructor(baseUrl: string, timeouts: VoicevoxTimeouts = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.requestTimeoutMs = timeouts.requestMs ?? REQUEST_TIMEOUT_MS;
    this.speakersTimeoutMs = timeouts.speakersMs ?? SPEAKERS_TIMEOUT_MS;
    this.synthTimeoutMs = timeouts.synthMs ?? SYNTH_TIMEOUT_MS;
  }

  get url(): string {
    return this.baseUrl;
  }

  // fetch して、レスポンスボディの消費（handler）まで含めてタイムアウトを効かせる。
  // 以前は fetch の解決時点でタイマーを解除していたため、ヘッダ受信後に
  // ボディが止まると無期限に待ち続けていた（合成の直列化ロックごと全体が停止する）。
  private async fetchWithTimeout<T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    handler: (res: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === "AbortError") {
        throw new VoicevoxError(
          "VOICEVOXへの接続がタイムアウトしました。VOICEVOX Engineの状態を確認してください。",
        );
      }
      throw new VoicevoxError(
        "VOICEVOXに接続できませんでした。VOICEVOX Engineが起動しているか確認してください。",
      );
    }
    try {
      return await handler(res);
    } catch (error) {
      // 自分のタイムアウトで中断した場合は、ボディ読み取り側が汎用エラー
      // （JSONパース失敗など）に化かしていてもタイムアウトとして報告する。
      if (controller.signal.aborted) {
        throw new VoicevoxError(
          "VOICEVOXへの接続がタイムアウトしました。VOICEVOX Engineの状態を確認してください。",
        );
      }
      if (error instanceof VoicevoxError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new VoicevoxError(
          "VOICEVOXへの接続がタイムアウトしました。VOICEVOX Engineの状態を確認してください。",
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async getVersion(): Promise<string> {
    const text = await this.fetchWithTimeout(
      `${this.baseUrl}/version`,
      {},
      this.requestTimeoutMs,
      async (res) => {
        if (!res.ok) {
          throw new VoicevoxError(
            `VOICEVOXがエラーを返しました（HTTP ${res.status}）。`,
            res.status,
          );
        }
        return (await res.text()).trim();
      },
    );
    if (!text)
      throw new VoicevoxError("VOICEVOXの応答を読み取れませんでした。");
    return text.replace(/^"|"$/g, "");
  }

  async listSpeakers(): Promise<VoicevoxSpeaker[]> {
    return this.fetchWithTimeout(
      `${this.baseUrl}/speakers`,
      {},
      this.speakersTimeoutMs,
      async (res) => {
        if (!res.ok) {
          throw new VoicevoxError(
            `話者一覧の取得に失敗しました（HTTP ${res.status}）。`,
            res.status,
          );
        }
        let data: unknown;
        try {
          data = await res.json();
        } catch {
          throw new VoicevoxError("話者一覧の形式を読み取れませんでした。");
        }
        if (!Array.isArray(data)) {
          throw new VoicevoxError("話者一覧の形式を読み取れませんでした。");
        }
        return data as VoicevoxSpeaker[];
      },
    );
  }

  // text を合成し、WAVを destPath へストリーミング保存する。
  // maxBytes を超えたら途中のファイルを消してエラーを投げる。
  async synthesizeToFile(
    text: string,
    opts: SynthOptions,
    destPath: string,
    maxBytes: number,
  ): Promise<void> {
    const queryUrl = `${this.baseUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${opts.speaker}`;
    const query = await this.fetchWithTimeout(
      queryUrl,
      { method: "POST" },
      this.requestTimeoutMs,
      async (res) => {
        if (!res.ok) {
          throw new VoicevoxError(
            `VOICEVOXの音声クエリ作成に失敗しました（HTTP ${res.status}）。話者IDが正しいか確認してください。`,
            res.status,
          );
        }
        let parsed: unknown;
        try {
          parsed = await res.json();
        } catch {
          throw new VoicevoxError(
            "VOICEVOXの音声クエリ応答を読み取れませんでした。",
          );
        }
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          throw new VoicevoxError(
            "VOICEVOXの音声クエリ応答を読み取れませんでした。",
          );
        }
        return parsed as Record<string, unknown>;
      },
    );
    query.volumeScale = opts.volume;
    query.speedScale = opts.speed;
    query.pitchScale = opts.pitch;

    const synthUrl = `${this.baseUrl}/synthesis?speaker=${opts.speaker}`;
    await this.fetchWithTimeout(
      synthUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query),
      },
      this.synthTimeoutMs,
      async (res) => {
        if (!res.ok) {
          throw new VoicevoxError(
            `VOICEVOXの音声合成に失敗しました（HTTP ${res.status}）。`,
            res.status,
          );
        }
        if (!res.body) {
          throw new VoicevoxError("VOICEVOXの音声合成の応答が空でした。");
        }
        // pipeline を使うことで、書き込みエラー（ディスク不足等）の伝播、
        // バックプレッシャ、上限超過時の送信元キャンセルまで正しく扱う。
        // 以前の手書きループは WriteStream の 'error' を拾わず、書き込み失敗を
        // 成功と誤認したり、drain 待ちで固まったりする恐れがあった。
        let written = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            written += chunk.byteLength;
            if (written > maxBytes) {
              callback(
                new VoicevoxError(
                  `VOICEVOXの合成音声が上限（${maxBytes} バイト）を超えました。文章を短くしてください。`,
                ),
              );
              return;
            }
            callback(null, chunk);
          },
        });
        try {
          await pipeline(
            Readable.fromWeb(
              res.body as Parameters<typeof Readable.fromWeb>[0],
            ),
            counter,
            createWriteStream(destPath),
          );
        } catch (error) {
          await unlink(destPath).catch(() => undefined);
          if (error instanceof VoicevoxError) throw error;
          if (error instanceof Error && error.name === "AbortError")
            throw error;
          const message =
            error instanceof Error ? error.message : String(error);
          throw new VoicevoxError(
            `VOICEVOXの音声合成の保存に失敗しました: ${message}`,
          );
        }
        if (written === 0) {
          await unlink(destPath).catch(() => undefined);
          throw new VoicevoxError("VOICEVOXの音声合成の応答が空でした。");
        }
      },
    );
  }
}
