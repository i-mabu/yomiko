import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { normalizeText } from "../normalize.js";
import { parseWav } from "../wav.js";
import { VoicevoxClient, VoicevoxError } from "../voicevox.js";
import { TtsCache, ttsCacheKey } from "../ttsCache.js";
import { YomikoStore } from "../store.js";
import {
  loadConfig,
  DEFAULT_MAX_AUDIO_BYTES,
  DEFAULT_CACHE_MAX_BYTES,
} from "../config.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "yomiko-regression-"));
}

// --- WAV 組み立てヘルパー（チャンク順や宣言サイズを細かく制御する） ---
function chunk(id: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  const pad = payload.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([header, payload, pad]);
}

function fmtPayload(sampleRate: number, channels: number): Buffer {
  const p = Buffer.alloc(16);
  p.writeUInt16LE(1, 0); // PCM
  p.writeUInt16LE(channels, 2);
  p.writeUInt32LE(sampleRate, 4);
  p.writeUInt32LE(sampleRate * channels * 2, 8);
  p.writeUInt16LE(channels * 2, 12);
  p.writeUInt16LE(16, 14);
  return p;
}

function sampleData(samples: number[]): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  return data;
}

function riff(chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function makeWavBytes(sampleCount: number): Buffer {
  const samples = Array.from({ length: sampleCount }, (_, i) => i * 10 - 100);
  return riff([
    chunk("fmt ", fmtPayload(24000, 1)),
    chunk("data", sampleData(samples)),
  ]);
}

describe("normalizeText dict (regression)", () => {
  it("置換後の読みが別の辞書エントリで再置換されない", () => {
    // 旧実装（split/join の繰り返し）では 猫→犬 の後に 犬→いぬ が効いて
    // 「いぬ」になってしまっていた。
    const dict = [
      { word: "猫", reading: "犬" },
      { word: "犬", reading: "いぬ" },
    ];
    assert.equal(normalizeText("猫", dict), "犬");
    assert.equal(normalizeText("猫と犬", dict), "犬といぬ");
    assert.equal(normalizeText("猫と猫", dict), "犬と犬");
  });

  it("置換で生まれた文字列が隣のエントリと結合して再置換されない", () => {
    const dict = [
      { word: "ab", reading: "bc" },
      { word: "bc", reading: "X" },
    ];
    assert.equal(normalizeText("ab", dict), "bc");
    assert.equal(normalizeText("bc", dict), "X");
  });

  it("重なる候補では左端・最長を優先する", () => {
    const dict = [
      { word: "bc", reading: "Y" },
      { word: "ab", reading: "X" },
    ];
    assert.equal(normalizeText("abc", dict), "Xc");
    const longest = [
      { word: "草", reading: "くさ" },
      { word: "草生える", reading: "くさはえる" },
    ];
    assert.equal(normalizeText("草生える", longest), "くさはえる");
  });
});

describe("parseWav (regression)", () => {
  it("fmt チャンクが data チャンクより後ろにあっても読める", () => {
    const wav = riff([
      chunk("data", sampleData([100, -100, 200, -200])),
      chunk("fmt ", fmtPayload(24000, 1)),
    ]);
    const pcm = parseWav(wav);
    assert.equal(pcm.sampleRate, 24000);
    assert.equal(pcm.channels, 1);
    assert.deepEqual([...pcm.samples], [100, -100, 200, -200]);
  });

  it("data の宣言サイズが実バイト数より大きくても、ある分だけ読む", () => {
    const data = sampleData([10, 20, 30]);
    const lyingHeader = Buffer.alloc(8);
    lyingHeader.write("data", 0, "ascii");
    lyingHeader.writeUInt32LE(data.length + 100, 4); // 実物より大きく宣言
    const wav = riff([
      chunk("fmt ", fmtPayload(24000, 1)),
      Buffer.concat([lyingHeader, data]),
    ]);
    const pcm = parseWav(wav);
    assert.deepEqual([...pcm.samples], [10, 20, 30]);
  });

  it("奇数サイズの JUNK チャンク（パディング付き）を読み飛ばせる", () => {
    const wav = riff([
      chunk("JUNK", Buffer.from([1, 2, 3])),
      chunk("fmt ", fmtPayload(24000, 1)),
      chunk("data", sampleData([7, -7])),
    ]);
    const pcm = parseWav(wav);
    assert.deepEqual([...pcm.samples], [7, -7]);
  });
});

describe("VoicevoxClient (regression)", () => {
  let server: Server;
  let baseUrl: string;
  let handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void;

  const okHandler =
    (wav: Buffer) =>
    (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => {
      if (req.url?.startsWith("/audio_query")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ volumeScale: 1, speedScale: 1, pitchScale: 0 }),
        );
      } else if (req.url?.startsWith("/synthesis")) {
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(wav);
      } else {
        res.writeHead(404);
        res.end();
      }
    };

  beforeEach(async () => {
    handler = okHandler(makeWavBytes(4));
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("maxBytes を超えたらファイルを残さず VoicevoxError を投げる", async () => {
    handler = okHandler(makeWavBytes(200)); // 約440バイト
    const dir = tempDir();
    try {
      const client = new VoicevoxClient(baseUrl);
      const dest = join(dir, "out.wav");
      await assert.rejects(
        () =>
          client.synthesizeToFile(
            "テスト",
            { speaker: 3, volume: 1, speed: 1, pitch: 0 },
            dest,
            100,
          ),
        (error: unknown) =>
          error instanceof VoicevoxError && /上限/.test(error.message),
      );
      assert.equal(existsSync(dest), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("書き込み先が作れない場合はクラッシュせず VoicevoxError を投げる", async () => {
    const dir = tempDir();
    try {
      const client = new VoicevoxClient(baseUrl);
      const dest = join(dir, "no-such-dir", "out.wav");
      await assert.rejects(
        () =>
          client.synthesizeToFile(
            "テスト",
            { speaker: 3, volume: 1, speed: 1, pitch: 0 },
            dest,
            1024 * 1024,
          ),
        (error: unknown) =>
          error instanceof VoicevoxError && /保存に失敗/.test(error.message),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("audio_query の応答がオブジェクトでなければ VoicevoxError を投げる", async () => {
    handler = (req, res) => {
      if (req.url?.startsWith("/audio_query")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([1, 2, 3]));
      } else {
        res.writeHead(404);
        res.end();
      }
    };
    const dir = tempDir();
    try {
      const client = new VoicevoxClient(baseUrl);
      await assert.rejects(
        () =>
          client.synthesizeToFile(
            "テスト",
            { speaker: 3, volume: 1, speed: 1, pitch: 0 },
            join(dir, "out.wav"),
            1024,
          ),
        (error: unknown) =>
          error instanceof VoicevoxError &&
          /読み取れませんでした/.test(error.message),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("synthesis のボディが途中で止まってもタイムアウトで失敗する", async () => {
    handler = (req, res) => {
      if (req.url?.startsWith("/audio_query")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ volumeScale: 1, speedScale: 1, pitchScale: 0 }),
        );
      } else if (req.url?.startsWith("/synthesis")) {
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.write(Buffer.alloc(16, 1)); // 一部だけ送って止まる
      } else {
        res.writeHead(404);
        res.end();
      }
    };
    const dir = tempDir();
    try {
      const client = new VoicevoxClient(baseUrl, {
        requestMs: 300,
        speakersMs: 300,
        synthMs: 300,
      });
      const dest = join(dir, "out.wav");
      const started = Date.now();
      await assert.rejects(
        () =>
          client.synthesizeToFile(
            "テスト",
            { speaker: 3, volume: 1, speed: 1, pitch: 0 },
            dest,
            1024 * 1024,
          ),
        (error: unknown) =>
          error instanceof VoicevoxError && /タイムアウト/.test(error.message),
      );
      assert.ok(Date.now() - started < 5000, "タイムアウトが効かずハングした");
      assert.equal(existsSync(dest), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("audio_query のボディが途中で止まってもタイムアウトで失敗する", async () => {
    handler = (req, res) => {
      if (req.url?.startsWith("/audio_query")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"volumeScale":'); // 途中で止まる
      } else {
        res.writeHead(404);
        res.end();
      }
    };
    const dir = tempDir();
    try {
      const client = new VoicevoxClient(baseUrl, {
        requestMs: 300,
        speakersMs: 300,
        synthMs: 300,
      });
      await assert.rejects(
        () =>
          client.synthesizeToFile(
            "テスト",
            { speaker: 3, volume: 1, speed: 1, pitch: 0 },
            join(dir, "out.wav"),
            1024,
          ),
        (error: unknown) =>
          error instanceof VoicevoxError && /タイムアウト/.test(error.message),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("TtsCache (regression)", () => {
  it("合成が失敗しても一時ファイルが残らず、mutex の連鎖が壊れず再試行できる", async () => {
    const dir = tempDir();
    try {
      const cacheDir = join(dir, "tts");
      const cache = new TtsCache(cacheDir, {
        ttlMs: 60_000,
        maxBytes: 1024 * 1024,
      });
      const key = ttsCacheKey("失敗テスト", 3, 1, 1, 0);
      await assert.rejects(() =>
        cache.ensure(key, async () => {
          throw new Error("synth failed");
        }),
      );
      assert.deepEqual(
        readdirSync(cacheDir).filter((name) => name.endsWith(".tmp")),
        [],
      );
      const path = await cache.ensure(key, async (tmpPath) => {
        writeFileSync(tmpPath, Buffer.alloc(8, 3));
      });
      assert.ok(existsSync(path));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("YomikoStore (regression)", () => {
  it("close は二重に呼んでも例外を投げない", () => {
    const dir = tempDir();
    try {
      const store = new YomikoStore(dir, 3);
      store.setGuildSettings("g1", { speaker: 5 });
      store.close();
      assert.doesNotThrow(() => store.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadConfig (regression)", () => {
  const KEYS = [
    "DISCORD_TOKEN",
    "DISCORD_APPLICATION_ID",
    "DISCORD_GUILD_ID",
    "VOICEVOX_URL",
    "VOICEVOX_SPEAKER",
    "DATA_DIR",
    "YOMIKO_CACHE_DIR",
    "YOMIKO_CACHE_TTL",
    "YOMIKO_CACHE_MAX_BYTES",
    "YOMIKO_MAX_AUDIO_BYTES",
    "YOMIKO_AUTO_LEAVE_DELAY_MS",
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.DISCORD_TOKEN = "test-token";
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("空白のみの数値環境変数は 0 にならず既定値になる", () => {
    process.env.YOMIKO_MAX_AUDIO_BYTES = " ";
    process.env.YOMIKO_CACHE_MAX_BYTES = "  ";
    const config = loadConfig();
    assert.equal(config.maxAudioBytes, DEFAULT_MAX_AUDIO_BYTES);
    assert.equal(config.cacheMaxBytes, DEFAULT_CACHE_MAX_BYTES);
  });

  it("スキームのない VOICEVOX_URL は起動時にエラーになる", () => {
    process.env.VOICEVOX_URL = "localhost:50021";
    assert.throws(() => loadConfig(), /VOICEVOX_URL is invalid/);
    process.env.VOICEVOX_URL = "ftp://example.com:50021";
    assert.throws(() => loadConfig(), /VOICEVOX_URL is invalid/);
  });

  it("末尾スラッシュ付きの正常な URL は受理される", () => {
    process.env.VOICEVOX_URL = "http://example.com:50021/";
    assert.equal(loadConfig().voicevoxUrl, "http://example.com:50021");
  });
});

describe("ecosystem.config.cjs の .env パーサ (regression)", () => {
  it("引用符・インラインコメント・= を含む値を正しく読む", () => {
    const dir = tempDir();
    try {
      const source = join(process.cwd(), "ecosystem.config.cjs");
      copyFileSync(source, join(dir, "ecosystem.config.cjs"));
      writeFileSync(
        join(dir, ".env"),
        [
          "DISCORD_TOKEN=token123 # trailing comment",
          "DISCORD_APPLICATION_ID=1234567890",
          "PLAIN=hello",
          "WITH_EQ=a=b=c",
          'QUOTED_HASH="abc # not comment"',
          'QUOTED_COMMENT="abc" # comment',
          "SINGLE='single value'",
          "export EXPORTED=yes",
          'ESCAPED="a\\nb"',
          "# comment line",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "runner.cjs"),
        "const c = require('./ecosystem.config.cjs'); process.stdout.write(JSON.stringify(c.apps[0].env));",
      );
      const out = execFileSync("node", ["runner.cjs"], {
        cwd: dir,
        encoding: "utf8",
      });
      const env = JSON.parse(out) as Record<string, string>;
      assert.equal(env.DISCORD_TOKEN, "token123");
      assert.equal(env.PLAIN, "hello");
      assert.equal(env.WITH_EQ, "a=b=c");
      assert.equal(env.QUOTED_HASH, "abc # not comment");
      assert.equal(env.QUOTED_COMMENT, "abc");
      assert.equal(env.SINGLE, "single value");
      assert.equal(env.EXPORTED, "yes");
      assert.equal(env.ESCAPED, "a\nb");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
