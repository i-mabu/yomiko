import { fileURLToPath } from "node:url";
import { ActivityType, Client, GatewayIntentBits, Partials } from "discord.js";
import { loadConfig, type YomikoConfig } from "./config.js";
import { YomikoStore } from "./store.js";
import { VoicevoxClient } from "./voicevox.js";
import { TtsCache } from "./ttsCache.js";
import { PlayerManager } from "./player.js";
import {
  EMBED_COLOR_ERROR,
  sendPublicEmbed,
  type CommandContext,
} from "./commands.js";
import { registerEvents } from "./events.js";

// リポジトリ直下の .env を読み込む（pm2 の ecosystem 経由でない
// `npm start` / `npm run dev` でも README 通りの手順で起動できるように）。
// 既に環境変数として渡されている値は上書きしない（Node の loadEnvFile の仕様）。
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // .env が無い場合は環境変数だけで起動する（従来通りの運用も可能）。
}

let config: YomikoConfig;
try {
  config = loadConfig();
} catch (error) {
  console.error("[yomiko] 設定の読み込みに失敗しました:", error);
  process.exit(1);
}

const store = new YomikoStore(config.dataDir, config.defaultSpeaker);
const voicevox = new VoicevoxClient(config.voicevoxUrl);
const cache = new TtsCache(config.cacheDir, {
  ttlMs: config.cacheTtlMs,
  maxBytes: config.cacheMaxBytes,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.GuildMember,
    Partials.User,
  ],
});

const players = new PlayerManager({
  store,
  voicevox,
  cache,
  defaultSpeaker: config.defaultSpeaker,
  maxAudioBytes: config.maxAudioBytes,
  notifyError: (guildId, channelId, message) => {
    void client.channels
      .fetch(channelId)
      .then((ch) => {
        if (ch?.isTextBased()) {
          void sendPublicEmbed(
            ch,
            "❌ 読み上げに失敗しました",
            message,
            EMBED_COLOR_ERROR,
          );
        }
      })
      .catch(() => undefined);
  },
});

const ctx: CommandContext = { store, players, voicevox, config };

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`);
  client.user?.setActivity("メッセージの読み上げ", {
    type: ActivityType.Listening,
  });
  // 起動時キャッシュGC（期限切れ・容量超過の整理）。
  cache.gc();
  // コマンドの起動時自動同期はしない。`npm run sync:commands` が
  // 唯一の登録場所（再起動で削除済みコマンドが復活しないようにする）。
});

registerEvents(client, ctx);

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  players.destroyAll();
  try {
    client.destroy();
  } catch {
    // 破棄中のエラーは無視する
  }
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await client.login(config.token);
} catch (error) {
  console.error("[yomiko] Discordへのログインに失敗しました:", error);
  players.destroyAll();
  store.close();
  process.exit(1);
}
