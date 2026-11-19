import {
  SOUND_CATALOG,
  SoundEffectItem,
  VOICE_PRESET_CATALOG,
  VoiceEffectType,
  VoicePresetItem,
} from '../data/soundCatalog';
import { TimelineToken } from './scriptParser';

export interface DownloadProgress {
  loaded: number;
  total: number;
  currentName: string;
  currentUrl: string;
  bytesDownloaded: number;
  fromCacheCount: number;
  newlyDownloadedCount: number;
  completedIds: string[];
  failedIds: string[];
}

export interface LocalCacheStats {
  localStorageCount: number;
  indexedDbCount: number;
  totalCachedCount: number;
  totalBytes: number;
}

const LS_MANIFEST_KEY = 'sonic_emoji_manifest_v4';
const LS_B64_PREFIX = 'sonic_emoji_snd_v4_';
const IDB_NAME = 'SonicEmojiAudioDB_v4';
const IDB_STORE = 'audio_buffers';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize))
    );
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function makeDistortionCurve(amount = 40): Float32Array<ArrayBuffer> {
  const k = typeof amount === 'number' ? amount : 40;
  const nSamples = 44100;
  const curve = new Float32Array(new ArrayBuffer(nSamples * 4));
  const deg = Math.PI / 180;
  for (let i = 0; i < nSamples; ++i) {
    const x = (i * 2) / nSamples - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

class AudioLocalCacheManager {
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  private getDb(): Promise<IDBDatabase | null> {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      return Promise.resolve(null);
    }
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve) => {
        try {
          const req = window.indexedDB.open(IDB_NAME, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
              db.createObjectStore(IDB_STORE);
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    return this.dbPromise;
  }

  public async getCachedAudioBytes(
    id: string,
    url: string
  ): Promise<ArrayBuffer | null> {
    const key = `${id}::${url}`;

    // 1. Check localStorage Base64 cache first
    try {
      const b64 = window.localStorage.getItem(LS_B64_PREFIX + id);
      const manifestRaw = window.localStorage.getItem(LS_MANIFEST_KEY);
      if (b64 && manifestRaw) {
        const manifest = JSON.parse(manifestRaw) as Record<string, string>;
        if (manifest[id] === url) {
          return base64ToArrayBuffer(b64);
        }
      }
    } catch {}

    // 2. Check IndexedDB binary cache
    const db = await this.getDb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const req = store.get(key);
        req.onsuccess = () => {
          if (req.result instanceof ArrayBuffer) {
            resolve(req.result);
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  public async saveCachedAudioBytes(
    id: string,
    url: string,
    buffer: ArrayBuffer
  ): Promise<void> {
    const key = `${id}::${url}`;

    // 1. Seamlessly merge into existing localStorage manifest + save compact sounds (< 75KB) in localStorage Base64
    try {
      const manifestRaw = window.localStorage.getItem(LS_MANIFEST_KEY);
      const manifest: Record<string, string> = manifestRaw
        ? JSON.parse(manifestRaw)
        : {};
      manifest[id] = url;
      window.localStorage.setItem(LS_MANIFEST_KEY, JSON.stringify(manifest));

      if (buffer.byteLength <= 75000) {
        const b64 = arrayBufferToBase64(buffer);
        window.localStorage.setItem(LS_B64_PREFIX + id, b64);
      }
    } catch {
      // Ignore localStorage quota limits; IndexedDB stores all binary buffers
    }

    // 2. Save full binary ArrayBuffer in IndexedDB
    const db = await this.getDb();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        store.put(buffer.slice(0), key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  public async clearAll(): Promise<void> {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && (k === LS_MANIFEST_KEY || k.startsWith(LS_B64_PREFIX))) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => window.localStorage.removeItem(k));
    } catch {}

    const db = await this.getDb();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}

const cacheManager = new AudioLocalCacheManager();

class SonicAudioEngine {
  private ctx: AudioContext | null = null;
  private offlineDecoderCtx: OfflineAudioContext | null = null;
  private bufferCache: Map<string, AudioBuffer> = new Map();
  private shortBufferCache: Map<string, AudioBuffer> = new Map();
  private rawBytesCache: Map<string, number> = new Map();
  private localStorageSavedIds: Set<string> = new Set();
  private activeNodes: Set<AudioNode> = new Set();
  private bgmSource: AudioBufferSourceNode | null = null;
  private bgmGain: GainNode | null = null;
  private isPlaying = false;
  private currentRunId = 0;
  private abortController: AbortController | null = null;
  private makeSoundsShort = false;

  public setMakeSoundsShort(short: boolean) {
    this.makeSoundsShort = short;
  }

  public getMakeSoundsShort(): boolean {
    return this.makeSoundsShort;
  }

  public getAudioContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private getDecoderContext(): BaseAudioContext {
    if (this.ctx) return this.ctx;
    if (!this.offlineDecoderCtx) {
      const OfflineCtx =
        window.OfflineAudioContext ||
        (
          window as unknown as {
            webkitOfflineAudioContext: typeof OfflineAudioContext;
          }
        ).webkitOfflineAudioContext;
      this.offlineDecoderCtx = new OfflineCtx(2, 44100, 44100);
    }
    return this.offlineDecoderCtx;
  }

  public getCacheStats(): LocalCacheStats {
    let lsCount = 0;
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(LS_B64_PREFIX)) lsCount++;
      }
    } catch {}
    let totalBytes = 0;
    this.rawBytesCache.forEach((b) => {
      totalBytes += b;
    });
    return {
      localStorageCount: lsCount,
      indexedDbCount: this.localStorageSavedIds.size,
      totalCachedCount: this.bufferCache.size,
      totalBytes,
    };
  }

  public async clearCache(): Promise<void> {
    await cacheManager.clearAll();
    this.localStorageSavedIds.clear();
    this.rawBytesCache.clear();
    this.bufferCache.clear();
    this.shortBufferCache.clear();
  }

  private getFetchUrl(rawUrl: string, useProxy = true): string {
    if (useProxy) {
      return `/api/audio-proxy?url=${encodeURIComponent(rawUrl)}`;
    }
    return rawUrl;
  }

  /**
   * Preloads all sound effects & BGMs:
   * - Seamlessly restores any already-cached sounds from Local Storage / IndexedDB,
   * - Only downloads newly added sounds from the network and merges them into Local Storage!
   * - Uses OfflineAudioContext for decoding so initial page load never triggers browser AudioContext gesture warnings.
   */
  public async preloadAllSounds(
    onProgress: (progress: DownloadProgress) => void,
    forceNetwork = false
  ): Promise<void> {
    const total = SOUND_CATALOG.length;
    let loaded = 0;
    let bytesDownloaded = 0;
    let fromCacheCount = 0;
    let newlyDownloadedCount = 0;
    const completedIds: string[] = [];
    const failedIds: string[] = [];

    const decodeCtx = this.getDecoderContext();
    const concurrency = 10;

    for (let i = 0; i < total; i += concurrency) {
      const batch = SOUND_CATALOG.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (item) => {
          onProgress({
            loaded,
            total,
            currentName: item.name,
            currentUrl: item.url,
            bytesDownloaded,
            fromCacheCount,
            newlyDownloadedCount,
            completedIds: [...completedIds],
            failedIds: [...failedIds],
          });

          try {
            let arrayBuf: ArrayBuffer | null = null;
            if (!forceNetwork) {
              arrayBuf = await cacheManager.getCachedAudioBytes(
                item.id,
                item.url
              );
              if (arrayBuf) {
                fromCacheCount++;
              }
            }

            if (!arrayBuf) {
              const proxyUrl = this.getFetchUrl(item.url, true);
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 14000);
              let res: Response;
              try {
                res = await fetch(proxyUrl, { signal: controller.signal });
                if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
              } catch {
                const directUrl = this.getFetchUrl(item.url, false);
                res = await fetch(directUrl);
                if (!res.ok) throw new Error(`Direct HTTP ${res.status}`);
              } finally {
                clearTimeout(timeout);
              }

              arrayBuf = await res.arrayBuffer();
              newlyDownloadedCount++;
              await cacheManager.saveCachedAudioBytes(
                item.id,
                item.url,
                arrayBuf
              );
            }

            bytesDownloaded += arrayBuf.byteLength;
            this.rawBytesCache.set(item.id, arrayBuf.byteLength);
            this.localStorageSavedIds.add(item.id);

            const decoded = await decodeCtx.decodeAudioData(arrayBuf.slice(0));
            const processed = this.trimSilenceAndKeepWholeSound(
              decodeCtx,
              decoded,
              item
            );
            this.bufferCache.set(item.id, processed);
            completedIds.push(item.id);
          } catch {
            const fallback = this.createSynthesizedBuffer(decodeCtx, item);
            this.bufferCache.set(item.id, fallback);
            failedIds.push(item.id);
            completedIds.push(item.id);
          } finally {
            loaded++;
            onProgress({
              loaded,
              total,
              currentName: item.name,
              currentUrl: item.url,
              bytesDownloaded,
              fromCacheCount,
              newlyDownloadedCount,
              completedIds: [...completedIds],
              failedIds: [...failedIds],
            });
          }
        })
      );
    }
  }

  /**
   * Smart Audio Envelope & Silence Sensing:
   * - Never time-limits BGMs (`item.isBgm` returns 100% of the entire decoded AudioBuffer whole).
   * - Strips leading dead air so the sound plays immediately.
   * - Scans backwards from the end of a generous window (`Math.max(item.maxWholeDuration * 3.5, 12.0)`s)
   *   so internal pauses between bird chirps, phone rings, or words are NEVER cut off!
   */
  private trimSilenceAndKeepWholeSound(
    ctx: BaseAudioContext,
    original: AudioBuffer,
    item: SoundEffectItem
  ): AudioBuffer {
    const sampleRate = original.sampleRate;
    const numCh = original.numberOfChannels;
    const ch0 = original.getChannelData(0);
    const totalSamples = ch0.length;

    // Never time-limit BGMs: return the entire decoded BGM AudioBuffer whole!
    if (item.isBgm) {
      return original;
    }

    const winSize = Math.max(1, Math.floor(sampleRate * 0.02));
    const numWins = Math.ceil(totalSamples / winSize);
    const rmsList = new Float32Array(numWins);
    let peakRms = 0;

    for (let w = 0; w < numWins; w++) {
      const start = w * winSize;
      const end = Math.min(totalSamples, start + winSize);
      let sumSq = 0;
      for (let i = start; i < end; i++) {
        sumSq += ch0[i] * ch0[i];
      }
      const rms = Math.sqrt(sumSq / Math.max(1, end - start));
      rmsList[w] = rms;
      if (rms > peakRms) peakRms = rms;
    }

    if (peakRms < 0.0005) {
      return original;
    }

    const startThreshold = Math.max(0.0025, peakRms * 0.02);
    const tailThreshold = Math.max(0.0015, peakRms * 0.012);

    let firstActiveWin = 0;
    for (let w = 0; w < numWins; w++) {
      if (rmsList[w] >= startThreshold) {
        firstActiveWin = Math.max(0, w - 2);
        break;
      }
    }

    // Generous time limit for whole sound effects (at least 18s or 4.5x item.maxWholeDuration)
    const generousMaxSec = Math.max((item.maxWholeDuration || 4.0) * 4.5, 18.0);
    const maxAllowedWins = Math.ceil(generousMaxSec / 0.02);
    const searchEndWin = Math.min(numWins - 1, firstActiveWin + maxAllowedWins);

    // Scan BACKWARDS from searchEndWin to find the true end of the sound effect,
    // preserving 100% of internal pauses (e.g. between bird chirps, phone rings, or words)!
    let lastActiveWin = searchEndWin;
    for (let w = searchEndWin; w >= firstActiveWin; w--) {
      if (rmsList[w] >= tailThreshold) {
        lastActiveWin = w;
        break;
      }
    }

    const startSample = firstActiveWin * winSize;
    const endSample = Math.min(totalSamples, (lastActiveWin + 8) * winSize);
    const outLength = Math.max(
      Math.min(totalSamples - startSample, Math.floor(sampleRate * 0.35)),
      endSample - startSample
    );

    const out = ctx.createBuffer(numCh, outLength, sampleRate);
    const fadeSamples = Math.min(
      Math.floor(0.04 * sampleRate),
      Math.floor(outLength * 0.12)
    );

    let maxSamplePeak = 0;
    for (
      let i = startSample;
      i < startSample + outLength && i < totalSamples;
      i++
    ) {
      const abs = Math.abs(ch0[i]);
      if (abs > maxSamplePeak) maxSamplePeak = abs;
    }
    const normGain =
      maxSamplePeak > 0.02 ? Math.min(2.2, 0.92 / maxSamplePeak) : 1.0;

    for (let c = 0; c < numCh; c++) {
      const src = original.getChannelData(c);
      const dst = out.getChannelData(c);
      for (let i = 0; i < outLength; i++) {
        let env = 1.0;
        if (i > outLength - fadeSamples) {
          env = Math.max(0, (outLength - i) / fadeSamples);
        }
        const s = (src[startSample + i] || 0) * normGain * env;
        dst[i] = Math.max(-0.98, Math.min(0.98, s));
      }
    }

    return out;
  }

  /**
   * "Make sounds short" Sweet-Spot Cutter (Strictly excludes BGMs):
   * - Never applies to BGMs (`if (item.isBgm) return wholeBuffer;`).
   * - Keeps short sounds (<= ~2.8s–4.2s sweet spot) 100% whole.
   * - For long 5s–15s sounds that would otherwise hold up speech, waits until at least 1.85s
   *   of the sound has played, then cuts at the first natural phrase gap (>= 0.80s silence)
   *   or at the sweet-spot cap (2.8s–4.2s) with a smooth 160ms fade-out so it never sounds abrupt.
   */
  private getSweetSpotShortBuffer(
    wholeBuffer: AudioBuffer,
    item: SoundEffectItem
  ): AudioBuffer {
    if (item.isBgm) {
      return wholeBuffer;
    }

    const cachedShort = this.shortBufferCache.get(item.id);
    if (cachedShort) return cachedShort;

    const sampleRate = wholeBuffer.sampleRate;
    const numCh = wholeBuffer.numberOfChannels;
    const ch0 = wholeBuffer.getChannelData(0);
    const totalSamples = ch0.length;

    // Sweet-spot maximum duration: 2.8s to 4.2s depending on the sound's natural pacing
    const sweetSpotMaxSec = Math.min(
      4.2,
      Math.max(2.8, item.maxWholeDuration || 3.4)
    );
    if (wholeBuffer.duration <= sweetSpotMaxSec + 0.15) {
      this.shortBufferCache.set(item.id, wholeBuffer);
      return wholeBuffer;
    }

    const decodeCtx = this.getDecoderContext();
    const winSize = Math.max(1, Math.floor(sampleRate * 0.02));
    const numWins = Math.ceil(totalSamples / winSize);
    const rmsList = new Float32Array(numWins);
    let peakRms = 0;

    for (let w = 0; w < numWins; w++) {
      const start = w * winSize;
      const end = Math.min(totalSamples, start + winSize);
      let sumSq = 0;
      for (let i = start; i < end; i++) {
        sumSq += ch0[i] * ch0[i];
      }
      const rms = Math.sqrt(sumSq / Math.max(1, end - start));
      rmsList[w] = rms;
      if (rms > peakRms) peakRms = rms;
    }

    const tailThreshold = Math.max(0.004, peakRms * 0.03);
    const maxAllowedWins = Math.min(
      numWins,
      Math.ceil(sweetSpotMaxSec / 0.02)
    );
    // Guarantee at least 1.85 seconds (92 windows) before allowing a silence-gap cut
    const minGuaranteedWins = 92;
    // Require a clear 0.80 second (40 windows) silence gap to cut before sweetSpotMaxSec
    const maxSilentGapWins = 40;

    let lastActiveWin = Math.min(numWins - 1, maxAllowedWins - 1);
    let silentStreak = 0;

    for (let w = 0; w < maxAllowedWins; w++) {
      if (rmsList[w] >= tailThreshold) {
        lastActiveWin = w;
        silentStreak = 0;
      } else {
        silentStreak++;
        if (w >= minGuaranteedWins && silentStreak >= maxSilentGapWins) {
          break;
        }
      }
    }

    const endSample = Math.min(
      totalSamples,
      Math.max(
        Math.floor(sampleRate * 1.85),
        Math.min(
          Math.floor(sweetSpotMaxSec * sampleRate),
          (lastActiveWin + 8) * winSize
        )
      )
    );

    const out = decodeCtx.createBuffer(numCh, endSample, sampleRate);
    const fadeSamples = Math.min(
      Math.floor(0.16 * sampleRate),
      Math.floor(endSample * 0.22)
    );

    for (let c = 0; c < numCh; c++) {
      const src = wholeBuffer.getChannelData(c);
      const dst = out.getChannelData(c);
      for (let i = 0; i < endSample; i++) {
        let env = 1.0;
        if (i > endSample - fadeSamples) {
          env = Math.max(0, (endSample - i) / fadeSamples);
        }
        dst[i] = src[i] * env;
      }
    }

    this.shortBufferCache.set(item.id, out);
    return out;
  }

  /**
   * Ensures a real decoded AudioBuffer is loaded for `item` on-demand if not yet in `bufferCache`,
   * and returns either the whole sound buffer or the sweet-spot shortened buffer (never shortens BGMs).
   */
  private async ensureRealSoundBuffer(
    item: SoundEffectItem,
    useShortMode?: boolean
  ): Promise<AudioBuffer> {
    const shouldShorten =
      !item.isBgm && (useShortMode ?? this.makeSoundsShort);

    let wholeBuf = this.bufferCache.get(item.id);
    if (!wholeBuf) {
      const decodeCtx = this.getDecoderContext();
      try {
        let arrayBuf = await cacheManager.getCachedAudioBytes(
          item.id,
          item.url
        );
        if (!arrayBuf) {
          try {
            const proxyRes = await fetch(this.getFetchUrl(item.url, true));
            if (!proxyRes.ok) throw new Error(`Proxy HTTP ${proxyRes.status}`);
            arrayBuf = await proxyRes.arrayBuffer();
          } catch {
            const directRes = await fetch(this.getFetchUrl(item.url, false));
            if (!directRes.ok)
              throw new Error(`Direct HTTP ${directRes.status}`);
            arrayBuf = await directRes.arrayBuffer();
          }
          await cacheManager.saveCachedAudioBytes(item.id, item.url, arrayBuf);
        }
        const decoded = await decodeCtx.decodeAudioData(arrayBuf.slice(0));
        wholeBuf = this.trimSilenceAndKeepWholeSound(
          decodeCtx,
          decoded,
          item
        );
        this.bufferCache.set(item.id, wholeBuf);
      } catch {
        wholeBuf = this.createSynthesizedBuffer(decodeCtx, item);
      }
    }

    if (shouldShorten) {
      return this.getSweetSpotShortBuffer(wholeBuf, item);
    }
    return wholeBuf;
  }

  private createSynthesizedBuffer(
    ctx: BaseAudioContext,
    item: SoundEffectItem
  ): AudioBuffer {
    const sampleRate = ctx.sampleRate || 44100;
    const duration = item.isBgm
      ? 8.0
      : Math.min(2.0, item.maxWholeDuration || 1.5);
    const length = Math.floor(duration * sampleRate);
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    if (item.isBgm) {
      if (item.synthPreset === 'bgm_horror') {
        // Eerie minor-second horror music box arpeggio + sub-drone
        const notes = [523.25, 622.25, 493.88, 587.33, 440.0, 466.16, 392.0, 369.99];
        for (let i = 0; i < length; i++) {
          const t = i / sampleRate;
          const noteIdx = Math.floor(t * 2.0) % notes.length;
          const localT = (t * 2.0) % 1.0;
          const f = notes[noteIdx];
          const chime =
            (Math.sin(2 * Math.PI * f * t) * 0.7 +
              Math.sin(2 * Math.PI * f * 3.01 * t) * 0.25) *
            Math.exp(-localT * 3.8) *
            0.22;
          const drone =
            Math.sin(2 * Math.PI * 65.41 * t) * 0.12 +
            Math.sin(2 * Math.PI * 69.3 * t) * 0.08;
          data[i] = chime + drone;
        }
        return buffer;
      }

      const chords =
        item.synthPreset === 'bgm_lofi'
          ? [
              [261.63, 329.63, 392.0, 493.88],
              [220.0, 261.63, 329.63, 392.0],
              [174.61, 220.0, 261.63, 349.23],
              [196.0, 246.94, 293.66, 349.23],
            ]
          : [
              [261.63, 311.13, 392.0],
              [293.66, 349.23, 440.0],
              [329.63, 392.0, 493.88],
              [261.63, 329.63, 392.0],
            ];
      for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        const bar = Math.floor(t / 2.0) % chords.length;
        const beatT = (t % 0.5) / 0.5;
        const chord = chords[bar];
        let val = 0;
        for (const freq of chord) {
          val +=
            Math.sin(2 * Math.PI * freq * t) * Math.exp(-beatT * 2.5) * 0.12;
        }
        const bassFreq = chord[0] * 0.5;
        val +=
          Math.sin(2 * Math.PI * bassFreq * t) * Math.exp(-beatT * 4.5) * 0.22;
        data[i] = val;
      }
      return buffer;
    }

    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      if (item.synthPreset === 'vine_boom' || item.id === 'vine_boom') {
        const freq = 64 * Math.exp(-t * 2.1) + 28;
        data[i] =
          Math.tanh(Math.sin(2 * Math.PI * freq * t) * 2.4) *
          Math.exp(-t * 2.2) *
          0.92;
      } else if (item.synthPreset === 'censor_beep') {
        data[i] = Math.sin(2 * Math.PI * 1000 * t) * 0.55;
      } else {
        const freq = 440 + Math.sin(t * 16) * 120;
        data[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 2.5) * 0.5;
      }
    }
    return buffer;
  }

  /**
   * Fetches fresh spoken TTS audio for a segment from real neural TTS providers (Google Assistant or TikTok Neural TTS)
   * with automatic retry so transient network hiccups never drop a voice switch.
   */
  public async fetchSpokenTtsBuffer(
    text: string,
    lang = 'en-US',
    voicePreset?: VoicePresetItem | null,
    runBufferMap?: Map<string, Promise<AudioBuffer | null>>
  ): Promise<AudioBuffer | null> {
    const cleanText = text.trim();
    if (!cleanText) return null;

    const provider = voicePreset?.provider || 'google';
    const apiVoice = voicePreset?.apiVoice || lang;
    const runKey = `${provider}::${apiVoice}::${lang}::${cleanText}`;

    if (runBufferMap && runBufferMap.has(runKey)) {
      return runBufferMap.get(runKey)!;
    }

    const fetchPromise = (async (): Promise<AudioBuffer | null> => {
      const ctx = this.getAudioContext();
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 180 * attempt));
        }
        try {
          const res = await fetch(
            `/api/tts?text=${encodeURIComponent(
              cleanText
            )}&lang=${encodeURIComponent(lang)}&provider=${encodeURIComponent(
              provider
            )}&voice=${encodeURIComponent(apiVoice)}&_t=${Date.now()}_${attempt}`,
            { cache: 'no-store' }
          );
          if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
          const arr = await res.arrayBuffer();
          if (arr.byteLength < 100) throw new Error('Empty TTS buffer');
          const decoded = await ctx.decodeAudioData(arr.slice(0));
          return this.trimTtsSilence(ctx, decoded);
        } catch {
          // Retry up to 3 attempts
        }
      }
      return null;
    })();

    if (runBufferMap) {
      runBufferMap.set(runKey, fetchPromise);
    }
    return fetchPromise;
  }

  private trimTtsSilence(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
    const sr = buf.sampleRate;
    const ch = buf.getChannelData(0);
    const len = ch.length;
    const threshold = 0.008;

    let start = 0;
    while (start < len && Math.abs(ch[start]) < threshold) {
      start++;
    }
    start = Math.max(0, start - Math.floor(sr * 0.02));

    let end = len - 1;
    while (end > start && Math.abs(ch[end]) < threshold) {
      end--;
    }
    end = Math.min(len, end + Math.floor(sr * 0.04));

    const outLen = Math.max(1, end - start);
    const out = ctx.createBuffer(buf.numberOfChannels, outLen, sr);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const src = buf.getChannelData(c);
      const dst = out.getChannelData(c);
      for (let i = 0; i < outLen; i++) {
        dst[i] = src[start + i];
      }
    }
    return out;
  }

  /**
   * Computes adjusted playbackRate, detuneCents, and tail padding strictly from the user's
   * Speed & Pitch sliders and any explicit `effect:...` voice filter tag.
   */
  private getVoiceEffectTimingParams(
    baseRate: number,
    basePitch: number,
    effect: VoiceEffectType
  ): { rate: number; detuneCents: number; extraTailSec: number } {
    let rate = Math.max(0.45, Math.min(2.2, baseRate));
    let detuneCents = (basePitch - 1.0) * 600;
    let extraTailSec = 0;

    if (effect === 'monster') {
      rate *= 0.92;
      detuneCents -= 450;
    } else if (effect === 'chipmunk') {
      rate *= 1.12;
      detuneCents += 550;
    } else if (effect === 'fast') {
      rate = Math.min(2.4, rate * 1.45);
    } else if (effect === 'slow') {
      rate = Math.max(0.4, rate * 0.68);
    } else if (effect === 'cave') {
      extraTailSec = 0.48;
    } else if (effect === 'ghost') {
      extraTailSec = 0.32;
    } else if (effect === 'megaphone') {
      extraTailSec = 0.12;
    }

    return {
      rate,
      detuneCents: Math.max(-1200, Math.min(1200, detuneCents)),
      extraTailSec,
    };
  }

  /**
   * Connects a Web Audio DSP filter graph between `source` and `destination` for `effect:...` tags.
   * Works identically on both live AudioContext and OfflineAudioContext (for WAV exports)!
   */
  private connectVoiceEffectChain(
    ctx: BaseAudioContext,
    source: AudioNode,
    destination: AudioNode,
    effect: VoiceEffectType,
    startTime: number,
    durationSec: number
  ): void {
    if (effect === 'normal' || effect === 'fast' || effect === 'slow') {
      const gain = ctx.createGain();
      gain.gain.value = 1.0;
      source.connect(gain);
      gain.connect(destination);
      return;
    }

    if (effect === 'telephone') {
      // Telephone / Phone Call: 350Hz - 3200Hz bandpass + 1250Hz vocal presence peak + line saturation
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 380;
      hp.Q.value = 0.9;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3100;
      lp.Q.value = 0.9;

      const midPeak = ctx.createBiquadFilter();
      midPeak.type = 'peaking';
      midPeak.frequency.value = 1250;
      midPeak.Q.value = 1.5;
      midPeak.gain.value = 10;

      const shaper = ctx.createWaveShaper();
      shaper.curve = makeDistortionCurve(28);
      shaper.oversample = '2x';

      const outGain = ctx.createGain();
      outGain.gain.value = 1.3;

      source.connect(hp);
      hp.connect(lp);
      lp.connect(midPeak);
      midPeak.connect(shaper);
      shaper.connect(outGain);
      outGain.connect(destination);
      return;
    }

    if (effect === 'radio') {
      // Vintage AM Radio / Walkie-Talkie: narrow 500Hz - 2500Hz + crisp overdrive
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 520;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2500;

      const peak = ctx.createBiquadFilter();
      peak.type = 'peaking';
      peak.frequency.value = 1500;
      peak.Q.value = 2.0;
      peak.gain.value = 12;

      const shaper = ctx.createWaveShaper();
      shaper.curve = makeDistortionCurve(55);

      const outGain = ctx.createGain();
      outGain.gain.value = 1.15;

      source.connect(hp);
      hp.connect(lp);
      lp.connect(peak);
      peak.connect(shaper);
      shaper.connect(outGain);
      outGain.connect(destination);
      return;
    }

    if (effect === 'megaphone') {
      // Megaphone / Bullhorn: 650Hz highpass + 1850Hz horn resonance + clipping + slapback echo
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 650;

      const hornPeak = ctx.createBiquadFilter();
      hornPeak.type = 'peaking';
      hornPeak.frequency.value = 1850;
      hornPeak.Q.value = 2.4;
      hornPeak.gain.value = 14;

      const shaper = ctx.createWaveShaper();
      shaper.curve = makeDistortionCurve(80);

      const dryGain = ctx.createGain();
      dryGain.gain.value = 0.95;

      const delay = ctx.createDelay(0.5);
      delay.delayTime.value = 0.065;
      const wetGain = ctx.createGain();
      wetGain.gain.value = 0.32;

      source.connect(hp);
      hp.connect(hornPeak);
      hornPeak.connect(shaper);

      shaper.connect(dryGain);
      dryGain.connect(destination);

      shaper.connect(delay);
      delay.connect(wetGain);
      wetGain.connect(destination);
      return;
    }

    if (effect === 'cave') {
      // Cave / Cathedral Multi-Tap Echo
      const dryGain = ctx.createGain();
      dryGain.gain.value = 0.95;
      source.connect(dryGain);
      dryGain.connect(destination);

      const taps = [
        { time: 0.13, gain: 0.48 },
        { time: 0.26, gain: 0.32 },
        { time: 0.41, gain: 0.2 },
      ];
      for (const tap of taps) {
        const d = ctx.createDelay(1.0);
        d.delayTime.value = tap.time;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 2200;
        const g = ctx.createGain();
        g.gain.value = tap.gain;

        source.connect(d);
        d.connect(lp);
        lp.connect(g);
        g.connect(destination);
      }
      return;
    }

    if (effect === 'robot') {
      // Robot / Metallic Ring Modulator (55 Hz carrier)
      const ringGain = ctx.createGain();
      ringGain.gain.value = 0.0;

      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 55;
      osc.connect(ringGain.gain);
      osc.start(startTime);
      osc.stop(startTime + durationSec + 0.1);

      const metallicPeak = ctx.createBiquadFilter();
      metallicPeak.type = 'peaking';
      metallicPeak.frequency.value = 950;
      metallicPeak.Q.value = 3.0;
      metallicPeak.gain.value = 8;

      const dryMix = ctx.createGain();
      dryMix.gain.value = 0.55;
      const wetMix = ctx.createGain();
      wetMix.gain.value = 0.85;

      source.connect(dryMix);
      dryMix.connect(metallicPeak);

      source.connect(ringGain);
      ringGain.connect(wetMix);
      wetMix.connect(metallicPeak);

      metallicPeak.connect(destination);
      return;
    }

    if (effect === 'monster') {
      // Monster / Demon: lowpass + warm growl saturation
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1900;

      const bassBoost = ctx.createBiquadFilter();
      bassBoost.type = 'lowshelf';
      bassBoost.frequency.value = 240;
      bassBoost.gain.value = 9;

      const shaper = ctx.createWaveShaper();
      shaper.curve = makeDistortionCurve(18);

      const outGain = ctx.createGain();
      outGain.gain.value = 1.25;

      source.connect(bassBoost);
      bassBoost.connect(lp);
      lp.connect(shaper);
      shaper.connect(outGain);
      outGain.connect(destination);
      return;
    }

    if (effect === 'chipmunk') {
      const hs = ctx.createBiquadFilter();
      hs.type = 'highshelf';
      hs.frequency.value = 2000;
      hs.gain.value = 5;
      source.connect(hs);
      hs.connect(destination);
      return;
    }

    if (effect === 'underwater') {
      // Underwater / Muffled Next Room: steep 360 Hz lowpass
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 360;
      lp.Q.value = 1.8;

      const outGain = ctx.createGain();
      outGain.gain.value = 1.65;

      source.connect(lp);
      lp.connect(outGain);
      outGain.connect(destination);
      return;
    }

    if (effect === 'ghost') {
      // Haunted Ghost: eerie bandpass + dual spectral delay taps
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1100;
      bp.Q.value = 0.8;

      const d1 = ctx.createDelay(0.5);
      d1.delayTime.value = 0.045;
      const g1 = ctx.createGain();
      g1.gain.value = 0.55;

      const d2 = ctx.createDelay(0.5);
      d2.delayTime.value = 0.19;
      const g2 = ctx.createGain();
      g2.gain.value = 0.42;

      const dry = ctx.createGain();
      dry.gain.value = 0.85;

      source.connect(bp);
      bp.connect(dry);
      dry.connect(destination);

      bp.connect(d1);
      d1.connect(g1);
      g1.connect(destination);

      bp.connect(d2);
      d2.connect(g2);
      g2.connect(destination);
      return;
    }

    if (effect === 'whisper') {
      // Soft Whisper: highpass 800Hz + airy highshelf boost
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 800;

      const hs = ctx.createBiquadFilter();
      hs.type = 'highshelf';
      hs.frequency.value = 3600;
      hs.gain.value = 10;

      const outGain = ctx.createGain();
      outGain.gain.value = 0.78;

      source.connect(hp);
      hp.connect(hs);
      hs.connect(outGain);
      outGain.connect(destination);
      return;
    }

    source.connect(destination);
  }

  public async playSoundEffect(
    item: SoundEffectItem,
    volume = 0.95,
    useShortMode?: boolean
  ): Promise<void> {
    const ctx = this.getAudioContext();
    const buffer = await this.ensureRealSoundBuffer(item, useShortMode);

    return new Promise<void>((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = volume;

      source.connect(gain);
      gain.connect(ctx.destination);
      this.activeNodes.add(source);

      source.onended = () => {
        this.activeNodes.delete(source);
        resolve();
      };

      source.start(0);
    });
  }

  private async startBgmLoop(item: SoundEffectItem) {
    this.stopBgmLoop();
    const ctx = this.getAudioContext();
    // BGMs are NEVER shortened: always pass false for useShortMode
    const buffer = await this.ensureRealSoundBuffer(item, false);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.01, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.35);

    source.connect(gain);
    gain.connect(ctx.destination);
    source.start(0);

    this.bgmSource = source;
    this.bgmGain = gain;
  }

  private stopBgmLoop() {
    if (this.bgmSource) {
      try {
        this.bgmSource.stop();
        this.bgmSource.disconnect();
      } catch {}
      this.bgmSource = null;
    }
    if (this.bgmGain) {
      try {
        this.bgmGain.disconnect();
      } catch {}
      this.bgmGain = null;
    }
  }

  public stopAll() {
    this.currentRunId++;
    this.isPlaying = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.stopBgmLoop();
    for (const node of this.activeNodes) {
      try {
        if (
          'stop' in node &&
          typeof (node as AudioBufferSourceNode).stop === 'function'
        ) {
          (node as AudioBufferSourceNode).stop();
        }
        node.disconnect();
      } catch {}
    }
    this.activeNodes.clear();
  }

  private playTtsAudioBuffer(
    buffer: AudioBuffer,
    baseRate: number,
    basePitch: number,
    voiceEffect: VoiceEffectType,
    signal: AbortSignal
  ): Promise<void> {
    const ctx = this.getAudioContext();
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();

      const { rate, detuneCents, extraTailSec } =
        this.getVoiceEffectTimingParams(baseRate, basePitch, voiceEffect);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      source.detune.value = detuneCents;

      const effectiveSpeed = rate * Math.pow(2, detuneCents / 1200);
      const effectiveDur = buffer.duration / Math.max(0.25, effectiveSpeed);

      this.connectVoiceEffectChain(
        ctx,
        source,
        ctx.destination,
        voiceEffect,
        ctx.currentTime,
        effectiveDur
      );
      this.activeNodes.add(source);

      let settled = false;
      let tailTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (!settled) {
          settled = true;
          if (tailTimer) clearTimeout(tailTimer);
          this.activeNodes.delete(source);
          resolve();
        }
      };

      source.onended = () => {
        if (extraTailSec > 0 && !signal.aborted) {
          tailTimer = setTimeout(finish, extraTailSec * 1000);
        } else {
          finish();
        }
      };

      signal.addEventListener('abort', () => {
        try {
          source.stop();
        } catch {}
        finish();
      });

      source.start(0);
    });
  }

  private shouldTokenUseBrowserEngine(
    token: Extract<TimelineToken, { type: 'speech' }>,
    options: {
      experimentalBrowserTts?: boolean;
      ttsEngineMode?: 'neural' | 'browser';
      useBrowserSpeechOnly?: boolean;
    }
  ): boolean {
    if (!options.experimentalBrowserTts) return false;
    if (token.ttsEngine === 'browser') return true;
    if (token.ttsEngine === 'neural') return false;
    if (token.voiceOverride) return false;
    return Boolean(
      options.ttsEngineMode === 'browser' || options.useBrowserSpeechOnly
    );
  }

  private resolveBrowserVoiceForHint(
    hint: string | null | undefined,
    defaultBrowserVoice: SpeechSynthesisVoice | null,
    allBrowserVoices: SpeechSynthesisVoice[] | undefined
  ): SpeechSynthesisVoice | null {
    const pool =
      allBrowserVoices && allBrowserVoices.length > 0
        ? allBrowserVoices
        : typeof window !== 'undefined' && 'speechSynthesis' in window
          ? window.speechSynthesis.getVoices()
          : [];

    if (hint && pool.length > 0) {
      const h = hint.toLowerCase();
      const exact = pool.find((v) => v.name.toLowerCase() === h);
      if (exact) return exact;
      const partial = pool.find(
        (v) =>
          v.name.toLowerCase().includes(h) || v.lang.toLowerCase().includes(h)
      );
      if (partial) return partial;
    }

    if (defaultBrowserVoice) return defaultBrowserVoice;
    return (
      pool.find((v) => v.lang.toLowerCase().startsWith('en') && v.default) ||
      pool.find((v) => v.lang.toLowerCase().startsWith('en')) ||
      pool[0] ||
      null
    );
  }

  /**
   * Matches a Browser SpeechSynthesisVoice by language & name gender cues to the closest
   * Neural Voice preset so offline WAV exports still speak if live tab-audio capture is declined/blocked.
   */
  public matchBrowserVoiceToNeuralPreset(
    browserVoice: SpeechSynthesisVoice | null,
    fallbackLang = 'en-US'
  ): VoicePresetItem {
    const lang = (browserVoice?.lang || fallbackLang || 'en-US').replace(
      '_',
      '-'
    );
    const nameLower = (browserVoice?.name || '').toLowerCase();
    const isFemaleCue =
      /\b(female|woman|girl|zira|hazel|susan|samantha|victoria|karen|tessa|moira|fiona|veena|kate|serena|salli|joanna|ivy|kimberly|kendra|amy|emma|nicole|aria|jenny|ava|sonia|libby|natasha|clara|heera|lekha|kalpana)\b/i.test(
        nameLower
      );
    const isMaleCue =
      /\b(male|man|boy|david|mark|george|daniel|alex|fred|rishi|richard|james|ryan|guy|christopher|eric|brian|matthew|justin|russell|joey|liam|oliver|william|thomas|arthur|hemant|prabhat)\b/i.test(
        nameLower
      );

    if (lang.toLowerCase().startsWith('en-gb')) {
      return (
        VOICE_PRESET_CATALOG.find(
          (vp) =>
            vp.id ===
            (isMaleCue ? 'tiktok:en_uk_001' : 'google:en-GB')
        ) || VOICE_PRESET_CATALOG[0]
      );
    }
    if (lang.toLowerCase().startsWith('en-au')) {
      return (
        VOICE_PRESET_CATALOG.find(
          (vp) =>
            vp.id ===
            (isMaleCue ? 'tiktok:en_au_002' : 'tiktok:en_au_001')
        ) || VOICE_PRESET_CATALOG[0]
      );
    }
    if (lang.toLowerCase().startsWith('en')) {
      if (isFemaleCue && !isMaleCue) {
        return (
          VOICE_PRESET_CATALOG.find((vp) => vp.id === 'tiktok:en_female_sarah') ||
          VOICE_PRESET_CATALOG[0]
        );
      }
      if (isMaleCue && !isFemaleCue) {
        return (
          VOICE_PRESET_CATALOG.find((vp) => vp.id === 'tiktok:en_male_adam') ||
          VOICE_PRESET_CATALOG[0]
        );
      }
      return (
        VOICE_PRESET_CATALOG.find((vp) => vp.id === 'builtin:en-US') ||
        VOICE_PRESET_CATALOG[0]
      );
    }

    const prefix = lang.split('-')[0].toLowerCase();
    const matched =
      VOICE_PRESET_CATALOG.find(
        (vp) => vp.lang.toLowerCase() === lang.toLowerCase()
      ) ||
      VOICE_PRESET_CATALOG.find((vp) =>
        vp.lang.toLowerCase().startsWith(prefix)
      );
    return matched || VOICE_PRESET_CATALOG[0];
  }

  /**
   * Attempts real browser tab-audio PCM capture via `getDisplayMedia` (experimental) so actual
   * `window.speechSynthesis` output + sound effects can be captured live into a WAV Blob.
   * Gracefully returns `null` if denied or blocked by iframe Permissions-Policy.
   */
  public async tryStartLiveTabAudioCapture(): Promise<{
    stopAndRenderWav: () => Promise<{ blob: Blob; durationSec: number }>;
    cancel: () => void;
  } | null> {
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getDisplayMedia !== 'function'
    ) {
      return null;
    }

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 1, height: 1 },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } as MediaTrackConstraints,
      });
    } catch {
      return null;
    }

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks || audioTracks.length === 0) {
      stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
      return null;
    }

    // Silence video track consumption while keeping stream alive for audio track
    stream.getVideoTracks().forEach((vt) => {
      try {
        vt.enabled = false;
      } catch {}
    });

    const ctx = this.getAudioContext();
    const sourceNode = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const silentMonitorGain = ctx.createGain();
    silentMonitorGain.gain.value = 0;

    const chunks: Float32Array[] = [];
    let totalSamples = 0;
    let closed = false;

    processor.onaudioprocess = (e) => {
      if (closed) return;
      const inputData = e.inputBuffer.getChannelData(0);
      const copy = new Float32Array(inputData.length);
      copy.set(inputData);
      chunks.push(copy);
      totalSamples += copy.length;
    };

    sourceNode.connect(processor);
    processor.connect(silentMonitorGain);
    silentMonitorGain.connect(ctx.destination);

    const cleanup = () => {
      closed = true;
      try {
        processor.disconnect();
        sourceNode.disconnect();
        silentMonitorGain.disconnect();
      } catch {}
      stream?.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
    };

    return {
      cancel: cleanup,
      stopAndRenderWav: async () => {
        // Allow trailing audio tail (180ms) before closing capture
        await new Promise((r) => setTimeout(r, 180));
        cleanup();

        const sampleRate = ctx.sampleRate || 44100;
        const merged = new Float32Array(Math.max(1, totalSamples));
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.length;
        }

        const blob = this.pcmSamplesToWavBlob(merged, sampleRate);
        const durationSec = merged.length / sampleRate;
        return { blob, durationSec };
      },
    };
  }

  public async playTimeline(
    tokens: TimelineToken[],
    options: {
      voice: SpeechSynthesisVoice | null;
      voicePreset?: VoicePresetItem | null;
      lang?: string;
      experimentalBrowserTts?: boolean;
      ttsEngineMode?: 'neural' | 'browser';
      browserVoices?: SpeechSynthesisVoice[];
      useBrowserSpeechOnly?: boolean;
      rate: number;
      pitch: number;
      makeSoundsShort?: boolean;
      defaultBgm: SoundEffectItem | null;
      runBufferMap?: Map<string, Promise<AudioBuffer | null>>;
      onTokenChange: (tokenId: string | null, index: number) => void;
      onComplete: () => void;
    }
  ): Promise<void> {
    this.stopAll();
    const runId = ++this.currentRunId;
    this.isPlaying = true;
    const controller = new AbortController();
    this.abortController = controller;
    const lang =
      options.voicePreset?.lang ||
      options.lang ||
      options.voice?.lang ||
      'en-US';
    const runMap =
      options.runBufferMap || new Map<string, Promise<AudioBuffer | null>>();

    const neuralSpeechTokens = tokens.filter(
      (t): t is Extract<TimelineToken, { type: 'speech' }> =>
        t.type === 'speech' && !this.shouldTokenUseBrowserEngine(t, options)
    );
    // Prefetch neural speech tokens in controlled batches of 4 so upstream neural TTS endpoints never rate-limit
    for (let b = 0; b < neuralSpeechTokens.length; b += 4) {
      if (this.currentRunId !== runId || !this.isPlaying || controller.signal.aborted) {
        break;
      }
      const batch = neuralSpeechTokens.slice(b, b + 4);
      await Promise.all(
        batch.map((st) => {
          const effectivePreset =
            st.voiceOverride ??
            options.voicePreset ??
            VOICE_PRESET_CATALOG[0];
          const effectiveLang = effectivePreset?.lang || lang;
          return this.fetchSpokenTtsBuffer(
            st.text,
            effectiveLang,
            effectivePreset,
            runMap
          );
        })
      );
    }

    if (
      this.currentRunId !== runId ||
      !this.isPlaying ||
      controller.signal.aborted
    ) {
      return;
    }

    if (options.defaultBgm) {
      this.startBgmLoop(options.defaultBgm);
    }

    for (let i = 0; i < tokens.length; i++) {
      if (
        this.currentRunId !== runId ||
        !this.isPlaying ||
        controller.signal.aborted
      ) {
        break;
      }
      const token = tokens[i];
      options.onTokenChange(token.id, i);

      if (token.type === 'effect' || token.type === 'voice_switch') {
        continue;
      } else if (token.type === 'bgm') {
        if (token.sound) {
          await this.startBgmLoop(token.sound);
        } else {
          this.stopBgmLoop();
        }
      } else if (token.type === 'pause') {
        await this.waitMs(token.durationSec * 1000, controller.signal);
      } else if (token.type === 'sfx') {
        const useShort = options.makeSoundsShort ?? this.makeSoundsShort;
        if (token.background) {
          this.playSoundEffect(token.sound, 0.78, useShort).catch(() => {});
        } else {
          await this.playSoundEffect(token.sound, 0.98, useShort);
        }
      } else if (token.type === 'speech') {
        const useBrowser = this.shouldTokenUseBrowserEngine(token, options);
        if (useBrowser) {
          const bVoice = this.resolveBrowserVoiceForHint(
            token.browserVoiceHint,
            options.voice,
            options.browserVoices
          );
          await this.speakBrowserSegment(
            token.text,
            bVoice,
            bVoice?.lang || lang,
            options.rate,
            options.pitch,
            controller.signal
          );
          continue;
        }

        const effectivePreset =
          token.voiceOverride ??
          options.voicePreset ??
          VOICE_PRESET_CATALOG[0];
        const effectiveLang = effectivePreset?.lang || lang;
        const ttsBuf = await this.fetchSpokenTtsBuffer(
          token.text,
          effectiveLang,
          effectivePreset,
          runMap
        );
        if (
          this.currentRunId !== runId ||
          !this.isPlaying ||
          controller.signal.aborted
        ) {
          break;
        }
        if (ttsBuf) {
          await this.playTtsAudioBuffer(
            ttsBuf,
            options.rate,
            options.pitch,
            token.voiceEffect,
            controller.signal
          );
        } else {
          await this.speakBrowserSegment(
            token.text,
            options.voice,
            effectiveLang,
            options.rate,
            options.pitch,
            controller.signal
          );
        }
      }
    }

    if (this.currentRunId === runId) {
      this.stopBgmLoop();
      this.isPlaying = false;
      options.onTokenChange(null, -1);
      options.onComplete();
    }
  }

  private waitMs(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private speakBrowserSegment(
    text: string,
    voice: SpeechSynthesisVoice | null,
    lang: string,
    rate: number,
    pitch: number,
    signal: AbortSignal
  ): Promise<void> {
    return new Promise((resolve) => {
      if (
        signal.aborted ||
        typeof window === 'undefined' ||
        !('speechSynthesis' in window)
      ) {
        return resolve();
      }

      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang || voice?.lang || 'en-US';
      if (voice) utterance.voice = voice;
      utterance.rate = Math.max(0.5, Math.min(2.0, rate));
      utterance.pitch = Math.max(0.5, Math.min(2.0, pitch));

      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const words = text.split(/\s+/).length;
      const estimatedMs = Math.max(1800, (words * 360) / rate + 1200);
      const safetyTimer = setTimeout(finish, estimatedMs);

      utterance.onend = () => {
        clearTimeout(safetyTimer);
        finish();
      };
      utterance.onerror = () => {
        clearTimeout(safetyTimer);
        finish();
      };

      signal.addEventListener('abort', () => {
        clearTimeout(safetyTimer);
        window.speechSynthesis.cancel();
        finish();
      });

      window.speechSynthesis.speak(utterance);
    });
  }

  /**
   * Renders the ENTIRE timeline — including REAL Spoken Text-to-Speech AudioBuffers,
   * Voice Effect DSP chains (effect:telephone, effect:phone call, etc.), whole Sound Effects,
   * timed Pauses, and Musical/Horror BGM segments — into a 44.1 kHz 16-bit PCM WAV Blob!
   * When experimental Browser TTS segments exist offline, automatically matches each browser
   * voice to its nearest neural voice approximation so the WAV retains full dialogue.
   */
  public async renderTimelineToWavBlob(
    tokens: TimelineToken[],
    options: {
      rate: number;
      pitch: number;
      lang?: string;
      voicePreset?: VoicePresetItem | null;
      voice?: SpeechSynthesisVoice | null;
      browserVoices?: SpeechSynthesisVoice[];
      experimentalBrowserTts?: boolean;
      ttsEngineMode?: 'neural' | 'browser';
      makeSoundsShort?: boolean;
      defaultBgm: SoundEffectItem | null;
      runBufferMap?: Map<string, Promise<AudioBuffer | null>>;
    }
  ): Promise<{ blob: Blob; durationSec: number }> {
    const sampleRate = 44100;
    const lang = options.voicePreset?.lang || options.lang || 'en-US';
    const runMap =
      options.runBufferMap || new Map<string, Promise<AudioBuffer | null>>();

    const resolveEffectivePresetForWav = (
      st: Extract<TimelineToken, { type: 'speech' }>
    ): VoicePresetItem => {
      if (this.shouldTokenUseBrowserEngine(st, options)) {
        const bVoice = this.resolveBrowserVoiceForHint(
          st.browserVoiceHint,
          options.voice ?? null,
          options.browserVoices
        );
        return this.matchBrowserVoiceToNeuralPreset(bVoice, lang);
      }
      return st.voiceOverride ?? options.voicePreset ?? VOICE_PRESET_CATALOG[0];
    };

    const speechTokens = tokens.filter(
      (t): t is Extract<TimelineToken, { type: 'speech' }> =>
        t.type === 'speech'
    );
    for (let b = 0; b < speechTokens.length; b += 4) {
      const batch = speechTokens.slice(b, b + 4);
      await Promise.all(
        batch.map((st) => {
          const effectivePreset = resolveEffectivePresetForWav(st);
          const effectiveLang = effectivePreset.lang || lang;
          return this.fetchSpokenTtsBuffer(
            st.text,
            effectiveLang,
            effectivePreset,
            runMap
          );
        })
      );
    }

    interface ScheduledClip {
      startSec: number;
      durationSec: number;
      buffer: AudioBuffer;
      gain: number;
      playbackRate: number;
      detuneCents: number;
      voiceEffect: VoiceEffectType;
    }

    interface BgmSpan {
      sound: SoundEffectItem;
      startSec: number;
      endSec: number;
    }

    const clips: ScheduledClip[] = [];
    const bgmSpans: BgmSpan[] = [];
    let currentBgm: { sound: SoundEffectItem; startSec: number } | null =
      options.defaultBgm ? { sound: options.defaultBgm, startSec: 0 } : null;

    let cursorSec = 0.05;

    for (const token of tokens) {
      if (token.type === 'effect' || token.type === 'voice_switch') {
        continue;
      } else if (token.type === 'bgm') {
        if (currentBgm) {
          bgmSpans.push({
            sound: currentBgm.sound,
            startSec: currentBgm.startSec,
            endSec: cursorSec,
          });
          currentBgm = null;
        }
        if (token.sound) {
          currentBgm = { sound: token.sound, startSec: cursorSec };
        }
      } else if (token.type === 'pause') {
        cursorSec += token.durationSec;
      } else if (token.type === 'sfx') {
        const useShort = options.makeSoundsShort ?? this.makeSoundsShort;
        const buf = await this.ensureRealSoundBuffer(token.sound, useShort);
        clips.push({
          startSec: cursorSec,
          durationSec: buf.duration,
          buffer: buf,
          gain: token.background ? 0.75 : 0.98,
          playbackRate: 1.0,
          detuneCents: 0,
          voiceEffect: 'normal',
        });
        if (!token.background) {
          cursorSec += buf.duration + 0.04;
        }
      } else if (token.type === 'speech') {
        const effectivePreset = resolveEffectivePresetForWav(token);
        const effectiveLang = effectivePreset.lang || lang;
        const ttsBuf = await this.fetchSpokenTtsBuffer(
          token.text,
          effectiveLang,
          effectivePreset,
          runMap
        );
        if (ttsBuf) {
          const { rate, detuneCents, extraTailSec } =
            this.getVoiceEffectTimingParams(
              options.rate,
              options.pitch,
              token.voiceEffect
            );
          const effectiveSpeedFactor =
            rate * Math.pow(2, detuneCents / 1200);
          const effectiveDur =
            ttsBuf.duration / Math.max(0.25, effectiveSpeedFactor);

          clips.push({
            startSec: cursorSec,
            durationSec: effectiveDur,
            buffer: ttsBuf,
            gain: 1.0,
            playbackRate: rate,
            detuneCents,
            voiceEffect: token.voiceEffect,
          });
          cursorSec += effectiveDur + extraTailSec + 0.06;
        }
      }
    }

    const totalDurationSec = Math.max(1.0, cursorSec + 0.35);
    if (currentBgm) {
      bgmSpans.push({
        sound: currentBgm.sound,
        startSec: currentBgm.startSec,
        endSec: totalDurationSec,
      });
    }

    const totalSamples = Math.ceil(totalDurationSec * sampleRate);
    const offlineCtx = new OfflineAudioContext(1, totalSamples, sampleRate);

    for (const span of bgmSpans) {
      if (span.endSec <= span.startSec + 0.05) continue;
      // BGMs are NEVER shortened: always pass false
      const bgmBuf = await this.ensureRealSoundBuffer(span.sound, false);
      const src = offlineCtx.createBufferSource();
      src.buffer = bgmBuf;
      src.loop = true;

      const g = offlineCtx.createGain();
      const fadeInEnd = Math.min(span.endSec, span.startSec + 0.25);
      const fadeOutStart = Math.max(span.startSec, span.endSec - 0.3);
      g.gain.setValueAtTime(0.01, span.startSec);
      g.gain.linearRampToValueAtTime(0.16, fadeInEnd);
      g.gain.setValueAtTime(0.16, fadeOutStart);
      g.gain.linearRampToValueAtTime(0.001, span.endSec);

      src.connect(g);
      g.connect(offlineCtx.destination);
      src.start(span.startSec);
      src.stop(span.endSec);
    }

    for (const clip of clips) {
      const src = offlineCtx.createBufferSource();
      src.buffer = clip.buffer;
      src.playbackRate.value = clip.playbackRate;
      src.detune.value = clip.detuneCents;

      const g = offlineCtx.createGain();
      g.gain.setValueAtTime(clip.gain, clip.startSec);
      src.connect(g);

      this.connectVoiceEffectChain(
        offlineCtx,
        g,
        offlineCtx.destination,
        clip.voiceEffect,
        clip.startSec,
        clip.durationSec
      );

      src.start(clip.startSec);
    }

    const renderedBuffer = await offlineCtx.startRendering();
    const wavBlob = this.audioBufferToWavBlob(renderedBuffer);
    return { blob: wavBlob, durationSec: totalDurationSec };
  }

  private audioBufferToWavBlob(buffer: AudioBuffer): Blob {
    return this.pcmSamplesToWavBlob(
      buffer.getChannelData(0),
      buffer.sampleRate
    );
  }

  private pcmSamplesToWavBlob(
    channelData: Float32Array,
    sampleRate: number
  ): Blob {
    const numChannels = 1;
    const numSamples = channelData.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = numSamples * blockAlign;

    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);

    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      const sample = Math.max(-1, Math.min(1, channelData[i]));
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, int16, true);
      offset += 2;
    }

    return new Blob([arrayBuffer], { type: 'audio/wav' });
  }
}

export const sonicAudioEngine = new SonicAudioEngine();
