import {
  SOUND_BY_ID,
  SOUND_CATALOG,
  SoundEffectItem,
  TAG_TO_SOUND,
  VOICE_EFFECT_CATALOG,
  VOICE_PRESET_CATALOG,
  VoiceEffectType,
  VoicePresetItem,
  resolveEmojiToSound,
  resolveVoiceSwitchName,
} from '../data/soundCatalog';

export type TimelineToken =
  | {
      id: string;
      type: 'speech';
      text: string;
      voiceEffect: VoiceEffectType;
      /**
       * If non-null, overrides the user's selected dropdown voice with this specific neural voice
       * until switched again or reset back to the original voice via `(voice:default)` / `(voice:original)`.
       */
      voiceOverride: VoicePresetItem | null;
      /**
       * Experimental multi-engine override: 'browser' | 'neural' | undefined (inherit selected engine)
       */
      ttsEngine?: 'neural' | 'browser';
      browserVoiceHint?: string | null;
    }
  | {
      id: string;
      type: 'sfx';
      sound: SoundEffectItem;
      rawTrigger: string;
      background: boolean;
    }
  | {
      id: string;
      type: 'pause';
      durationSec: number;
      rawTrigger: string;
    }
  | {
      id: string;
      type: 'bgm';
      sound: SoundEffectItem | null; // null means stop BGM
      rawTrigger: string;
    }
  | {
      id: string;
      type: 'effect';
      effect: VoiceEffectType;
      rawTrigger: string;
    }
  | {
      id: string;
      type: 'voice_switch';
      voicePreset: VoicePresetItem | null; // null means return to user's original selected voice
      rawTrigger: string;
      ttsEngine?: 'neural' | 'browser';
      browserVoiceHint?: string | null;
    };

function resolveVoiceEffectName(rawName: string): VoiceEffectType | null {
  const s = rawName.trim().toLowerCase().replace(/[-_]+/g, ' ');
  if (!s) return null;

  if (
    s === 'normal' ||
    s === 'reset' ||
    s === 'off' ||
    s === 'clear' ||
    s === 'none' ||
    s === 'default'
  ) {
    return 'normal';
  }
  if (
    s === 'telephone' ||
    s === 'phone call' ||
    s === 'phone' ||
    s === 'call' ||
    s === 'cellphone' ||
    s === 'mobile'
  ) {
    return 'telephone';
  }
  if (
    s === 'radio' ||
    s === 'walkie talkie' ||
    s === 'intercom' ||
    s === 'broadcast'
  ) {
    return 'radio';
  }
  if (
    s === 'megaphone' ||
    s === 'bullhorn' ||
    s === 'loudspeaker' ||
    s === 'pa' ||
    s === 'speaker'
  ) {
    return 'megaphone';
  }
  if (
    s === 'cave' ||
    s === 'echo' ||
    s === 'reverb' ||
    s === 'hall' ||
    s === 'canyon'
  ) {
    return 'cave';
  }
  if (
    s === 'robot' ||
    s === 'droid' ||
    s === 'cyber' ||
    s === 'vocoder' ||
    s === 'ai'
  ) {
    return 'robot';
  }
  if (
    s === 'monster' ||
    s === 'demon' ||
    s === 'deep' ||
    s === 'giant' ||
    s === 'boss'
  ) {
    return 'monster';
  }
  if (
    s === 'chipmunk' ||
    s === 'helium' ||
    s === 'high' ||
    s === 'tiny' ||
    s === 'squeaky'
  ) {
    return 'chipmunk';
  }
  if (
    s === 'underwater' ||
    s === 'muffled' ||
    s === 'submerged' ||
    s === 'next room' ||
    s === 'outside door'
  ) {
    return 'underwater';
  }
  if (
    s === 'ghost' ||
    s === 'spooky' ||
    s === 'haunted' ||
    s === 'poltergeist'
  ) {
    return 'ghost';
  }
  if (
    s === 'whisper' ||
    s === 'quiet' ||
    s === 'soft' ||
    s === 'asmr'
  ) {
    return 'whisper';
  }
  if (s === 'fast' || s === 'speed' || s === 'rush' || s === 'rapid') {
    return 'fast';
  }
  if (s === 'slow' || s === 'slowmo' || s === 'slomo') {
    return 'slow';
  }

  for (const item of VOICE_EFFECT_CATALOG) {
    if (item.id === s) return item.id;
    for (const trig of item.triggers) {
      const bare = trig.replace(/^effect\s*:\s*/, '');
      if (s === bare) return item.id;
    }
  }
  return null;
}

