// ==========================================
// 🔊 WAV→PCM 変換
// ==========================================
// WAV（PCM16）を @discordjs/voice 用の 48kHz ステレオ s16le PCM へ変換する。
// VOICEVOXは 24kHz モノラル WAV を返すため、ffmpeg なしで再生できる。
export interface PcmData {
  sampleRate: number;
  channels: number;
  samples: Int16Array;
}

export function parseWav(buffer: Buffer): PcmData {
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("WAV形式ではありません。");
  }
  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === "data") {
      // 📌 data を見つけても即 break しない。fmt が data の後にあるファイルでも
      // 読めるよう、位置だけ控えて走査を続ける（offset は data の後ろへ進む）。
      // 宣言サイズがバッファ残量を超える（切り詰められた／可変長として書かれた）
      // 場合は、実際に存在するバイト数へ切り詰めて使う。
      if (dataStart < 0) {
        dataStart = chunkStart;
        dataLength = Math.min(chunkSize, buffer.length - chunkStart);
      }
      offset = chunkStart + chunkSize + (chunkSize % 2);
      continue;
    }
    // 📌 data 以外のチャンクで宣言サイズがバッファを超えていたら、それより後ろの
    // チャンク境界は信頼できないため走査を打ち切る。
    if (chunkStart + chunkSize > buffer.length) break;
    if (chunkId === "fmt ") {
      // ⚠️ fmt の必須フィールド（16バイト）に満たないチャンクは読み違えるため無視する。
      if (chunkSize >= 16) {
        audioFormat = buffer.readUInt16LE(chunkStart);
        channels = buffer.readUInt16LE(chunkStart + 2);
        sampleRate = buffer.readUInt32LE(chunkStart + 4);
        bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
      }
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  if (audioFormat !== 1) {
    throw new Error(
      `対応していないWAV形式です（audioFormat=${audioFormat}）。PCMのみ対応しています。`,
    );
  }
  if (bitsPerSample !== 16) {
    throw new Error(
      `対応していないWAV形式です（${bitsPerSample}bit）。16bit PCMのみ対応しています。`,
    );
  }
  if (channels !== 1 && channels !== 2) {
    throw new Error(
      `対応していないチャンネル数です（${channels}ch）。モノラル／ステレオのみ対応しています。`,
    );
  }
  if (sampleRate <= 0 || dataStart < 0) {
    throw new Error("WAVの読み取りに失敗しました。");
  }
  const sampleCount = Math.floor(dataLength / 2);
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = buffer.readInt16LE(dataStart + i * 2);
  }
  return { sampleRate, channels, samples };
}

// 📌 線形補間で 48kHz ステレオへ変換する。入力はモノラル／ステレオ。
export function resampleTo48kStereo(pcm: PcmData): Buffer {
  const targetRate = 48_000;
  const frames = Math.floor(pcm.samples.length / pcm.channels);
  const outFrames = Math.max(
    1,
    Math.round((frames * targetRate) / pcm.sampleRate),
  );
  const out = Buffer.alloc(outFrames * 2 * 2); // ステレオ × 16bit
  const sampleAt = (frame: number, ch: number): number => {
    const clamped = Math.min(Math.max(frame, 0), frames - 1);
    return pcm.samples[clamped * pcm.channels + ch];
  };
  for (let i = 0; i < outFrames; i++) {
    const srcPos = (i * pcm.sampleRate) / targetRate;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;
    for (let ch = 0; ch < 2; ch++) {
      const srcCh = pcm.channels === 1 ? 0 : ch;
      const a = sampleAt(srcIndex, srcCh);
      const b = sampleAt(srcIndex + 1, srcCh);
      const value = Math.round(a + (b - a) * frac);
      out.writeInt16LE(
        Math.min(32767, Math.max(-32768, value)),
        (i * 2 + ch) * 2,
      );
    }
  }
  return out;
}

export function wavToDiscordPcm(buffer: Buffer): Buffer {
  return resampleTo48kStereo(parseWav(buffer));
}
