// 読み上げ前の本文正規化（元の yomiage には無かった改善）。
// URL・メンション・絵文字・コードブロックを読みやすい形に直し、辞書を適用する。
export interface NormalizeContext {
  resolveUser?: (id: string) => string | null;
  resolveChannel?: (id: string) => string | null;
  resolveRole?: (id: string) => string | null;
}

export interface DictEntryLike {
  word: string;
  reading: string;
}

// [...text].length と同じルーン数
export function runeLength(text: string): number {
  return [...text].length;
}

export function truncateRunes(text: string, maxRunes: number): string {
  const runes = [...text];
  if (runes.length <= maxRunes) return text;
  return runes.slice(0, maxRunes).join("");
}

// 辞書は最長一致で置換する（短い語が長い語の一部を壊さないため）。
// 左から右へ1回だけ走査し、各位置で最も長い一致を採用する単一パス方式。
// 以前の「長い順に split/join を繰り返す」方式は、置換後の読みが後続の
// エントリで再置換される（例: 猫→犬 と 犬→いぬ があると 猫 が いぬ になる）
// 問題があった。単一パスでは読みを再走査しないため起きない。
function applyDict(text: string, dict: DictEntryLike[]): string {
  const entries = dict.filter((entry) => entry.word.length > 0);
  if (entries.length === 0 || text.length === 0) return text;
  // 先頭文字ごとに候補を分け、各候補リスト内では長い順にする。
  const byFirstChar = new Map<string, DictEntryLike[]>();
  for (const entry of entries) {
    const key = entry.word[0] as string;
    const list = byFirstChar.get(key);
    if (list) list.push(entry);
    else byFirstChar.set(key, [entry]);
  }
  for (const list of byFirstChar.values()) {
    list.sort((a, b) => b.word.length - a.word.length);
  }
  let result = "";
  let i = 0;
  while (i < text.length) {
    const candidates = byFirstChar.get(text[i] as string);
    let matched: DictEntryLike | null = null;
    if (candidates) {
      for (const entry of candidates) {
        if (text.startsWith(entry.word, i)) {
          matched = entry;
          break;
        }
      }
    }
    if (matched) {
      result += matched.reading;
      i += matched.word.length;
    } else {
      result += text[i];
      i += 1;
    }
  }
  return result;
}

const URL_PATTERN = /https?:\/\/[^\s<>()\[\]{}"']+/g;
const INVITE_PATTERN = /(?:discord\.gg|discord\.com\/invite)\/[A-Za-z0-9_-]+/g;

export function normalizeText(
  text: string,
  dict: DictEntryLike[],
  ctx: NormalizeContext = {},
): string {
  let result = applyDict(text, dict);

  // コードブロック・インラインコードは読まない
  result = result.replace(/```[\s\S]*?```/g, "");
  result = result.replace(/`[^`\n]*`/g, "");
  // カスタム絵文字は読まない（Markdown記号の除去より先。`>` を使うため）
  result = result.replace(/<a?:[A-Za-z0-9_]+:\d+>/g, "");
  // Markdown記号を落とす。`>`・`#` はメンション構文（`<@123>`・`#名前`）を
  // 壊さないよう行頭のものだけ除去し、`*_~` は全体から除去する。
  result = result.replace(/^#+\s?/gm, "");
  result = result.replace(/^>\s?/gm, "");
  result = result.replace(/[*_~]/g, "");
  // URL・招待リンクは「URL」と読む
  result = result.replace(URL_PATTERN, "URL");
  result = result.replace(INVITE_PATTERN, "URL");
  // ユーザーメンション → 表示名（分からなければ「メンション」）
  result = result.replace(
    /<@!?(\d+)>/g,
    (_m, id: string) => ctx.resolveUser?.(id) ?? "メンション",
  );
  // ロールメンション → ロール名（分からなければ「メンション」）
  result = result.replace(
    /<@&(\d+)>/g,
    (_m, id: string) => ctx.resolveRole?.(id) ?? "メンション",
  );
  // チャンネルメンション → 「#チャンネル名」
  result = result.replace(/<#(\d+)>/g, (_m, id: string) => {
    const name = ctx.resolveChannel?.(id);
    return name ? `#${name}` : "チャンネル";
  });
  // スポイラーは中身だけ読む
  result = result.replace(/\|\|([\s\S]*?)\|\|/g, "$1");
  // Unicode絵文字は読まない
  result = result.replace(/\p{Extended_Pictographic}/gu, "");
  // 改行は読点区切りにして空白を整える
  result = result.replace(/[\r\n]+/g, " ");
  result = result.replace(/\s+/g, " ").trim();
  return result;
}
