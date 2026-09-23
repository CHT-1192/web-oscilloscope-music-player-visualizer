#!/usr/bin/env node
'use strict';

/* ============================================================================
    probe.js — audio header inspection for the playlist.

    Enough parsing to show duration / sample rate / channels in the playlist
    without decoding a single audio frame: WAV, FLAC, AIFF/CAF, the MP4 family
    (m4a — AAC or ALAC), Ogg and MP3. Others report nothing, and the app then
    runs at the device rate, which means resampling.

    Why bother for a container whose codec the browser may refuse anyway: the
    sample rate is what decides whether the ANALYSIS path resamples, and that is
    this project's whole premise. A browser that cannot decode ALAC still cannot,
    but a browser that can (Safari) then gets it at its native rate.

    It lives apart from server.js because its failure mode is its own: a bug in
    here shows up as a wrong number in the playlist, not as a broken route or a
    bad byte range. Zero dependencies, like everything else here.
   ========================================================================== */

const fsp = require('node:fs/promises');

/* ------------------------------------------------------------ per container */

function readBitsBE(buf, bitOffset, bitCount) {
  let out = 0n;
  for (let i = 0; i < bitCount; i++) {
    const bit = bitOffset + i;
    const byte = buf[bit >> 3];
    if (byte === undefined) return null;
    out = (out << 1n) | BigInt((byte >> (7 - (bit & 7))) & 1);
  }
  return out;
}

function probeWav(buf) {
  if (buf.length < 44) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt = null;
  let dataSize = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataSize = size;
      break;
    }
    off = body + size + (size % 2); // chunks are word aligned
  }
  if (!fmt || !fmt.sampleRate || !fmt.channels) return null;
  const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
  const duration = dataSize != null && bytesPerSec > 0 ? dataSize / bytesPerSec : null;
  return { ...fmt, duration };
}

function probeFlac(buf) {
  if (buf.length < 42) return null;
  if (buf.toString('latin1', 0, 4) !== 'fLaC') return null;
  // first metadata block must be STREAMINFO (type 0), 34 bytes, at offset 8
  const blockType = buf[4] & 0x7f;
  const blockLen = buf.readUIntBE(5, 3);
  if (blockType !== 0 || blockLen < 34 || buf.length < 8 + 34) return null;
  const si = buf.subarray(8, 42);
  const sampleRate = readBitsBE(si, 80, 20);
  const channels = readBitsBE(si, 100, 3);
  const bps = readBitsBE(si, 103, 5);
  const totalSamples = readBitsBE(si, 108, 36);
  if (sampleRate === null) return null;
  return {
    sampleRate: Number(sampleRate),
    channels: Number(channels) + 1,
    bits: Number(bps) + 1,
    duration: Number(sampleRate) > 0 ? Number(totalSamples) / Number(sampleRate) : null,
  };
}

/** mp4 / m4a / mov. The rate, channel count and bit depth live in the audio
 *  sample entry inside moov > trak > mdia > minf > stbl > stsd, and the duration
 *  in mvhd. Unlike WAV and FLAC there is no fixed header: moov is often at the
 *  END of the file (anything written mdat-first, which is ffmpeg's default), so
 *  the caller hands us a tail slice as well when the head does not contain it.
 *
 *  For ALAC the generic sample-entry fields are not enough — the rate there is
 *  16.16 fixed point (nothing above 65535 Hz fits) and the depth field is only a
 *  hint. The codec's own 36-byte config box carries the truth, so it wins. */
