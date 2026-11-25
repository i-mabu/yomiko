# 🔊 yomiko

Discordの会話をVOICEVOXで読み上げるBotです。

元リポジトリ `inumabu/yomiage`（Go製 v5.3.6）を、TypeScript + discord.js 1プロセスで完全リニューアルしたものです。logbot / mabubot と同じ流儀（Node標準SQLite、上書き式コマンド同期、pm2起動）に統一しています。

| 項目 | 内容 |
|---|---|
| バージョン | v0.1.0 |
| 状態 | 開発中 |
| 入手先 | GitHub（i-mabu/yomiko） |
| 実装 | TypeScript（Node.js 24+、discord.js 14） |
| 更新履歴 | [CHANGELOG.md](CHANGELOG.md) |

## ✨ 機能


- VCのテキストチャンネルを自動で読み上げ（キュー付き、最大30件）
- VOICEVOX Engine（`audio_query` → `synthesis`）で音声合成
- TTSキャッシュ（SHA-256キー、TTL 7日、容量上限 256MiB、mtimeベースLRU）
- 話者・音量・速度・ピッチをサーバー別／ユーザー別に設定可能
- 読み替え辞書（サーバー別）
- URL・メンション・絵文字・コードブロックを読みやすい形に正規化して読む
- VOICEVOXが未接続でもBotは落ちず、わかりやすいエラー表示
- ffmpeg不要（VOICEVOXのWAVを内蔵で48kHzステレオPCMへ変換）
- VCにBotだけになったら自動退出（既定60秒後）


## 📝 使い方（コマンド一覧）


すべてスラッシュコマンドで使えます。`!` 付きのメッセージコマンド（17件）も使えます（返信は公開Embed）。

### 基本（誰でも）

| コマンド      | 説明                                          |
| ------------- | --------------------------------------------- |
| `/join`       | 自分のいるVCに接続して読み上げを開始します    |
| `/leave`      | VCから切断して読み上げを終了します            |
| `/say <text>` | 指定したテキストを読み上げます（120文字以内） |
| `/status`     | 読み上げの現在状態を表示します                |
| `/queue`      | 待機中の読み上げキューを表示します            |
| `/help`       | 利用できるコマンドを表示します                |
| `/speakers`   | VOICEVOXの話者一覧を表示します                |
| `/voicevox`   | VOICEVOX Engineへの接続を確認します           |
| `/ping`       | Botの応答状態を確認します                     |

### キュー操作（管理者）

| コマンド          | 説明                                                         |
| ----------------- | ------------------------------------------------------------ |
| `/skip`           | 現在の読み上げをスキップします（待機キューは残ります）       |
| `/clear`          | 待機中の読み上げをすべて取り消します                         |
| `/remove <index>` | 待機キューから指定番号の文を削除します                       |
| `/pause`          | 次の読み上げを一時停止します（再生中の文は最後まで流れます） |
| `/resume`         | 読み上げを再開します                                         |

### 設定（管理者）

| コマンド                      | 説明                                                               |
| ----------------------------- | ------------------------------------------------------------------ |
| `/speaker <id>`               | サーバーの話者IDを変更します（1以上）                              |
| `/volume <value>`             | サーバーの音量を変更します（0.0〜2.0）                             |
| `/speed <value>`              | サーバーの読み上げ速度を変更します（0.5〜2.0）                     |
| `/pitch <value>`              | サーバーのピッチを変更します（-0.15〜0.15）                        |
| `/channel <action> <channel>` | 読み上げ対象チャンネルを設定します（`allow` / `block` / `remove`） |
| `/user <action> <user>`       | 読み上げ対象ユーザーを設定します（`block` / `remove`）             |
| `/toggle <on\|off>`           | 読み上げのON/OFFを切り替えます                                     |
| `/dict <add\|remove\|list>`   | 読み替え辞書を設定します（`add <単語> <読み>`）                    |

### 自分の声（誰でも）

| コマンド                                          | 説明                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| `/myvoice set [speaker] [volume] [speed] [pitch]` | 自分だけの話者・音量・速度・ピッチを設定します（サーバー既定より優先） |
| `/myvoice show`                                   | 自分の声の設定を表示します                                             |
| `/myvoice reset`                                  | 自分の声の設定をリセットします                                         |

### ボタン

Botの返信にはボタン行が付きます: 🎙️ 接続 / 🛑 終了 / 📊 状態 / 📚 キュー / 🧹 全消去。全消去ボタンも管理者専用です。


## 🚀 セットアップ

### 必要条件


