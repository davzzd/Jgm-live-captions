/**
 * Caption segmenter for Soniox real-time tokens.
 *
 * Soniox protocol (https://soniox.com/docs/stt/rt/real-time-transcription):
 * - Final tokens (is_final: true) are sent exactly ONCE and never change.
 * - Non-final tokens are the full current hypothesis, re-sent on every message
 *   (they must REPLACE the previous non-final text, never be appended).
 * - With endpoint detection on, a final "<end>" token marks the end of an utterance.
 *   After a manual finalize, a final "<fin>" token is sent. Neither is caption text.
 * - With translation, "original" tokens arrive first and "translation" tokens follow
 *   chunk by chunk. Speech already in the target language may never be translated.
 *
 * This class turns that token stream into:
 * - Segments: complete caption lines for the transcript, audience page and YouTube.
 * - An overlay snapshot: the running text (committed + live partial) for captions.html.
 *
 * It has no timers of its own. The caller passes `now` into every method and calls
 * tick(now) periodically, which keeps it deterministic and easy to unit test.
 */

const CONTROL_TOKENS = new Set(['<end>', '<fin>']);

function isControlToken(token) {
  return !!token && CONTROL_TOKENS.has(token.text);
}

// Sentence-ending punctuation (Latin, Indic danda, CJK, Arabic, ellipsis),
// optionally followed by closing quotes/brackets and whitespace.
const SENTENCE_END_RE = /[.!?।॥。！？؟…]["'”’)\]]*\s*$/u;

function endsWithSentence(text) {
  return SENTENCE_END_RE.test(text || '');
}

/**
 * captions.log is a TSV file, so tabs and newlines must never reach it.
 */
function sanitizeCaptionText(text) {
  return String(text || '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Soniox tokens carry their own leading spaces, so they are joined without a separator.
function joinTokens(tokens) {
  return tokens.map(t => t.text || '').join('');
}

// Translation chunks sometimes arrive without a leading space ("Hello," + "My name").
// Insert one when the previous text ends in punctuation and the next starts with a letter/digit.
const NEEDS_SPACE_RE = /[,.;:!?\u0964\u0965]$/;
const STARTS_WORD_RE = /^[\p{L}\p{N}]/u;
function joinWithSpace(previous, next) {
  if (previous && next && NEEDS_SPACE_RE.test(previous) && STARTS_WORD_RE.test(next)) {
    return previous + ' ' + next;
  }
  return previous + next;
}

function tokenConfidence(token) {
  const c = token.confidence ?? token.conf ?? token.confidence_score;
  return typeof c === 'number' ? c : null;
}

function trimToLastWords(text, maxWords) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  return words.slice(words.length - maxWords).join(' ');
}

class CaptionSegmenter {
  constructor(options = {}) {
    this.mode = options.mode === 'transcribe' ? 'transcribe' : 'translate';
    this.targetLanguage = options.targetLanguage || null;
    this.passthroughByLanguage = options.passthroughByLanguage !== false;
    this.flushIdleMs = options.flushIdleMs ?? 2000;
    this.postEndIdleMs = options.postEndIdleMs ?? 800;
    this.originalWaitMs = options.originalWaitMs ?? 4000;
    this.maxChars = options.maxChars ?? 200;
    this.overlayMaxWords = options.overlayMaxWords ?? 400;
    this.pauseThresholdMs = options.pauseThresholdMs ?? 5000;

    // Text that becomes captions (translations, passthrough originals, or transcript).
    this.display = { finals: '', partial: '', lastFinalAt: 0, confidences: [], sources: new Set() };
    // Translate mode only: source-language finals waiting to see whether a translation arrives.
    this.pending = { finals: '', lastFinalAt: 0, confidences: [] };
    this.endSeen = false;
    this.endSeenAt = 0;
    this.lastTranslationFinalAt = 0;
    this.lastFallbackAt = 0;

    const prev = options.previousOverlay;
    this.overlay = {
      gen: prev ? prev.gen : 1,
      committed: prev ? prev.committed : '',
      lastActivityAt: prev ? prev.lastActivityAt : 0
    };
    this.lastOverlaySent = null;
  }

  /**
   * Decide where a (non-control) token goes: 'display', 'pending' or null (ignored).
   */
  _route(token) {
    if (this.mode === 'transcribe') return 'display';

    const status = token.translation_status;
    if (status === 'translation' || status === 'translated') return 'display';
    // Soniox marks speech it will not translate as 'none'.
    if (status === 'none') return 'display';
    // Speech already in the target language: show it as-is.
    if (this.passthroughByLanguage && token.language && this.targetLanguage &&
        token.language === this.targetLanguage) {
      return 'display';
    }
    return 'pending';
  }

  /**
   * Process one Soniox message's tokens. Returns emitted segments.
   */
  ingest(tokens, now) {
    if (!Array.isArray(tokens)) return [];

    let sawEnd = false;
    let translationFinal = false;
    const displayFinals = [];
    const displayNonFinals = [];
    const pendingFinals = [];

    for (const token of tokens) {
      if (!token) continue;
      if (isControlToken(token)) {
        if (token.text === '<end>') sawEnd = true;
        continue;
      }
      if (!token.text) continue;

      const bucket = this._route(token);
      const isTranslation = token.translation_status === 'translation' || token.translation_status === 'translated';
      if (bucket === 'display') {
        if (token.is_final) {
          displayFinals.push(token);
          this.display.sources.add(this.mode === 'transcribe' ? 'transcript' : (isTranslation ? 'translation' : 'passthrough'));
          if (isTranslation) translationFinal = true;
        } else {
          displayNonFinals.push(token);
        }
      } else if (bucket === 'pending' && token.is_final) {
        pendingFinals.push(token);
      }
    }

    // Overlay paragraph break: activity resuming after a long silence starts a new paragraph.
    if (displayFinals.length > 0 || displayNonFinals.length > 0) {
      if (this.overlay.lastActivityAt && now - this.overlay.lastActivityAt > this.pauseThresholdMs &&
          this.overlay.committed) {
        this.overlay.gen++;
        this.overlay.committed = '';
      }
      this.overlay.lastActivityAt = now;
    }

    if (translationFinal) {
      if (this.lastFallbackAt && now - this.lastFallbackAt < 2000) {
        this.lateTranslationAfterFallback = true;
      }
      this.lastTranslationFinalAt = now;
      // Soniox is translating this stretch, so the waiting originals are covered.
      this._clearPending();
    }

    if (displayFinals.length > 0) {
      this.display.finals = joinWithSpace(this.display.finals, joinTokens(displayFinals));
      this.display.lastFinalAt = now;
      for (const t of displayFinals) {
        const c = tokenConfidence(t);
        if (c !== null) this.display.confidences.push(c);
      }
    }
    // Non-final tokens are the full current hypothesis: always replace.
    this.display.partial = joinTokens(displayNonFinals);

    if (pendingFinals.length > 0) {
      this.pending.finals += joinTokens(pendingFinals);
      this.pending.lastFinalAt = now;
      for (const t of pendingFinals) {
        const c = tokenConfidence(t);
        if (c !== null) this.pending.confidences.push(c);
      }
    }

    if (sawEnd) {
      this.endSeen = true;
      this.endSeenAt = now;
    }

    const out = [];
    this._splitLong(now, out);
    if (this.display.finals.trim()) {
      if (endsWithSentence(this.display.finals)) {
        out.push(this._emitDisplay('punct'));
      } else if (sawEnd && this.mode === 'transcribe') {
        out.push(this._emitDisplay('end'));
      }
    }
    return out.filter(Boolean);
  }

  /**
   * Time-based emission. Call periodically (e.g. every 250 ms).
   */
  tick(now) {
    const out = [];

    if (this.display.finals.trim()) {
      const lastActivity = Math.max(this.endSeenAt, this.display.lastFinalAt);
      const idleSinceFinal = now - this.display.lastFinalAt;
      if (this.mode === 'translate' && this.endSeen && now - lastActivity > this.postEndIdleMs) {
        // Utterance ended and its translation has stopped arriving.
        out.push(this._emitDisplay('end'));
      } else if (idleSinceFinal > this.flushIdleMs &&
                 (!this.display.partial || idleSinceFinal > this.flushIdleMs * 2)) {
        // No new finals for a while (and the speaker is not mid-word).
        out.push(this._emitDisplay('idle'));
      }
    }

    if (this.mode === 'translate' && this.pending.finals.trim() &&
        now - this.pending.lastFinalAt > this.originalWaitMs &&
        now - this.lastTranslationFinalAt > this.originalWaitMs) {
      // No translation has arrived for this speech: show the original instead of dropping it.
      out.push(this._emitPending(now));
    }

    return out.filter(Boolean);
  }

  /**
   * Emit everything buffered (on stop, reconnect or shutdown). Display first, then pending.
   */
  flush(reason, now) {
    const out = [];
    if (this.display.finals.trim()) out.push(this._emitDisplay(reason || 'flush'));
    if (this.pending.finals.trim()) out.push(this._emitPending(now, reason || 'flush'));
    this.display.partial = '';
    return out.filter(Boolean);
  }

  resetOverlay(now) {
    this.overlay.gen++;
    this.overlay.committed = '';
    this.overlay.lastActivityAt = now || 0;
  }

  setPauseThreshold(ms) {
    const value = Number(ms);
    if (Number.isFinite(value) && value > 0) this.pauseThresholdMs = value;
  }

  overlaySnapshot() {
    const current = sanitizeCaptionText(this.display.finals);
    return {
      type: 'caption',
      gen: this.overlay.gen,
      text: [this.overlay.committed, current].filter(Boolean).join(' '),
      partial: sanitizeCaptionText(this.display.partial)
    };
  }

  /**
   * True if the overlay snapshot differs from the last time this returned true.
   */
  overlayChanged() {
    const json = JSON.stringify(this.overlaySnapshot());
    if (json === this.lastOverlaySent) return false;
    this.lastOverlaySent = json;
    return true;
  }

  /**
   * Returns and clears the "translation arrived right after a fallback" flag (possible duplicate).
   */
  takeLateTranslationWarning() {
    const flag = !!this.lateTranslationAfterFallback;
    this.lateTranslationAfterFallback = false;
    return flag;
  }

  // ----- internals -----

  _splitLong(now, out) {
    while (this.display.finals.length > this.maxChars) {
      const text = this.display.finals;
      let cut = text.lastIndexOf(' ', this.maxChars);
      if (cut <= 0) cut = text.length;
      const head = text.slice(0, cut);
      const rest = text.slice(cut);
      const sources = new Set(this.display.sources);
      this.display.finals = head;
      const seg = this._emitDisplay('length');
      if (seg) out.push(seg);
      this.display.finals = rest;
      this.display.sources = sources;
      if (rest.trim()) this.display.lastFinalAt = now;
    }
  }

  _emitDisplay(reason) {
    const text = sanitizeCaptionText(this.display.finals);
    const confidences = this.display.confidences;
    const sources = this.display.sources;
    this.display.finals = '';
    this.display.confidences = [];
    this.display.sources = new Set();
    this.endSeen = false;
    this.endSeenAt = 0;
    if (!text) return null;

    let source;
    if (this.mode === 'transcribe') source = 'transcript';
    else if (sources.has('translation')) source = 'translation';
    else source = 'passthrough';

    this._commitToOverlay(text);
    return { text, source, reason, avgConfidence: average(confidences) };
  }

  _emitPending(now, reason) {
    const text = sanitizeCaptionText(this.pending.finals);
    const confidences = this.pending.confidences;
    this._clearPending();
    if (!text) return null;
    this.lastFallbackAt = now || 0;
    this._commitToOverlay(text);
    return { text, source: 'original-fallback', reason: reason || 'no-translation', avgConfidence: average(confidences) };
  }

  _clearPending() {
    this.pending.finals = '';
    this.pending.confidences = [];
  }

  _commitToOverlay(text) {
    const joined = this.overlay.committed ? `${this.overlay.committed} ${text}` : text;
    this.overlay.committed = trimToLastWords(joined, this.overlayMaxWords);
  }
}

function average(values) {
  if (!values || values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

module.exports = {
  CaptionSegmenter,
  isControlToken,
  endsWithSentence,
  sanitizeCaptionText,
  joinTokens
};
