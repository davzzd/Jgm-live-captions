const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CaptionSegmenter,
  endsWithSentence,
  sanitizeCaptionText,
  isControlToken
} = require('../segmenter');

function tok(text, { final = false, status, lang } = {}) {
  const t = { text, is_final: final };
  if (status) t.translation_status = status;
  if (lang) t.language = lang;
  return t;
}
const orig = (text, final = false, lang) => tok(text, { final, status: 'original', lang });
const tr = (text, final = false) => tok(text, { final, status: 'translation' });

function translator(opts = {}) {
  return new CaptionSegmenter({ mode: 'translate', targetLanguage: 'en', ...opts });
}
function transcriber(opts = {}) {
  return new CaptionSegmenter({ mode: 'transcribe', targetLanguage: 'ml', ...opts });
}

// ----- helpers -----

test('endsWithSentence handles Latin, danda and trailing quotes', () => {
  assert.equal(endsWithSentence('He is risen.'), true);
  assert.equal(endsWithSentence('Is He risen?'), true);
  assert.equal(endsWithSentence('Amen!'), true);
  assert.equal(endsWithSentence('അവൻ ഉയിർത്തെഴുന്നേറ്റു।'), true);
  assert.equal(endsWithSentence('He said, "Follow me."'), true);
  assert.equal(endsWithSentence('He is risen. '), true);
  assert.equal(endsWithSentence('He is'), false);
  assert.equal(endsWithSentence(''), false);
});

test('sanitizeCaptionText strips tabs and newlines', () => {
  assert.equal(sanitizeCaptionText('a\tb\nc\r\nd'), 'a b c d');
  assert.equal(sanitizeCaptionText('  a   b  '), 'a b');
  assert.equal(sanitizeCaptionText(null), '');
});

test('isControlToken recognises <end> and <fin> only', () => {
  assert.equal(isControlToken({ text: '<end>' }), true);
  assert.equal(isControlToken({ text: '<fin>' }), true);
  assert.equal(isControlToken({ text: 'end' }), false);
});

// ----- bug 1: finals mixed with non-finals must not be lost -----

test('translate: finals arriving alongside non-finals are accumulated, not dropped', () => {
  const s = translator();
  let out = s.ingest([tr('The Lord', true), tr(' is', true), tr(' good and')], 0);
  assert.deepEqual(out, []);
  out = s.ingest([tr(' good', true), tr(' and his mercy')], 100);
  assert.deepEqual(out, []);
  out = s.ingest([tr(' and his mercy endures.', true)], 200);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'The Lord is good and his mercy endures.');
  assert.equal(out[0].source, 'translation');
  assert.equal(out[0].reason, 'punct');
});

test('transcribe: finals + non-finals in one message accumulate until punctuation', () => {
  const s = transcriber();
  assert.deepEqual(s.ingest([tok('Hello', { final: true }), tok(' every')], 0), []);
  const out = s.ingest([tok(' everyone.', { final: true })], 50);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Hello everyone.');
  assert.equal(out[0].source, 'transcript');
});

test('non-final partial is replaced each message and cleared when absent', () => {
  const s = transcriber();
  s.ingest([tok('How\'re')], 0);
  assert.equal(s.overlaySnapshot().partial, 'How\'re');
  s.ingest([tok('How are'), tok(' you')], 10);
  assert.equal(s.overlaySnapshot().partial, 'How are you');
  s.ingest([tok('How', { final: true }), tok(' are', { final: true })], 20);
  assert.equal(s.overlaySnapshot().partial, '');
  assert.equal(s.overlaySnapshot().text, 'How are');
});

// ----- control tokens and endpointing -----

test('<end> and <fin> never appear in segments or overlay', () => {
  const s = transcriber();
  const out = s.ingest([tok('Praise the Lord', { final: true }), tok('<end>', { final: true })], 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Praise the Lord');
  assert.equal(out[0].reason, 'end');
  s.ingest([tok('<fin>', { final: true })], 10);
  assert.ok(!s.overlaySnapshot().text.includes('<'));
});

test('translate: <end> does not emit immediately, only after translation goes quiet', () => {
  const s = translator({ postEndIdleMs: 800 });
  s.ingest([orig(' ദൈവം', true), orig('<end>', true)], 0);
  s.ingest([tr('God', true)], 300);
  assert.deepEqual(s.tick(900), []); // 600ms since last final
  s.ingest([tr(' is love', true)], 900);
  assert.deepEqual(s.tick(1500), []);
  const out = s.tick(1701);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'God is love');
  assert.equal(out[0].reason, 'end');
});

// ----- time and length based emission -----

test('idle flush fires after flushIdleMs, not before', () => {
  const s = transcriber({ flushIdleMs: 2000 });
  s.ingest([tok('Grace upon grace', { final: true })], 0);
  assert.deepEqual(s.tick(1999), []);
  const out = s.tick(2001);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, 'idle');
});

test('idle flush waits while a partial is still in progress (up to 2x)', () => {
  const s = transcriber({ flushIdleMs: 2000 });
  s.ingest([tok('Grace upon', { final: true }), tok(' gra')], 0);
  assert.deepEqual(s.tick(2500), []);
  assert.equal(s.tick(4001).length, 1);
});

test('long run-on text is split at a word boundary', () => {
  const s = transcriber({ maxChars: 20 });
  const out = s.ingest([tok('one two three four five six seven', { final: true })], 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, 'length');
  assert.ok(out[0].text.length <= 20);
  assert.equal(out[0].text, 'one two three four');
  const rest = s.flush('flush', 10);
  assert.equal(rest[0].text, 'five six seven');
});