function probeMp4(head, tail) {
  if (head.length < 12 || head.toString('latin1', 4, 8) !== 'ftyp') return null;
  const chunks = tail && tail.length ? [head, tail] : [head];
  const out = { sampleRate: 0, channels: 0, bits: 0, codec: null, duration: null };

  for (const buf of chunks) {
    const find = (s, from) => buf.indexOf(s, from || 0, 'latin1');

    // ALAC codec-specific config:
    // [size=36]['alac'][ver/flags][frameLength][compatibleVersion][bitDepth]
    // [pb][mb][kb][numChannels][maxRun][maxFrameBytes][avgBitRate][sampleRate]
    for (let i = find('alac'); i >= 4 && i + 32 <= buf.length; i = find('alac', i + 1)) {
      if (buf.readUInt32BE(i - 4) !== 36) continue;
      out.codec = 'ALAC';
      out.bits = buf[i + 13];
      out.channels = buf[i + 17];
      out.sampleRate = buf.readUInt32BE(i + 28);
      break;
    }

    // Generic audio sample entry:
    // [size][4cc][reserved 6][dataRefIdx 2][version 2][revision 2][vendor 4]
    // [channels 2][sampleSize 2][compressionId 2][packetSize 2][rate 16.16]
    if (!out.sampleRate) {
      for (const cc of ['mp4a', 'alac']) {
        for (let i = find(cc); i >= 4 && i + 32 <= buf.length; i = find(cc, i + 1)) {
          const clean = buf.readUInt32BE(i + 4) === 0 && buf.readUInt16BE(i + 8) === 0;
          const rate = buf.readUInt32BE(i + 28) >>> 16;
          const ch = buf.readUInt16BE(i + 20);
          if (!clean || rate < 8000 || rate > 384000 || ch < 1 || ch > 8) continue;
          out.codec = cc === 'mp4a' ? 'AAC' : 'ALAC';
          out.sampleRate = rate;
          out.channels = ch;
          // "bit depth" is only meaningful for the lossless one; reporting 16
          // for AAC would imply the source was 16-bit, which nothing says.
          if (cc === 'alac') out.bits = out.bits || buf.readUInt16BE(i + 22);
          break;
        }
        if (out.sampleRate) break;
      }
    }

    // mvhd: [ver/flags][created][modified][timescale][duration] — version 1
    // widens the last four to 64 bits
    const mi = find('mvhd');
    if (out.duration == null && mi >= 0) {
      const v = buf[mi + 4];
      const ts = v === 1 ? buf.readUInt32BE(mi + 24) : buf.readUInt32BE(mi + 16);
      const dur = v === 1 ? Number(buf.readBigUInt64BE(mi + 28)) : buf.readUInt32BE(mi + 20);
      if (ts > 0 && dur > 0) out.duration = dur / ts;
    }

    if (out.sampleRate && out.duration != null) break;
  }

  if (!out.sampleRate) return null;
  if (!out.channels) out.channels = 2;
  return out;
}

async function probeAudio(absPath, size) {
  let fh = null;
  try {
    fh = await fsp.open(absPath, 'r');
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    const head = buf.subarray(0, bytesRead);
    const direct = probeWav(head) || probeFlac(head) || probeAiff(head) || probeCaf(head);
    if (direct) return direct;

    const isMp4 = head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp';
    const isOgg = head.toString('latin1', 0, 4) === 'OggS';
    if (isMp4 || isOgg) {
      /* moov sits at the far end of an mdat-first mp4, and an Ogg duration is
         only in its last page — both need the tail. */
      let tail = null;
      const wantTail = size > head.length && (isOgg || head.indexOf('moov', 0, 'latin1') < 0);
      if (wantTail) {
        const tailLen = Math.min(size - head.length, 1024 * 1024);
        const tb = Buffer.alloc(tailLen);
        const { bytesRead: got } = await fh.read(tb, 0, tailLen, size - tailLen);
        tail = tb.subarray(0, got);
      }
      return isMp4 ? probeMp4(head, tail) : probeOgg(head, tail);
    }
    return probeMp3(head);          // a byte pattern: only for what nothing else claimed
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** AIFF / AIFF-C. The sample rate is an 80-bit IEEE extended float — never a
 *  fixed-width integer — and COMM holds channels, frame count and depth. AIFF-C
 *  (.aifc) differs only by a compression tag, which is why ffmpeg writes
 *  pcm_s16le into one as 'sowt'. */
function readExtendedBE(buf, off) {
  if (buf.length < off + 10) return 0;
  const exp = ((buf[off] & 0x7f) << 8) | buf[off + 1];
  if (exp === 0) return 0;
  let mant = 0n;
  for (let i = 2; i < 10; i++) mant = (mant << 8n) | BigInt(buf[off + i]);
  return Number(mant) * Math.pow(2, exp - 16383 - 63);
}

function probeAiff(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'FORM') return null;
  const form = buf.toString('latin1', 8, 12);
  if (form !== 'AIFF' && form !== 'AIFC') return null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32BE(off + 4);
    const body = off + 8;
    if (id === 'COMM' && body + 18 <= buf.length) {
      const channels = buf.readUInt16BE(body);
      const frames = buf.readUInt32BE(body + 2);
      const bits = buf.readUInt16BE(body + 6);
      const sampleRate = Math.round(readExtendedBE(buf, body + 8));
      if (!sampleRate || !channels) return null;
      const tag = form === 'AIFC' && body + 22 <= buf.length
        ? buf.toString('latin1', body + 18, body + 22) : 'PCM';
      return {
        sampleRate,
        channels,
        bits: bits || null,
        codec: ['NONE', 'twos', 'sowt'].includes(tag) ? 'PCM' : tag,
        duration: frames > 0 ? frames / sampleRate : null,
      };
    }
    off = body + size + (size % 2);          // chunks are word aligned
  }
  return null;
}

