# yomiage（元リポジトリ）機能分析 — リニューアル版（yomiko）設計用

- 分析対象: `~/workspace/yomiage-orig/`（`inumabu/yomiage`、Go製）
- 対象バージョン: **v5.3.6**（`VERSION` / `CHANGELOG.md` 先頭と一致）
- 分析日: 2026-11-14
- 精読対象: `main.go` 全文（1319行）、`main_test.go` 全文（131行）、`.env.example`、`.github/workflows/ci.yml`、`Dockerfile`、`CHANGELOG.md`、`VERSION`、`go.mod`、`docs/` 全ファイル、`modes/` 全ファイル、`patches/0001-keiryou-cache.patch`（309行）、`patches/0002-dave.patch`（48行）、`README.md`、`Makefile`、`build/build.sh`、`bot/`・`voicevox/`・`pc-schedule/`・`windows/` の運用ファイル
- リニューアル版の方針（参考）: TypeScript + discord.js 1プロセスで作り直し、logbot／mabubotと同じ流儀（Node標準SQLite、上書き式コマンド同期、pm2起動）に統一。作業場所 `~/workspace/yomiko/`、リポジトリ `inumabu/yomiko`。
- 注意: 本書は分析のみ。実装は含まない。秘密情報（トークン類の実値）は含まない。

## 0. 全体像と重要な前提

- 単一バイナリのGoプログラム（`main.go` 1ファイルに全ロジック）。依存は discordgo + dca（ffmpeg経由のOpusエンコード）のみ（`go.mod`: Go 1.22、discordgo v0.29.0、dca v2.0.0）。
- **素の `main.go` だけでは完成形ではない。** 正式ビルドは `build/build.sh` が2つのパッチを適用してから `go test` → `go build` する。
  - `patches/0001-keiryou-cache.patch`: TTSキャッシュ（ディスクWAVキャッシュ、合成の直列化、ストリーミング保存）を追加。**キャッシュ仕様はすべてこのパッチ由来**で、素の `main.go` には存在しない。
  - `patches/0002-dave.patch`: discordgoを `aleph-garden/discordgo v0.29.1-dave.26`（DAVE/E2EE対応フォーク）に差し替え、Go 1.24へ引き上げ。
- マルチギルド対応: `bot.players` / `bot.settings` はギルドIDをキーとするmap。1プロセスで複数サーバーを同時に読み上げる。
- 永続化は `settings.json`（ギルド別設定）のみ。SQLiteは使われていない。
- **辞書機能は存在しない。** `main.go`・パッチ・docs・全env例を全文検索しても、読み替え辞書・ユーザー辞書・置換ルールにあたる実装・設定は一切ない。リニューアルで辞書が要るなら新規機能になる。
- **メッセージ本文の正規化も存在しない。** URL・メンション（`<@id>`）・チャンネルメンション・カスタム絵文字・スタンプ・添付ファイルに関する処理は一切なく、本文は `strings.TrimSpace` しただけでそのままVOICEVOXへ渡される（詳細は §3）。
- ユーザー別設定は存在しない。話者・音量・速度はすべて**サーバー別**のみ。

---

## 1. コマンド一覧

スラッシュコマンドは18件。`!` プレフィックスのメッセージコマンドも18件で同じ体系。ボタンは5件。

### 1.1 スラッシュコマンド（`/xxx`）

登録は `applicationCommands`（`main.go:53-137`）。Discord側の権限制限（`DefaultMemberPermissions` 等）は**設定されていない**。管理者専用はすべてハンドラ内で `isAdminInteraction`（`Administrator` 権限ビット）により判定し、非管理者には「この操作はサーバー管理者のみ実行できます。」を返す。

| #   | コマンド    | 説明（登録文言）                                         | オプション（型・必須）                                                                            | 権限   | 応答            |
| --- | ----------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ | --------------- |
| 1   | `/join`     | ボイスチャンネルに接続して読み上げを開始します。         | なし                                                                                              | 誰でも | ephemeral Embed |
| 2   | `/leave`    | ボイスチャンネルから切断して読み上げを終了します。       | なし                                                                                              | 誰でも | ephemeral Embed |
| 3   | `/say`      | 現在のボイスチャンネルで指定したテキストを読み上げます。 | `text`（文字列・必須）                                                                            | 誰でも | ephemeral Embed |
| 4   | `/speaker`  | このサーバーで使うVOICEVOXの話者IDを変更します。         | `id`（整数・必須）                                                                                | 管理者 | ephemeral Embed |
| 5   | `/status`   | 読み上げBOTの現在状態を表示します。                      | なし                                                                                              | 誰でも | ephemeral Embed |
| 6   | `/queue`    | 現在の読み上げキューの件数を表示します。                 | なし                                                                                              | 誰でも | ephemeral Embed |
| 7   | `/clear`    | 待機中の読み上げをすべて取り消します。                   | なし                                                                                              | 管理者 | ephemeral Embed |
| 8   | `/skip`     | 現在の読み上げをスキップします。                         | なし                                                                                              | 管理者 | ephemeral Embed |
| 9   | `/volume`   | このサーバーの音量を変更します（0.0〜2.0）。             | `value`（数値・必須）                                                                             | 管理者 | ephemeral Embed |
| 10  | `/speed`    | このサーバーの読み上げ速度を変更します（0.5〜2.0）。     | `value`（数値・必須）                                                                             | 管理者 | ephemeral Embed |
| 11  | `/channel`  | 読み上げ対象チャンネルを設定します（管理者専用）。       | `action`（文字列・必須、`allow / block / remove`）、`id`（文字列・必須、チャンネルID）            | 管理者 | ephemeral Embed |
| 12  | `/user`     | 読み上げ対象ユーザーを設定します（管理者専用）。         | `action`（文字列・必須、`block / remove` のみ。`allow` は不可）、`id`（文字列・必須、ユーザーID） | 管理者 | ephemeral Embed |
| 13  | `/help`     | 利用できるコマンドを表示します。                         | なし                                                                                              | 誰でも | ephemeral Embed |
| 14  | `/speakers` | VOICEVOXの話者一覧を表示します。                         | なし                                                                                              | 誰でも | ephemeral Embed |
| 15  | `/pause`    | 次の読み上げを一時停止します。                           | なし                                                                                              | 管理者 | ephemeral Embed |
| 16  | `/resume`   | 読み上げを再開します。                                   | なし                                                                                              | 管理者 | ephemeral Embed |
| 17  | `/remove`   | 待機キューから指定番号の文を削除します（管理者専用）。   | `index`（整数・必須、キュー番号・1始まり）                                                        | 管理者 | ephemeral Embed |
| 18  | （なし）    | —                                                        | —                                                                                                 | —      | —               |

- 18件目は存在しない。スラッシュは上記17件。`remove` が17件目。**スラッシュコマンドは17件**（`join, leave, say, speaker, status, queue, clear, skip, volume, speed, channel, user, help, speakers, pause, resume, remove`）。
- 応答はすべて `replyInteraction`（`main.go:521`）経由の **Ephemeral Embed**（`MessageFlagsEphemeral`）。タイトルは常に `📣 読み上げBOT`、成功は緑 `0x2ECC71`、失敗は赤 `0xE74C3C`、フィールドに `サーバー: <ギルドID>` と `話者ID: <n>` が付く。**すべての応答にボタン行（§1.3）が付く。**
- DMではスラッシュコマンドは無視される（`onInteraction` で `interaction.GuildID == ""` なら return）。
- オプション未指定時の挙動: `/say` は「読み上げる文章を指定してください。」、`/speaker` は「話者IDを指定してください。」、`/volume`・`/speed` は「音量／速度を指定してください。」、`/remove` は「削除するキュー番号を指定してください。」（いずれも ephemeral、失敗色）。
- `/channel` の `action` は `allow / block / remove` 以外でエラー文言。「使い方: !channel allow|block|remove チャンネルID」を返す（スラッシュでも同じ文言）。
- `/user` の `action` は `block / remove` のみ。`allow` を指定すると「ユーザー操作は block / remove のいずれかで指定してください。」。ユーザー側に allow-list は存在しない。

### 1.2 メッセージコマンド（`!xxx`）

プレフィックスは `!`（定数 `commandPrefix`、`main.go:29`）。処理は `onMessage`（`main.go:236`）。**通常メッセージコマンドへの返信は公開 Embed**（`reply`、`main.go:1221`、ephemeral ではない）。ただしエラー系の返信も同じく公開である点に注意（README:「通常メッセージコマンドとBotの障害通知は、チャンネル全体に表示される公開Embed」）。

