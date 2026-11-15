import { fileURLToPath } from "node:url";
import { REST, Routes } from "discord.js";

// リポジトリ直下の .env を読み込む（Bot本体・index.ts と同じ扱い）。
// 既にシェルで export されている値は上書きしないため、下記の
// 「旧アプリの認証情報をシェルでだけ渡す」運用は従来通り可能。
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // .env が無い場合は環境変数のみで動作する。
}

// Delete ALL application commands for one application.
//
// Use this when old commands remain after `npm run sync:commands`.
// Overwrite-sync only replaces the commands of *this* application in
// one scope, so it cannot delete either of these:
//  - guild-scoped commands (registered per server, a separate endpoint)
//  - commands belonging to a *different* application (the old program)
//
// Usage:
//   # yomiko's own global + one guild's commands:
//   DISCORD_GUILD_ID=<guild id> npm run clear:commands
//
//   # the OLD program's commands (different application):
//   # run with the OLD application's token / application id instead.
//   # Do not overwrite yomiko's .env with the old credentials; pass
//   # them only in the shell for this one command, e.g.:
//   DISCORD_TOKEN=<old token> DISCORD_APPLICATION_ID=<old app id> npm run clear:commands
//
// Env vars come from the repo-root .env (loaded above via Node's
// built-in loadEnvFile, no dotenv dependency) or from the shell /
// systemd EnvironmentFile. Shell-provided values win: loadEnvFile
// never overwrites them, so passing the OLD application's credentials
// in the shell for one run (above) still works.
// DISCORD_GUILD_ID / DISCORD_GUILD_IDS (comma-separated) is optional.
const token = process.env.DISCORD_TOKEN?.trim();
const applicationId = process.env.DISCORD_APPLICATION_ID?.trim();
if (!token || !applicationId) {
  console.error("DISCORD_TOKEN and DISCORD_APPLICATION_ID are required.");
  process.exit(1);
}
const guildIds = [
  ...new Set(
    (process.env.DISCORD_GUILD_IDS ?? process.env.DISCORD_GUILD_ID ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  ),
];

const rest = new REST({ version: "10" }).setToken(token);

async function clearScope(label: string, route: `/${string}`): Promise<void> {
  const before = (await rest.get(route)) as Array<{ name: string }>;
  const beforeNames = before.map((c) => c.name).sort();
  if (!before.length) {
    console.log(`${label}: no commands to delete.`);
    return;
  }
  // PUT [] is a full replacement with an empty set: every command is deleted.
  await rest.put(route, { body: [] });
  const after = (await rest.get(route)) as Array<{ name: string }>;
  if (after.length) {
    console.error(
      `${label}: verification failed, ${after.length} command(s) remain: ${after.map((c) => c.name).join(", ")}.`,
    );
    process.exit(1);
  }
  console.log(
    `${label}: deleted ${before.length} command(s): ${beforeNames.join(", ")}`,
  );
}

await clearScope("Global commands", Routes.applicationCommands(applicationId));
for (const guildId of guildIds) {
  await clearScope(
    `Guild commands (${guildId})`,
    Routes.applicationGuildCommands(applicationId, guildId),
  );
}
console.log("All commands cleared for this application.");
if (!guildIds.length) {
  console.log(
    "Note: guild-scoped commands were not checked. Set DISCORD_GUILD_ID to clear them too.",
  );
}