- Node.js 24以上
- VOICEVOX Engine（`http://localhost:50021` で待ち受け、または別ホスト）
- Discord Bot Token（Developer Portalで発行）
- Botに必要なIntent: Guilds、Guild Messages、**Message Content**（特権インテント。Developer Portalで有効化すること）、Guild Voice States
- Botに必要な権限: VCへの接続・発言、メッセージ送信、Embed送信



```bash
git clone https://github.com/inumabu/yomiko.git
cd yomiko
cp .env.example .env
# .env を編集して DISCORD_TOKEN / DISCORD_APPLICATION_ID を入れる
npm ci
npm run build
npm run sync:commands   # スラッシュコマンドを上書き同期（初回必須）
```

`.env` の設定例は [.env.example](.env.example) を参照してください。

> コマンド同期は `npm run sync:commands` が唯一の登録場所です。Bot起動時に自動同期はしません。`DISCORD_GUILD_ID` を指定するとそのサーバーへ同期（開発中の即時反映用）、未指定ならグローバル同期です。コマンドをすべて削除するには `npm run clear:commands` を使います。


### 起動


```bash
npm start
```

開発時は `npm run dev`（tsxで直接起動）も使えます。


### 環境変数


| 変数                         |                   既定値 | 用途                                                        |
| ---------------------------- | -----------------------: | ----------------------------------------------------------- |
| `DISCORD_TOKEN`              |             なし（必須） | Discord Botトークン                                         |
| `DISCORD_APPLICATION_ID`     |       なし（同期に必須） | DiscordアプリケーションID                                   |
| `DISCORD_GUILD_ID`           |                     空欄 | 開発中にスラッシュコマンドを即時反映するサーバーID          |
| `VOICEVOX_URL`               | `http://localhost:50021` | VOICEVOX EngineのURL                                        |
| `VOICEVOX_SPEAKER`           |                      `3` | 初期話者ID                                                  |
| `DATA_DIR`                   |                 `./data` | 設定DB・キャッシュの保存先                                  |
| `YOMIKO_CACHE_DIR`           |     `DATA_DIR/cache/tts` | TTSキャッシュディレクトリ                                   |
| `YOMIKO_CACHE_TTL`           |                   `168h` | キャッシュの有効期間（単位 s/m/h/d、数値のみはミリ秒）      |
| `YOMIKO_CACHE_MAX_BYTES`     |              `268435456` | キャッシュ総容量の上限（バイト）                            |
| `YOMIKO_MAX_AUDIO_BYTES`     |               `33554432` | 1音声ファイルの上限（バイト）                               |
| `YOMIKO_AUTO_LEAVE_DELAY_MS` |                  `60000` | VCにBotだけになってから自動退出するまでの待ち時間（ミリ秒） |


## 🔄 運用

### 設定の保存先


- `data/yomiko.db`（SQLite）: サーバー別設定、ユーザー別声設定、チャンネル／ユーザー除外、辞書
- `data/cache/tts/`（WAV）: TTSキャッシュ。削除しても再生成されるため、バックアップ対象外です

バックアップは `data/yomiko.db` をコピーするだけです。例:

```bash
cp data/yomiko.db "yomiko-$(date +%Y%m%d-%H%M%S).db"
```


### VPS + pm2 での運用


```bash
# Node.js 24 と pm2 を入れる（Ubuntuの例）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2

# Botを配置してビルド・コマンド同期
git clone https://github.com/inumabu/yomiko.git ~/yomiko
cd ~/yomiko
cp .env.example .env   # トークン等を入れる
npm ci
npm run build
npm run sync:commands

# pm2で起動・自動起動設定
pm2 start ecosystem.config.cjs
pm2 startup   # 表示されたコマンドを実行する
pm2 save
```

日常の操作:

```bash
pm2 status            # 状態確認
pm2 logs yomiko       # ログ確認
pm2 restart yomiko    # 再起動（更新後に実行）
pm2 stop yomiko       # 停止
```

更新手順（VOICEVOX Engineは別途起動しておくこと）:

```bash
cd ~/yomiko
git pull --ff-only
npm ci
npm run build
npm run sync:commands   # コマンド定義が変わったときのみ
pm2 restart yomiko
```

> `ecosystem.config.cjs` がリポジトリ直下の `.env` を解析して環境変数として渡すため、pm2用の `.env` 読み込み設定は不要です。Node 22では `node:sqlite` に必要な `--experimental-sqlite` を自動で付けます（Node 24では不要）。

#### VOICEVOXを別ホストに置く場合

`.env` の `VOICEVOX_URL` を `http://<VOICEVOXホスト>:50021` に変えるだけです。VOICEVOXの50021番は、Botホストからのみ到達できるようにファイアウォールで制限してください（同一ホスト・LAN内・Tailscale等）。