| コマンド    | 書式                                         | 権限   | 備考                                                                                   |
| ----------- | -------------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `!join`     | `!join`（完全一致）                          | 誰でも |                                                                                        |
| `!leave`    | `!leave`（完全一致）                         | 誰でも |                                                                                        |
| `!say`      | `!say 文章`                                  | 誰でも | 引数なしの `!say` 単体は「読み上げる文章を指定してください。」（公開・失敗色）         |
| `!speaker`  | `!speaker ID`                                | 管理者 | 引数なしは「話者IDを指定してください。」。非数値は「話者IDは数値で指定してください。」 |
| `!status`   | `!status`（完全一致）                        | 誰でも |                                                                                        |
| `!queue`    | `!queue`（完全一致）                         | 誰でも |                                                                                        |
| `!clear`    | `!clear`（完全一致）                         | 管理者 |                                                                                        |
| `!skip`     | `!skip`（完全一致）                          | 管理者 |                                                                                        |
| `!volume`   | `!volume 値`                                 | 管理者 | 非数値は「音量は数値で指定してください。」                                             |
| `!speed`    | `!speed 値`                                  | 管理者 | 非数値は「速度は数値で指定してください。」                                             |
| `!channel`  | `!channel allow\|block\|remove チャンネルID` | 管理者 | スペース区切りで分割（`strings.Fields`）。引数不足は使い方文言                         |
| `!user`     | `!user block\|remove ユーザーID`             | 管理者 | 同上                                                                                   |
| `!help`     | `!help`（完全一致）                          | 誰でも |                                                                                        |
| `!speakers` | `!speakers`（完全一致）                      | 誰でも |                                                                                        |
| `!pause`    | `!pause`（完全一致）                         | 管理者 |                                                                                        |
| `!resume`   | `!resume`（完全一致）                        | 管理者 |                                                                                        |
| `!remove`   | `!remove 番号`                               | 管理者 | 非数値は「削除するキュー番号は数値で指定してください。」                               |

- メッセージコマンドの管理者判定は `isAdminMessage`（`main.go:617`）。`message.Member` の権限ビットを見て、なければ `session.State.Member` で再取得して判定する。
- `!join`・`!leave` 等は **Botのメッセージ・DM・Bot作者のメッセージをすべて無視**（`message.Author.Bot` または `GuildID == ""` なら return）。また `!` で始まる未知のコマンドは読み上げ対象からも除外される（§3参照）。
- `/help` / `!help` の表示内容（`helpMessage`、`main.go:564`）:
  - `基本: \`!join\` / \`!leave\` / \`!say 文章\` / \`!status\``
  - `キュー: \`!queue\` / \`!remove 番号\` / \`!clear\` / \`!skip\` / \`!pause\` / \`!resume\``
  - `設定（管理者）: \`!speaker ID\` / \`!volume 0.0-2.0\` / \`!speed 0.5-2.0\``
  - `除外（管理者）: \`!channel allow|block|remove チャンネルID\` / \`!user block|remove ユーザーID\``
  - `その他: \`!speakers\``
  - ※ヘルプはスラッシュコマンドの存在に触れていない（`!` 形式のみの案内）。

### 1.3 ボタン（MessageComponent）

`newActionRow`（`main.go:1243`）で、**Botの返信（公開・ephemeral 問わず）すべてに付く**5ボタン。押下時の応答はすべて ephemeral Embed。

| Custom ID       | ラベル | スタイル        | 絵文字 | 動作                               | 権限チェック       |
| --------------- | ------ | --------------- | ------ | ---------------------------------- | ------------------ |
| `join_button`   | 接続   | Success（緑）   | 🎙️     | `/join` 相当（押した人のVCへ接続） | なし               |
| `leave_button`  | 終了   | Danger（赤）    | 🛑     | `/leave` 相当                      | なし               |
| `status_button` | 状態   | Secondary（灰） | 📊     | `/status` 相当                     | なし               |
| `queue_button`  | キュー | Secondary（灰） | 📚     | `/queue` 相当                      | なし               |
| `clear_button`  | 全消去 | Danger（赤）    | 🧹     | `/clear` 相当                      | **なし（要注意）** |

- **不整合:** スラッシュ・メッセージの `/clear` は管理者専用だが、ボタン `clear_button` には管理者チェックがなく、誰でも待機キューを全消去できる（`onInteraction` の MessageComponent 分岐、`main.go:383` 付近）。リニューアル時は仕様として決め直すこと。
- ボタンの `join_button` は押したユーザーのVCへ接続する（`interaction.ChannelID` を通知チャンネルとして使う）。

---

## 2. 設定項目一覧

### 2.1 サーバー別設定（`settings.json`、ギルドごと）

型 `guildSettings`（`main.go:139-148`）。保存先は `YOMIAGE_SETTINGS_FILE`（既定 `./settings.json`）。ファイル全体は `{ "<ギルドID>": {…}, … }` のJSON（`MarshalIndent`、2スペース）。

| 項目               | JSONキー           | 型              | 既定値                      | 範囲・制約                                                                              | 設定手段                                     |
| ------------------ | ------------------ | --------------- | --------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------- |
| 話者ID             | `speaker`          | int             | `VOICEVOX_SPEAKER`（既定3） | 1以上（`setSpeaker` で `<=0` は拒否。上限チェックなし。話者一覧との突合せもなし）       | `/speaker`・`!speaker`（管理者）             |
| 音量               | `volume`           | float64         | 1.0                         | **0.0〜2.0**（範囲外・NaN・±Inf は拒否）                                                | `/volume`・`!volume`（管理者）               |
| 音量設定済みフラグ | `volume_set`       | bool            | false                       | 内部用。`omitempty`。`false` かつ `volume==0` のとき既定値1.0に正規化                   | —                                            |
| 速度               | `speed`            | float64         | 1.0                         | **0.5〜2.0**（範囲外・NaN・±Inf は拒否）                                                | `/speed`・`!speed`（管理者）                 |
| 速度設定済みフラグ | `speed_set`        | bool            | false                       | 内部用。`omitempty`。同上                                                               | —                                            |
| 許可チャンネル     | `allowed_channels` | map[string]bool | 空                          | 空のときは制限なし。**1件でも入るとホワイトリスト化**され、未登録チャンネルはすべて除外 | `/channel allow`・`!channel allow`（管理者） |
| 禁止チャンネル     | `blocked_channels` | map[string]bool | 空                          | 登録チャンネルは除外。`allow` 指定で `blocked` から削除される（相互排他）               | `/channel block`・`!channel block`（管理者） |
| 禁止ユーザー       | `blocked_users`    | map[string]bool | 空                          | 登録ユーザーの発言は除外。allow は存在しない                                            | `/user block`・`!user block`（管理者）       |

- 正規化（`normalizeSettings`、`main.go:675`）: 話者 `<=0` → 既定話者。音量・速度は未設定かつ0なら既定値。3つのmapがnilなら空map化。
- 保存は **更新のたびに全量書き戻し**（`updateSettings` → `saveSettings`、`main.go:697`）。一時ファイル（`.yomiage-settings-*.tmp`）に書き、完了後に `os.Rename` で原子置換。保存失敗はログのみ（`⚠️ 設定の保存に失敗しました`）で、コマンド応答自体は成功として返る。
- 読み込み（`loadSettings`、`main.go:655`）: ファイル不存在は正常（空設定で開始）。JSONデコード失敗は起動時ログ警告のみで、Botは空設定で起動する（**壊れた設定ファイルは黙って破棄される**）。
- 除外判定（`isExcluded`、`main.go:801`）の優先順: ①禁止ユーザー → 除外、②禁止チャンネル → 除外、③許可チャンネルが1件以上あり、かつ当該チャンネルが未登録 → 除外。許可チャンネルが空なら③は適用されない。
- **ユーザー別設定は存在しない**（話者・音量・速度のユーザー単位の上書きなし）。ユーザーにできるのはブロックのみ。
- チャンネルID・ユーザーIDは**数値検証なし**。任意の文字列がそのままキーになる（存在しないIDの登録も可能で、エラーにならない）。
- `remove` 操作は両mapからの削除（チャンネル）／`blocked_users` からの削除（ユーザー）。

### 2.2 環境変数（Bot本体）

| 変数                      | 既定値                   | 用途・制約                                                                                                    | 参照箇所                          |
| ------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `DISCORD_TOKEN`           | なし（**必須**）         | Discord Botトークン。未設定なら `log.Fatal` で起動失敗                                                        | `main()` `main.go:176`            |
| `DISCORD_GUILD_ID`        | 空                       | ギルドコマンド登録先。空ならグローバル登録。カンマ区切りで複数可（空白は除去）。開発中の即時反映用            | `registerCommands` `main.go:1296` |
| `VOICEVOX_URL`            | `http://localhost:50021` | VOICEVOX EngineのURL。末尾 `/` は除去                                                                         | `main()` `main.go:191`            |
| `VOICEVOX_SPEAKER`        | `3`                      | 初期話者ID（全ギルド共通の既定）。空でなければ整数解析。**不正値（非数値・0以下）は起動失敗（`log.Fatalf`）** | `main()` `main.go:183`            |
| `YOMIAGE_SETTINGS_FILE`   | `./settings.json`        | ギルド設定の保存先。空白は除去して判定                                                                        | `settingsFilePath` `main.go:648`  |
| `YOMIAGE_CACHE_DIR`       | `./cache/tts`            | TTSキャッシュディレクトリ。起動時に `MkdirAll(0750)`、失敗は `log.Fatal`                                      | パッチ0001、`main()`              |
| `YOMIAGE_CACHE_TTL`       | `168h`（7日）            | キャッシュ有効期間。`time.ParseDuration`。**不正・0以下は黙って既定値へ**                                     | パッチ0001、`envDuration`         |
| `YOMIAGE_CACHE_MAX_BYTES` | `268435456`（256MiB）    | キャッシュ総容量上限（バイト、整数のみ・単位付き文字列不可）。**不正・0以下は黙って既定値へ**                 | パッチ0001、`envInt64`            |
| `YOMIAGE_MAX_AUDIO_BYTES` | `33554432`（32MiB）      | 1音声ファイルの上限（バイト）。超過すると合成エラー                                                           | パッチ0001、`envInt64`            |
| `GOMEMLIMIT`              | 構成依存                 | Goランタイムのメモリ上限。Bot本体は読まない（Goランタイムが読む）                                             | env例のみ                         |
| `GOGC`                    | 構成依存                 | Go GC比率。同上                                                                                               | env例のみ                         |