function matchTagContent(
  rawInside: string,
  allowExperimentalBrowserTts = false
):
  | { kind: 'pause'; durationSec: number }
  | { kind: 'bgm'; sound: SoundEffectItem | null }
  | { kind: 'effect'; effect: VoiceEffectType }
  | {
      kind: 'voice_switch';
      voicePreset: VoicePresetItem | null;
      ttsEngine?: 'neural' | 'browser';
      browserVoiceHint?: string | null;
      resetToDefault?: boolean;
    }
  | { kind: 'sfx'; sound: SoundEffectItem; forceBg: boolean }
  | null {
  const cleaned = rawInside.trim().toLowerCase();
  if (!cleaned) return null;

  // 0. Experimental TTS Engine Switch tag: "(engine: browser)", "(engine: neural)", "(tts: browser)", "(tts: neural)"
  if (
    cleaned.startsWith('engine:') ||
    cleaned.startsWith('engine ') ||
    cleaned.startsWith('tts:') ||
    cleaned.startsWith('tts ')
  ) {
    const sub = cleaned.replace(/^(?:engine|tts)\s*:?\s*/, '').trim();
    if (
      sub === 'browser' ||
      sub === 'system' ||
      sub === 'speechsynthesis' ||
      sub === 'local' ||
      sub === 'web'
    ) {
      return {
        kind: 'voice_switch',
        voicePreset: null,
        ttsEngine: allowExperimentalBrowserTts ? 'browser' : 'neural',
        browserVoiceHint: null,
      };
    }
    if (
      sub === 'neural' ||
      sub === 'cloud' ||
      sub === 'google' ||
      sub === 'tiktok' ||
      sub === 'studio' ||
      sub === 'default' ||
      sub === 'normal'
    ) {
      return {
        kind: 'voice_switch',
        voicePreset: null,
        ttsEngine: 'neural',
        browserVoiceHint: null,
        resetToDefault: sub === 'default' || sub === 'normal',
      };
    }
  }

  // 0A. Check for Inline Voice Switch tag: e.g. "voice:jessie", "voice:ghostface", "voice:default", "voice:original", "voice:browser", "tiktok voice"
  if (
    cleaned.startsWith('voice:') ||
    cleaned.startsWith('voice ') ||
    cleaned.startsWith('speaker:') ||
    cleaned.startsWith('speaker ') ||
    cleaned.startsWith('switch to ') ||
    cleaned.startsWith('change voice') ||
    cleaned.endsWith(' voice')
  ) {
    const sub = cleaned
      .replace(/^(?:voice|speaker|switch\s+to|change\s+voice(?:\s+to)?)\s*:?\s*/, '')
      .trim();

    if (
      sub === 'browser' ||
      sub === 'system' ||
      sub.startsWith('browser:') ||
      sub.startsWith('browser ') ||
      sub.startsWith('system:')
    ) {
      const hint = sub.replace(/^(?:browser|system)\s*:?\s*/, '').trim() || null;
      return {
        kind: 'voice_switch',
        voicePreset: null,
        ttsEngine: allowExperimentalBrowserTts ? 'browser' : 'neural',
        browserVoiceHint: allowExperimentalBrowserTts ? hint : null,
      };
    }

    const resolvedVoice = resolveVoiceSwitchName(sub) || resolveVoiceSwitchName(cleaned);
    if (resolvedVoice === 'DEFAULT') {
      return {
        kind: 'voice_switch',
        voicePreset: null,
        resetToDefault: true,
      };
    }
    if (resolvedVoice) {
      return {
        kind: 'voice_switch',
        voicePreset: resolvedVoice,
        ttsEngine: 'neural',
        browserVoiceHint: null,
      };
    }
    // Fallback: if someone wrote (voice:telephone), check if it's a DSP voice effect
    const fallbackEffect = resolveVoiceEffectName(sub);
    if (fallbackEffect) {
      return { kind: 'effect', effect: fallbackEffect };
    }
    // Never let an explicit (voice: ...) or (speaker: ...) tag fall through as raw spoken text!
    if (
      cleaned.startsWith('voice:') ||
      cleaned.startsWith('voice ') ||
      cleaned.startsWith('speaker:')
    ) {
      const defaultTikTok =
        VOICE_PRESET_CATALOG.find((v) => v.id === 'tiktok:en_us_001') || null;
      return {
        kind: 'voice_switch',
        voicePreset: defaultTikTok,
        ttsEngine: 'neural',
      };
    }
  }

  // 0B. Check for Voice Effect DSP tag: e.g. "effect:telephone", "effect: phone call", "effect:normal"
  if (cleaned.startsWith('effect:') || cleaned.startsWith('effect ')) {
    const sub = cleaned.replace(/^effect\s*:?\s*/, '').trim();
    const resolved = resolveVoiceEffectName(sub);
    if (resolved) {
      return { kind: 'effect', effect: resolved };
    }
  }

  // 1. Check for pause tag: e.g. "pause 1.5s", "pause 2", "wait 500ms", "pause"
  const pauseMatch = cleaned.match(
    /^(?:pause|wait|silence|delay)(?:\s+([0-9]*\.?[0-9]+)\s*(ms|s|sec|seconds|second)?)?$/i
  );
  if (pauseMatch) {
    if (!pauseMatch[1]) {
      return { kind: 'pause', durationSec: 1.0 };
    }
    const val = parseFloat(pauseMatch[1]);
    const unit = (pauseMatch[2] || 's').toLowerCase();
    const durationSec =
      unit === 'ms' ? Math.max(0.05, val / 1000) : Math.max(0.05, Math.min(30, val));
    return { kind: 'pause', durationSec };
  }

  // 2. Check for BGM tag: e.g. "bgm", "bgm: lost woods", "bgm: zelda", "bgm: horror", "bgm: sneaky", "bgm: off"
  if (cleaned === 'bgm' || cleaned.startsWith('bgm:') || cleaned.startsWith('bgm ')) {
    const sub = cleaned.replace(/^bgm\s*:?\s*/, '').trim();
    if (sub === 'off' || sub === 'stop' || sub === 'none') {
      return { kind: 'bgm', sound: null };
    }
    if (TAG_TO_SOUND[`bgm: ${sub}`]) {
      return { kind: 'bgm', sound: TAG_TO_SOUND[`bgm: ${sub}`] };
    }
    if (TAG_TO_SOUND[`bgm ${sub}`]) {
      return { kind: 'bgm', sound: TAG_TO_SOUND[`bgm ${sub}`] };
    }
    if (
      sub.includes('lost woods') ||
      sub.includes('zelda') ||
      sub.includes('saria') ||
      sub.includes('ocarina')
    ) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_zelda_lost_woods'] };
    }
    if (sub.includes('guardian') || sub.includes('botw')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_zelda_guardian'] };
    }
    if (sub.includes('outro') || sub.includes('xenogenesis') || sub.includes('thefatrat')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_xenogenesis_outro'] };
    }
    if (sub.includes('gigachad') || sub.includes('sigma') || sub.includes('chad')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_gigachad'] };
    }
    if (sub.includes('giorno') || sub.includes('jojo') || sub.includes('golden wind')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_giorno_theme'] };
    }
    if (sub.includes('tetris') || sub.includes('korobeiniki')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_tetris'] };
    }
    if (sub.includes('naruto') || sub.includes('sadness') || sub.includes('sad')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_naruto_sad'] };
    }
    if (sub.includes('chase') || sub.includes('ao oni') || sub.includes('panic')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_horror_chase'] };
    }
    if (sub.includes('music box') || sub.includes('haunted') || sub.includes('cursed')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_haunted_box'] };
    }
    if (
      sub.includes('horror') ||
      sub.includes('scary') ||
      sub.includes('spooky') ||
      sub.includes('creepy') ||
      sub.includes('dark')
    ) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_horror_box'] };
    }
    if (
      sub.includes('suspense') ||
      sub.includes('fnaf') ||
      sub.includes('hallway') ||
      sub.includes('eerie') ||
      sub.includes('nightmare')
    ) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_horror_suspense'] };
    }
    if (sub.includes('weasel') || sub.includes('youtube')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_scheming_weasel'] };
    }
    if (sub.includes('duck') || sub.includes('fluffing') || sub.includes('goofy')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_fluffing_duck'] };
    }
    if (sub.includes('mii')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_mii_channel'] };
    }
    if (sub.includes('megalovania') || sub.includes('sans')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_megalovania'] };
    }
    if (sub.includes('undertale shop') || sub.includes('rpg shop')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_undertale_shop'] };
    }
    if (sub.includes('fallen down') || sub.includes('nostalgic')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_fallen_down'] };
    }
    if (sub.includes('coconut') || sub.includes('mario kart')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_coconut_mall'] };
    }
    if (sub.includes('kahoot')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_kahoot'] };
    }
    if (sub.includes('pink panther') || sub.includes('detective') || sub.includes('mystery')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_pink_panther'] };
    }
    if (sub.includes('spongebob') || sub.includes('bikini bottom') || sub.includes('seaweed')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_spongebob_seaweed'] };
    }
    if (sub.includes('boss')) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_boss_fight'] };
    }
    if (
      !sub ||
      sub === 'on' ||
      sub === 'play' ||
      sub.includes('sneaky') ||
      sub.includes('comedy') ||
      sub.includes('carnival') ||
      sub.includes('funny')
    ) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_sneaky'] };
    }
    if (
      sub.includes('curb') ||
      sub.includes('frolic') ||
      sub.includes('meme') ||
      sub.includes('credits')
    ) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_curb'] };
    }
    if (
      sub.includes('chill') ||
      sub.includes('lofi') ||
      sub.includes('coffee') ||
      sub.includes('cozy')
    ) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_lofi'] };
    }
    if (
      sub.includes('elevator') ||
      sub.includes('lounge') ||
      sub.includes('jazz') ||
      sub.includes('bossa')
    ) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_elevator'] };
    }
    if (
      sub.includes('wii') ||
      sub.includes('arcade') ||
      sub.includes('game') ||
      sub.includes('gaming') ||
      sub.includes('shop')
    ) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_wii'] };
    }
    if (
      sub.includes('jeopardy') ||
      sub.includes('thinking') ||
      sub.includes('quiz')
    ) {
      return { kind: 'bgm', sound: SOUND_BY_ID['bgm_jeopardy'] };
    }
    return { kind: 'bgm', sound: SOUND_BY_ID['bgm_sneaky'] };
  }

  // 3. Check if prefixed with bg: / background: / & / ~ inside the tag
  let forceBg = false;
  let lookup = cleaned;
  if (/^(?:bg|background)\s*:?\s+/.test(lookup)) {
    forceBg = true;
    lookup = lookup.replace(/^(?:bg|background)\s*:?\s+/, '').trim();
  } else if (/^[&~^]/.test(lookup)) {
    forceBg = true;
    lookup = lookup.replace(/^[&~^]\s*/, '').trim();
  }

  // Strip optional suffix like "sound effect", "sfx", "sound"
  const normalized = lookup
    .replace(/\s+(?:sound\s+effects?|sfx|sounds?|audio|track|noise)$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();

  if (TAG_TO_SOUND[lookup]) {
    const s = TAG_TO_SOUND[lookup];
    if (s.isBgm) return { kind: 'bgm', sound: s };
    return { kind: 'sfx', sound: s, forceBg };
  }
  if (TAG_TO_SOUND[normalized]) {
    const s = TAG_TO_SOUND[normalized];
    if (s.isBgm) return { kind: 'bgm', sound: s };
    return { kind: 'sfx', sound: s, forceBg };
  }

  // Fuzzy match against catalog tags and names
  for (const item of SOUND_CATALOG) {
    if (item.id === normalized.replace(/\s+/g, '_')) {
      if (item.isBgm) return { kind: 'bgm', sound: item };
      return { kind: 'sfx', sound: item, forceBg };
    }
    for (const t of item.tags) {
      if (normalized.includes(t) || t.includes(normalized)) {
        if (item.isBgm) return { kind: 'bgm', sound: item };
        return { kind: 'sfx', sound: item, forceBg };
      }
    }
  }

  return null;
}

