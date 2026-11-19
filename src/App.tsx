/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  COMPREHENSIVE_SHOWCASE_TEXT,
  EXPERIMENTAL_BROWSER_TTS_SHOWCASE_TEXT,
  SOUND_CATALOG,
  SoundEffectItem,
  VOICE_EFFECT_CATALOG,
  VOICE_PRESET_CATALOG,
  getDocumentationMarkdown,
} from './data/soundCatalog';
import {
  DownloadProgress,
  LocalCacheStats,
  sonicAudioEngine,
} from './utils/audioEngine';
import { TimelineToken, parseSonicScript } from './utils/scriptParser';
import {
  Check,
  Copy,
  Database,
  Download,
  ExternalLink,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Square,
  Volume2,
} from 'lucide-react';

const DEFAULT_SCRIPT = `What do you mean by that, bro? 💀 (bruh) How dare you even try that? (pause 1.5s) (effect:telephone) Hey bro, why is there a goat in the kitchen?! (effect:normal) 🐐 And that was what happened. (crowd laughing) 🎉`;
const LS_SCRIPT_KEY = 'sonic_emoji_saved_script_v3';

export default function App() {
  // Four clean tabs: 'generate' | 'soundboard' | 'sounds' | 'docs'
  const [activeTab, setActiveTab] = useState<
    'generate' | 'soundboard' | 'sounds' | 'docs'
  >('generate');

  // Asset downloader screen state
  const [isDownloadingAssets, setIsDownloadingAssets] = useState<boolean>(true);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress>({
    loaded: 0,
    total: SOUND_CATALOG.length,
    currentName: 'Checking local storage audio cache...',
    currentUrl: '',
    bytesDownloaded: 0,
    fromCacheCount: 0,
    newlyDownloadedCount: 0,
    completedIds: [],
    failedIds: [],
  });
  const [cacheStats, setCacheStats] = useState<LocalCacheStats>({
    localStorageCount: 0,
    indexedDbCount: 0,
    totalCachedCount: 0,
    totalBytes: 0,
  });

  // Main editor & TTS state (persisted in localStorage)
  const [scriptText, setScriptText] = useState<string>(() => {
    try {
      return window.localStorage.getItem(LS_SCRIPT_KEY) || DEFAULT_SCRIPT;
    } catch {
      return DEFAULT_SCRIPT;
    }
  });
  const [speed, setSpeed] = useState<number>(1.0);
  const [pitch, setPitch] = useState<number>(1.0);
  const [makeSoundsShort, setMakeSoundsShort] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('sonic_emoji_make_sounds_short') === 'true';
    } catch {
      return false;
    }
  });
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoiceURI, setSelectedVoiceURI] =
    useState<string>('builtin:en-US');

  // Experimental Browser TTS & Engine Switching (ALWAYS OFF by default on every load)
  const [experimentalBrowserTts, setExperimentalBrowserTts] =
    useState<boolean>(false);
  const [ttsEngineMode, setTtsEngineMode] = useState<'neural' | 'browser'>(
    'neural'
  );

  // Playback & generated audio state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [activeTokenId, setActiveTokenId] = useState<string | null>(null);
  const [isGeneratingWav, setIsGeneratingWav] = useState<boolean>(false);
  const [generatedWavUrl, setGeneratedWavUrl] = useState<string | null>(null);
  const [generatedDurationSec, setGeneratedDurationSec] = useState<number>(0);
  const [statusAnnouncement, setStatusAnnouncement] = useState<string>('');

  // Optional Advanced Options & Prompt Mode state (strictly optional, defaults to Standard Mode)
  const [showAdvancedOptions, setShowAdvancedOptions] =
    useState<boolean>(false);
  const [editorMode, setEditorMode] = useState<'standard' | 'prompt'>(
    'standard'
  );
  const [promptInput, setPromptInput] = useState<string>(
    'Generate me an audio with cool sound effects, comedic timing, a phone call voice filter, and a screaming goat.'
  );
  const [isGeneratingPromptScript, setIsGeneratingPromptScript] =
    useState<boolean>(false);
  const [promptError, setPromptError] = useState<string | null>(null);

  // Verified in-memory Blob .zip export state (prevents iframe auth HTML download bug)
  const [isPreparingSourceZip, setIsPreparingSourceZip] =
    useState<boolean>(false);
  const [sourceZipUrl, setSourceZipUrl] = useState<string | null>(null);
  const [sourceZipMeta, setSourceZipMeta] = useState<{
    fileCount: number;
    sizeBytes: number;
  } | null>(null);
  const [sourceZipError, setSourceZipError] = useState<string | null>(null);

  // Soundboard filter, Sounds tab & Docs tab state
  const [soundboardFilter, setSoundboardFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [insertAsBackground, setInsertAsBackground] = useState<boolean>(false);
  const [copiedUrlId, setCopiedUrlId] = useState<string | null>(null);
  const [copiedDocs, setCopiedDocs] = useState<boolean>(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const wavRunCounterRef = useRef<number>(0);
  const activeCaptureSessionRef = useRef<{
    stopAndRenderWav: () => Promise<{ blob: Blob; durationSec: number }>;
    cancel: () => void;
  } | null>(null);

  // Save script to localStorage on change
  useEffect(() => {
    try {
      window.localStorage.setItem(LS_SCRIPT_KEY, scriptText);
    } catch {}
  }, [scriptText]);

  // Sync Make Sounds Short preference to audio engine & localStorage
  useEffect(() => {
    sonicAudioEngine.setMakeSoundsShort(makeSoundsShort);
    try {
      window.localStorage.setItem(
        'sonic_emoji_make_sounds_short',
        String(makeSoundsShort)
      );
    } catch {}
  }, [makeSoundsShort]);

  const runPreload = (forceNetwork = false) => {
    setIsDownloadingAssets(true);
    sonicAudioEngine
      .preloadAllSounds((prog) => {
        setDownloadProgress(prog);
      }, forceNetwork)
      .then(() => {
        setCacheStats(sonicAudioEngine.getCacheStats());
        setTimeout(() => {
          setIsDownloadingAssets(false);
        }, 300);
      });
  };

  useEffect(() => {
    let mounted = true;
    sonicAudioEngine
      .preloadAllSounds((prog) => {
        if (!mounted) return;
        setDownloadProgress(prog);
      }, false)
      .then(() => {
        if (!mounted) return;
        setCacheStats(sonicAudioEngine.getCacheStats());
        setTimeout(() => {
          if (mounted) setIsDownloadingAssets(false);
        }, 300);
      });

    return () => {
      mounted = false;
      sonicAudioEngine.stopAll();
    };
  }, []);

  // Load browser SpeechSynthesis voices and default to English (US)
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const updateVoices = () => {
      const available = window.speechSynthesis.getVoices();
      if (available.length > 0) {
        setVoices(available);
      }
    };

    updateVoices();
    window.speechSynthesis.onvoiceschanged = updateVoices;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  const parsedTokens: TimelineToken[] = useMemo(
    () => parseSonicScript(scriptText, experimentalBrowserTts),
    [scriptText, experimentalBrowserTts]
  );

  const documentationMarkdown = useMemo(
    () => getDocumentationMarkdown(experimentalBrowserTts, voices),
    [experimentalBrowserTts, voices]
  );

  useEffect(() => {
    return () => {
      if (generatedWavUrl) {
        URL.revokeObjectURL(generatedWavUrl);
      }
    };
  }, [generatedWavUrl]);

  useEffect(() => {
    return () => {
      if (sourceZipUrl) {
        URL.revokeObjectURL(sourceZipUrl);
      }
    };
  }, [sourceZipUrl]);

  const handleDownloadSourceZip = async () => {
    setSourceZipError(null);
    setIsPreparingSourceZip(true);
    try {
      const resp = await fetch('/api/download-source?format=json', {
        credentials: 'include',
        cache: 'no-store',
      });
      const contentType = resp.headers.get('content-type') || '';
      if (!resp.ok || !contentType.includes('application/json')) {
        throw new Error(
          'Server returned an unexpected response instead of the ZIP payload.'
        );
      }
      const data = (await resp.json()) as {
        filename?: string;
        fileCount?: number;
        sizeBytes?: number;
        base64?: string;
      };
      if (!data.base64) {
        throw new Error('Missing ZIP archive payload.');
      }

      const binaryStr = window.atob(data.base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      // Strictly verify PKZIP magic header (PK\x03\x04) so an HTML page can never be saved as .zip
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        throw new Error('Archive failed ZIP header verification.');
      }

      const blob = new Blob([bytes], { type: 'application/zip' });
      const blobUrl = URL.createObjectURL(blob);
      setSourceZipUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return blobUrl;
      });
      setSourceZipMeta({
        fileCount: data.fileCount || 14,
        sizeBytes: bytes.length,
      });

      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = data.filename || 'sonic-emoji-source.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setStatusAnnouncement(
        `Verified ZIP archive ready (${data.fileCount || 14} files, ${(bytes.length / 1024).toFixed(1)} KB).`
      );
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Failed to prepare source code ZIP.';
      setSourceZipError(msg);
    } finally {
      setIsPreparingSourceZip(false);
    }
  };

  const selectedVoicePreset = useMemo(() => {
    if (selectedVoiceURI.startsWith('browser:')) return null;
    return VOICE_PRESET_CATALOG.find((vp) => vp.id === selectedVoiceURI) || null;
  }, [selectedVoiceURI]);

  const selectedLang = useMemo(() => {
    if (selectedVoicePreset) return selectedVoicePreset.lang;
    const rawUri = selectedVoiceURI.startsWith('browser:')
      ? selectedVoiceURI.slice('browser:'.length)
      : selectedVoiceURI;
    const matched = voices.find((v) => v.voiceURI === rawUri);
    return matched?.lang || 'en-US';
  }, [voices, selectedVoiceURI, selectedVoicePreset]);

  const selectedVoice = useMemo(() => {
    if (selectedVoiceURI.startsWith('browser:')) {
      const rawUri = selectedVoiceURI.slice('browser:'.length);
      return voices.find((v) => v.voiceURI === rawUri) || voices[0] || null;
    }
    if (selectedVoicePreset) {
      const targetLang = selectedVoicePreset.lang.toLowerCase();
      const langPrefix = targetLang.split('-')[0];
      return (
        voices.find(
          (v) =>
            v.lang.replace('_', '-').toLowerCase() === targetLang && v.default
        ) ||
        voices.find(
          (v) => v.lang.replace('_', '-').toLowerCase() === targetLang
        ) ||
        voices.find((v) => v.lang.toLowerCase().startsWith(langPrefix)) ||
        null
      );
    }
    return voices.find((v) => v.voiceURI === selectedVoiceURI) || null;
  }, [voices, selectedVoiceURI, selectedVoicePreset]);

  const handleToggleExperimentalBrowserTts = (checked: boolean) => {
    setExperimentalBrowserTts(checked);
    if (checked) {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        const latest = window.speechSynthesis.getVoices();
        if (latest.length > 0) setVoices(latest);
      }
      setStatusAnnouncement(
        'Experimental Browser TTS enabled: Browser system voices, TTS engine switching, dynamic docs, and multi-engine example unlocked.'
      );
    } else {
      setTtsEngineMode('neural');
      if (
        !VOICE_PRESET_CATALOG.some((vp) => vp.id === selectedVoiceURI)
      ) {
        setSelectedVoiceURI('builtin:en-US');
      }
      setStatusAnnouncement(
        'Experimental Browser TTS turned off: returned to standard Neural TTS mode.'
      );
    }
  };

  const executeGenerateAndPlayForScript = async (rawScript: string) => {
    const freshTokens = parseSonicScript(rawScript, experimentalBrowserTts);
    if (freshTokens.length === 0) return;

    // Immediately stop any previous playback and discard any previous WAV URL/capture
    sonicAudioEngine.stopAll();
    if (activeCaptureSessionRef.current) {
      activeCaptureSessionRef.current.cancel();
      activeCaptureSessionRef.current = null;
    }
    const currentWavRun = ++wavRunCounterRef.current;

    if (generatedWavUrl) {
      URL.revokeObjectURL(generatedWavUrl);
      setGeneratedWavUrl(null);
    }
    setGeneratedDurationSec(0);
    setIsGeneratingWav(true);

    const lang = selectedLang;
    const effectiveEngineMode: 'neural' | 'browser' = experimentalBrowserTts
      ? ttsEngineMode
      : 'neural';
    const usesBrowserTts =
      experimentalBrowserTts &&
      freshTokens.some(
        (t) =>
          t.type === 'speech' &&
          (t.ttsEngine === 'browser' ||
            (t.ttsEngine !== 'neural' &&
              !t.voiceOverride &&
              effectiveEngineMode === 'browser'))
      );

    let captureSession: {
      stopAndRenderWav: () => Promise<{ blob: Blob; durationSec: number }>;
      cancel: () => void;
    } | null = null;

    if (usesBrowserTts) {
      setStatusAnnouncement(
        'Experimental Browser TTS active: attempting live tab-audio capture for WAV export...'
      );
      captureSession = await sonicAudioEngine.tryStartLiveTabAudioCapture();
      if (wavRunCounterRef.current !== currentWavRun) {
        captureSession?.cancel();
        return;
      }
      activeCaptureSessionRef.current = captureSession;
    }

    setStatusAnnouncement(
      captureSession
        ? 'Capturing live Browser TTS + sound effects for WAV export...'
        : usesBrowserTts
          ? 'Playing Browser TTS live; preparing WAV via neural voice approximation...'
          : 'Generating fresh speech, voice effects, and sound effects...'
    );
    setIsPlaying(true);

    // Per-click buffer map shared ONLY between this single click's live playback and WAV render
    const runBufferMap = new Map<string, Promise<AudioBuffer | null>>();

    const renderFallbackOfflineWav = async () => {
      try {
        const { blob, durationSec } =
          await sonicAudioEngine.renderTimelineToWavBlob(freshTokens, {
            rate: speed,
            pitch: pitch,
            lang,
            voicePreset: selectedVoicePreset,
            voice: selectedVoice,
            browserVoices: voices,
            experimentalBrowserTts,
            ttsEngineMode: effectiveEngineMode,
            makeSoundsShort,
            defaultBgm: null,
            runBufferMap,
          });
        if (wavRunCounterRef.current !== currentWavRun) return;
        const url = URL.createObjectURL(blob);
        setGeneratedWavUrl(url);
        setGeneratedDurationSec(durationSec);
      } catch {
        // Ignore render errors
      } finally {
        if (wavRunCounterRef.current === currentWavRun) {
          setIsGeneratingWav(false);
        }
      }
    };

    sonicAudioEngine.playTimeline(freshTokens, {
      voice: selectedVoice,
      voicePreset: selectedVoicePreset,
      lang,
      experimentalBrowserTts,
      ttsEngineMode: effectiveEngineMode,
      browserVoices: voices,
      useBrowserSpeechOnly: false,
      rate: speed,
      pitch: pitch,
      makeSoundsShort,
      defaultBgm: null,
      runBufferMap,
      onTokenChange: (tokenId) => {
        setActiveTokenId(tokenId);
      },
      onComplete: async () => {
        setIsPlaying(false);
        setActiveTokenId(null);

        if (captureSession && activeCaptureSessionRef.current === captureSession) {
          activeCaptureSessionRef.current = null;
          try {
            const { blob, durationSec } =
              await captureSession.stopAndRenderWav();
            if (wavRunCounterRef.current === currentWavRun) {
              if (durationSec > 0.25 && blob.size > 4000) {
                const url = URL.createObjectURL(blob);
                setGeneratedWavUrl(url);
                setGeneratedDurationSec(durationSec);
                setIsGeneratingWav(false);
                setStatusAnnouncement(
                  'Playback finished — captured live Browser TTS + effects to WAV!'
                );
                return;
              }
            }
          } catch {
            // Fall through to offline WAV approximation
          }
          await renderFallbackOfflineWav();
          return;
        }

        setStatusAnnouncement('Playback finished.');
      },
    });

    if (!captureSession) {
      await renderFallbackOfflineWav();
    }
  };

  const handleGenerateAndPlay = async () => {
    const latestText = textareaRef.current?.value ?? scriptText;
    if (latestText !== scriptText) {
      setScriptText(latestText);
    }
    await executeGenerateAndPlayForScript(latestText);
  };

  const handlePromptGenerate = async (autoPlayAfter: boolean) => {
    const trimmedPrompt = promptInput.trim();
    if (!trimmedPrompt) {
      setPromptError('Please enter a prompt describing what audio to generate.');
      return;
    }

    setPromptError(null);
    setIsGeneratingPromptScript(true);
    setStatusAnnouncement('Prompting Gemini to write a Sonic Emoji script...');

    try {
      const response = await fetch('/api/generate-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmedPrompt }),
      });
      const data = await response.json();
      if (!response.ok || !data.script) {
        throw new Error(data.error || 'Failed to generate script.');
      }

      const newScript = String(data.script).trim();
      setScriptText(newScript);
      setStatusAnnouncement('Generated new Sonic Emoji script with Gemini.');

      if (autoPlayAfter) {
        await executeGenerateAndPlayForScript(newScript);
      } else {
        setEditorMode('standard');
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Failed to generate script with Gemini.';
      setPromptError(msg);
    } finally {
      setIsGeneratingPromptScript(false);
    }
  };

  const handleStopPlayback = () => {
    wavRunCounterRef.current++;
    if (activeCaptureSessionRef.current) {
      activeCaptureSessionRef.current.cancel();
      activeCaptureSessionRef.current = null;
    }
    sonicAudioEngine.stopAll();
    setIsPlaying(false);
    setIsGeneratingWav(false);
    setActiveTokenId(null);
    setStatusAnnouncement('Playback stopped.');
  };

  const handlePasteComprehensiveExample = () => {
    if (activeCaptureSessionRef.current) {
      activeCaptureSessionRef.current.cancel();
      activeCaptureSessionRef.current = null;
    }
    sonicAudioEngine.stopAll();
    setIsPlaying(false);
    setActiveTokenId(null);
    setActiveTab('generate');
    setScriptText(
      experimentalBrowserTts
        ? EXPERIMENTAL_BROWSER_TTS_SHOWCASE_TEXT
        : COMPREHENSIVE_SHOWCASE_TEXT
    );
    setStatusAnnouncement(
      experimentalBrowserTts
        ? 'Loaded experimental multi-engine showcase example.'
        : 'Loaded comprehensive comedic & battle showcase example.'
    );
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  };

  const handleCopyEntireDocumentation = () => {
    navigator.clipboard?.writeText(documentationMarkdown);
    setCopiedDocs(true);
    setStatusAnnouncement('Copied entire documentation to clipboard.');
    setTimeout(() => setCopiedDocs(false), 2500);
  };

  const insertSnippetAtCursor = (snippet: string) => {
    const el = textareaRef.current;
    if (el && activeTab === 'generate') {
      const start = el.selectionStart ?? scriptText.length;
      const end = el.selectionEnd ?? scriptText.length;
      const before = scriptText.slice(0, start);
      const after = scriptText.slice(end);
      const needsLeadSpace = before.length > 0 && !/\s$/.test(before);
      const needsTrailSpace = after.length === 0 || !/^\s/.test(after);
      const inserted = `${needsLeadSpace ? ' ' : ''}${snippet}${needsTrailSpace ? ' ' : ''}`;
      const next = before + inserted + after;
      setScriptText(next);
      requestAnimationFrame(() => {
        el.focus();
        const cursor = before.length + inserted.length;
        el.setSelectionRange(cursor, cursor);
      });
      return;
    }

    setScriptText(
      (prev) => `${prev}${prev.endsWith(' ') || !prev ? '' : ' '}${snippet} `
    );
    setActiveTab('generate');
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  };

  const insertSnippetAndGoToGenerate = (snippet: string) => {
    insertSnippetAtCursor(snippet);
  };

  const scriptSummary = useMemo(() => {
    let speechCount = 0;
    let sfxCount = 0;
    let voiceSwitchCount = 0;
    let effectCount = 0;
    let bgmCount = 0;
    let pauseCount = 0;
    for (const t of parsedTokens) {
      if (t.type === 'speech') speechCount++;
      else if (t.type === 'sfx') sfxCount++;
      else if (t.type === 'voice_switch') voiceSwitchCount++;
      else if (t.type === 'effect') effectCount++;
      else if (t.type === 'bgm') bgmCount++;
      else if (t.type === 'pause') pauseCount++;
    }
    const activeTok = activeTokenId
      ? parsedTokens.find((t) => t.id === activeTokenId) || null
      : null;
    return {
      speechCount,
      sfxCount,
      voiceSwitchCount,
      effectCount,
      bgmCount,
      pauseCount,
      activeTok,
    };
  }, [parsedTokens, activeTokenId]);

  const filteredSoundboard = useMemo(() => {
    const q = soundboardFilter.trim().toLowerCase();
    if (!q) return SOUND_CATALOG;
    return SOUND_CATALOG.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.emojis.some((e) => e.includes(q)) ||
        item.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [soundboardFilter]);

  const categories = useMemo(() => {
    const set = new Set<string>(['All']);
    SOUND_CATALOG.forEach((s) => set.add(s.category));
    return Array.from(set);
  }, []);

  const filteredCatalog = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return SOUND_CATALOG.filter((item) => {
      const matchesCat =
        selectedCategory === 'All' || item.category === selectedCategory;
      if (!matchesCat) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        item.url.toLowerCase().includes(q) ||
        item.emojis.some((e) => e.includes(q)) ||
        item.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [searchQuery, selectedCategory]);

  // ================= 1. ASSETS DOWNLOADER SCREEN AT FIRST LAUNCH =================
  if (isDownloadingAssets) {
    const percent = Math.min(
      100,
      Math.round(
        (downloadProgress.loaded / Math.max(1, downloadProgress.total)) * 100
      )
    );
    const kbDownloaded = (downloadProgress.bytesDownloaded / 1024).toFixed(0);

    return (
      <main
        className="min-h-screen bg-slate-50 text-slate-900 flex flex-col items-center justify-center p-6"
        role="status"
        aria-live="polite"
      >
        <div className="w-full max-w-xl bg-white border border-slate-300 rounded-lg p-8">
          <div className="flex items-center justify-between gap-4 border-b border-slate-200 pb-4 mb-6">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                Sonic Emoji
              </h1>
              <p className="text-sm text-slate-600 mt-1">
                Assets Downloader — Downloading sounds...
              </p>
            </div>
            <span className="font-mono-tabular text-lg font-semibold text-slate-900">
              {percent}%
            </span>
          </div>

          <div className="space-y-4">
            <div
              className="w-full h-3 bg-slate-200 rounded overflow-hidden"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Sound effects download progress"
            >
              <div
                className="h-full bg-blue-600 transition-transform duration-150 origin-left"
                style={{ transform: `scaleX(${percent / 100})` }}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 font-mono-tabular">
              <span>
                {downloadProgress.loaded} / {downloadProgress.total} sounds (
                {downloadProgress.fromCacheCount} restored from local storage,{' '}
                {downloadProgress.newlyDownloadedCount} new)
              </span>
              <span>{kbDownloaded} KB cached</span>
            </div>

            <div className="bg-slate-100 border border-slate-200 rounded p-3 text-xs font-mono-tabular text-slate-700 space-y-1">
              <div className="font-semibold text-slate-900 truncate">
                Current: {downloadProgress.currentName}
              </div>
              {downloadProgress.currentUrl && (
                <div className="text-slate-600 truncate">
                  URL: {downloadProgress.currentUrl}
                </div>
              )}
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-200 flex items-center justify-between gap-4">
            <p className="text-xs text-slate-600">
              Seamlessly integrating {SOUND_CATALOG.length} sounds into local storage.
            </p>
            <button
              type="button"
              onClick={() => setIsDownloadingAssets(false)}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Skip &amp; Open App
            </button>
          </div>
        </div>
      </main>
    );
  }

  // ================= 2. MAIN WORKSPACE (3 CLEAN TABS: GENERATE | SOUNDS | DOCUMENTATION) =================
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      <div className="sr-only" role="status" aria-live="polite">
        {statusAnnouncement}
      </div>

      {/* Top Navigation Bar (Strict 3-Zone Contract) */}
      <header className="bg-white border-b border-slate-200 px-6 py-3.5 flex items-center justify-between gap-8">
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('generate');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          Sonic Emoji
        </a>

        <nav
          aria-label="Primary tabs"
          className="flex items-center gap-6 text-sm font-medium text-slate-600"
        >
          <button
            type="button"
            onClick={() => setActiveTab('generate')}
            className={`hover:text-slate-900 hover:underline whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'generate'
                ? 'text-slate-900 font-bold underline'
                : ''
            }`}
          >
            Generate
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('soundboard')}
            className={`hover:text-slate-900 hover:underline whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'soundboard'
                ? 'text-slate-900 font-bold underline'
                : ''
            }`}
          >
            Soundboard
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('sounds')}
            className={`hover:text-slate-900 hover:underline whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'sounds'
                ? 'text-slate-900 font-bold underline'
                : ''
            }`}
          >
            Sounds ({SOUND_CATALOG.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('docs')}
            className={`hover:text-slate-900 hover:underline whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'docs' ? 'text-slate-900 font-bold underline' : ''
            }`}
          >
            Documentation
          </button>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          {activeTab === 'docs' ? (
            <button
              type="button"
              onClick={handleCopyEntireDocumentation}
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {copiedDocs ? 'Copied Documentation!' : 'Copy Documentation'}
            </button>
          ) : (
            <button
              type="button"
              onClick={handlePasteComprehensiveExample}
              className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Paste Comprehensive Example
            </button>
          )}
        </div>
      </header>

      <main
        id="top"
        className="w-full max-w-4xl mx-auto px-6 py-8 flex-1 flex flex-col gap-6"
      >
        {/* ================= TAB 1: SIMPLE, UNCLUTTERED GENERATE TAB ================= */}
        {activeTab === 'generate' && (
          <section
            aria-labelledby="generate-heading"
            className="bg-white border border-slate-300 rounded-lg p-6 space-y-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
              <div className="flex items-center gap-2.5">
                <h1
                  id="generate-heading"
                  className="text-lg font-bold text-slate-900"
                >
                  Text-to-Speech &amp; Sound Generator
                </h1>
                {editorMode === 'prompt' && (
                  <span className="px-2 py-0.5 text-[11px] font-semibold bg-blue-50 text-blue-800 border border-blue-200 rounded">
                    Prompt Mode
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {editorMode === 'prompt' && (
                  <button
                    type="button"
                    onClick={() => setEditorMode('standard')}
                    className="px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded focus-visible:outline-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Switch to Standard Mode
                  </button>
                )}
                <button
                  type="button"
                  onClick={handlePasteComprehensiveExample}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded focus-visible:outline-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Paste Comprehensive Example
                </button>
                <button
                  type="button"
                  onClick={() => {
                    sonicAudioEngine.stopAll();
                    setIsPlaying(false);
                    setScriptText('');
                    textareaRef.current?.focus();
                  }}
                  className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-100 border border-slate-300 rounded focus-visible:outline-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Clear
                </button>
              </div>
            </div>

            {/* Optional Prompt Mode Box (Only visible when user explicitly switches to Prompt Mode in Advanced Options) */}
            {editorMode === 'prompt' && (
              <div className="bg-slate-50 border border-slate-300 rounded p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor="sonic-prompt-input"
                    className="text-sm font-semibold text-slate-900 inline-flex items-center gap-1.5"
                  >
                    <Sparkles
                      className="w-4 h-4 text-blue-600"
                      aria-hidden="true"
                    />
                    Prompt Gemini to Write Your Audio Script
                  </label>
                  <button
                    type="button"
                    onClick={() => setEditorMode('standard')}
                    className="text-xs font-medium text-slate-700 underline hover:text-slate-900 cursor-pointer"
                  >
                    Back to Standard Mode
                  </button>
                </div>

                <textarea
                  id="sonic-prompt-input"
                  rows={3}
                  value={promptInput}
                  onChange={(e) => setPromptInput(e.target.value)}
                  placeholder='E.g. "Generate me an audio with cool sound effects about a guy ordering 50 tacos at 3 AM"'
                  className="w-full rounded border border-slate-300 bg-white p-3 text-sm text-slate-900 leading-relaxed focus:border-blue-600 focus:outline-2 focus:outline-blue-600"
                />

                {promptError && (
                  <p className="text-xs font-medium text-red-600" role="alert">
                    {promptError}
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => handlePromptGenerate(true)}
                    disabled={isGeneratingPromptScript}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded focus-visible:outline-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                    {isGeneratingPromptScript
                      ? 'Generating Script...'
                      : 'Generate Script & Play Audio'}
                  </button>

                  <button
                    type="button"
                    onClick={() => handlePromptGenerate(false)}
                    disabled={isGeneratingPromptScript}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white hover:bg-slate-100 disabled:bg-slate-100 border border-slate-300 rounded focus-visible:outline-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Generate Script Only (Edit in Standard Mode)
                  </button>
                </div>
              </div>
            )}

            {/* Textbox + Quick Insert Toolbar + Live Script Breakdown */}
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label
                  htmlFor="sonic-script-input"
                  className="block text-sm font-semibold text-slate-900"
                >
                  {editorMode === 'prompt'
                    ? 'Generated Script Text (Editable)'
                    : 'Script Text'}
                </label>

                {/* Neat Quick-Insert Toolbar for Voice Switches, Effects, BGMs, and Pauses */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <select
                    aria-label="Quick insert voice switch"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) {
                        insertSnippetAtCursor(e.target.value);
                      }
                    }}
                    className="rounded border border-slate-300 bg-slate-50 hover:bg-slate-100 px-2 py-1 text-xs font-medium text-slate-800 cursor-pointer"
                  >
                    <option value="">+ Switch Voice...</option>
                    <option value="(voice: default)">(voice: default) — Original Voice</option>
                    {experimentalBrowserTts && (
                      <optgroup label="Experimental TTS Engine Switching">
                        <option value="(engine: browser)">(engine: browser) — Browser TTS</option>
                        <option value="(engine: neural)">(engine: neural) — Neural TTS</option>
                        <option value="(voice: browser)">(voice: browser) — Browser System Voice</option>
                      </optgroup>
                    )}
                    <option value="(voice: jessie)">(voice: jessie) — TikTok US Female</option>
                    <option value="(voice: sarah)">(voice: sarah) — Sarah US Female</option>
                    <option value="(voice: betty)">(voice: betty) — Betty US Female</option>
                    <option value="(voice: crystal)">(voice: crystal) — Crystal US Female</option>
                    <option value="(voice: warm jessie)">(voice: warm jessie) — Warm US Female</option>
                    <option value="(voice: joey)">(voice: joey) — TikTok US Male</option>
                    <option value="(voice: adam)">(voice: adam) — Adam US Male</option>
                    <option value="(voice: ryan)">(voice: ryan) — Ryan US Male</option>
                    <option value="(voice: bob)">(voice: bob) — Bob Casual Male</option>
                    <option value="(voice: valley girl)">(voice: valley girl) — Sassy Valley Girl</option>
                    <option value="(voice: butler)">(voice: butler) — British Butler</option>
                    <option value="(voice: trevor)">(voice: trevor) — Gritty Male</option>
                    <option value="(voice: deadpool)">(voice: deadpool) — Deadpool</option>
                    <option value="(voice: jarvis)">(voice: jarvis) — J.A.R.V.I.S. AI</option>
                    <option value="(voice: wizard)">(voice: wizard) — Grand Wizard</option>
                    <option value="(voice: santa)">(voice: santa) — Santa Narrator</option>
                    <option value="(voice: grinch)">(voice: grinch) — The Grinch</option>
                    <option value="(voice: grandma)">(voice: grandma) — Sweet Grandma</option>
                    <option value="(voice: storyteller)">(voice: storyteller) — Narrator</option>
                    <option value="(voice: ghostface)">(voice: ghostface) — Scream</option>
                    <option value="(voice: rocket)">(voice: rocket) — Rocket</option>
                    <option value="(voice: c3po)">(voice: c3po) — Droid</option>
                    <option value="(voice: stitch)">(voice: stitch) — Stitch</option>
                    <option value="(voice: pirate)">(voice: pirate) — Pirate</option>
                    <option value="(voice: british)">(voice: british) — UK Narrator</option>
                    <option value="(voice: hindi)">(voice: hindi) — Hindi</option>
                  </select>

                  <select
                    aria-label="Quick insert voice filter effect"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) {
                        insertSnippetAtCursor(e.target.value);
                      }
                    }}
                    className="rounded border border-slate-300 bg-slate-50 hover:bg-slate-100 px-2 py-1 text-xs font-medium text-slate-800 cursor-pointer"
                  >
                    <option value="">+ Voice Effect...</option>
                    <option value="(effect:telephone)">(effect:telephone)</option>
                    <option value="(effect:phone call)">(effect:phone call)</option>
                    <option value="(effect:radio)">(effect:radio)</option>
                    <option value="(effect:megaphone)">(effect:megaphone)</option>
                    <option value="(effect:cave)">(effect:cave)</option>
                    <option value="(effect:robot)">(effect:robot)</option>
                    <option value="(effect:monster)">(effect:monster)</option>
                    <option value="(effect:ghost)">(effect:ghost)</option>
                    <option value="(effect:whisper)">(effect:whisper)</option>
                    <option value="(effect:normal)">(effect:normal) — Reset Filter</option>
                  </select>

                  <select
                    aria-label="Quick insert background music"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) {
                        insertSnippetAtCursor(e.target.value);
                      }
                    }}
                    className="rounded border border-slate-300 bg-slate-50 hover:bg-slate-100 px-2 py-1 text-xs font-medium text-slate-800 cursor-pointer"
                  >
                    <option value="">+ Full BGM...</option>
                    <option value="(bgm: lost woods)">(bgm: lost woods) — Zelda</option>
                    <option value="(bgm: horror)">(bgm: horror) — Scary Music Box</option>
                    <option value="(bgm: suspense)">(bgm: suspense) — Horror Hallway</option>
                    <option value="(bgm: chase)">(bgm: chase) — Horror Chase</option>
                    <option value="(bgm: boss)">(bgm: boss) — Final Boss Battle</option>
                    <option value="(bgm: outro)">(bgm: outro) — Xenogenesis Outro</option>
                    <option value="(bgm: gigachad)">(bgm: gigachad) — Sigma Theme</option>
                    <option value="(bgm: giorno)">(bgm: giorno) — JoJo Piano</option>
                    <option value="(bgm: sneaky)">(bgm: sneaky) — Sneaky Snitch</option>
                    <option value="(bgm: scheming weasel)">(bgm: scheming weasel)</option>
                    <option value="(bgm: megalovania)">(bgm: megalovania)</option>
                    <option value="(bgm: tetris)">(bgm: tetris)</option>
                    <option value="(bgm: naruto)">(bgm: naruto) — Sad Violin/Flute</option>
                    <option value="(bgm: off)">(bgm: off) — Stop BGM</option>
                  </select>

                  <button
                    type="button"
                    onClick={() => insertSnippetAtCursor('(pause 1.0s)')}
                    className="rounded border border-slate-300 bg-slate-50 hover:bg-slate-100 px-2 py-1 text-xs font-mono-tabular font-medium text-slate-800 cursor-pointer"
                  >
                    + (pause 1.0s)
                  </button>
                </div>
              </div>

              <textarea
                id="sonic-script-input"
                ref={textareaRef}
                rows={8}
                value={scriptText}
                onChange={(e) => setScriptText(e.target.value)}
                placeholder="Paste your text here... E.g. What do you mean by that, bro? 💀 (pause 1.5s) (voice: jessie) (effect:telephone) Hello? (effect:normal) (voice: default) 🐐 (crowd laughing)"
                className="w-full rounded border border-slate-300 bg-white p-3.5 text-base text-slate-900 leading-relaxed focus:border-blue-600 focus:outline-2 focus:outline-blue-600 font-sans"
              />

              {/* Live Script Breakdown & Active Playback Token Indicator */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 font-mono-tabular bg-slate-50 border border-slate-200 rounded px-3 py-1.5">
                <div className="flex flex-wrap items-center gap-3">
                  <span>{scriptSummary.speechCount} speech</span>
                  <span>·</span>
                  <span>{scriptSummary.sfxCount} SFX</span>
                  <span>·</span>
                  <span>{scriptSummary.voiceSwitchCount} voice switches</span>
                  <span>·</span>
                  <span>{scriptSummary.effectCount} filters</span>
                  <span>·</span>
                  <span>{scriptSummary.bgmCount} BGM cues</span>
                  <span>·</span>
                  <span>{scriptSummary.pauseCount} pauses</span>
                </div>

                {isPlaying && scriptSummary.activeTok && (
                  <div className="font-semibold text-blue-700 truncate max-w-xs">
                    {scriptSummary.activeTok.type === 'speech'
                      ? `Speaking (${
                          scriptSummary.activeTok.ttsEngine === 'browser' ||
                          (experimentalBrowserTts &&
                            ttsEngineMode === 'browser' &&
                            !scriptSummary.activeTok.voiceOverride &&
                            scriptSummary.activeTok.ttsEngine !== 'neural')
                            ? `Browser TTS${
                                scriptSummary.activeTok.browserVoiceHint
                                  ? `: ${scriptSummary.activeTok.browserVoiceHint}`
                                  : ''
                              }`
                            : scriptSummary.activeTok.voiceOverride?.label
                                .split('—')[0]
                                .trim() ||
                              selectedVoicePreset?.label
                                .split('—')[0]
                                .trim() ||
                              'Default Voice'
                        }): "${scriptSummary.activeTok.text.slice(0, 32)}..."`
                      : scriptSummary.activeTok.type === 'sfx'
                        ? `Playing SFX: ${scriptSummary.activeTok.sound.name}`
                        : scriptSummary.activeTok.type === 'pause'
                          ? `Pause (${scriptSummary.activeTok.durationSec}s)`
                          : 'Playing...'}
                  </div>
                )}
              </div>
            </div>

            {/* Simple Controls: Voice, Speed, Pitch */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
              <div>
                <label
                  htmlFor="tts-voice-select"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  {experimentalBrowserTts
                    ? 'Language / Voice (Neural + Own Browser Voices)'
                    : 'Language / Voice (Default: Google Assistant US)'}
                </label>
                <select
                  id="tts-voice-select"
                  value={selectedVoiceURI}
                  onChange={(e) => {
                    const nextVal = e.target.value;
                    setSelectedVoiceURI(nextVal);
                    if (experimentalBrowserTts) {
                      if (nextVal.startsWith('browser:')) {
                        setTtsEngineMode('browser');
                      } else {
                        setTtsEngineMode('neural');
                      }
                    }
                  }}
                  className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-blue-600 focus:outline-2 focus:outline-blue-600"
                >
                  <optgroup label="Google Assistant Neural Voices (Default)">
                    {VOICE_PRESET_CATALOG.filter(
                      (vp) => vp.group === 'Google Assistant Neural Voices'
                    ).map((vp) => (
                      <option key={vp.id} value={vp.id}>
                        {vp.label}
                      </option>
                    ))}
                  </optgroup>

                  <optgroup label="TikTok Neural Voices (English)">
                    {VOICE_PRESET_CATALOG.filter(
                      (vp) => vp.group === 'TikTok Neural Voices (English)'
                    ).map((vp) => (
                      <option key={vp.id} value={vp.id}>
                        {vp.label}
                      </option>
                    ))}
                  </optgroup>

                  <optgroup label="TikTok Neural Character & Cinema Voices">
                    {VOICE_PRESET_CATALOG.filter(
                      (vp) => vp.group === 'TikTok Neural Character & Cinema Voices'
                    ).map((vp) => (
                      <option key={vp.id} value={vp.id}>
                        {vp.label}
                      </option>
                    ))}
                  </optgroup>

                  <optgroup label="International Neural Voices">
                    {VOICE_PRESET_CATALOG.filter(
                      (vp) => vp.group === 'International Neural Voices'
                    ).map((vp) => (
                      <option key={vp.id} value={vp.id}>
                        {vp.label}
                      </option>
                    ))}
                  </optgroup>

                  {experimentalBrowserTts && (
                    <optgroup
                      label={`Browser System Voices (Your Own Device — ${voices.length})`}
                    >
                      {voices.length > 0 ? (
                        voices.map((v) => (
                          <option
                            key={`browser:${v.voiceURI}`}
                            value={`browser:${v.voiceURI}`}
                          >
                            {v.name} ({v.lang})
                            {v.default ? ' [Default]' : ''}
                          </option>
                        ))
                      ) : (
                        <option value="browser:" disabled>
                          No local Browser SpeechSynthesis voices detected
                        </option>
                      )}
                    </optgroup>
                  )}
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between text-xs mb-1">
                  <label
                    htmlFor="tts-speed-range"
                    className="font-semibold text-slate-700"
                  >
                    Speed
                  </label>
                  <span className="font-mono-tabular font-semibold text-slate-900">
                    {speed.toFixed(2)}x
                  </span>
                </div>
                <input
                  id="tts-speed-range"
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.05"
                  value={speed}
                  onChange={(e) => setSpeed(parseFloat(e.target.value))}
                  className="w-full accent-blue-600 cursor-pointer"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-xs mb-1">
                  <label
                    htmlFor="tts-pitch-range"
                    className="font-semibold text-slate-700"
                  >
                    Pitch
                  </label>
                  <span className="font-mono-tabular font-semibold text-slate-900">
                    {pitch.toFixed(2)}
                  </span>
                </div>
                <input
                  id="tts-pitch-range"
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.05"
                  value={pitch}
                  onChange={(e) => setPitch(parseFloat(e.target.value))}
                  className="w-full accent-blue-600 cursor-pointer"
                />
              </div>
            </div>

            {/* Make Sounds Short Checkbox (Strictly excludes BGMs) */}
            <div className="bg-slate-50 border border-slate-200 rounded px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor="make-sounds-short-checkbox"
                className="inline-flex items-center gap-2 text-xs font-semibold text-slate-900 cursor-pointer select-none"
              >
                <input
                  id="make-sounds-short-checkbox"
                  type="checkbox"
                  checked={makeSoundsShort}
                  onChange={(e) => setMakeSoundsShort(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600 cursor-pointer"
                />
                <span>Make sounds short</span>
              </label>
              <span className="text-[11px] text-slate-600">
                {makeSoundsShort
                  ? 'Active: Long sound effects smoothly fade out at a ~2.8s–4.2s sweet spot so speech resumes quickly (BGMs stay 100% whole).'
                  : 'Unchecked: All sound effects and BGMs play whole.'}
              </span>
            </div>

            {/* Experimental Toggle: Always OFF by default on every load */}
            <div className="bg-slate-50 border border-slate-200 rounded px-3.5 py-2.5 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label
                  htmlFor="experimental-browser-tts-checkbox"
                  className="inline-flex items-center gap-2 text-xs font-semibold text-slate-900 cursor-pointer select-none"
                >
                  <input
                    id="experimental-browser-tts-checkbox"
                    type="checkbox"
                    checked={experimentalBrowserTts}
                    onChange={(e) =>
                      handleToggleExperimentalBrowserTts(e.target.checked)
                    }
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600 cursor-pointer"
                  />
                  <span>
                    Experimental: Use Own Browser TTS Voices &amp; Engine Switching
                  </span>
                </label>
                <span className="text-[11px] text-slate-600">
                  {experimentalBrowserTts
                    ? `${voices.length} browser voice${voices.length === 1 ? '' : 's'} unlocked, multi-engine tags active, docs & example updated.`
                    : 'Off by default: Neural voices only.'}
                </span>
              </div>

              {experimentalBrowserTts && (
                <div className="pt-2 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <label
                      htmlFor="tts-engine-select"
                      className="text-xs font-semibold text-slate-800 whitespace-nowrap"
                    >
                      TTS Engine:
                    </label>
                    <select
                      id="tts-engine-select"
                      value={ttsEngineMode}
                      onChange={(e) => {
                        const nextEngine =
                          e.target.value === 'browser' ? 'browser' : 'neural';
                        setTtsEngineMode(nextEngine);
                        if (nextEngine === 'browser') {
                          if (
                            !selectedVoiceURI.startsWith('browser:') &&
                            voices.length > 0
                          ) {
                            const fallbackBv =
                              voices.find((v) => v.default) || voices[0];
                            setSelectedVoiceURI(`browser:${fallbackBv.voiceURI}`);
                          }
                        } else if (selectedVoiceURI.startsWith('browser:')) {
                          const matched =
                            sonicAudioEngine.matchBrowserVoiceToNeuralPreset(
                              selectedVoice
                            );
                          setSelectedVoiceURI(matched.id);
                        }
                      }}
                      className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-900 focus:border-blue-600 focus:outline-2 focus:outline-blue-600"
                    >
                      <option value="neural">
                        Neural TTS (Cloud Voices — Studio WAV)
                      </option>
                      <option value="browser">
                        Browser SpeechSynthesis (Your Device Voices)
                      </option>
                    </select>
                  </div>

                  <span className="text-[11px] text-slate-600">
                    WAV export tries live tab-audio capture first and falls back to matched Neural speech if blocked.
                  </span>
                </div>
              )}
            </div>

            {/* Generate, Stop, Reset & Download Row */}
            <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={handleGenerateAndPlay}
                  disabled={parsedTokens.length === 0}
                  className="inline-flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Play className="w-4 h-4 fill-current" aria-hidden="true" />
                  Generate
                </button>

                {isPlaying && (
                  <button
                    type="button"
                    onClick={handleStopPlayback}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Square
                      className="w-4 h-4 fill-current"
                      aria-hidden="true"
                    />
                    Stop
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setSpeed(1.0);
                    setPitch(1.0);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded focus-visible:outline-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  Reset Speed &amp; Pitch
                </button>
              </div>

              {generatedWavUrl && (
                <a
                  href={generatedWavUrl}
                  download="sonic-emoji.wav"
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-slate-900 bg-white hover:bg-slate-100 border border-slate-300 rounded focus-visible:outline-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0"
                >
                  <Download className="w-4 h-4" aria-hidden="true" />
                  Download WAV ({generatedDurationSec.toFixed(1)}s)
                </a>
              )}
              {isGeneratingWav && !generatedWavUrl && (
                <span className="text-xs text-slate-600 font-mono-tabular">
                  Preparing WAV download...
                </span>
              )}
            </div>

            {/* Advanced Options Button at the Very End of the Generate Tab */}
            <div className="pt-3 border-t border-slate-200 space-y-3">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setShowAdvancedOptions((prev) => !prev)}
                  aria-expanded={showAdvancedOptions}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded focus-visible:outline-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Settings2 className="w-3.5 h-3.5" aria-hidden="true" />
                  {showAdvancedOptions
                    ? 'Hide Advanced Options'
                    : 'Advanced Options'}
                </button>
                <span className="text-[11px] text-slate-500">
                  Current Mode:{' '}
                  <strong className="text-slate-700">
                    {editorMode === 'standard'
                      ? 'Standard Mode (Manual Text)'
                      : 'Prompt Mode (Optional Gemini Generator)'}
                  </strong>
                </span>
              </div>

              {showAdvancedOptions && (
                <div className="bg-slate-50 border border-slate-200 rounded p-4 space-y-3">
                  <div>
                    <h2 className="text-xs font-bold text-slate-900">
                      Input Mode Switcher (Completely Optional)
                    </h2>
                    <p className="text-xs text-slate-600 mt-0.5">
                      Stay in Standard Mode to paste or type text directly, or optionally switch to Prompt Mode to ask Gemini to write a script with sound effects for you.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setEditorMode('standard')}
                      className={`px-3.5 py-2 text-xs font-semibold rounded border cursor-pointer ${
                        editorMode === 'standard'
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                      }`}
                    >
                      Standard Mode (Default)
                    </button>

                    <button
                      type="button"
                      onClick={() => setEditorMode('prompt')}
                      className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded border cursor-pointer ${
                        editorMode === 'prompt'
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                      }`}
                    >
                      <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                      Switch to Prompt Mode (Gemini)
                    </button>
                  </div>

                  <div className="pt-3 border-t border-slate-200 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-xs font-bold text-slate-900">
                          Project Source Code Export
                        </h3>
                        <p className="text-xs text-slate-600 mt-0.5">
                          Download the complete project source files as a verified{' '}
                          <code className="font-mono-tabular">.zip</code> archive (excludes secrets and{' '}
                          <code className="font-mono-tabular">node_modules</code>).
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={handleDownloadSourceZip}
                          disabled={isPreparingSourceZip}
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-900 bg-white hover:bg-slate-100 disabled:bg-slate-100 border border-slate-300 rounded focus-visible:outline-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <Download className="w-3.5 h-3.5" aria-hidden="true" />
                          {isPreparingSourceZip
                            ? 'Building Verified ZIP...'
                            : 'Download Source Code (.zip)'}
                        </button>

                        {sourceZipUrl && sourceZipMeta && (
                          <a
                            href={sourceZipUrl}
                            download="sonic-emoji-source.zip"
                            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded focus-visible:outline-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0"
                          >
                            <Download className="w-3.5 h-3.5" aria-hidden="true" />
                            Save ZIP ({sourceZipMeta.fileCount} files ·{' '}
                            {(sourceZipMeta.sizeBytes / 1024).toFixed(1)} KB)
                          </a>
                        )}
                      </div>
                    </div>

                    {sourceZipError && (
                      <p className="text-xs font-medium text-red-600" role="alert">
                        {sourceZipError}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ================= TAB 2: PURE TAP-TO-PLAY SOUNDBOARD TAB (NO CATEGORIES, NO URLS) ================= */}
        {activeTab === 'soundboard' && (
          <section
            aria-labelledby="soundboard-heading"
            className="bg-white border border-slate-300 rounded-lg p-6 space-y-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-200">
              <h1
                id="soundboard-heading"
                className="text-lg font-bold text-slate-900"
              >
                Soundboard — Tap a Sound to Play ({filteredSoundboard.length})
              </h1>

              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={makeSoundsShort}
                    onChange={(e) => setMakeSoundsShort(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-600 cursor-pointer"
                  />
                  <span>Make sounds short (excludes BGMs)</span>
                </label>

                <div className="relative w-52">
                  <Search
                    className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={soundboardFilter}
                    onChange={(e) => setSoundboardFilter(e.target.value)}
                    placeholder="Filter sounds..."
                    aria-label="Filter soundboard sounds"
                    className="w-full rounded border border-slate-300 bg-white pl-8 pr-2.5 py-1.5 text-xs text-slate-900 focus:border-blue-600 focus:outline-2 focus:outline-blue-600"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleStopPlayback}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded focus-visible:outline-2 focus-visible:outline-red-600 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Square className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
                  Stop Audio
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
              {filteredSoundboard.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    sonicAudioEngine.playSoundEffect(item);
                  }}
                  className="flex items-center gap-2.5 px-3 py-3 text-left bg-slate-50 hover:bg-blue-50 active:bg-blue-100 border border-slate-300 hover:border-blue-400 rounded text-xs font-semibold text-slate-900 focus-visible:outline-2 focus-visible:outline-blue-600 cursor-pointer transition-colors"
                >
                  <span className="text-lg shrink-0" aria-hidden="true">
                    {item.emojis[0] || '🔊'}
                  </span>
                  <span className="line-clamp-2 leading-snug">{item.name}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* ================= TAB 3: DEDICATED SOUNDS & EFFECTS DIRECTORY TAB ================= */}
        {activeTab === 'sounds' && (
          <section
            aria-labelledby="sounds-heading"
            className="bg-white border border-slate-300 rounded-lg p-6 space-y-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-200">
              <div>
                <h1
                  id="sounds-heading"
                  className="text-lg font-bold text-slate-900"
                >
                  Sounds, Voice Switching &amp; Voice Effects Directory ({SOUND_CATALOG.length}{' '}
                  Sounds + {VOICE_PRESET_CATALOG.length} Voices + {VOICE_EFFECT_CATALOG.length} Filters)
                </h1>
                <p className="text-xs text-slate-600 mt-0.5">
                  Click any emoji, sound tag, voice switch, or voice effect to insert it into your script, or click Play to preview.
                </p>
              </div>

              <div className="flex items-center gap-3 text-xs text-slate-600">
                <span className="font-mono-tabular inline-flex items-center gap-1.5">
                  <Database
                    className="w-3.5 h-3.5 text-slate-500"
                    aria-hidden="true"
                  />
                  Local Storage: {cacheStats.totalCachedCount}/
                  {SOUND_CATALOG.length} ({(cacheStats.totalBytes / 1024).toFixed(0)}{' '}
                  KB)
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    await sonicAudioEngine.clearCache();
                    runPreload(true);
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" aria-hidden="true" />
                  Refresh Cache
                </button>
              </div>
            </div>

            {/* Inline Voice Switching (voice:...) Quick Reference & Insert */}
            <div className="space-y-2">
              <h2 className="text-xs font-bold text-slate-900">
                Inline Voice Switching (Switch voices mid-script; use <code className="font-mono-tabular">(voice: default)</code> or <code className="font-mono-tabular">(voice: original)</code> to return to your selected voice)
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {[
                  'voice: default',
                  'voice: original',
                  ...(experimentalBrowserTts
                    ? ['engine: browser', 'engine: neural', 'voice: browser']
                    : []),
                  'voice: jessie',
                  'voice: sarah',
                  'voice: betty',
                  'voice: crystal',
                  'voice: warm jessie',
                  'voice: joey',
                  'voice: adam',
                  'voice: bob',
                  'voice: chris',
                  'voice: ryan',
                  'voice: mark',
                  'voice: valley girl',
                  'voice: makeup',
                  'voice: shenna',
                  'voice: pansino',
                  'voice: trevor',
                  'voice: butler',
                  'voice: neighbor',
                  'voice: magician',
                  'voice: commentator',
                  'voice: storyteller',
                  'voice: cody',
                  'voice: professor',
                  'voice: scientist',
                  'voice: wacky',
                  'voice: peaceful',
                  'voice: deadpool',
                  'voice: jarvis',
                  'voice: wizard',
                  'voice: santa',
                  'voice: elf',
                  'voice: grinch',
                  'voice: grandma',
                  'voice: ghostface',
                  'voice: rocket',
                  'voice: pirate',
                  'voice: c3po',
                  'voice: stitch',
                  'voice: stormtrooper',
                  'voice: chewbacca',
                  'voice: cupid',
                  'voice: silly',
                  'voice: twinkle',
                  'voice: maestro',
                  'voice: soprano',
                  'voice: crooner',
                  'voice: phantom',
                  'voice: glorious',
                  'voice: celebration',
                  'voice: ballad',
                  'voice: british',
                  'voice: australian',
                  'voice: anime girl',
                  'voice: hindi',
                ].map((vTag) => (
                  <button
                    key={vTag}
                    type="button"
                    onClick={() => insertSnippetAndGoToGenerate(`(${vTag})`)}
                    className="px-2.5 py-1 text-xs font-mono-tabular bg-slate-100 hover:bg-blue-50 text-slate-900 border border-slate-300 rounded whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    ({vTag})
                  </button>
                ))}
              </div>
            </div>

            {/* Voice Effects (effect:...) Quick Reference & Insert */}
            <div className="space-y-2">
              <h2 className="text-xs font-bold text-slate-900">
                Voice Effects (Applies to TTS until sentence ends with a period &ldquo;.&rdquo; or until effect:normal)
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {VOICE_EFFECT_CATALOG.map((ve) => (
                  <button
                    key={ve.id}
                    type="button"
                    onClick={() =>
                      insertSnippetAndGoToGenerate(`(${ve.triggers[0]})`)
                    }
                    title={ve.description}
                    className="px-2.5 py-1 text-xs font-mono-tabular bg-slate-100 hover:bg-blue-50 text-slate-900 border border-slate-300 rounded whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    ({ve.triggers[0]})
                  </button>
                ))}
              </div>
            </div>

            {/* Search & Background Mode Toggle */}
            <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-slate-200">
              <div className="relative w-full sm:w-72">
                <Search
                  className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search goat, eat, drink, horror..."
                  aria-label="Search sound effects catalog"
                  className="w-full rounded border border-slate-300 bg-white pl-9 pr-3 py-1.5 text-xs text-slate-900 focus:border-blue-600 focus:outline-2 focus:outline-blue-600"
                />
              </div>

              <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={insertAsBackground}
                  onChange={(e) => setInsertAsBackground(e.target.checked)}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                />
                <span>
                  Insert with <code className="font-mono-tabular">&amp;</code>{' '}
                  (plays in background while TTS speaks)
                </span>
              </label>
            </div>

            {/* Category Filter Tabs */}
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="tablist"
              aria-label="Filter sound effects by category"
            >
              {categories.map((cat) => {
                const active = selectedCategory === cat;
                return (
                  <button
                    key={cat}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      active
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200'
                    }`}
                  >
                    {cat}
                  </button>
                );
              })}
            </div>

            {/* Accessible Table of All 122 Sound Effects */}
            <div className="overflow-x-auto border border-slate-200 rounded">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-100 border-b border-slate-200 text-slate-700 font-semibold">
                    <th className="py-2.5 px-3">Sound Effect</th>
                    <th className="py-2.5 px-3">Emojis</th>
                    <th className="py-2.5 px-3">Tags</th>
                    <th className="py-2.5 px-3">Valid URL</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredCatalog.map((item: SoundEffectItem) => (
                    <tr key={item.id} className="hover:bg-slate-50">
                      <td className="py-2.5 px-3 align-top">
                        <div className="font-semibold text-slate-900">
                          {item.name}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {item.category}
                        </div>
                      </td>

                      <td className="py-2.5 px-3 align-top">
                        <div className="flex flex-wrap gap-1">
                          {item.emojis.map((em) => (
                            <button
                              key={em}
                              type="button"
                              onClick={() =>
                                insertSnippetAndGoToGenerate(
                                  insertAsBackground && !item.isBgm
                                    ? `&${em}`
                                    : em
                                )
                              }
                              className="px-2 py-1 text-sm bg-white hover:bg-blue-50 border border-slate-300 rounded cursor-pointer"
                            >
                              {em}
                            </button>
                          ))}
                        </div>
                      </td>

                      <td className="py-2.5 px-3 align-top">
                        <div className="flex flex-wrap gap-1">
                          {item.tags.slice(0, 4).map((tg) => {
                            const formattedTag = `(${tg})`;
                            return (
                              <button
                                key={tg}
                                type="button"
                                onClick={() =>
                                  insertSnippetAndGoToGenerate(
                                    insertAsBackground && !item.isBgm
                                      ? `&${formattedTag}`
                                      : formattedTag
                                  )
                                }
                                className="px-2 py-1 font-mono-tabular text-[11px] bg-white hover:bg-blue-50 text-slate-800 border border-slate-300 rounded whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                {insertAsBackground && !item.isBgm
                                  ? `&(${tg})`
                                  : `(${tg})`}
                              </button>
                            );
                          })}
                        </div>
                      </td>

                      <td className="py-2.5 px-3 align-top font-mono-tabular">
                        <div className="flex items-center gap-1.5 max-w-[200px]">
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-700 hover:underline truncate"
                            title={item.url}
                          >
                            {item.url}
                          </a>
                          <ExternalLink
                            className="w-3 h-3 text-slate-400 shrink-0"
                            aria-hidden="true"
                          />
                        </div>
                      </td>

                      <td className="py-2.5 px-3 align-top text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              sonicAudioEngine.playSoundEffect(item)
                            }
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-slate-800 bg-white hover:bg-slate-100 border border-slate-300 rounded cursor-pointer"
                          >
                            <Volume2
                              className="w-3.5 h-3.5 text-blue-600"
                              aria-hidden="true"
                            />
                            Play
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard?.writeText(item.url);
                              setCopiedUrlId(item.id);
                              setTimeout(() => setCopiedUrlId(null), 1500);
                            }}
                            title="Copy valid sound URL"
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 bg-white hover:bg-slate-100 border border-slate-300 rounded cursor-pointer"
                          >
                            {copiedUrlId === item.id ? (
                              <Check
                                className="w-3.5 h-3.5 text-emerald-600"
                                aria-hidden="true"
                              />
                            ) : (
                              <Copy
                                className="w-3.5 h-3.5"
                                aria-hidden="true"
                              />
                            )}
                            <span className="sr-only">Copy URL</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ================= TAB 3: DEDICATED DOCUMENTATION TAB ================= */}
        {activeTab === 'docs' && (
          <section
            aria-labelledby="docs-heading"
            className="bg-white border border-slate-300 rounded-lg p-6 space-y-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-200">
              <div>
                <h1
                  id="docs-heading"
                  className="text-lg font-bold text-slate-900"
                >
                  Sonic Emoji — Complete Documentation &amp; How It Works
                </h1>
                <p className="text-xs text-slate-600 mt-1">
                  Covers all {SOUND_CATALOG.length} sound effects, {VOICE_PRESET_CATALOG.length} neural voices
                  {experimentalBrowserTts
                    ? ` + Experimental Browser System TTS (${voices.length} detected)`
                    : ''}
                  , universal emoji coverage, {VOICE_EFFECT_CATALOG.length} voice effects (<code className="font-mono-tabular">effect:telephone</code>, <code className="font-mono-tabular">effect:phone call</code>, <code className="font-mono-tabular">effect:normal</code>), pauses, and BGM tags.
                </p>
              </div>

              <button
                type="button"
                onClick={handleCopyEntireDocumentation}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {copiedDocs ? (
                  <>
                    <Check className="w-4 h-4" aria-hidden="true" />
                    Copied Entire Documentation!
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" aria-hidden="true" />
                    Copy Entire Documentation
                  </>
                )}
              </button>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="full-docs-markdown"
                  className="text-xs font-bold text-slate-900"
                >
                  Full Documentation Text (Click &ldquo;Copy Entire Documentation&rdquo; above)
                </label>
                <span className="text-xs text-slate-500 font-mono-tabular">
                  {documentationMarkdown.length.toLocaleString()} chars
                </span>
              </div>
              <textarea
                id="full-docs-markdown"
                readOnly
                rows={26}
                value={documentationMarkdown}
                className="w-full rounded border border-slate-300 bg-slate-50 p-4 text-xs font-mono-tabular text-slate-800 leading-relaxed focus:border-blue-600 focus:outline-2 focus:outline-blue-600"
              />
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
