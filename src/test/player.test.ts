import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GuildPlayer,
  PlayerManager,
  SpeechQueue,
  type PlayerDeps,
} from "../player.js";
import { YomikoStore } from "../store.js";
import { TtsCache } from "../ttsCache.js";
import { VoicevoxClient } from "../voicevox.js";

interface NotifyCall {
  guildId: string;
  channelId: string;
  message: string;
}

function makeDeps(): {
  deps: PlayerDeps;
  notifyCalls: NotifyCall[];
  store: YomikoStore;
} {
  const dir = mkdtempSync(join(tmpdir(), "yomiko-player-test-"));
  const store = new YomikoStore(join(dir, "data"), 3);
  // 未使用の URL。テストでは VOICEVOX は呼ばれない。
  const voicevox = new VoicevoxClient("http://127.0.0.1:1");
  const cache = new TtsCache(join(dir, "cache"), {
    ttlMs: 60_000,
    maxBytes: 1024 * 1024,
  });
  const notifyCalls: NotifyCall[] = [];
  const deps: PlayerDeps = {
    store,
    voicevox,
    cache,
    defaultSpeaker: 3,
    maxAudioBytes: 1024 * 1024,
    notifyError: (guildId, channelId, message) => {
      notifyCalls.push({ guildId, channelId, message });
    },
  };
  return { deps, notifyCalls, store };
}

describe("SpeechQueue", () => {
  it("容量30で、31件目は false になる", () => {
    const queue = new SpeechQueue();
    for (let i = 0; i < 30; i++) {
      assert.equal(queue.enqueue({ text: `文${i}`, authorId: "u1" }), true);
    }
    assert.equal(queue.length, 30);
    assert.equal(queue.enqueue({ text: "文30", authorId: "u1" }), false);
    assert.equal(queue.length, 30);
  });

  it("FIFO順で取り出せる", () => {
    const queue = new SpeechQueue();
    queue.enqueue({ text: "one", authorId: "u1" });
    queue.enqueue({ text: "two", authorId: "u2" });
    queue.enqueue({ text: "three", authorId: "u1" });
    assert.deepEqual(queue.dequeue(), { text: "one", authorId: "u1" });
    assert.deepEqual(queue.dequeue(), { text: "two", authorId: "u2" });
    assert.deepEqual(queue.dequeue(), { text: "three", authorId: "u1" });
    assert.equal(queue.dequeue(), undefined);
    assert.equal(queue.length, 0);
  });

  it("remove は0始まりで、範囲外は null を返す", () => {
    const queue = new SpeechQueue();
    queue.enqueue({ text: "a", authorId: "u1" });
    queue.enqueue({ text: "b", authorId: "u1" });
    queue.enqueue({ text: "c", authorId: "u1" });
    assert.deepEqual(queue.remove(1), { text: "b", authorId: "u1" });
    assert.deepEqual(
      queue.peekAll().map((item) => item.text),
      ["a", "c"],
    );
    assert.equal(queue.remove(-1), null);
    assert.equal(queue.remove(2), null);
    assert.equal(queue.remove(99), null);
    assert.equal(queue.length, 2);
    assert.deepEqual(queue.remove(0), { text: "a", authorId: "u1" });
    assert.equal(queue.length, 1);
  });

  it("clear は消した件数を返す", () => {
    const queue = new SpeechQueue();
    assert.equal(queue.clear(), 0);
    queue.enqueue({ text: "a", authorId: "u1" });
    queue.enqueue({ text: "b", authorId: "u1" });
    assert.equal(queue.clear(), 2);
    assert.equal(queue.length, 0);
    assert.deepEqual(queue.peekAll(), []);
    assert.equal(queue.clear(), 0);
  });

  it("pause/resume でフラグが切り替わる", () => {
    const queue = new SpeechQueue();
    assert.equal(queue.paused, false);
    queue.pause();
    assert.equal(queue.paused, true);
    queue.resume();
    assert.equal(queue.paused, false);
  });

  it("peekAll はコピーを返し、内部の順序を変えない", () => {
    const queue = new SpeechQueue();
    queue.enqueue({ text: "a", authorId: "u1" });
    const listed = queue.peekAll();
    listed.push({ text: "x", authorId: "u1" });
    assert.equal(queue.length, 1);
    assert.deepEqual(
      queue.peekAll().map((item) => item.text),
      ["a"],
    );
  });
});

describe("GuildPlayer (未接続)", () => {
  it("未接続時は enqueue が not-connected、skip/leave は false、clearQueue は 0", () => {
    const { deps, notifyCalls, store } = makeDeps();
    try {
      const player = new GuildPlayer("g1", deps);
      assert.equal(player.guildId, "g1");
      assert.equal(player.enqueue("こんにちは", "u1"), "not-connected");
      assert.equal(player.skip(), false);
      assert.equal(player.leave(), false);
      assert.equal(player.clearQueue(), 0);
      assert.equal(player.removeFromQueue(0), null);
      assert.deepEqual(player.queueList(), []);
      assert.equal(player.channelId, null);
      assert.equal(player.notifyChannelId, null);
      assert.equal(player.currentText, null);
      assert.equal(player.paused, false);
      assert.deepEqual(player.status, {
        connected: false,
        channelId: null,
        queueLength: 0,
        paused: false,
        current: null,
      });
      assert.deepEqual(notifyCalls, []);
    } finally {
      store.close();
    }
  });

  it("pause/resume フラグが status に反映される", () => {
    const { deps, store } = makeDeps();
    try {
      const player = new GuildPlayer("g1", deps);
      player.pause();
      assert.equal(player.paused, true);
      assert.equal(player.status.paused, true);
      player.resume();
      assert.equal(player.paused, false);
      assert.equal(player.status.paused, false);
    } finally {
      store.close();
    }
  });

  it("destroy しても notifyError は呼ばれない", () => {
    const { deps, notifyCalls, store } = makeDeps();
    try {
      const player = new GuildPlayer("g1", deps);
      player.destroy();
      assert.equal(player.status.connected, false);
      assert.deepEqual(notifyCalls, []);
    } finally {
      store.close();
    }
  });
});

describe("PlayerManager", () => {
  it("get は未作成時に undefined、getOrCreate は同一インスタンスを返す", () => {
    const { deps, store } = makeDeps();
    try {
      const manager = new PlayerManager(deps);
      assert.equal(manager.get("g1"), undefined);
      const first = manager.getOrCreate("g1");
      assert.equal(first.guildId, "g1");
      assert.equal(manager.get("g1"), first);
      assert.equal(manager.getOrCreate("g1"), first);
      assert.notEqual(manager.getOrCreate("g2"), first);
      assert.equal(manager.get("g2")?.guildId, "g2");
    } finally {
      store.close();
    }
  });

  it("destroyAll ですべてのプレイヤーが消える", () => {
    const { deps, store } = makeDeps();
    try {
      const manager = new PlayerManager(deps);
      manager.getOrCreate("g1");
      manager.getOrCreate("g2");
      manager.destroyAll();
      assert.equal(manager.get("g1"), undefined);
      assert.equal(manager.get("g2"), undefined);
    } finally {
      store.close();
    }
  });
});
