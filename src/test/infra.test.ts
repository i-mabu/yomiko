import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { YomikoStore } from "../store.js";
import { normalizeText, runeLength, truncateRunes } from "../normalize.js";
import { parseWav, resampleTo48kStereo, wavToDiscordPcm } from "../wav.js";
import { ttsCacheKey, TtsCache } from "../ttsCache.js";
import { VoicevoxClient, VoicevoxError } from "../voicevox.js";
import { parseDurationMs } from "../config.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "yomiko-test-"));
}

// 🧪 16bit PCM WAV を組み立てるテスト用ヘルパー
function makeWav(
  sampleRate: number,
  channels: number,
  samples: number[],
): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("parseDurationMs", () => {
  it("parses s/m/h/d and plain ms numbers", () => {
    assert.equal(parseDurationMs("168h", 0), 168 * 3_600_000);
    assert.equal(parseDurationMs("30m", 0), 30 * 60_000);
    assert.equal(parseDurationMs("7d", 0), 7 * 86_400_000);
    assert.equal(parseDurationMs("1000", 0), 1000);
    assert.equal(parseDurationMs("90s", 0), 90_000);
  });

  it("falls back on invalid input", () => {
    assert.equal(parseDurationMs("abc", 1234), 1234);
    assert.equal(parseDurationMs(undefined, 1234), 1234);
    assert.equal(parseDurationMs("", 1234), 1234);
  });
});

describe("YomikoStore", () => {
  let dir: string;
  let store: YomikoStore;

  beforeEach(() => {
    dir = tempDir();
    store = new YomikoStore(dir, 3);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns defaults for an unknown guild", () => {
    const s = store.getGuildSettings("g1");
    assert.equal(s.speaker, 3);
    assert.equal(s.volume, 1.0);
    assert.equal(s.speed, 1.0);
    assert.equal(s.pitch, 0);
    assert.equal(s.enabled, true);
  });

  it("persists guild settings across reopen", () => {
    store.setGuildSettings("g1", {
      speaker: 8,
      volume: 1.5,
      speed: 1.25,
      pitch: 0.05,
      enabled: false,
    });
    store.close();
    const reopened = new YomikoStore(dir, 3);
    const s = reopened.getGuildSettings("g1");
    assert.equal(s.speaker, 8);
    assert.equal(s.volume, 1.5);
    assert.equal(s.speed, 1.25);
    assert.equal(s.pitch, 0.05);
    assert.equal(s.enabled, false);
    reopened.close();
  });

  it("isExcluded follows blocked user > blocked channel > allow-list", () => {
    assert.equal(store.isExcluded("g1", "c1", "u1"), false);
    store.setChannelMode("g1", "c1", "allow");
    assert.equal(store.isExcluded("g1", "c1", "u1"), false);
    assert.equal(store.isExcluded("g1", "c2", "u1"), true);
    store.setChannelMode("g1", "c1", "block");
    assert.equal(store.isExcluded("g1", "c1", "u1"), true);
    assert.equal(store.isExcluded("g1", "c2", "u1"), false);
    store.setUserBlocked("g1", "u1", true);
    assert.equal(store.isExcluded("g1", "c2", "u1"), true);
    store.setUserBlocked("g1", "u1", false);
    assert.equal(store.isExcluded("g1", "c2", "u1"), false);
    store.removeChannel("g1", "c1");
    assert.equal(store.getChannelMode("g1", "c1"), null);
  });

  it("stores per-user voice overrides and resets them", () => {
    const v = store.setUserVoice("g1", "u1", { speaker: 8, speed: 1.5 });
    assert.equal(v.speaker, 8);
    assert.equal(v.speed, 1.5);
    assert.equal(v.volume, null);
    store.resetUserVoice("g1", "u1");
    const after = store.getUserVoice("g1", "u1");
    assert.equal(after.speaker, null);
    assert.equal(after.speed, null);
  });

  it("stores dict entries (upsert, remove, list)", () => {
    store.addDict("g1", "終夜", "しゅうや");
    store.addDict("g1", "終夜", "よる");
    store.addDict("g1", "草", "くさ");
    assert.deepEqual(store.listDict("g1"), [
      { guildId: "g1", word: "終夜", reading: "よる" },
      { guildId: "g1", word: "草", reading: "くさ" },
    ]);
    assert.equal(store.removeDict("g1", "草"), true);
    assert.equal(store.removeDict("g1", "草"), false);
    assert.deepEqual(
      store.listDict("g1").map((d) => d.word),
      ["終夜"],
    );
  });
});

