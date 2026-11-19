import { GoogleGenAI } from '@google/genai';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import zlib from 'zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZipBuffer(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const uncompressed = entry.data;
    const compressed = zlib.deflateRawSync(uncompressed, { level: 6 });
    const checksum = crc32(uncompressed);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(20, 4); // Version needed to extract
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(8, 8); // Compression method: deflate
    localHeader.writeUInt16LE(0, 10); // Mod time
    localHeader.writeUInt16LE(0x21, 12); // Mod date
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // Extra field length

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
    centralHeader.writeUInt16LE(20, 4); // Version made by
    centralHeader.writeUInt16LE(20, 6); // Version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(8, 10); // Deflate
    centralHeader.writeUInt16LE(0, 12); // Mod time
    centralHeader.writeUInt16LE(0x21, 14); // Mod date
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // Extra length
    centralHeader.writeUInt16LE(0, 32); // Comment length
    centralHeader.writeUInt16LE(0, 34); // Disk number
    centralHeader.writeUInt16LE(0, 36); // Internal attrs
    centralHeader.writeUInt32LE(0, 38); // External attrs
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDirBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // End of central directory signature
  eocd.writeUInt16LE(0, 4); // Disk number
  eocd.writeUInt16LE(0, 6); // Start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // Comment length

  return Buffer.concat([...localParts, centralDirBuf, eocd]);
}

function collectProjectSourceEntries(rootDir: string): Array<{ name: string; data: Buffer }> {
  const entries: Array<{ name: string; data: Buffer }> = [];
  const allowedRootFiles = [
    'package.json',
    'index.html',
    'tsconfig.json',
    'vite.config.ts',
    'server.ts',
    'metadata.json',
    '.env.example',
    '.gitignore',
  ];

  for (const filename of allowedRootFiles) {
    const fullPath = path.join(rootDir, filename);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      entries.push({
        name: `sonic-emoji/${filename}`,
        data: fs.readFileSync(fullPath),
      });
    }
  }

  const walkDir = (dir: string, relPrefix: string) => {
    if (!fs.existsSync(dir)) return;
    const dirents = fs.readdirSync(dir, { withFileTypes: true });
    for (const d of dirents) {
      if (
        d.name === 'node_modules' ||
        d.name === 'dist' ||
        d.name === '.git' ||
        d.name.startsWith('.env')
      ) {
        continue;
      }
      const fullPath = path.join(dir, d.name);
      const relPath = `${relPrefix}/${d.name}`;
      if (d.isDirectory()) {
        walkDir(fullPath, relPath);
      } else if (d.isFile()) {
        entries.push({
          name: `sonic-emoji/${relPath}`,
          data: fs.readFileSync(fullPath),
        });
      }
    }
  };

  walkDir(path.join(rootDir, 'src'), 'src');
  return entries;
}

/**
 * Splits a long text string into natural speech chunks <= maxLen chars
 * so both Google Assistant TTS and TikTok Neural TTS endpoints can synthesize any paragraph reliably.
 */
