const test = require('node:test');
const assert = require('node:assert/strict');
const { CaptionQueue } = require('../caption-queue');

function makeQueue(opts = {}) {
  const sent = [];
  const expired = [];
  const q = new CaptionQueue({
    delayMs: 10000,
    editLeaseMs: 15000,
    onSend: (item, now) => sent.push({ id: item.id, text: item.text, at: now }),
    onEditExpired: item => expired.push(item.id),
    ...opts
  });
  const add = (id, now) => q.add({ id, text: `line ${id}`, createdAt: now }, now);
  return { q, sent, expired, add, ids: () => sent.map(s => s.id) };
}

test('auto mode sends immediately', () => {
  const { q, add, ids } = makeQueue();
  add('a', 0);
  add('b', 5);
  assert.deepEqual(ids(), ['a', 'b']);
  assert.equal(q.items.length, 0);
});

test('veto mode waits the delay, then sends by itself', () => {
  const { q, add, ids } = makeQueue({ mode: 'veto' });
  add('a', 0);
  q.process(9999);
  assert.deepEqual(ids(), []);
  q.process(10000);
  assert.deepEqual(ids(), ['a']);
});

test('reject removes a line so it is never sent', () => {
  const { q, add, ids } = makeQueue({ mode: 'veto' });
  add('a', 0);
  add('b', 1000);
  const r = q.reject('a', 2000);
  assert.equal(r.ok, true);
  assert.equal(r.item.text, 'line a');
  q.process(20000);
  assert.deepEqual(ids(), ['b']);
});

test('send now sends the line and the lines ahead of it, in order', () => {
  const { q, add, ids } = makeQueue({ mode: 'veto' });
  add('a', 0);
  add('b', 1000);
  add('c', 2000);
  assert.equal(q.sendNow('b', 3000).ok, true);
  assert.deepEqual(ids(), ['a', 'b']);
  q.process(11999);
  assert.deepEqual(ids(), ['a', 'b']);
  q.process(12000);
  assert.deepEqual(ids(), ['a', 'b', 'c']);
});

test('lines behind an edit keep their order and wait for it', () => {
  const { q, add, ids, sent } = makeQueue({ mode: 'veto' });
  add('a', 0);
  add('b', 1000);
  add('c', 2000);
  q.startEdit('a', 3000);
  q.process(12500); // b and c are due, but a is being edited
  assert.deepEqual(ids(), []);
  q.renewEdit('a', 12500);
  q.saveEdit('a', 'fixed a', 14000);
  assert.deepEqual(ids(), ['a', 'b', 'c']);
  assert.equal(sent[0].text, 'fixed a');
});

test('editing a later line lets earlier lines go on their own timers', () => {
  const { q, add, ids } = makeQueue({ mode: 'veto' });
  add('a', 0);
  add('b', 1000);
  add('c', 2000);
  q.startEdit('b', 3000);
  q.process(10000);
  assert.deepEqual(ids(), ['a']);
  q.process(12500);
  assert.deepEqual(ids(), ['a']); // c waits behind b
  q.saveEdit('b', 'fixed b', 13000);
  assert.deepEqual(ids(), ['a', 'b', 'c']);
});

test('saved edit waits for lines ahead that are still counting down', () => {
  const { q, add, ids } = makeQueue({ mode: 'veto' });
  add('a', 0);
  add('b', 1000);
  q.startEdit('b', 2000);
  q.saveEdit('b', 'fixed b', 3000);
  assert.deepEqual(ids(), []); // a still has 7s left; order is kept
  q.process(10000);
  assert.deepEqual(ids(), ['a', 'b']);
});

test('send now is refused while a line ahead is being edited', () => {
  const { q, add } = makeQueue({ mode: 'veto' });
  add('a', 0);
  add('b', 1000);
  q.startEdit('a', 2000);
  const r = q.sendNow('b', 3000);
  assert.equal(r.ok, false);
});

test('cancel edit resumes the countdown (sends at once if overdue)', () => {
  const { q, add, ids } = makeQueue({ mode: 'veto' });
  add('a', 0);
  q.startEdit('a', 1000);
  q.cancelEdit('a', 5000);
  assert.deepEqual(ids(), []);
  q.startEdit('a', 6000);
  q.cancelEdit('a', 11000);
  assert.deepEqual(ids(), ['a']);
});

test('an abandoned edit expires and the original line is sent', () => {
  const { q, add, ids, expired, sent } = makeQueue({ mode: 'veto' });
  add('a', 0);
  q.startEdit('a', 1000);
  q.process(15999);
  assert.deepEqual(ids(), []);
  q.process(16000); // lease (15s) ran out without renewal
  assert.deepEqual(expired, ['a']);
  assert.deepEqual(ids(), ['a']);
  assert.equal(sent[0].text, 'line a');
});

test('a second editor cannot take over a live edit', () => {
  const { q, add } = makeQueue({ mode: 'veto' });
  add('a', 0);
  assert.equal(q.startEdit('a', 1000).ok, true);
  assert.equal(q.startEdit('a', 2000).ok, false);
});

test('rejecting a line that is being edited frees the lines behind it', () => {
  const { q, add, ids } = makeQueue({ mode: 'veto' });
  add('a', 0);
  add('b', 1000);
  q.startEdit('a', 2000);
  q.process(12000);
  assert.deepEqual(ids(), []);
  q.reject('a', 12000);
  assert.deepEqual(ids(), ['b']);
});

test('switching to auto sends everything waiting, in order', () => {
  const { q, add, ids } = makeQueue({ mode: 'veto' });
  add('a', 0);
  add('b', 1000);
  q.setMode('auto', 2000);
  assert.deepEqual(ids(), ['a', 'b']);
});

test('switching to auto still waits behind a line being edited', () => {
  const { q, add, ids } = makeQueue({ mode: 'veto' });
  add('a', 0);
  add('b', 1000);
  q.startEdit('a', 1500);
  q.setMode('auto', 2000);
  add('c', 2500); // auto-mode line must not jump ahead
  assert.deepEqual(ids(), []);
  q.saveEdit('a', 'fixed a', 3000);
  assert.deepEqual(ids(), ['a', 'b', 'c']);
});

test('switching to veto only delays new lines', () => {
  const { q, add, ids } = makeQueue();
  add('a', 0);
  q.setMode('veto', 1000);
  add('b', 1000);
  assert.deepEqual(ids(), ['a']);
  q.process(11000);
  assert.deepEqual(ids(), ['a', 'b']);
});

test('restore + flushAll sends saved lines after a restart', () => {
  const first = makeQueue({ mode: 'veto' });
  first.add('a', 0);
  first.add('b', 1000);
  const saved = first.q.serialize();
  const second = makeQueue();
  second.q.restore(saved, 50000);
  second.q.flushAll(50000);
  assert.deepEqual(second.ids(), ['a', 'b']);
});

test('clear empties the queue without sending', () => {
  const { q, add, ids } = makeQueue({ mode: 'veto' });
  add('a', 0);
  q.clear();
  q.process(20000);
  assert.deepEqual(ids(), []);
});

test('snapshot exposes countdown and edit state', () => {
  const { q, add } = makeQueue({ mode: 'veto' });
  add('a', 0);
  q.startEdit('a', 500);
  const snap = q.snapshot(600);
  assert.equal(snap.mode, 'veto');
  assert.equal(snap.serverNow, 600);
  assert.equal(snap.items[0].dueAt, 10000);
  assert.equal(snap.items[0].editing, true);
});
