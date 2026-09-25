const test = require('node:test');
const assert = require('node:assert/strict');
const { Corrections } = require('../corrections');

test('whole-word, case-insensitive replacement', () => {
  const c = new Corrections();
  assert.equal(c.add('Devan', 'David').ok, true);
  assert.equal(c.apply('My name is Devan, and devan is here.'), 'My name is David, and David is here.');
  assert.equal(c.apply('Devanand is not touched'), 'Devanand is not touched');
});

test('casing follows what was heard when the right word is lower-case', () => {
  const c = new Corrections();
  c.add('sheekinah', 'shekinah');
  assert.equal(c.apply('Sheekinah glory. SHEEKINAH! sheekinah.'), 'Shekinah glory. SHEKINAH! shekinah.');
});

test('an explicitly capitalised right word is used as typed', () => {
  const c = new Corrections();
  c.add('yeshuah', 'Yeshua');
  assert.equal(c.apply('we call him yeshuah'), 'we call him Yeshua');
});

test('multi-word entries and longest match first', () => {
  const c = new Corrections();
  c.add('Thoma', 'Thomas');
  c.add('Mar Thoma', 'Mar Thoma Church');
  assert.equal(c.apply('The Mar  Thoma people and Thoma.'), 'The Mar Thoma Church people and Thomas.');
});

test('Unicode words (Malayalam) are matched as whole words', () => {
  const c = new Corrections();
  c.add('ദൈവം', 'ദൈവം (God)');
  assert.equal(c.apply('ദൈവം സ്നേഹമാണ്'), 'ദൈവം (God) സ്നേഹമാണ്');
});

test('regex characters in entries are treated literally', () => {
  const c = new Corrections();
  c.add('a.b', 'ab');
  assert.equal(c.apply('a.b but not axb'), 'ab but not axb');
});

test('adding the same wrong word again updates the right word', () => {
  const c = new Corrections();
  c.add('Devan', 'David');
  c.add('devan', 'Davey');
  assert.equal(c.list().length, 1);
  assert.equal(c.apply('Devan'), 'Davey');
});

test('remove and clear', () => {
  const c = new Corrections();
  const { entry } = c.add('Devan', 'David');
  c.add('Thoma', 'Thomas');
  assert.equal(c.remove(entry.id), true);
  assert.equal(c.apply('Devan and Thoma'), 'Devan and Thomas');
  c.clear();
  assert.equal(c.apply('Devan and Thoma'), 'Devan and Thoma');
  assert.equal(c.remove(999), false);
});

test('validation', () => {
  const c = new Corrections();
  assert.equal(c.add('', 'x').ok, false);
  assert.equal(c.add('x', '').ok, false);
  assert.equal(c.add('same', 'Same').ok, false);
  assert.equal(c.add('a'.repeat(81), 'b').ok, false);
  assert.equal(c.apply(''), '');
  assert.equal(c.apply(null), null);
});