- モード別の既定値の違い（各 `*.env.example` より）:
  - モード01・02・04（1台・1GB）: `GOMEMLIMIT=512MiB`、`GOGC=80`、キャッシュ256MiB（268435456）。
  - モード03 Pi側・モード04分離Bot側（512MB）: `GOMEMLIMIT=128MiB`、`GOGC=50`、キャッシュ128MiB（134217728）。
  - Docker（ルート `Dockerfile` / `windows/docker/Dockerfile` のENV）: `GOMEMLIMIT=128MiB`、`GOGC=50`、キャッシュ256MiB、TTL 168h、最大音声32MiB、`TMPDIR=/var/lib/yomiage-keiryou/tmp`。
  - `YOMIAGE_CACHE_TTL`・`YOMIAGE_MAX_AUDIO_BYTES` は全モード共通で `168h` / `33554432`。
- `.env` ファイルの自動読込は**ない**（Go本体は `os.Getenv` のみ。systemdの `EnvironmentFile`、Docker Composeの `env_file`、手動 `export` で注入する運用）。

### 2.3 環境変数（VOICEVOX Engine側・運用スクリプト用）

Bot本体は読まないが、運用セットに含まれる。

| 変数                                     | 既定値                                         | 用途                                                                 |
| ---------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| `VOICEVOX_BIN`                           | `/opt/voicevox/voicevox_engine`                | Engineバイナリのパス（`voicevox-wrapper` が `--host/--port` で起動） |
| `VOICEVOX_HOST`                          | 例: `10.0.0.12` / `192.168.1.20` / `127.0.0.1` | Engineの bind アドレス。LAN/VPN公開時は明示指定                      |
| `VOICEVOX_PORT`                          | `50021`                                        | Engineのポート                                                       |
| `VOICEVOX_EXTRA_ARGS`                    | 空                                             | Engineへ渡す追加引数（CPUスレッド数等。Engineの版依存）              |
| `VOICEVOX_IMAGE`                         | `voicevox/voicevox_engine:latest`              | Docker用イメージ（`docs/env-setup.md`）                              |
| `BOT_PRIVATE_IP` / `VOICEVOX_PRIVATE_IP` | 例: `10.0.0.11` / `10.0.0.12`                  | 分離構成のプライベートIP。nftablesで50021番の許可元に使う            |
| `LAN_CIDR`                               | 例: `192.168.1.0/24`                           | Pi+PC構成のLAN範囲                                                   |
| `SSH_PORT`                               | `22`                                           | ファイアウォール設定用                                               |

### 2.4 環境変数（バックアップ・同意・ビルド）

| 変数                                                                                      | 既定値                            | 用途                                                                    |
| ----------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `LOCAL_RETENTION_DAYS`                                                                    | `14`                              | ローカルバックアップ保持日数。非整数はエラー終了（`backup-yomiage.sh`） |
| `R2_ENABLED`                                                                              | `0`                               | `1` のときのみCloudflare R2へアップロード（rclone必須）                 |
| `R2_ACCOUNT_ID` / `R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_PREFIX` | — / — / — / — / `yomiage-keiryou` | R2アップロード用。未設定時はエラー終了                                  |
| `YOMIAGE_LICENSE_ACCEPTED` / `YOMIAGE_LICENSE_VERSION`                                    | 自動で `true` / `2026-10-08`      | Docker対話設定の同意フラグ（`docs/env-setup.md`）。Bot本体は読まない    |
| `TARGET_ARCH` / `TARGET_OS`                                                               | `amd64` / `linux`                 | ビルド対象。`linux/amd64` 以外はビルドスクリプトが終了コード2で拒否     |

---

## 3. 読み上げの仕様

### 3.1 自動読み上げの対象条件（`onMessage`、`main.go:236`）

すべて満たす場合のみキューに入る。

1. `message.Author` が存在し、**Botではない**こと（`Author.Bot` は除外）。
2. **ギルド内メッセージ**であること（`GuildID == ""`、すなわちDMは除外）。
3. 本文を `TrimSpace` して空でないこと。
4. `!` で始まらないこと（コマンドとみなされる。未知の `!xxx` も読み上げない）。
5. **文字数が120ルーン以下**であること（`maxMessageRunes = 120`、`utf8.RuneCountInString`。超過は無言で無視。切詰めではなく**全文破棄**）。
6. そのギルドでBotがVCに接続中であること（`players[guildID]` が存在しない場合は無言で無視）。
7. 除外判定（§2.1）に該当しないこと（禁止ユーザー・禁止チャンネル・許可チャンネル外）。

- 対象Intent: `IntentsGuilds | IntentsGuildMessages | IntentsGuildVoiceStates | IntentsMessageContent`（`main.go:200`）。**Message Content Intentが必須**。
- スレッド・フォーラム等の区別はない。チャンネルIDベースの許可／禁止のみ。

### 3.2 除外ルール（まとめ）

| ルール                                   | 挙動                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| Botの発言                                | 読み上げない（自分自身の発言も含む）                                    |
| DM                                       | 読み上げない（コマンドも無視）                                          |
| 空メッセージ（空白のみ）                 | 読み上げない                                                            |
| `!` 始まり                               | コマンドとして処理。該当コマンドがなくても読み上げない                  |
| 121ルーン以上                            | 無言で破棄（`/say` の場合は「120 文字以内で指定してください。」と返す） |
| 禁止ユーザー                             | 読み上げない                                                            |
| 禁止チャンネル                           | 読み上げない                                                            |
| 許可チャンネル設定時、その外のチャンネル | 読み上げない                                                            |
| VC未接続時                               | 読み上げない（キューにも入らない）                                      |

### 3.3 URL / メンション / 絵文字 / 添付の扱い — **すべて未処理（原文のまま）**

**これが元実装の最大の注意点。** 本文のサニタイズ・置換処理は存在しない。

| 要素                                           | 元実装の扱い                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| URL（`https://…`）                             | そのままVOICEVOXへ渡される。「エイチティーティーピー…」のように読まれる |
| ユーザーメンション（`<@123…>`）                | そのまま渡される                                                        |
| ロールメンション（`<@&123…>`）                 | そのまま渡される                                                        |
| チャンネルメンション（`<#123…>`）              | そのまま渡される                                                        |
| カスタム絵文字（`<:name:id>` / `<a:name:id>`） | そのまま渡される                                                        |
| Unicode絵文字                                  | そのまま渡される                                                        |
| スタンプ・添付ファイルのみのメッセージ         | 本文が空なら対象外。本文があれば本文のみ読む（添付の存在は無視）        |
| コードブロック・引用・スポイラー               | 特別扱いなし（記号ごと渡される）                                        |
| 改行                                           | そのまま渡される                                                        |

- リニューアルで「URLは『URL』と読む」「メンションは表示名で読む」「絵文字は読み飛ばす」等を入れる場合は**新規仕様**になる。元実装との互換性を保つか改善するか、方針決定が必要。

### 3.4 文字数上限

| 場所                            | 上限       | 超過時の挙動                                                                      |
| ------------------------------- | ---------- | --------------------------------------------------------------------------------- |
| 自動読み上げ（通常メッセージ）  | 120ルーン  | 無言で破棄                                                                        |
| `/say`・`!say`（`enqueueText`） | 120ルーン  | 「120 文字以内で指定してください。」を返す（`/say` は ephemeral、 `!say` は公開） |
| `/queue` の表示全体             | 1900ルーン | 超過分を切り捨てて `…` を付ける                                                   |
| `/speakers` の表示全体          | 1900ルーン | 超過分を切り捨てて `\n…（続きはVOICEVOXの話者一覧を確認してください）` を付ける   |

- ルーン数（UTF-8文字数）でありバイト数ではない。

### 3.5 キュー挙動

- 容量: **30件**（`queueCapacity = 30`、チャネルバッファ）。`player.queue`（`chan string`、バッファ30）と `player.queued`（`[]string`、表示用のミラー）の二重管理。
- 追加: `player.enqueue`（`main.go:912`）。チャネルへの送信が非ブロッキングで成功すれば `queued` へ append して `true`。満杯なら即 `false`（ブロックしない）。
- 満杯時の挙動:
  - 自動読み上げ: ログに `読み上げキューが満杯です guild=…` を出すだけ。ユーザーへの通知なし。
  - `/say`・`!say`: 「読み上げキューがいっぱいです。少し待ってから再度お試しください。」（処理が終了済みの場合は「現在の読み上げ処理が終了してから再度お試しください。」）。
- 消費: `playQueue`（`main.go:1044`）が1件ずつ順番に処理。再生中は次の文は待機。**ギルドごとに1つの再生ループ**（goroutine）が動く。複数ギルドは並行に再生される。
- 取り出し時の `dequeue`（`main.go:924`）は引数のテキストを無視し、先頭要素を無条件に1件除去する（キューとミラーのずれが起きうる実装上の癖）。
- 再生失敗時のリトライ: `playQueue` が `speak` を **最大2回**試行し、間隔500ms。`context.Canceled`（スキップ・切断）なら即終了。2回とも失敗した場合、通知チャンネル（`/join` 時のチャンネル）へ公開Embedで「音声の生成または再生に失敗しました。VOICEVOXとffmpegの状態を確認してください。」を送る。
- キュー表示（`/queue`・`!queue`）: `1. <本文>` の連番リスト（1始まり）。0件なら「📚 読み上げキューには 0 件の待機があります。」。未接続なら「現在、このサーバーでは読み上げをしていません。」。