describe("normalizeText", () => {
  const ctx = {
    resolveUser: (id: string) => (id === "123" ? "終夜" : null),
    resolveChannel: (id: string) => (id === "456" ? "雑談" : null),
    resolveRole: (id: string) => (id === "789" ? "管理者" : null),
  };

  it("replaces URLs and invites with URL", () => {
    assert.equal(
      normalizeText("見て https://example.com/a?b=c だよ", [], ctx),
      "見て URL だよ",
    );
    assert.equal(
      normalizeText("discord.gg/abc123 に来て", [], ctx),
      "URL に来て",
    );
  });

  it("resolves mentions to display names", () => {
    assert.equal(
      normalizeText("<@123> こんにちは", [], ctx),
      "終夜 こんにちは",
    );
    assert.equal(normalizeText("<@!999> さん", [], ctx), "メンション さん");
    assert.equal(normalizeText("<#456> で話そう", [], ctx), "#雑談 で話そう");
    assert.equal(normalizeText("<@&789> の皆さん", [], ctx), "管理者 の皆さん");
  });

  it("drops custom emoji, unicode emoji and code blocks", () => {
    assert.equal(normalizeText("やった<:yatta:111> 🎉", [], ctx), "やった");
    assert.equal(
      normalizeText("`code` と ```\nblock\n``` 残る", [], ctx),
      "と 残る",
    );
  });

  it("keeps spoiler contents and applies dict longest-match first", () => {
    assert.equal(normalizeText("||秘密|| だよ", [], ctx), "秘密 だよ");
    const dict = [
      { word: "草", reading: "くさ" },
      { word: "草生える", reading: "くさはえる" },
    ];
    assert.equal(normalizeText("草生える", dict, ctx), "くさはえる");
    assert.equal(normalizeText("草", dict, ctx), "くさ");
  });

  it("collapses whitespace and newlines", () => {
    assert.equal(
      normalizeText("  おはよう\n\nございます  ", [], ctx),
      "おはよう ございます",
    );
  });
});

describe("runeLength / truncateRunes", () => {
  it("counts runes, not bytes", () => {
    assert.equal(runeLength("あいう"), 3);
    assert.equal(runeLength("🎉🎉"), 2);
    assert.equal(truncateRunes("あいうえお", 3), "あいう");
    assert.equal(truncateRunes("あいう", 5), "あいう");
  });
});

describe("wav", () => {
  it("parses a 24kHz mono WAV and resamples to 48kHz stereo", () => {
    const samples = Array.from({ length: 240 }, (_, i) =>
      i % 2 === 0 ? 1000 : -1000,
    );
    const wav = makeWav(24000, 1, samples);
    const pcm = parseWav(wav);
    assert.equal(pcm.sampleRate, 24000);
    assert.equal(pcm.channels, 1);
    assert.equal(pcm.samples.length, 240);
    const out = resampleTo48kStereo(pcm);
    // 📌 240 frames @24kHz -> 480 frames @48kHz, stereo s16le
    assert.equal(out.length, 480 * 2 * 2);
    const viaHelper = wavToDiscordPcm(wav);
    assert.equal(viaHelper.length, out.length);
  });

  it("throws on non-WAV input", () => {
    assert.throws(
      () => parseWav(Buffer.from("not a wav file at all, definitely not")),
      /WAV/,
    );
  });
});