### トラブルシューティング


#### `VOICEVOXに接続できませんでした` と出る

1. VOICEVOX Engineが起動しているか確認します（`curl http://localhost:50021/version`）。
2. `.env` の `VOICEVOX_URL` のホスト名・ポートを確認します。
3. 分離構成では、BotホストからVOICEVOXホストのTCP `50021` に到達できるか確認します。

`/voicevox` コマンドで接続状態（バージョン・話者数）を確認できます。

#### スラッシュコマンドが表示されない

- `npm run sync:commands` を実行したか確認します（グローバル同期は反映に最大1時間かかることがあります。開発中は `DISCORD_GUILD_ID` を指定してギルド同期すると即時反映されます）。
- Botの再招待が必要な場合があります（`applications.commands` スコープ付きで招待し直す）。

#### 音声が出ない

- BotがVCに接続しているか、`/status` で確認します。
- サーバーの音量設定が0になっていないか、`/status` で確認します。
- VOICEVOXの話者IDが存在するか、`/speakers` で確認します。
- `pm2 logs yomiko` で再生失敗のログが出ていないか確認します。

#### `DISCORD_TOKEN is required` で起動しない

`.env` がリポジトリ直下にあり、`DISCORD_TOKEN=` にトークンが入っているか確認します。`ecosystem.config.cjs` は `.env` を読むため、pm2起動時も同じファイルを使います。

#### `node:sqlite` のエラーが出る（Node 22の場合）

Node 24以上を使うか、pm2起動時（`ecosystem.config.cjs` 経由）であれば自動で `--experimental-sqlite` が付きます。直接 `node dist/index.js` で動かす場合は `node --experimental-sqlite dist/index.js` としてください。


## 🧪 テスト


```bash
npm run typecheck   # 型チェック
npm run build       # ビルド（dist/）
npm test            # テスト（node:test）
npm run dev         # 開発起動（tsx）
```

テストは `src/test/` にあります（設定の永続化・除外判定・辞書・正規化・WAV変換・TTSキャッシュ・VOICEVOXモック連携・再生キュー）。


## 📋 仕様メモ


- 対象: BotがVCに接続中で、読み上げがONのサーバーのテキストチャンネルへのメッセージ（Botの発言・DM・`!` コマンドは対象外）
- 文字数: 正規化後の本文が120文字（ルーン）以内。超えたメッセージは無言で読み飛ばします
- 除外: 禁止ユーザー → 禁止チャンネル → 許可チャンネル（1件でも登録するとホワイトリスト化）の優先順で判定します
- 正規化: URL・招待リンクは「URL」、メンションは表示名、チャンネルメンションは「#チャンネル名」、カスタム絵文字・Unicode絵文字・コードブロックは読み飛ばし、スポイラーは中身だけ読みます。辞書は最長一致で置換します
- キュー: 最大30件。満杯時は自動読み上げは無言で破棄、`/say` はエラーを返します
- 再生失敗時: 500ms間隔で最大2回リトライし、それでも失敗したら通知チャンネルへ公開Embedで知らせ、その文は破棄して次へ進みます
- 自動退出: VCにBotだけになったら既定60秒後に自動退出します（誰か参加すれば取り消し）


## 🧭 判断記録

### 元の yomiage からの変更点


詳しい分析は [docs/analysis.md](docs/analysis.md) を参照してください。主な変更点:

- 言語をGoからTypeScript + discord.jsに変更。DAVE対応のためのlibdaveビルド・Goビルド体系は不要になりました（discord.jsがE2EE音声に標準対応）
- 設定保存を `settings.json` からNode標準SQLite（`data/yomiko.db`）に変更
- コマンド同期を上書き式（PUT全置換）に変更。削除したコマンドが残り続ける問題を解消
- 新機能: ユーザー別声設定（`/myvoice`）、ピッチ設定（`/pitch`）、読み替え辞書（`/dict`）、読み上げON/OFF（`/toggle`）、VOICEVOX接続確認（`/voicevox`）、本文の正規化、VC自動退出
- 修正: 全消去ボタン（`clear_button`）に管理者チェックが無かった不具合を修正
- 落としたもの: `!` コマンドは残していますが、systemd運用・Windows運用・R2バックアップ・時間帯起動タイマーは含めていません（pm2運用が前提）。Dockerfileは含めていません（必要になれば追加）


## 🔗 関連

📜 更新履歴: [CHANGELOG.md](CHANGELOG.md)

## 📄 ライセンス


ライセンスは未定です。元の `inumabu/yomiage` は作者 inumabu のカスタムライセンスで公開されていたため、公開前にライセンス方針を決めて `LICENSE` を追加してください。