### 3.6 スキップ / 停止 / 一時停止

| 操作     | コマンド                           | 権限                               | 挙動・詳細                                                                                                                                                                                                                                            |
| -------- | ---------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| スキップ | `/skip`・`!skip`                   | 管理者                             | 現在再生中の1文だけを中断する。`speechCancel`（`speak` のコンテキストのcancel関数）を呼ぶ。再生中でなければ「現在読み上げ中の文章はありません。」。未接続なら「現在、このサーバーでは読み上げをしていません。」。**待機キューは残る**（次の文へ進む） |
| 全消去   | `/clear`・`!clear`・`clear_button` | 管理者（ボタンは誰でも、§1.3参照） | 待機中のキューをすべて破棄。チャネルを drain し `queued` を nil にする。**再生中の文は止まらない**。返信は「待機中の読み上げを N 件取り消しました。」                                                                                                 |
| 個別削除 | `/remove N`・`!remove N`           | 管理者                             | N番目（1始まり）を削除。範囲外は「キュー番号は 1〜N で指定してください。」（0件時は `1〜0`）。削除後、チャネルを全 drain して残りを再投入して再構築する。返信は「キュー N 番を削除しました: <本文>」                                                  |
| 一時停止 | `/pause`・`!pause`                 | 管理者                             | `player.paused = true`。**次の文の再生開始を止める**。再生中の文は最後まで流れる。返信は「次の読み上げを一時停止しました。再開するには `/resume` を実行してください。」                                                                               |
| 再開     | `/resume`・`!resume`               | 管理者                             | `player.paused = false`。返信は「読み上げを再開しました。」                                                                                                                                                                                           |
| 退出     | `/leave`・`!leave`・`leave_button` | 誰でも                             | VCから切断し、再生ループを終了（`cancel()`）。待機キューは破棄される（`players` から削除）。返信は「読み上げを終了しました。」／未接続時は「現在このサーバーでは読み上げをしていません。」                                                            |

- 一時停止の実装: `playQueue` が文を取り出した後、再生前に `paused` を200ms間隔でポーリングして待つ。**キューへの追加自体は止まらない**（ため込まれる）。
- 終了時の処理: プロセス終了（SIGINT / SIGTERM）で `stopAll`（`main.go:1031`）が全ギルドのVCを切断する。**キューのドレインや保存はしない**。

### 3.7 VC参加 / 退出の詳細

- 参加（`joinForUser`、`main.go:829`）:
  - 実行者のVC参加状態を `session.State.VoiceState(guildID, userID)` で確認。未参加なら「先にボイスチャンネルへ参加してください。」。
  - すでに接続済みなら「すでにボイスチャンネルに接続しています。」（二重接続防止。接続処理中に他方が入った場合も重複接続を切断して同じ文言）。
  - `ChannelVoiceJoin(guildID, channelID, false, true)` — **ミュートなし・スピーカーミュート（deaf）あり**で参加。
  - 接続失敗はログに `❌ ボイスチャンネルへの接続に失敗しました` を残し、「ボイスチャンネルに接続できませんでした。」を返す。
  - 成功時は `playQueue` をgoroutineで開始し「読み上げを開始しました。」。
  - **VCに誰もいなくなっても自動退出しない。** VC参加者の出入りを監視するハンドラは存在しない（`VoiceStateUpdate` ハンドラなし）。退出は `/leave`・`!leave`・ボタン・プロセス終了のみ。
  - 通知チャンネル（再生失敗時の通知先）は `/join`・`!join` を実行したチャンネル（`notifyChannelID`）。
- 切断（`leave`、`main.go:1016`）: `players` から削除 → `cancel()` → `voice.Disconnect()`。切断失敗はログのみ。
- 再生（`speak`、`main.go:1084`）のVC側の流れ:
  - 1文あたりのコンテキストタイムアウト **45秒**（`context.WithTimeout`）。スキップはこのコンテキストをキャンセルすることで実現。
  - VCの `Ready` を100ms間隔でポーリングして待つ（未準備のままタイムアウトすれば `ctx.Err()`）。
  - `Speaking(true)` → Opusフレームを `OpusSend` へ送る → 終了時に `Speaking(false)`（defer）。
  - フレーム送信は `encodeSession.FrameDuration()` 間隔のティッカーで pacing する。

---

## 4. VOICEVOX連携の仕様

### 4.1 エンドポイント一覧

ベースURLは `VOICEVOX_URL`（既定 `http://localhost:50021`、末尾 `/` 除去）。HTTPクライアントのタイムアウトは **30秒**（`http.Client{Timeout: 30s}`）。

| 用途           | メソッド・パス                                                                  | パラメータ                                                                                                                           | タイムアウト                         | 呼び出し元                            |
| -------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------- |
| 音声クエリ作成 | `POST {VOICEVOX_URL}/audio_query?text=<URLエスケープ済み本文>&speaker=<話者ID>` | クエリのみ。ボディなし                                                                                                               | 30秒（クライアント既定）＋文全体45秒 | `synthesizeToFile`（パッチ0001）      |
| 音声合成       | `POST {VOICEVOX_URL}/synthesis?speaker=<話者ID>`                                | クエリ `speaker`。ボディは `audio_query` の応答JSONに `volumeScale`・`speedScale` を上書きしたもの。`Content-Type: application/json` | 同上                                 | `synthesizeToFile`                    |
| 話者一覧       | `GET {VOICEVOX_URL}/speakers`                                                   | なし                                                                                                                                 | **10秒**（`context.WithTimeout`）    | `speakerListMessage`（`main.go:572`） |

- その他のVOICEVOX API（`version`、`audio_query` 以外のクエリパラメータ、`preset`、`user_dict` 等）は**一切呼ばない**。
- `audio_query` の応答は `map[string]any` としてデコードし、以下の2キーのみ上書きする（それ以外のパラメータはVOICEVOX既定のまま）:
  - `volumeScale` ← サーバーの音量設定（0.0〜2.0）
  - `speedScale` ← サーバーの速度設定（0.5〜2.0）
- 話者IDの存在確認はしない。存在しない話者IDを指定すると `audio_query`／`synthesis` が非200を返し、再生失敗扱いになる。

### 4.2 話者一覧（`/speakers`）

- 応答JSONを `[{name, styles: [{id, name}]}]` としてデコードし、`"<styleID>: <話者名>（<スタイル名>）"` を1行ずつ列挙。先頭に `利用可能な話者:` を付ける。
- エラー時の文言:
  - リクエスト作成失敗: 「話者一覧のリクエストを作成できませんでした。」
  - 接続失敗: 「VOICEVOXに接続できないため、話者一覧を取得できません。」
  - 非200: 「話者一覧の取得に失敗しました（<HTTPステータス>）。」
  - デコード失敗: 「話者一覧の形式を読み取れませんでした。」
  - 0件: 「利用可能な話者がありません。」
- 表示は1900ルーンで切詰め（§3.4）。

### 4.3 エラー時の挙動

| 失敗箇所                          | 挙動                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `audio_query` のHTTPエラー・非200 | `VOICEVOX audio query: …` / `VOICEVOX audio query returned <status>` としてエラーを返す                                                     |
| `audio_query` のJSONデコード失敗  | `decode audio query: …`                                                                                                                     |
| `synthesis` のHTTPエラー・非200   | `VOICEVOX synthesis: …` / `VOICEVOX synthesis returned <status>`                                                                            |
| 合成WAVが上限超過                 | `VOICEVOX synthesis exceeded <バイト数> bytes`（`YOMIAGE_MAX_AUDIO_BYTES` 超過時）                                                          |
| 再生ループでの失敗                | 最大2回リトライ（間隔500ms）。それでも失敗なら通知チャンネルへ公開Embedで通知（§3.5）。**失敗した文は破棄され、次へ進む**（再キューしない） |
| VOICEVOX未起動時                  | `/speakers` は接続失敗文言。読み上げはリトライ後に通知チャンネルへ失敗通知。起動時のVOICEVOX疎通チェックは**ない**                          |

- 起動時にVOICEVOXへ接続確認する処理はない。`DISCORD_TOKEN` さえあればVOICEVOXが落ちていてもBotは起動する。

---

## 5. TTSキャッシュ仕様

**すべてパッチ `0001-keiryou-cache.patch` による追加機能。** 素の `main.go` には存在しない。正式ビルド（`build/build.sh`・両Dockerfile）では必ず適用される。

### 5.1 キー生成（`ttsCacheKey`）

- 入力: 本文（原文そのまま）・話者ID・音量・速度。
- 生成式: `SHA-256("v1\x00" + 本文 + "\x00" + 話者ID + "\x00" + 音量 + "\x00" + 速度)` の16進文字列。音量・速度は `strconv.FormatFloat(v, 'g', -1, 64)` で正規化（NaN・±Inf は既定値に置換）。
- ファイル名: `<sha256hex>.wav` を `YOMIAGE_CACHE_DIR` 直下に保存。サブディレクトリなし。
- バージョン接頭辞 `v1\x00` 付き。仕様変更時は `v2` へ上げる設計。
- **注意:** キーにギルドIDは含まれない。同じ本文・話者・音量・速度なら全ギルドで共有される。