function splitTextIntoChunks(text: string, maxLen = 175): string[] {
  const cleaned = text
    .replace(/\.{2,}|…+/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxLen) return [cleaned];

  const chunks: string[] = [];
  const sentences = cleaned.split(/(?<=[.!?।,;:])\s+/);
  let current = '';

  for (const sentence of sentences) {
    if ((current + ' ' + sentence).trim().length <= maxLen) {
      current = (current + ' ' + sentence).trim();
    } else {
      if (current) chunks.push(current);
      if (sentence.length <= maxLen) {
        current = sentence;
      } else {
        const words = sentence.split(' ');
        let wordChunk = '';
        for (const w of words) {
          if ((wordChunk + ' ' + w).trim().length <= maxLen) {
            wordChunk = (wordChunk + ' ' + w).trim();
          } else {
            if (wordChunk) chunks.push(wordChunk);
            wordChunk = w;
          }
        }
        current = wordChunk;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

const audioProxyCache = new Map<
  string,
  { buffer: Buffer; contentType: string }
>();

const SONIC_EMOJI_PROMPT_SYSTEM_INSTRUCTION = `You are the script writer for "Sonic Emoji", an audio comedy, battle, and storytelling studio where emojis and parenthesized tags are automatically replaced by real sound effects, inline voice switches, voice filters, timed pauses, and background music.

Write ONLY the raw Sonic Emoji script text requested by the user. Do NOT wrap your output in markdown code blocks, backticks, or explanations.

Available Sonic Emoji features you should weave naturally into the script for comedic timing or immersive storytelling:
1. Emojis (automatically play sound effects):
   - 💀 (Vine Boom), 🐐 (Screaming Goat), 🎉 (Party Popper), 🥳 (Crowd Cheer), 😂 (Laugh), 👏 (Applause), 🍔 or 🍕 (Minecraft Eating), 🍪 (Nom Nom Eating), 🍎 (Crispy Crunch), 🫗 (Pouring Drink Into Glass), 🥤 (Straw Slurp), 🥫 (Soda Can Open), ⚔️ (Sword Slash), 🛡️ (Shield Block), 🏹 (Bow & Arrow), 💥 (Explosion), 🧱 (LEGO Breaking), 🌮 (Taco Bell Bong), 📱 (Realistic Telephone Ring), 😱 (Wilhelm Scream).
2. Sound Effect Tags in parentheses:
   - Comedy & Memes: (vine boom), (bruh), (screaming goat), (crowd cheer), (crowd laughing), (applause), (rimshot), (airhorn), (crickets), (sad violin), (sad trombone), (spongebob fail), (record scratch), (dun dun dun), (metal pipe), (emotional damage), (fbi open up), (get out), (let him cook), (bonk), (mgs alert), (roblox oof), (noice), (law and order), (to be continued), (door knock), (fnaf jumpscare), (lego yoda).
   - Battle & Combat: (sword slash), (sword clash), (anime sword), (shield block), (bow shoot), (arrow hit), (battle cry), (war horn), (round 1 fight), (finish him), (fatality), (toasty), (critical hit), (smaaash), (heavy laser), (cannon fire), (big explosion), (lightsaber), (gta wasted), (ff7 victory), (zelda secret).
3. Background Overlap (& prefix):
   - Prefix an emoji or sound tag with & so it plays in the background while TTS speaks, e.g. &(crowd cheer), &(applause), or &🎉.
4. Inline Voice Switching (switches the speaker voice until changed or reset back to the user's original selected voice with (voice: default)):
   - (voice: jessie), (voice: warm jessie), (voice: joey), (voice: valley girl), (voice: butler), (voice: trevor), (voice: deadpool), (voice: jarvis), (voice: wizard), (voice: grinch), (voice: grandma), (voice: storyteller), (voice: cody), (voice: professor), (voice: ghostface), (voice: rocket), (voice: pirate), (voice: c3po), (voice: stitch), (voice: stormtrooper), (voice: british), (voice: australian), and (voice: default) or (voice: original) to return to the user's selected voice.
5. Voice Effects (apply to spoken sentences until a period "." or until (effect:normal)):
   - (effect:telephone), (effect:phone call), (effect:radio), (effect:megaphone), (effect:cave), (effect:robot), (effect:monster), (effect:chipmunk), (effect:underwater), (effect:ghost), (effect:whisper), (effect:fast), (effect:slow), (effect:normal).
6. Timed Pauses & Triple Periods:
   - Triple periods (...) automatically create a natural 0.65s dramatic pause without TTS reading "dot dot dot". You can also use explicit tags like (pause 0.8s), (pause 1.2s), (pause 1.5s).
7. Optional Background Music (BGM):
   - (bgm: lost woods), (bgm: zelda), (bgm: horror), (bgm: suspense), (bgm: chase), (bgm: giorno), (bgm: gigachad), (bgm: sneaky), (bgm: scheming weasel), (bgm: fluffing a duck), (bgm: curb), (bgm: megalovania), (bgm: mii), (bgm: coconut mall), (bgm: kahoot), (bgm: chill), (bgm: elevator), (bgm: wii), (bgm: jeopardy), and (bgm: off) at the end.

Keep the script punchy, entertaining, well-paced (around 4 to 8 sentences unless the user asks for shorter/longer), and output ONLY the playable Sonic Emoji script text.`;

async function fetchGoogleTtsChunkWithRetry(
  chunk: string,
  lang: string
): Promise<Buffer> {
  const urls = [
    `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(
      chunk
    )}&tl=${encodeURIComponent(lang)}&client=tw-ob`,
    `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(
      chunk
    )}&tl=${encodeURIComponent(lang)}&client=gtx`,
    `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(
      chunk
    )}&tl=${encodeURIComponent(lang.split('-')[0] || 'en')}&client=tw-ob`,
  ];

  let lastErr: unknown = null;
  for (const ttsUrl of urls) {
    try {
      const response = await fetch(ttsUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
      });
      if (response.ok) {
        const arr = await response.arrayBuffer();
        if (arr.byteLength > 100) {
          return Buffer.from(arr);
        }
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All Google TTS upstream endpoints failed');
}

async function requestSingleTikTokChunkWithRetry(
  rawChunk: string,
  tiktokVoice: string
): Promise<Buffer | null> {
  const sanitized = rawChunk
    .replace(/\.{2,}|…+/g, ', ')
    .replace(/[“”"]/g, '')
    .replace(/[—–]/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized) return null;

  const delays = [0, 140, 300, 520];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
    try {
      const response = await fetch(
        'https://tiktok-tts.weilnet.workers.dev/api/generation',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          },
          body: JSON.stringify({
            text: sanitized,
            voice: tiktokVoice,
          }),
        }
      );
      if (response.ok) {
        const json = (await response.json()) as {
          data?: string | null;
          error?: string | null;
        };
        if (json?.data) {
          const buf = Buffer.from(json.data, 'base64');
          if (buf.byteLength > 100) {
            return buf;
          }
        }
      }
    } catch {
      // Continue retry loop
    }
  }
  return null;
}

async function fetchTikTokNeuralTtsChunk(
  chunk: string,
  tiktokVoice: string,
  fallbackLang: string
): Promise<Buffer> {
  const direct = await requestSingleTikTokChunkWithRetry(chunk, tiktokVoice);
  if (direct) return direct;

  // If a longer phrase was rejected or cut off by upstream, split it in half at a word boundary
  // so both halves still synthesize seamlessly with the exact same TikTok voice!
  const words = chunk.trim().split(/\s+/);
  if (words.length >= 4) {
    const mid = Math.ceil(words.length / 2);
    const firstHalf = words.slice(0, mid).join(' ');
    const secondHalf = words.slice(mid).join(' ');
    const [buf1, buf2] = await Promise.all([
      requestSingleTikTokChunkWithRetry(firstHalf, tiktokVoice),
      requestSingleTikTokChunkWithRetry(secondHalf, tiktokVoice),
    ]);
    if (buf1 && buf2) {
      return Buffer.concat([buf1, buf2]);
    }
  }

  return fetchGoogleTtsChunkWithRetry(chunk, fallbackLang);
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '1mb' }));

  // 1. Real Multi-Provider Spoken TTS Audio Endpoint (Google Assistant TTS + TikTok Neural TTS)
  app.get('/api/tts', async (req, res) => {
    try {
      const rawText = String(req.query.text || '').trim();
      const lang = String(req.query.lang || 'en-US').trim();
      const provider = String(req.query.provider || 'google').trim();
      const apiVoice = String(req.query.voice || lang).trim();

      if (!rawText) {
        res.status(400).send('Missing text parameter');
        return;
      }

      // Use tighter 105-character phrase chunks for TikTok Neural TTS so long sentences never get cut off
      const maxChunkLen = provider === 'tiktok' ? 105 : 175;
      const chunks = splitTextIntoChunks(rawText, maxChunkLen);
      const buffers: Buffer[] = [];

      for (const chunk of chunks) {
        if (provider === 'tiktok') {
          const buf = await fetchTikTokNeuralTtsChunk(chunk, apiVoice, lang);
          buffers.push(buf);
        } else {
          const buf = await fetchGoogleTtsChunkWithRetry(chunk, apiVoice || lang);
          buffers.push(buf);
        }
      }

      const combined = Buffer.concat(buffers);

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate'
      );
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.send(combined);
    } catch (err) {
      console.error('TTS error:', err);
      res.status(502).send('Failed to synthesize TTS audio');
    }
  });

  // 2. Audio Proxy Endpoint for external sound effect hosts (MyInstants MP3s & Google Actions OGGs)
  app.get('/api/audio-proxy', async (req, res) => {
    try {
      const targetUrl = String(req.query.url || '').trim();
      if (!targetUrl) {
        res.status(400).send('Missing url parameter');
        return;
      }

      const parsed = new URL(targetUrl);
      const allowedHosts = [
        'www.myinstants.com',
        'myinstants.com',
        'actions.google.com',
      ];
      if (!allowedHosts.includes(parsed.hostname)) {
        res.status(403).send('Host not permitted');
        return;
      }

      if (audioProxyCache.has(targetUrl)) {
        const cached = audioProxyCache.get(targetUrl)!;
        res.setHeader('Content-Type', cached.contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=604800');
        res.send(cached.buffer);
        return;
      }

      let upstream: Response | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const resp = await fetch(targetUrl, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            },
          });
          if (resp.ok) {
            upstream = resp;
            break;
          }
        } catch {
          // Retry once
        }
      }

      if (!upstream || !upstream.ok) {
        res.status(502).send('Upstream audio asset unavailable');
        return;
      }

      const contentType =
        upstream.headers.get('content-type') ||
        (targetUrl.endsWith('.mp3') ? 'audio/mpeg' : 'audio/ogg');
      const arr = await upstream.arrayBuffer();
      const buffer = Buffer.from(arr);

      if (audioProxyCache.size < 1000) {
        audioProxyCache.set(targetUrl, { buffer, contentType });
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=604800');
      res.send(buffer);
    } catch (err) {
      console.error('Audio proxy error:', err);
      res.status(502).send('Failed to fetch audio asset');
    }
  });

  // 3. Optional Gemini Script Generator Endpoint for Prompt Mode
  app.post('/api/generate-script', async (req, res) => {
    try {
      const userPrompt = String(req.body?.prompt || '').trim();
      if (!userPrompt) {
        res.status(400).json({ error: 'Please enter a prompt first.' });
        return;
      }

      if (!process.env.GEMINI_API_KEY) {
        res.status(500).json({
          error:
            'GEMINI_API_KEY is not configured. Please check Settings > Secrets.',
        });
        return;
      }

      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const candidateModels = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
      let generatedScript = '';
      let lastError: unknown = null;

      for (const modelName of candidateModels) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: userPrompt,
            config: {
              systemInstruction: SONIC_EMOJI_PROMPT_SYSTEM_INSTRUCTION,
            },
          });
          const text = (response.text ?? '').trim();
          if (text) {
            generatedScript = text
              .replace(/^```[a-zA-Z]*\s*/i, '')
              .replace(/\s*```$/, '')
              .trim();
            break;
          }
        } catch (err) {
          lastError = err;
        }
      }

      if (!generatedScript) {
        throw lastError || new Error('Model returned an empty script.');
      }

      res.json({ script: generatedScript });
    } catch (err: unknown) {
      console.error('Gemini script generation error:', err);
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to generate script with Gemini.';
      res.status(500).json({ error: message });
    }
  });

  // 4. Download Full Project Source Code as a Standard .zip Archive (excludes secrets & node_modules)
  app.get('/api/download-source', (req, res) => {
    try {
      const entries = collectProjectSourceEntries(__dirname);
      const zipBuffer = buildZipBuffer(entries);
      res.setHeader('Cache-Control', 'no-store');

      if (String(req.query.format || '').toLowerCase() === 'json') {
        res.json({
          filename: 'sonic-emoji-source.zip',
          fileCount: entries.length,
          sizeBytes: zipBuffer.length,
          base64: zipBuffer.toString('base64'),
        });
        return;
      }

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="sonic-emoji-source.zip"'
      );
      res.send(zipBuffer);
    } catch (err) {
      console.error('Source code zip export error:', err);
      res.status(500).json({ error: 'Failed to build source code archive' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Sonic Emoji server running on http://localhost:${PORT}`);
  });
}

startServer();