/**
 * Parses input script into an ordered sequence of speech, sound effects, pauses, voice switches, voice effects, and BGM cues.
 * - Voice switches (`(voice:jessie)`, `(voice:ghostface)`, `(voice:default)`) persist across sentences until changed or reset back to the user's original selected voice.
 * - Voice effects (`effect:telephone`, `effect:phone call`, etc.) modify TTS for a specific segment until it ends with a period (`.`) or until `effect:normal` is encountered.
 */
export function parseSonicScript(
  input: string,
  allowExperimentalBrowserTts = false
): TimelineToken[] {
  const tokens: TimelineToken[] = [];
  if (!input || !input.trim()) return tokens;

  // Match:
  // 1) Optional background prefix (& or ~) followed by (tag) or [tag]
  // 2) Bare inline effect:name, voice:name, or engine:name
  // 3) Optional background prefix (& or ~) followed by any Emoji sequence
  // 4) Triple periods (... or …) to insert automatic pauses instead of TTS saying "dot dot dot"
  const pattern =
    /([&~^])?\s*(\([^()\n]{1,75}\)|\[[^[\]\n]{1,75}\])|\b((?:effect|voice|speaker|engine|tts)\s*:\s*(?:phone\s+call|walkie\s+talkie|next\s+room|outside\s+door|ghost\s+host|ghost\s+face|madame\s+leota|protocol\s+droid|story\s+teller|narrator\s+uk|commanding\s+uk|valley\s+girl|rich\s+girl|warm\s+jessie|uk\s+butler|british\s+butler|uk\s+neighbor|ai\s+butler|grand\s+wizard|the\s+grinch|warm\s+breeze|sing\s+female|sing\s+male|anime\s+girl|korean\s+male|santa\s+claus|bass\s+jingle|quirk\s+crooner|rising\s+tenor|tiktok\s+voice|assistant\s+voice|google\s+voice|[a-z0-9_:-]+))\b|([&~^])?(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*)|(\.{3,}|…+)/giu;

  let lastIndex = 0;
  let tokenCounter = 0;
  let activeVoiceEffect: VoiceEffectType = 'normal';
  let activeVoiceOverride: VoicePresetItem | null = null;
  let activeTtsEngine: 'neural' | 'browser' | undefined = undefined;
  let activeBrowserVoiceHint: string | null = null;

  const pushSpeech = (rawText: string) => {
    const cleaned = rawText
      .replace(/(?:^|\s)[&~^](?=["'A-Za-z])/g, ' ')
      .replace(/\.{2,}|…+/g, '. ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || /^[,.;:!?'"”’)\s-]+$/.test(cleaned)) return;

    const engineForToken = allowExperimentalBrowserTts
      ? activeTtsEngine
      : undefined;

    if (activeVoiceEffect === 'normal') {
      tokens.push({
        id: `tok_${++tokenCounter}`,
        type: 'speech',
        text: cleaned,
        voiceEffect: 'normal',
        voiceOverride: activeVoiceOverride,
        ttsEngine: engineForToken,
        browserVoiceHint: allowExperimentalBrowserTts ? activeBrowserVoiceHint : null,
      });
      return;
    }

    // Active voice effect is set! It applies until the segment ends with a period (.)
    // or until an explicit (effect:normal) tag resets it.
    const periodMatch = cleaned.match(/^(.*?\.['"”’)]*)(?:\s+(.*))?$/);
    if (periodMatch) {
      const firstSentence = periodMatch[1].trim();
      const restAfterPeriod = (periodMatch[2] || '').trim();
      if (firstSentence) {
        tokens.push({
          id: `tok_${++tokenCounter}`,
          type: 'speech',
          text: firstSentence,
          voiceEffect: activeVoiceEffect,
          voiceOverride: activeVoiceOverride,
          ttsEngine: engineForToken,
          browserVoiceHint: allowExperimentalBrowserTts
            ? activeBrowserVoiceHint
            : null,
        });
      }
      // Reset voice effect back to normal after the period (voiceOverride remains active until switched!)
      activeVoiceEffect = 'normal';
      if (restAfterPeriod) {
        tokens.push({
          id: `tok_${++tokenCounter}`,
          type: 'speech',
          text: restAfterPeriod,
          voiceEffect: 'normal',
          voiceOverride: activeVoiceOverride,
          ttsEngine: engineForToken,
          browserVoiceHint: allowExperimentalBrowserTts
            ? activeBrowserVoiceHint
            : null,
        });
      }
    } else {
      tokens.push({
        id: `tok_${++tokenCounter}`,
        type: 'speech',
        text: cleaned,
        voiceEffect: activeVoiceEffect,
        voiceOverride: activeVoiceOverride,
        ttsEngine: engineForToken,
        browserVoiceHint: allowExperimentalBrowserTts
          ? activeBrowserVoiceHint
          : null,
      });
    }
  };

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const matchStart = match.index;
    const fullMatch = match[0];

    const tagBgPrefix = match[1];
    const bracketedTag = match[2];
    const bareDirectiveTag = match[3];
    const emojiBgPrefix = match[4];
    const emojiStr = match[5];
    const ellipsisStr = match[6];

    if (bracketedTag) {
      const inner = bracketedTag.slice(1, -1);
      const matched = matchTagContent(inner, allowExperimentalBrowserTts);
      if (matched) {
        if (matchStart > lastIndex) {
          pushSpeech(input.slice(lastIndex, matchStart));
        }
        if (matched.kind === 'voice_switch') {
          activeVoiceOverride = matched.voicePreset;
          if (matched.resetToDefault) {
            activeTtsEngine = undefined;
            activeBrowserVoiceHint = null;
          } else {
            activeTtsEngine = allowExperimentalBrowserTts
              ? matched.ttsEngine
              : undefined;
            activeBrowserVoiceHint = allowExperimentalBrowserTts
              ? (matched.browserVoiceHint ?? null)
              : null;
          }
          tokens.push({
            id: `tok_${++tokenCounter}`,
            type: 'voice_switch',
            voicePreset: matched.voicePreset,
            rawTrigger: fullMatch.trim(),
            ttsEngine: activeTtsEngine,
            browserVoiceHint: activeBrowserVoiceHint,
          });
        } else if (matched.kind === 'effect') {
          activeVoiceEffect = matched.effect;
          tokens.push({
            id: `tok_${++tokenCounter}`,
            type: 'effect',
            effect: matched.effect,
            rawTrigger: fullMatch.trim(),
          });
        } else if (matched.kind === 'pause') {
          tokens.push({
            id: `tok_${++tokenCounter}`,
            type: 'pause',
            durationSec: matched.durationSec,
            rawTrigger: fullMatch.trim(),
          });
        } else if (matched.kind === 'bgm') {
          tokens.push({
            id: `tok_${++tokenCounter}`,
            type: 'bgm',
            sound: matched.sound,
            rawTrigger: fullMatch.trim(),
          });
        } else {
          tokens.push({
            id: `tok_${++tokenCounter}`,
            type: 'sfx',
            sound: matched.sound,
            rawTrigger: fullMatch.trim(),
            background: Boolean(tagBgPrefix) || matched.forceBg,
          });
        }
        lastIndex = matchStart + fullMatch.length;
      }
    } else if (bareDirectiveTag) {
      const matched = matchTagContent(
        bareDirectiveTag,
        allowExperimentalBrowserTts
      );
      if (matched && (matched.kind === 'effect' || matched.kind === 'voice_switch')) {
        if (matchStart > lastIndex) {
          pushSpeech(input.slice(lastIndex, matchStart));
        }
        if (matched.kind === 'voice_switch') {
          activeVoiceOverride = matched.voicePreset;
          if (matched.resetToDefault) {
            activeTtsEngine = undefined;
            activeBrowserVoiceHint = null;
          } else {
            activeTtsEngine = allowExperimentalBrowserTts
              ? matched.ttsEngine
              : undefined;
            activeBrowserVoiceHint = allowExperimentalBrowserTts
              ? (matched.browserVoiceHint ?? null)
              : null;
          }
          tokens.push({
            id: `tok_${++tokenCounter}`,
            type: 'voice_switch',
            voicePreset: matched.voicePreset,
            rawTrigger: fullMatch.trim(),
            ttsEngine: activeTtsEngine,
            browserVoiceHint: activeBrowserVoiceHint,
          });
        } else {
          activeVoiceEffect = matched.effect;
          tokens.push({
            id: `tok_${++tokenCounter}`,
            type: 'effect',
            effect: matched.effect,
            rawTrigger: fullMatch.trim(),
          });
        }
        lastIndex = matchStart + fullMatch.length;
      }
    } else if (emojiStr) {
      if (matchStart > lastIndex) {
        pushSpeech(input.slice(lastIndex, matchStart));
      }
      const sound = resolveEmojiToSound(emojiStr);
      if (sound.isBgm) {
        tokens.push({
          id: `tok_${++tokenCounter}`,
          type: 'bgm',
          sound,
          rawTrigger: fullMatch.trim(),
        });
      } else {
        tokens.push({
          id: `tok_${++tokenCounter}`,
          type: 'sfx',
          sound,
          rawTrigger: fullMatch.trim(),
          background: Boolean(emojiBgPrefix),
        });
      }
      lastIndex = matchStart + fullMatch.length;
    } else if (ellipsisStr) {
      if (matchStart > lastIndex) {
        pushSpeech(input.slice(lastIndex, matchStart));
      }
      const normalizedDots = ellipsisStr.replace(/…/g, '...');
      const groupCount = Math.max(1, Math.floor(normalizedDots.length / 3));
      const pauseDurationSec = Number(
        Math.min(2.6, groupCount * 0.65).toFixed(2)
      );
      tokens.push({
        id: `tok_${++tokenCounter}`,
        type: 'pause',
        durationSec: pauseDurationSec,
        rawTrigger: ellipsisStr,
      });
      lastIndex = matchStart + fullMatch.length;
    }
  }

  if (lastIndex < input.length) {
    pushSpeech(input.slice(lastIndex));
  }

  return tokens;
}