### 5.2 ヒット / ミス / 保存（`ensureTTSAudio`）

1. パスを計算し、ファイルが存在し、サイズ > 0、かつ **TTL未超過**ならヒット。`os.Chtimes` でatime/mtimeを現在時刻に更新（**LRUの基準はmtime**）してそのパスを返す。
2. ミス時は **全ギルド共通の `synthMu` で合成を直列化**（低メモリ環境のピーク抑制）。ロック取得後に再度ヒット確認（ダブルチェック）。
3. キャッシュディレクトリ内に一時ファイル `.tts-*.wav.tmp` を作成し、VOICEVOX合成結果を **ストリーミングで直接書き込む**（メモリにWAV全体を載せない。`io.LimitReader` で `YOMIAGE_MAX_AUDIO_BYTES + 1` バイトまで読み、超過でエラー）。
4. 書き込み完了後に `file.Sync()` し、`os.Rename` で正式ファイル名へ原子移動（不完全なWAVは再利用されない）。
5. 保存後に `cleanupTTSCaches(保存したパス)` を呼んで整理する。

### 5.3 TTL・容量上限・GC（`cleanupTTSCaches` / `cache-gc.sh`）

| 項目               | 既定値                       | 挙動                                                                                                                                            |
| ------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| TTL                | `168h`（7日）                | `cacheExpired`: `TTL > 0` かつ `経過時間 >= TTL` で期限切れ。**TTL=0 は無期限扱い**（Go側）。ヒット判定とGCの両方で使う                         |
| 容量上限           | `268435456` バイト（256MiB） | 総量が上限を超えたら **mtimeが古いものから削除**し、上限以下になるまで繰り返す。上限 `<=0` は無制限扱い（Go側）                                 |
| GCの発火タイミング | —                            | ①起動時（`main()` で `cleanupTTSCaches("")` を1回）、②音声保存のたび、③systemd timerによる日次実行（`cache-gc.service` / `cache-gc.timer`、§8） |
| GCの対象           | —                            | キャッシュディレクトリ直下の `*.wav` のみ。`.tmp` や他ファイルは触らない。保存直後のファイル（`excludePath`）は削除対象外                       |

- **シェル版GC（`bot/scripts/cache-gc.sh`）の仕様差:** TTLの単位は `d` / `h` / `m` のみ対応（Goの `time.ParseDuration` とは異なる。`s`・`ms`・複合指定はエラー終了）。TTL=`0` は年齢削除を無効化。容量超過時は `du -sb` と `find -printf '%T@'` で最古から1件ずつ削除。`YOMIAGE_CACHE_MAX_BYTES` は整数チェックあり（不正は終了コード2）。
- キャッシュは再生成可能なため**バックアップ対象外**（README明記）。
- 起動時・保存時のGCは失敗しても無視される（`cleanupTTSCaches` はエラーを返さない）。

### 5.4 メモリ対策の設計意図

- WAVをGoヒープに保持しない（ディスクストリーミング）。
- 合成は全ギルド共通で1件ずつ直列化（`synthMu`）。
- Goランタイム調整: `GOMEMLIMIT`・`GOGC` を構成別に設定（§2.2）。systemdでは `MemoryHigh=256M` / `MemoryMax=384M` も設定。

---

## 6. 辞書機能の仕様

**存在しない。**

- `main.go`・両パッチ・`docs/`・全 `*.env.example`・全スクリプトを検索しても、読み替え辞書・ユーザー辞書・単語登録・置換ルール・VOICEVOX `user_dict` APIの利用は一切ない。
- VOICEVOX Engine側のユーザー辞書（Engine内蔵機能）をBotから操作する手段もない。
- したがってリニューアル版で辞書を入れる場合は**完全な新規機能**。設計時に決めるべき点:
  - 適用範囲（サーバー別か、ユーザー別か、全体か）
  - 適用タイミング（キャッシュキーの計算前＝本文置換後にキーを作る必要がある）
  - VOICEVOXの `user_dict` APIを使うか、Bot側でテキスト置換するか
  - 管理権限・コマンド体系（既存の `/channel`・`/user` に倣うなら管理者専用）

---

## 7. 運用面

### 7.1 運用モード（`modes/`）

| モード                  | 構成                                                                                 | 起動                                          | 推奨度（`modes/README.md`）             |
| ----------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- | --------------------------------------- |
| `01-local-pc-always`    | 自宅PC1台にBot＋VOICEVOX同居                                                         | 常時                                          | ⭐⭐⭐⭐⭐                              |
| `02-local-pc-scheduled` | 自宅PC1台に同居                                                                      | systemd timerで時間帯起動（既定18:00〜02:00） | ⭐⭐⭐⭐                                |
| `03-pi-bot-pc-voicevox` | Pi＝Bot、PC＝VOICEVOXに分離                                                          | Pi常時／PC任意                                | ⭐⭐⭐⭐⭐（ただしARM64ビルドは準備中） |
| `04-vps`                | ConoHa VPS。1GB×1台に同居が推奨スタート。メモリ不足なら512MB Bot＋1GB VOICEVOXに分離 | 常時                                          | ⭐⭐⭐⭐                                |

- 移行ルート（`docs/transition.md`）: 自宅PC →（メモリ不足）→ Pi＋PC →（外へ出したい）→ VPS 1GB×1 →（分離が必要）→ 512MB Bot＋1GB VOICEVOX。TTSキャッシュとWAVディスク化は全段階共通。
- VOICEVOXの50021番は同一ホスト・Docker内部ネットワーク・許可したLAN／プライベートIP以外へ公開しない方針。分離構成ではnftablesでBotホストからのみ許可（`bot/firewall/`・`voicevox/firewall/install-nftables.sh`）。

### 7.2 systemd運用（Linux）

| ファイル                                                  | 内容                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bot/systemd/yomiage-keiryou.service`                     | Bot本体。ユーザー `yomiage-keiryou`、`/etc/yomiage-keiryou/yomiage.env` 読込、`/usr/local/bin/yomiage-keiryou` 起動、`Restart=always`（5秒間隔）。ハードニング多数（`NoNewPrivileges`、`PrivateTmp`、`ProtectSystem=strict` 等）。`MemoryHigh=256M` / `MemoryMax=384M` / `TasksMax=64`。書込可は `/var/lib/yomiage-keiryou` と `/var/cache/yomiage-keiryou` のみ。`TMPDIR=/var/cache/yomiage-keiryou/tmp` |
| `voicevox/systemd/voicevox-engine.service`                | VOICEVOX Engine。ユーザー `voicevox`、`/etc/voicevox-engine.env` 読込、ラッパー `/usr/local/libexec/voicevox-keiryou-wrapper` 経由で起動、`Restart=always`                                                                                                                                                                                                                                                |
| `bot/systemd/yomiage-keiryou-backup.service` + `.timer`   | 日次04:15（`RandomizedDelaySec=20min`、`Persistent=true`）に `backup-yomiage.sh` を実行                                                                                                                                                                                                                                                                                                                   |
| `bot/systemd/yomiage-keiryou-cache-gc.service` + `.timer` | 起動15分後＋24時間ごと（`RandomizedDelaySec=30min`）に `cache-gc.sh` を実行                                                                                                                                                                                                                                                                                                                               |
| `pc-schedule/systemd/`（4ファイル）                       | モード02用。`stack-start.timer` 18:00に両サービス起動、`stack-stop.timer` 02:00に両サービス停止（`Persistent=true`）。**PC自体の電源操作ではない**                                                                                                                                                                                                                                                        |
| `bot/systemd/yomiage-keiryou.conf`                        | journald設定（`SystemMaxUse=32M`、`RuntimeMaxUse=16M`、`MaxRetentionSec=7day`）。`/etc/systemd/journald.conf.d/99-yomiage-keiryou.conf` へ配置                                                                                                                                                                                                                                                            |

- インストール先（README）: バイナリ `/usr/local/bin/yomiage-keiryou`、Bot設定 `/etc/yomiage-keiryou/yomiage.env`、VOICEVOX設定 `/etc/voicevox-engine.env`、設定保存 `/var/lib/yomiage-keiryou`、キャッシュ `/var/cache/yomiage-keiryou/tts`、バックアップ `/var/backups/yomiage-keiryou`。
- インストールスクリプト: `bot/scripts/install.sh`（root必須。ユーザー作成、ディレクトリ作成・権限設定、スクリプトとunitの配置、env例の初期配置（既存ファイルは上書きしない）、`daemon-reload`）。`voicevox/scripts/install.sh`（同上、`/opt/voicevox/voicevox_engine` の存在確認あり）。
- 権限修復: `bot/scripts/doctor-permissions.sh`（診断）、`repair-permissions.sh`（修復）。詳細は `docs/permission-troubleshooting.md`。

### 7.3 Docker運用

- ルート `Dockerfile` と `windows/docker/Dockerfile` は**同一内容**（DAVE対応の正式Docker構成）。ビルドステージは `golang:1.24-bookworm`、実行ステージは `debian:bookworm-slim`＋`ffmpeg`・`ca-certificates`・`libstdc++6`。専用ユーザー `yomiage-keiryou` で実行。`ENTRYPOINT` はバイナリ直指定。
- CI（`.github/workflows/ci.yml`）のdockerジョブは `windows/docker/Dockerfile` を使う。GHCRへのpushは**タグpush時のみ**。
- `windows/docker/compose.yml`: 3サービス構成。
  - `yomiage-volume-init`（rootでnamed volume `yomiage-keiryou-data` を初期化し、所有者をBotユーザーへ変更）
  - `voicevox`（`voicevox/voicevox_engine:latest`、50021番は `expose` のみで**ホストへ公開しない**）
  - `yomiage`（Bot本体。`VOICEVOX_URL=http://voicevox:50021` を環境変数で上書き。`depends_on` でvolume-init完了とvoicevox起動を待つ）
  - `settings.json` とTTSキャッシュは named volume に保存。**バックアップ対象は `settings.json` のみ**。
