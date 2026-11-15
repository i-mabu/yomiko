// pm2 ecosystem file for yomiko.
//
// Start with:  pm2 start ecosystem.config.cjs
// Then make it survive a server reboot with:  pm2 startup  (run the
// command it prints)  and  pm2 save
//
// Why this file loads .env itself: pm2 does not load a .env file, and
// this bot does not auto-load one either (no dotenv dependency), so
// DISCORD_TOKEN / DISCORD_APPLICATION_ID would otherwise be missing.
// This file parses the repo-root `.env` and passes it to the app as
// environment variables. Secrets stay in `.env` (gitignored) — never
// put them in this file.
//
// Node version: the bot uses Node's built-in `node:sqlite`, which on
// Node 22 still needs `--experimental-sqlite`. This file adds that
// flag automatically on Node < 24; on Node 24+ it is not needed.
const fs = require("node:fs");
const path = require("node:path");

// .env の値部分を解釈する。
// - ダブルクォート: 閉じクォートまでを取り、\n \r \t \" \\ を展開する。
//   閉じクォートの後ろ（インラインコメント等）は無視する。
// - シングルクォート: 閉じクォートまでをそのまま取る。
// - 無引用: 空白＋# 以降はインラインコメントとして取り除く。
// 以前の実装は `"値" # コメント` の形で引用符が値に残ったり、無引用値の
// インラインコメントが値に混入したりして、トークンが壊れることがあった。
function parseEnvValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    let out = "";
    for (let i = 1; i < value.length; i++) {
      const ch = value[i];
      if (ch === "\\" && i + 1 < value.length) {
        const next = value[i + 1];
        if (next === "n") {
          out += "\n";
          i++;
          continue;
        }
        if (next === "r") {
          out += "\r";
          i++;
          continue;
        }
        if (next === "t") {
          out += "\t";
          i++;
          continue;
        }
        if (next === '"') {
          out += '"';
          i++;
          continue;
        }
        if (next === "\\") {
          out += "\\";
          i++;
          continue;
        }
        out += ch;
        continue;
      }
      if (ch === '"') break;
      out += ch;
    }
    return out;
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  const commentIndex = value.search(/\s#/);
  return (commentIndex === -1 ? value : value.slice(0, commentIndex)).trim();
}

function loadEnvFile(file) {
  const env = {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return env;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match) continue;
    env[match[1]] = parseEnvValue(match[2]);
  }
  return env;
}

const envFromFile = loadEnvFile(path.join(__dirname, ".env"));
if (!envFromFile.DISCORD_TOKEN || !envFromFile.DISCORD_APPLICATION_ID) {
  console.error(
    "[yomiko] .env に DISCORD_TOKEN / DISCORD_APPLICATION_ID がありません。先に .env を用意してください。",
  );
}

const nodeMajor = Number(process.versions.node.split(".")[0]);

module.exports = {
  apps: [
    {
      name: "yomiko",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      kill_timeout: 5000,
      // Node < 24 needs this flag for `node:sqlite`.
      ...(nodeMajor < 24 ? { node_args: "--experimental-sqlite" } : {}),
      env: {
        NODE_ENV: "production",
        ...envFromFile,
      },
    },
  ],
};
