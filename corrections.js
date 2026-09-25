/**
 * Session corrections: "wrong → right" replacements the operator adds during a service.
 *
 * Soniox has no way to take feedback mid-stream, so recurring mistakes (a Hebrew word it
 * keeps mishearing, a name it spells wrong) are fixed here, on every caption line before it
 * goes to phones, YouTube and the transcript.
 *
 * Matching is whole-word, case-insensitive and Unicode-aware, so "Devan" → "David" doesn't
 * touch "Devanand". Longer entries are tried first so "Mar Thoma" beats "Thoma".
 */

class Corrections {
  constructor() {
    this.entries = [];
    this.nextId = 1;
    this.regex = null;
    this.byKey = new Map();
  }

  list() {
    return this.entries.map(e => ({ id: e.id, wrong: e.wrong, right: e.right, createdAt: e.createdAt }));
  }

  /**
   * Add or update an entry. Returns { ok, entry } or { ok: false, error }.
   */
  add(wrong, right, now = Date.now()) {
    wrong = String(wrong || '').replace(/\s+/g, ' ').trim();
    right = String(right || '').replace(/\s+/g, ' ').trim();
    if (!wrong) return { ok: false, error: 'Enter the word Soniox got wrong' };
    if (!right) return { ok: false, error: 'Enter the correct word' };
    if (wrong.length > 80 || right.length > 80) return { ok: false, error: 'Keep entries under 80 characters' };
    if (wrong.toLowerCase() === right.toLowerCase()) return { ok: false, error: 'Wrong and right are the same' };

    const key = wrong.toLowerCase();
    let entry = this.byKey.get(key);
    if (entry) {
      entry.right = right;
      entry.wrong = wrong;
    } else {
      entry = { id: this.nextId++, wrong, right, createdAt: now };
      this.entries.push(entry);
      this.byKey.set(key, entry);
    }
    this.rebuild();
    return { ok: true, entry: { ...entry } };
  }

  remove(id) {
    const index = this.entries.findIndex(e => e.id === Number(id));
    if (index < 0) return false;
    const [entry] = this.entries.splice(index, 1);
    this.byKey.delete(entry.wrong.toLowerCase());
    this.rebuild();
    return true;
  }

  clear() {
    this.entries = [];
    this.byKey.clear();
    this.rebuild();
  }

  rebuild() {
    if (this.entries.length === 0) {
      this.regex = null;
      return;
    }
    const alternatives = this.entries
      .slice()
      .sort((a, b) => b.wrong.length - a.wrong.length)
      .map(e => escapeRegex(e.wrong).replace(/ /g, '\\s+'))
      .join('|');
    // Whole "word": not preceded or followed by a letter or digit
    this.regex = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, 'giu');
  }

  /**
   * Apply all entries to a line. Returns the (possibly unchanged) text.
   */
  apply(text) {
    if (!this.regex || !text) return text;
    return String(text).replace(this.regex, (match) => {
      const entry = this.byKey.get(match.replace(/\s+/g, ' ').toLowerCase());
      if (!entry) return match;
      return matchCase(match, entry.right);
    });
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Keep the casing pattern of what was heard when the replacement is a plain lower-case word:
 * "devan" → "david", "Devan" → "David", "DEVAN" → "DAVID". If the operator typed the right word
 * with its own capitals (e.g. "Yeshua", "Mar Thoma"), use exactly that.
 */
function matchCase(heard, right) {
  if (right !== right.toLowerCase()) return right;
  if (heard === heard.toUpperCase() && heard !== heard.toLowerCase()) return right.toUpperCase();
  if (heard[0] === heard[0].toUpperCase() && heard[0] !== heard[0].toLowerCase()) {
    return right[0].toUpperCase() + right.slice(1);
  }
  return right;
}

module.exports = { Corrections };