- Windows運用: Docker Desktop＋WSL2 backend、またはWSL2 Debian＋systemd（`windows/wsl/install-bot.sh` でamd64バイナリを配置）。PowerShellスクリプト群（`backup.ps1`・`restore.ps1`・`repair-volume.ps1`・`setup-env.ps1` 等）と `setup.ps1` / `setup.cmd` / `setup.sh` / `scripts/setup.mjs`（Node.js 22以上）の構築自動化入口がある。

### 7.4 バックアップと復元

- 対象は **`settings.json` のみ**（TTSキャッシュは再生成可能なため対象外）。
- `bot/scripts/backup-yomiage.sh`: `settings.json` を `tar.gz`（`yomiage-settings-YYYYMMDD-HHMMSS.tar.gz`、UTC時刻）に固めて `/var/backups/yomiage-keiryou` へ保存。`LOCAL_RETENTION_DAYS`（既定14日）より古いものを削除。`R2_ENABLED=1` のときのみrcloneでCloudflare R2へアップロード（`R2_PREFIX/<ホスト名>/<ファイル名>`）。`settings.json` が無い場合は空JSON `{ }` を作ってからバックアップする。
- `bot/scripts/restore-yomiage.sh`: 引数のアーカイブから `settings.json` のみを展開（`tar -- settings.json`、権限・所有者は引き継がない）。**復元前に現行ファイルを `settings.json.before-restore.<UTC時刻>` へコピー**してから上書き（0600→0640で配置）。
- Windows Docker版は `backup.ps1` / `restore.ps1`（ZIP形式、`settings-YYYYMMDD-HHMMSS.zip`）。
- 秘密情報（Discordトークン、`.env`、R2アクセスキー、バックアップアーカイブ）はGitへコミットしない運用ルール（README明記）。

### 7.5 権限（Discord側）

- Botに必要なIntent: Guilds、Guild Messages、Guild Voice States、**Message Content**（§3.1）。
- VC参加・発言・メッセージ送信・Embed送信・スラッシュコマンド応答の権限が前提（READMEには権限一覧の明示なし。`docs/permission-troubleshooting.md` はOS側の権限が中心）。
- 管理者専用コマンドの判定は `Administrator` 権限ビットのみ（ロール単位・チャンネル単位の細かい権限制御なし。Discord側のコマンド権限設定も未使用）。
- VOICEVOXの50021番はBotホストからのみ到達可能にする（同一ホスト／Docker内部網／nftables許可）。

### 7.6 ビルドとCI

- `build/build.sh`（7段階）: ①リポジトリソースを作業領域へ展開（`git archive HEAD`）、②パッチの `git apply --check`、③パッチ適用、④DAVE対応discordgoのクローン（`v0.29.1-dave.26`、サブモジュール再帰）、⑤libdaveのビルド（vcpkg＋`make BUILD_TYPE=Release`）、⑥ `go test -vet=off ./...` と `go build -trimpath -ldflags='-s -w'`、⑦成果物 `build/dist/yomiage-keiryou-amd64`。
- 対象は **Linux amd64のみ**。`linux/arm64` は終了コード2で拒否（libdaveのクロスビルド未整備）。Pi（ARM64）は準備中。
- `Makefile`: `build-amd64`、`archive-amd64`（`yomiage-keiryou-linux-amd64.tar.gz`）、`build-windows-amd64`（WSL用にバイナリをコピー）。
- CI（`.github/workflows/ci.yml`）: ①Linux amd64のテスト・ビルド（Go 1.24、`bash ./build/build.sh`、成果物をartifactへ）、②WSL用amd64バイナリのartifact生成、③Dockerイメージビルド（タグ時のみGHCRへpush）。`contents: read` が既定で、dockerジョブのみ `packages: write`。
- リリース番号は `VERSION` とCHANGELOG先頭を揃えて更新する運用。

### 7.7 テスト（`main_test.go`、131行・6テスト）

| テスト                             | 対象                                                             |
| ---------------------------------- | ---------------------------------------------------------------- |
| `TestQueueMessageAndClearQueue`    | キュー表示と全消去（2件→0件）                                    |
| `TestQueueOperationsWithoutPlayer` | 未接続時の `/queue`・`/clear` の文言                             |
| `TestSetSpeakerAndStatus`          | 話者IDのバリデーション（0は拒否）と状態表示                      |
| `TestSettingsPersistAndExclusions` | 音量・速度・チャンネル許可・ユーザー遮断の設定→保存→再読込の復元 |
| `TestVolumeAndSpeedValidation`     | 音量2.1・速度0.4の拒否                                           |
| `TestPauseAndResume`               | 一時停止フラグのON／OFF                                          |

- テストは設定・キュー・バリデーションのみ。**VOICEVOX連携・音声再生・Discord接続のテストはない**（`synthesize`・`speak`・`playQueue` は未テスト）。
- テスト用ヘルパー `newTestBot` は一時ディレクトリの `settings.json` を使う。

---

## 8. リニューアルで再現すべき機能と、落としてよいもの

### 8.1 再現すべき機能（コア）

| 機能                                                                       | 根拠・備考                                                                                                                                                                                |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| スラッシュコマンド17件（§1.1）                                             | 体系の中核。`/join`・`/leave`・`/say`・`/speaker`・`/status`・`/queue`・`/clear`・`/skip`・`/volume`・`/speed`・`/channel`・`/user`・`/help`・`/speakers`・`/pause`・`/resume`・`/remove` |
| `!` メッセージコマンド（§1.2）                                             | 既存ユーザーの利用形態。ただしリニューアルでスラッシュ専用にするかは方針決定（logbot／mabubot流儀ならスラッシュ中心）。残す場合は公開Embedの挙動も含めて再現                              |
| 自動読み上げ（通常メッセージ→VC）                                          | 対象条件（§3.1）・除外ルール（§3.2）・120ルーン上限をそのまま再現                                                                                                                         |
| キュー（容量30・順次再生・満杯時の挙動）                                   | §3.5。容量・文言・満杯時の通知なし／ありの違いを含む                                                                                                                                      |
| スキップ・全消去・個別削除・一時停止・再開                                 | §3.6。再生中の文のみ中断、待機のみ消去、などの範囲を正確に再現                                                                                                                            |
| サーバー別設定（話者・音量・速度・許可／禁止チャンネル・禁止ユーザー）     | §2.1。範囲（音量0.0〜2.0・速度0.5〜2.0・話者1以上）と正規化ルールを含む。保存先はSQLite化してよい（内容は同じ）                                                                           |
| 管理者専用コマンドの権限判定                                               | `Administrator` ビット判定。Discord側の権限制限と併用するかは方針決定                                                                                                                     |
| VOICEVOX連携（`audio_query`→`synthesis`、話者一覧）                        | §4。`volumeScale`・`speedScale` の上書き、話者一覧の表示形式、エラー文言を含む                                                                                                            |
| TTSキャッシュ（キー・TTL・容量上限・GC）                                   | §5。キー式（`v1`＋SHA-256）、TTL 168h、256MiB、mtimeベースLRU、原子rename、合成の直列化を再現                                                                                             |
| Ephemeral Embed応答＋ボタン行                                              | スラッシュ応答は実行者のみ。ボタン5件（接続・終了・状態・キュー・全消去）。**ただし `clear_button` の権限なし問題は修正すること**（§1.3）                                                 |
| 状態表示・キュー表示の文言と1900ルーン切詰め                               | `/status` の「話者ID／音量／速度／待機中 N件」形式を含む                                                                                                                                  |
| 再生失敗時のリトライ（2回・500ms間隔）と通知チャンネルへの公開通知         | §3.5                                                                                                                                                                                      |
| VC参加（deafあり）・切断・プロセス終了時の全切断                           | §3.7                                                                                                                                                                                      |
| ギルドコマンド登録（`DISCORD_GUILD_ID` 指定時）とグローバル登録の切り替え  | logbot／mabubot流儀の「上書き式コマンド同期」へ置き換える場合は、同期の対象（ギルド／グローバル）と削除挙動を決めること                                                                   |
| バックアップ（`settings.json` 相当のみ）・復元（復元前の現行ファイル退避） | SQLite化する場合はDBファイルが対象になる。キャッシュは対象外                                                                                                                              |

### 8.2 改善すべき点（元実装の欠陥・不整合 — リニューアルで直す）