describe("ttsCacheKey / TtsCache", () => {
  it("is deterministic and sensitive to voice params", () => {
    const a = ttsCacheKey("こんにちは", 3, 1, 1, 0);
    const b = ttsCacheKey("こんにちは", 3, 1, 1, 0);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, ttsCacheKey("こんにちは", 8, 1, 1, 0));
    assert.notEqual(a, ttsCacheKey("こんにちは", 3, 1, 1, 0.05));
    assert.notEqual(a, ttsCacheKey("こんばんは", 3, 1, 1, 0));
  });

  it("hits, expires by TTL, and GCs by capacity", () => {
    const dir = tempDir();
    try {
      const cache = new TtsCache(join(dir, "tts"), {
        ttlMs: 1000,
        maxBytes: 100,
      });
      const key = ttsCacheKey("テスト", 3, 1, 1, 0);
      assert.equal(cache.get(key), null);
      const tmp = join(dir, "tmp.wav");
      writeFileSync(tmp, Buffer.alloc(60, 1));
      cache.put(key, tmp);
      const hit = cache.get(key);
      assert.ok(hit);
      assert.equal(readFileSync(hit).length, 60);
      // 📌 TTL超過: mtime を古くする
      const past = new Date(Date.now() - 2000);
      utimesSync(hit, past, past);
      assert.equal(cache.get(key), null);
      // 🧹 容量超過: 60バイト×2件で上限100を超えるので古い方から消える
      const key2 = ttsCacheKey("テスト2", 3, 1, 1, 0);
      const tmp2 = join(dir, "tmp2.wav");
      writeFileSync(tmp2, Buffer.alloc(60, 2));
      cache.put(key2, tmp2);
      const key3 = ttsCacheKey("テスト3", 3, 1, 1, 0);
      const tmp3 = join(dir, "tmp3.wav");
      writeFileSync(tmp3, Buffer.alloc(60, 3));
      cache.put(key3, tmp3);
      assert.equal(cache.get(key2), null);
      assert.ok(cache.get(key3));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ensure synthesizes once and reuses the cache", async () => {
    const dir = tempDir();
    try {
      const cache = new TtsCache(join(dir, "tts"), {
        ttlMs: 60_000,
        maxBytes: 1024 * 1024,
      });
      let calls = 0;
      const key = ttsCacheKey("やっほー", 3, 1, 1, 0);
      const synth = async (tmpPath: string): Promise<void> => {
        calls += 1;
        writeFileSync(tmpPath, Buffer.alloc(10, 7));
      };
      const first = await cache.ensure(key, synth);
      const second = await cache.ensure(key, synth);
      assert.equal(first, second);
      assert.equal(calls, 1);
      assert.ok(existsSync(first));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("VoicevoxClient (mock server)", () => {
  let server: Server;
  let baseUrl: string;
  let mode: "ok" | "error" = "ok";

  beforeEach(async () => {
    const wav = makeWav(24000, 1, [100, -100, 200, -200]);
    server = createServer((req, res) => {
      if (mode === "error") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "boom" }));
        return;
      }
      if (req.url?.startsWith("/version")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("0.16.0");
      } else if (req.url?.startsWith("/speakers")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            { name: "ずんだもん", styles: [{ id: 3, name: "ノーマル" }] },
          ]),
        );
      } else if (req.url?.startsWith("/audio_query")) {
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
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    mode = "ok";
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("gets version and speakers", async () => {
    const client = new VoicevoxClient(baseUrl);
    assert.equal(await client.getVersion(), "0.16.0");
    const speakers = await client.listSpeakers();
    assert.equal(speakers.length, 1);
    assert.equal(speakers[0].name, "ずんだもん");
    assert.equal(speakers[0].styles[0].id, 3);
  });

  it("synthesizes to a file", async () => {
    const dir = tempDir();
    try {
      const client = new VoicevoxClient(baseUrl);
      const dest = join(dir, "out.wav");
      await client.synthesizeToFile(
        "こんにちは",
        { speaker: 3, volume: 1, speed: 1, pitch: 0 },
        dest,
        1024 * 1024,
      );
      const pcm = parseWav(readFileSync(dest));
      assert.equal(pcm.sampleRate, 24000);
      assert.equal(pcm.samples.length, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws VoicevoxError on HTTP 500 and on connection failure", async () => {
    const client = new VoicevoxClient(baseUrl);
    mode = "error";
    await assert.rejects(() => client.getVersion(), VoicevoxError);
    const dead = new VoicevoxClient("http://127.0.0.1:1");
    await assert.rejects(() => dead.getVersion(), VoicevoxError);
  });
});