/** CAF (Core Audio Format). One `desc` chunk carries everything, big-endian,
 *  behind a 64-bit chunk size. Duration comes from the data chunk: LPCM states
 *  no frame count of its own. */
function probeCaf(buf) {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'caff') return null;
  let off = 8;
  let desc = null;
  let dataSize = null;
  while (off + 12 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = Number(buf.readBigInt64BE(off + 4));
    const body = off + 12;
    if (size < 0) break;
    if (id === 'desc' && body + 32 <= buf.length) {
      desc = {
        sampleRate: Math.round(buf.readDoubleBE(body)),
        formatID: buf.toString('latin1', body + 8, body + 12),
        bytesPerPacket: buf.readUInt32BE(body + 16),
        channels: buf.readUInt32BE(body + 24),
        bits: buf.readUInt32BE(body + 28),
      };
    } else if (id === 'data') {
      dataSize = size;
      break;                                  // the header is all we need
    }
    off = body + size;
  }
  if (!desc || !desc.sampleRate || !desc.channels) return null;
  const pcm = desc.formatID === 'lpcm';
  return {
    sampleRate: desc.sampleRate,
    channels: desc.channels,
    bits: pcm ? (desc.bits || null) : null,
    codec: pcm ? 'PCM' : desc.formatID,
    duration: dataSize != null && desc.bytesPerPacket > 0
      ? dataSize / desc.bytesPerPacket / desc.sampleRate : null,
  };
}

/** Ogg: the first page's payload names the codec. Vorbis states its rate; Opus
 *  always decodes at 48 kHz whatever the source was, and 48 kHz is what the
 *  analyser sees, so that is the honest answer. The duration is not in any
 *  header — it is the granule position of the LAST page, which is why this one
 *  also wants a tail slice. */
function probeOgg(head, tail) {
  if (head.length < 40 || head.toString('latin1', 0, 4) !== 'OggS') return null;
  const body = 27 + head[26];                 // page header + segment table
  if (body + 16 > head.length) return null;
  let sampleRate = 0;
  let channels = 0;
  let codec = null;
  if (head.toString('latin1', body + 1, body + 7) === 'vorbis') {
    sampleRate = head.readUInt32LE(body + 12);
    channels = head[body + 11];
    codec = 'Vorbis';
  } else if (head.toString('latin1', body, body + 8) === 'OpusHead') {
    sampleRate = 48000;
    channels = head[body + 9];
    codec = 'Opus';
  } else {
    return null;
  }
  if (!sampleRate || !channels) return null;

  const end = tail && tail.length > head.length ? tail : head;
  const at = end.lastIndexOf('OggS');
  let duration = null;
  if (at >= 0 && at + 14 <= end.length) {
    const granule = Number(end.readBigUInt64LE(at + 6));   // samples, per the codec's rate
    if (granule > 0) duration = granule / sampleRate;
  }
  return { sampleRate, channels, bits: null, codec, duration };
}

/** MP3: the first frame header, the same scan the client does. Lossy, so no
 *  bit depth is claimed, and no duration — that needs a full frame count or a
 *  Xing header, and a wrong duration is worse than none. */
function probeMp3(buf) {
  const scan = Math.min(buf.length - 4, 65536);
  for (let i = 0; i < scan; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (buf[i + 1] >> 3) & 3;
    const srIdx = (buf[i + 2] >> 2) & 3;
    if (ver === 1 || srIdx === 3) continue;
    const table = ver === 3 ? [44100, 48000, 32000]
      : ver === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
    return {
      sampleRate: table[srIdx],
      channels: ((buf[i + 3] >> 6) & 3) === 3 ? 1 : 2,
      bits: null,
      codec: 'MP3',
    };
  }
  return null;
}

module.exports = { probeAudio };