// ----- bug 2: speech already in the target language -----

test("translate: translation_status 'none' passes through", () => {
  const s = translator();
  const out = s.ingest([tok('Welcome everyone.', { final: true, status: 'none' })], 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Welcome everyone.');
  assert.equal(out[0].source, 'passthrough');
});

test("translate: 'original' tokens in the target language pass through via language ID", () => {
  const s = translator();
  const out = s.ingest([orig('Open your Bibles.', true, 'en')], 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'passthrough');
});

test("translate: 'original' tokens in the source language wait for translation", () => {
  const s = translator();
  assert.deepEqual(s.ingest([orig('ദൈവം സ്നേഹമാണ്.', true, 'ml')], 0), []);
  assert.equal(s.overlaySnapshot().text, '');
});

test('translate: passthroughByLanguage=false keeps target-language originals pending', () => {
  const s = translator({ passthroughByLanguage: false });
  assert.deepEqual(s.ingest([orig('Open your Bibles.', true, 'en')], 0), []);
});

test('translate: pending originals fall back when no translation arrives', () => {
  const s = translator({ originalWaitMs: 3000 });
  s.ingest([orig('ഹല്ലേലൂയാ', true, 'ml')], 0);
  assert.deepEqual(s.tick(2999), []);
  const out = s.tick(3001);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'ഹല്ലേലൂയാ');
  assert.equal(out[0].source, 'original-fallback');
});

test('translate: a translation final covers pending originals (no duplicate)', () => {
  const s = translator({ originalWaitMs: 3000 });
  s.ingest([orig('ദൈവം', true, 'ml')], 0);
  s.ingest([tr('God', true)], 500);
  const out = s.tick(5000);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'God');
  assert.equal(out[0].source, 'translation');
});

test('translate: late translation right after a fallback is flagged', () => {
  const s = translator({ originalWaitMs: 3000 });
  s.ingest([orig('ദൈവം', true, 'ml')], 0);
  s.tick(3001);
  s.ingest([tr('God', true)], 3500);
  assert.equal(s.takeLateTranslationWarning(), true);
  assert.equal(s.takeLateTranslationWarning(), false);
});

// ----- flush -----

test('flush emits display then pending and leaves buffers empty', () => {
  const s = translator();
  s.ingest([tr('We give thanks', true), orig(' നന്ദി', true, 'ml'), tr(' and')], 0);
  // Originals after a translation final belong to the next stretch, so they stay pending.
  const out = s.flush('end', 100);
  assert.deepEqual(out.map(o => o.text), ['We give thanks', 'നന്ദി']);
  assert.deepEqual(out.map(o => o.source), ['translation', 'original-fallback']);
  s.ingest([orig(' ആമേൻ', true, 'ml')], 200);
  const out2 = s.flush('end', 300);
  assert.deepEqual(out2.map(o => o.source), ['original-fallback']);
  assert.deepEqual(s.flush('end', 400), []);
  assert.equal(s.overlaySnapshot().partial, '');
});

// ----- overlay -----

test('overlay text is committed + current finals, and gen bumps after a long pause', () => {
  const s = transcriber({ pauseThresholdMs: 5000 });
  s.ingest([tok('First sentence.', { final: true })], 0);
  s.ingest([tok('Second', { final: true })], 1000);
  let snap = s.overlaySnapshot();
  assert.equal(snap.text, 'First sentence. Second');
  const gen = snap.gen;
  s.flush('flush', 1500);
  s.ingest([tok('After pause', { final: true })], 7000);
  snap = s.overlaySnapshot();
  assert.equal(snap.gen, gen + 1);
  assert.equal(snap.text, 'After pause');
});

test('overlay committed text is front-trimmed to overlayMaxWords', () => {
  const s = transcriber({ overlayMaxWords: 3 });
  s.ingest([tok('one two.', { final: true })], 0);
  s.ingest([tok('three four.', { final: true })], 10);
  assert.equal(s.overlaySnapshot().text, 'two. three four.');
});

test('overlayChanged only reports real changes', () => {
  const s = transcriber();
  assert.equal(s.overlayChanged(), true);
  assert.equal(s.overlayChanged(), false);
  s.ingest([tok('Hi')], 0);
  assert.equal(s.overlayChanged(), true);
  s.ingest([tok('Hi')], 10);
  assert.equal(s.overlayChanged(), false);
});

test('resetOverlay starts a new paragraph; previousOverlay carries across sessions', () => {
  const s = transcriber();
  s.ingest([tok('Kept.', { final: true })], 0);
  const carried = new CaptionSegmenter({ mode: 'transcribe', previousOverlay: s.overlay });
  assert.equal(carried.overlaySnapshot().text, 'Kept.');
  s.resetOverlay(10);
  assert.equal(s.overlaySnapshot().text, '');
});


test('a space is inserted when a chunk follows punctuation without one', () => {
  const s = translator();
  assert.deepEqual(s.ingest([tr('Hello,', true)], 0), []);
  const out = s.ingest([tr('My name is David.', true)], 100); // ends a sentence: emitted now
  assert.equal(out[0].text, 'Hello, My name is David.');
  // Normal Soniox tokens carry their own leading space and must not get a second one
  s.ingest([tr('Amen', true)], 300);
  s.ingest([tr(' Hallelujah.', true)], 400);
  assert.equal(s.flush('end', 500).length, 0);
  const s2 = translator();
  s2.ingest([tr('Amen,', true)], 0);
  s2.ingest([tr(' Hallelujah', true)], 100);
  assert.equal(s2.flush('end', 200)[0].text, 'Amen, Hallelujah');
});