| 項目                                          | 内容                                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `clear_button` に管理者チェックがない         | §1.3。誰でもキュー全消去できる。修正必須                                                                                           |
| メッセージ本文の無加工                        | §3.3。URL・メンション・絵文字がそのまま読まれる。リニューアルで正規化（読み飛ばし／読み替え）を入れるのが望ましい                  |
| `dequeue` が引数を無視して先頭を除去する      | キューと表示ミラーのずれの原因になりうる。単一のキュー構造に整理すること                                                           |
| 壊れた `settings.json` を黙って破棄する       | 起動時に警告のみで空設定になる。リニューアルでは起動失敗させるか、破損ファイルを退避してから開始すること                           |
| 設定保存の失敗をログのみにする                | コマンド応答は成功扱い。保存失敗を応答に反映するか、少なくとも明確に通知すること                                                   |
| `/speaker` に上限チェック・話者存在確認がない | 存在しない話者IDも設定でき、再生時に初めて失敗する。`/speakers` の結果と突合せるか、設定時に `audio_query` で検証する選択肢がある  |
| VC自動退出がない                              | 誰もいなくなってもBotが残り続ける。自動退出（＋再参加時の復帰）の要否を決めること                                                  |
| コマンドの削除・同期がない                    | `registerCommands` は作成のみ。削除したコマンドがDiscord側に残り続ける。logbot／mabubot流儀の上書き式同期（PUT全置換）で解決できる |
| チャンネル／ユーザーIDの数値検証がない        | 存在しないIDも登録できる。登録時に存在確認するか、少なくとも数値形式を検証すること                                                 |
| `/help` がスラッシュコマンドに触れていない    | ヘルプ文言を現行の体系に合わせること                                                                                               |

### 8.3 Go / DAVE固有で落としてよいもの

| 項目                                                  | 理由                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **libdave / DAVE対応フォーク**                        | discord.jsがDAVE（E2EE音声）に標準対応しているため、Go固有の `aleph-garden/discordgo` フォーク・libdaveのC++ビルド・vcpkg・CGOは不要。`patches/0002-dave.patch`・`build/build.sh` のlibdave工程・両Dockerfileのビルドステージは落とす                                                                                 |
| **dca（`jonas747/dca`）＋ffmpegによるOpusエンコード** | discord.js（`@discordjs/voice`）がOpus送信を内包する。`ffmpeg` 依存の明示的なエンコード処理（`speak` 内の `dca.EncodeFile`・フレーム pacing）は不要。ただしVOICEVOXのWAVをどう流すか（`@discordjs/voice` の `createAudioResource` 等）は新実装で決める                                                                |
| **Go固有のビルド体系**                                | `build/build.sh`・`Makefile`・`go.mod`・`go.sum`・CIのGoビルドジョブは不要。TypeScriptのビルド（`tsc`・`npm run build`）とCIに置き換える                                                                                                                                                                              |
| **パッチ適用方式**                                    | `patches/` ディレクトリと `git apply` による機能追加は不要。キャッシュ機能は本体コードとして直接実装する                                                                                                                                                                                                              |
| **systemd timerによる運用**                           | `pc-schedule/` の時間帯起動、`bot/systemd/*-backup.timer`・`cache-gc.timer` は運用形態の選択肢。リニューアルはpm2起動が前提（logbot／mabubot流儀）のため、systemd unit・timerは必須ではない。ただし **日次バックアップとキャッシュGCの「機能」自体**は別手段（pm2常駐プロセス内のスケジューラ等）で再現を検討すること |
| **ARM64ビルド制限**                                   | libdave由来の「Linux amd64のみ」という制約はなくなる。Node.jsが動く環境ならアーキテクチャを問わない                                                                                                                                                                                                                   |
| **Windows Docker / WSL固有の運用一式**                | `windows/` 配下のPowerShell・`setup.ps1`・`setup.cmd`・`scripts/setup.mjs`（Node.js製の構築自動化）・Docker Desktop向けComposeは、リニューアルの運用対象（VPS＋pm2）から外れる。必要になったら別途検討                                                                                                                |
| **Raspberry Piモード（モード03）**                    | ARM64ビルド制限とセットの構成。Node.js版では技術的制約は消えるが、運用モードとして残すかは別途判断                                                                                                                                                                                                                    |
| **R2バックアップ（任意）**                            | `backup-yomiage.sh` の `R2_ENABLED` 経由のrcloneアップロードはオプション機能。リニューアルのバックアップ方針（ローカルのみか、遠隔保管ありか）に従って決める。既定はローカルのみでよい                                                                                                                                |
| **journald設定・systemdハードニング**                 | `bot/systemd/yomiage-keiryou.conf`・service内の `ProtectSystem` 等はsystemd固有。pm2運用では不要（同等のことはpm2／OS側で別途検討）                                                                                                                                                                                   |
| **対話型 `.env` 設定・ライセンス同意フロー**          | `docs/env-setup.md`・`setup-env.ps1/.sh`・同意ログ（`.yomiage-consent.jsonl`）は配布セット固有の仕組み。リニューアルでは不要。`.env` の扱いはlogbot／mabubot流儀に合わせる                                                                                                                                            |
| **`GOMEMLIMIT` / `GOGC`**                             | Goランタイム専用。Node.js版では不要（代わりにNodeのメモリ上限等を必要に応じて設定）                                                                                                                                                                                                                                   |

### 8.4 残すか決める必要があるもの（判断保留）

| 項目                                            | 論点                                                                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 運用モード4種（`modes/`）                       | 構成の考え方自体は有効。リニューアルの運用対象がVPS＋pm2なら、モード01（常時）・モード04（VPS）が中心になり、モード02（時間帯起動）・モード03（Pi分離）は要否を決める |
| VOICEVOX分離構成（BotとEngineを別ホストに置く） | `VOICEVOX_URL` を変えるだけの設計なので、コード上の対応は不要。ファイアウォール（nftables）やEngine側の bind 設定は運用ドキュメントとして残すか決める                 |
| キャッシュGCの外部スクリプト（`cache-gc.sh`）   | Go本体にもGCが内蔵されているため、外部スクリプトは冗長。pm2常駐プロセス内の定期実行に一本化できる                                                                     |
| `DISCORD_GUILD_ID` によるギルドコマンド登録     | 開発中の即時反映用。logbot／mabubot流儀の上書き式同期と組み合わせる場合、ギルド指定の扱いを決める（開発用ギルドへの同期か、グローバル同期か）                         |

---

## 9. main.go 主要関数対応表（実装時の参照用）

行数は `~/workspace/yomiage-orig/main.go`（パッチ適用前）のもの。パッチ0001適用後は `speak`・`synthesizeWithSettings` 周辺の行数が後ろへずれる。

### 9.1 型・定数・コマンド定義

| 名前                  | 種別          | 行      | 内容                                                                                                                                                                                                 |
| --------------------- | ------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定数ブロック          | `const`       | 28-51   | コマンド名17件、`commandPrefix="!"`、`maxMessageRunes=120`、`queueCapacity=30`、`defaultVolume=1.0`、`defaultSpeed=1.0`                                                                              |
| `applicationCommands` | `var`         | 53-137  | スラッシュコマンド17件の定義（名前・説明・オプション）                                                                                                                                               |
| `guildSettings`       | `type struct` | 139-148 | サーバー別設定（§2.1）                                                                                                                                                                               |
| `bot`                 | `type struct` | 150-160 | Bot全体の状態（セッション・TTS URL・話者既定・players・settings・settingsPath）。パッチ0001でキャッシュ用フィールド（`cacheDir`・`cacheTTL`・`cacheMaxByte`・`maxAudioByte`・`synthMu`）が追加される |
| `player`              | `type struct` | 162-174 | ギルドごとの再生状態（VC接続・通知チャンネル・キュー・コンテキスト・一時停止フラグ等）                                                                                                               |

### 9.2 起動・イベント

| 関数                        | 行        | 内容                                                                                                                                                                                          |
| --------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main`                      | 176-234   | 環境変数の読込・バリデーション、Discordセッション作成、Intent設定、設定読込、ハンドラ登録、起動、SIGINT／SIGTERM待ち、`stopAll`。パッチ0001でキャッシュディレクトリ作成と起動時GCが追加される |
| `(b *bot) onMessage`        | 236-381   | メッセージ受信。`!` コマンドの振り分けと自動読み上げの対象判定・キュー投入                                                                                                                    |
| `(b *bot) onInteraction`    | 383-519   | スラッシュコマンドとボタンの振り分け。管理者チェックもここ                                                                                                                                    |
| `(b *bot) replyInteraction` | 521-532   | スラッシュ／ボタンへの ephemeral Embed応答                                                                                                                                                    |
| `(b *bot) reply`            | 1221-1229 | メッセージコマンド・障害通知への公開Embed送信                                                                                                                                                 |
| `(b *bot) registerCommands` | 1296-1319 | スラッシュコマンド登録。`DISCORD_GUILD_ID` 指定時はギルド登録、未指定時はグローバル登録。作成のみ（削除・同期なし）                                                                           |

### 9.3 コマンド処理（設定・キュー・VC）

| 関数                          | 行        | 内容                                                                         |
| ----------------------------- | --------- | ---------------------------------------------------------------------------- |
| `(b *bot) joinMessage`        | 534-536   | `!join` の薄いラッパー                                                       |
| `(b *bot) joinForUser`        | 829-865   | VC参加（実行者のVC確認・二重接続防止・`ChannelVoiceJoin`・`playQueue` 起動） |
| `(b *bot) leaveForCommand`    | 867-872   | `/leave`・`!leave` の文言返却ラッパー                                        |
| `(b *bot) leave`              | 1016-1029 | VC切断と再生ループ終了                                                       |
| `(b *bot) stopAll`            | 1031-1042 | 全ギルドの切断（プロセス終了時）                                             |
| `(b *bot) enqueueText`        | 886-910   | `/say`・`!say` の共通処理（空・120ルーン・未接続・満杯の判定）               |
| `(p *player) enqueue`         | 912-922   | キューへの非ブロッキング追加（満杯なら `false`）                             |
| `(p *player) dequeue`         | 924-930   | 表示用ミラーから先頭を除去（引数無視の癖あり）                               |
| `(p *player) queueLength`     | 987-991   | 待機件数                                                                     |
| `(b *bot) statusMessage`      | 932-941   | `/status` の文言生成                                                         |
| `(b *bot) queueMessage`       | 943-965   | `/queue` の文言生成（1900ルーン切詰め）                                      |
| `(b *bot) clearQueue`         | 967-985   | 待機キューの全消去                                                           |
| `(b *bot) removeQueue`        | 993-1014  | 指定番号の削除とキューの再構築                                               |
| `(b *bot) skip`               | 812-827   | 再生中の文の中断                                                             |
| `(b *bot) pause`              | 538-549   | 一時停止フラグON                                                             |
| `(b *bot) resume`             | 551-562   | 一時停止フラグOFF                                                            |
| `helpMessage`                 | 564-570   | `/help`・`!help` の文言                                                      |
| `(b *bot) speakerListMessage` | 572-611   | `/speakers`（`GET /speakers`、1900ルーン切詰め）                             |
| `(b *bot) setSpeaker`         | 874-880   | 話者IDの設定（1以上のみ）                                                    |
| `(b *bot) guildSpeaker`       | 882-884   | サーバーの話者ID取得                                                         |
| `(b *bot) setVolume`          | 743-749   | 音量の設定（0.0〜2.0）                                                       |
| `(b *bot) setSpeed`           | 751-757   | 速度の設定（0.5〜2.0）                                                       |
| `(b *bot) configureChannel`   | 759-781   | チャンネルの allow／block／remove                                            |
| `(b *bot) configureUser`      | 783-799   | ユーザーの block／remove                                                     |
| `(b *bot) isExcluded`         | 801-810   | 除外判定（禁止ユーザー・禁止チャンネル・許可チャンネル）                     |

### 9.4 設定の永続化・権限・ユーティリティ

| 関数                                    | 行        | 内容                                                           |
| --------------------------------------- | --------- | -------------------------------------------------------------- |
| `settingsFilePath`                      | 648-653   | `YOMIAGE_SETTINGS_FILE`（既定 `./settings.json`）              |
| `(b *bot) loadSettings`                 | 655-673   | `settings.json` の読込（不存在は正常、破損は警告のみで空設定） |
| `normalizeSettings`                     | 675-695   | 設定の正規化（既定値補完・map初期化）                          |
| `(b *bot) saveSettings`                 | 697-723   | 原子置換による全量保存（一時ファイル＋rename）                 |
| `(b *bot) guildSettings`                | 725-730   | サーバー設定の取得（正規化済み）                               |
| `(b *bot) updateSettings`               | 732-741   | 設定の更新＋保存（失敗はログのみ）                             |
| `isAdministrator`                       | 613-615   | `Administrator` 権限ビットの判定                               |
| `(b *bot) isAdminMessage`               | 617-626   | メッセージコマンドの管理者判定（Stateから再取得あり）          |
| `(b *bot) isAdminInteraction`           | 628-630   | スラッシュ／ボタンの管理者判定                                 |
| `commandOption` / `commandOptionString` | 632-646   | スラッシュオプションの取得ヘルパー                             |
| `newEmbed`                              | 1230-1241 | Embed生成（緑／赤、タイトル `📣 読み上げBOT`）                 |
| `newActionRow`                          | 1243-1278 | ボタン5件の行生成                                              |
| `(b *bot) embedFieldsForGuild`          | 1280-1294 | Embedのフィールド（サーバーID・話者ID）                        |

### 9.5 再生・合成（パッチ0001で大きく変わる部分）

| 関数                              | 行（パッチ適用前） | 内容                                                                                                                                                                                     |
| --------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `(b *bot) playQueue`              | 1044-1082          | ギルドごとの再生ループ。一時停止ポーリング（200ms）、`speak` の最大2回リトライ（500ms間隔）、失敗時の通知チャンネルへの公開通知                                                          |
| `(b *bot) speak`                  | 1084-1166          | 1文の再生。45秒タイムアウト、合成→一時WAVファイル→dcaエンコード→VCの `Ready` 待ち→`Speaking(true)`→Opusフレーム送信。**パッチ0001で一時WAV作成が `ensureTTSAudio` 呼び出しに置き換わる** |
| `(b *bot) synthesizeWithSettings` | 1172-1215          | `audio_query`→`synthesis` の2段階合成（バイト列を返す）。**パッチ0001で `synthesizeToFile` へ処理が移り、本関数は一時ファイル経由のラッパーになる**                                      |
| `(b *bot) synthesizeWithSpeaker`  | 1168-1170          | 話者ID指定の合成ラッパー                                                                                                                                                                 |
| `(b *bot) synthesize`             | 1217-1219          | 既定話者での合成ラッパー                                                                                                                                                                 |

### 9.6 パッチ0001で追加される関数（行数はパッチ内での位置。適用後の `main.go` では `synthesize` 付近に挿入される）

| 関数                                     | 内容                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `(b *bot) ensureTTSAudio`                | キャッシュのヒット判定・直列化・一時ファイル合成・原子rename・保存後GC                     |
| `(b *bot) synthesizeToFile`              | `audio_query`→`synthesis` をファイルへストリーミング保存（上限超過チェック・`fsync` 付き） |
| `ttsCacheKey`                            | SHA-256キャッシュキー生成（`v1`＋本文＋話者＋音量＋速度）                                  |
| `cacheExpired`                           | TTL超過判定（TTL=0は無期限）                                                               |
| `(b *bot) cleanupTTSCaches`              | 期限切れ削除＋容量超過時の最古から削除                                                     |
| `normalizeFloat`                         | NaN・±Inf を既定値に置換                                                                   |
| `envString` / `envDuration` / `envInt64` | 環境変数の読込ヘルパー（不正値は黙って既定値へ）                                           |

---

## 10. 参照ファイル一覧（分析の根拠）

| ファイル                                                                                                                        | 内容・分析での用途                          |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `main.go`（1319行）                                                                                                             | 全ロジック。§1〜§4・§9の主根拠              |
| `main_test.go`（131行）                                                                                                         | テスト範囲。§7.7                            |
| `patches/0001-keiryou-cache.patch`                                                                                              | TTSキャッシュ。§5・§9.6の根拠               |
| `patches/0002-dave.patch`                                                                                                       | DAVE対応。§8.3の根拠                        |
| `.env.example`                                                                                                                  | Botの環境変数。§2.2                         |
| `bot/yomiage.env.example`・`bot/backup.env.example`・`bot/network.env.example`                                                  | VPS運用の環境変数。§2.2〜§2.4               |
| `modes/*/README.md`・`modes/*/*.env.example`                                                                                    | 運用モードとモード別既定値。§2.2・§7.1      |
| `docs/automation.md`・`docs/env-setup.md`・`docs/mode-selection.md`・`docs/permission-troubleshooting.md`・`docs/transition.md` | 構築・設定・移行・権限。§7                  |
| `bot/README.md`・`voicevox/README.md`・`bot/systemd/*`・`voicevox/systemd/*`・`bot/scripts/*`・`voicevox/scripts/*`             | systemd・バックアップ・GC・権限。§7.2〜§7.4 |
| `pc-schedule/README.md`・`pc-schedule/systemd/*`                                                                                | 時間帯起動。§7.2                            |
| `windows/README.md`・`windows/docker/*`・`windows/wsl/*`                                                                        | Windows運用。§7.3                           |
| `Dockerfile`・`windows/docker/Dockerfile`（同一内容）                                                                           | DAVE対応コンテナ。§7.3・§8.3                |
| `.github/workflows/ci.yml`                                                                                                      | CI。§7.6                                    |
| `Makefile`・`build/build.sh`                                                                                                    | ビルド手順。§7.6                            |
| `README.md`・`CHANGELOG.md`・`VERSION`（5.3.6）・`go.mod`                                                                       | 全体像・バージョン・依存関係                |

---

## 11. リニューアル設計への申し送り（要判断事項の再掲）

1. **本文の正規化を入れるか**（§3.3）。入れるなら仕様を新規定義すること。入れないなら元実装と同じく原文のまま読む。
2. **辞書機能を新設するか**（§6）。新設するなら適用範囲・適用タイミング（キャッシュキー計算前）・管理権限を決めること。
3. **`!` メッセージコマンドを残すか**、スラッシュ専用にするか（§8.1）。
4. **VC自動退出の要否**（§8.2）。元実装にはない。
5. **コマンド同期方式**。元実装は作成のみ。logbot／mabubot流儀の上書き式同期（PUT全置換）に置き換える場合、ギルド／グローバルの扱いと `DISCORD_GUILD_ID` の扱いを決めること。
6. **設定の保存先**。`settings.json` からNode標準SQLiteへ移行する場合、テーブル設計は §2.1 の項目をそのまま写すこと。ユーザー別設定は元実装にないため、追加するなら新規仕様。
7. **運用形態**。pm2起動を前提とする場合、systemd unit・timer・日次バックアップ・キャッシュGCは pm2常駐プロセス内の仕組みへ置き換えること（§8.3・§8.4）。
8. **`clear_button` の権限チェック漏れを修正すること**（§1.3）。
