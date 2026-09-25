const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The processor lives inside client.html so the page can load it without serving another file.
const html = fs.readFileSync(path.join(__dirname, '..', 'client.html'), 'utf8');
const match = html.match(/<script id="pcmWorkletSource" type="text\/plain">([\s\S]*?)<\/script>/);
assert.ok(match, 'client.html must contain the pcmWorkletSource block');
const source = match[1];

function load(sampleRate) {
  const registered = {};
  class AudioWorkletProcessor {
    constructor() {
      this.port = {
        posted: [],
        onmessage: null,
        postMessage(msg, transfer) { this.posted.push({ msg, transfer: transfer || [] }); }
      };
    }
  }
  const PcmChunker = new Function(
    'AudioWorkletProcessor', 'registerProcessor', 'sampleRate',
    source + '\nreturn PcmChunker;'
  )(AudioWorkletProcessor, (name, cls) => { registered[name] = cls; }, sampleRate);
  return { PcmChunker, Processor: registered['pcm-chunker'] };
}

const block = (value, n = 128) => [[new Float32Array(n).fill(value)]];

test('worklet registers as pcm-chunker and chunks 128-frame blocks', () => {
  const { Processor } = load(16000);
  const p = new Processor({ processorOptions: { chunkSize: 256, targetRate: 16000 } });
  for (let i = 0; i < 5; i++) assert.equal(p.process(block(0.25)), true);
  // 5 x 128 = 640 samples -> two full chunks of 256, 128 left over
  assert.equal(p.port.posted.length, 2);
  for (const { msg, transfer } of p.port.posted) {
    assert.equal(msg.type, 'chunk');
    assert.equal(msg.buffer.byteLength, 512);
    assert.equal(transfer[0], msg.buffer, 'buffer must be transferred, not copied');
    const samples = new Int16Array(msg.buffer);
    assert.ok(samples.every(v => v === Math.trunc(0.25 * 0x7FFF)));
  }
  p.port.onmessage({ data: { type: 'flush' } });
  const flushed = p.port.posted[2];
  assert.equal(flushed.msg.type, 'flushed');
  assert.equal(flushed.msg.buffer.byteLength, 256);
  // Flushing again with nothing buffered reports null
  p.port.onmessage({ data: { type: 'flush' } });
  assert.equal(p.port.posted[3].msg.buffer, null);
});

test('samples are clamped and converted to 16-bit', () => {
  const { PcmChunker } = load(16000);
  const chunks = [];
  const c = new PcmChunker({ inRate: 16000, outRate: 16000, chunkSize: 6, onChunk: ch => chunks.push(Array.from(ch)) });
  c.push(Float32Array.from([2, -2, 0.5, 0, -1, 1]));
  assert.deepEqual(chunks, [[32767, -32768, 16383, 0, -32768, 32767]]);
});

test('empty input emits nothing and keeps the processor alive', () => {
  const { Processor } = load(16000);
  const p = new Processor({ processorOptions: { chunkSize: 128 } });
  assert.equal(p.process([]), true);
  assert.equal(p.process([[]]), true);
  assert.equal(p.process([[new Float32Array(0)]]), true);
  assert.equal(p.port.posted.length, 0);
});

test('defaults: 2048-sample chunks at 16 kHz when no options are given', () => {
  const { Processor } = load(16000);
  const p = new Processor();
  for (let i = 0; i < 16; i++) p.process(block(0.1));
  assert.equal(p.port.posted.length, 1);
  assert.equal(p.port.posted[0].msg.buffer.byteLength, 4096);
});

for (const inRate of [48000, 44100]) {
  test(`resamples ${inRate} Hz to 16 kHz with the right sample count`, () => {
    const { PcmChunker } = load(inRate);
    let out = 0;
    const c = new PcmChunker({ inRate, outRate: 16000, chunkSize: 1000, onChunk: ch => { out += ch.length; } });
    // One second of a 440 Hz sine in 128-sample blocks
    let t = 0;
    const blocks = Math.floor(inRate / 128);
    for (let b = 0; b < blocks; b++) {
      const buf = new Float32Array(128);
      for (let i = 0; i < 128; i++, t++) buf[i] = Math.sin(2 * Math.PI * 440 * t / inRate);
      c.push(buf);
    }
    const tail = c.flush();
    const total = out + (tail ? tail.length : 0);
    const expected = (blocks * 128) * 16000 / inRate;
    assert.ok(Math.abs(total - expected) <= 2, `got ${total}, expected ~${expected}`);
  });
}

test('resampling a constant signal has no seams at block edges', () => {
  const { PcmChunker } = load(48000);
  const values = [];
  const c = new PcmChunker({ inRate: 48000, outRate: 16000, chunkSize: 100, onChunk: ch => values.push(...ch) });
  for (let b = 0; b < 30; b++) c.push(new Float32Array(128).fill(0.5));
  assert.ok(values.length > 1000);
  assert.ok(values.every(v => v === 16383), 'every output sample must equal the input level');
});

test('resampling preserves a slow ramp (interpolation is continuous)', () => {
  const { PcmChunker } = load(32000);
  const values = [];
  const c = new PcmChunker({ inRate: 32000, outRate: 16000, chunkSize: 50, onChunk: ch => values.push(...ch) });
  let t = 0;
  for (let b = 0; b < 10; b++) {
    const buf = new Float32Array(128);
    for (let i = 0; i < 128; i++, t++) buf[i] = t / 2000; // 0 .. 0.64
    c.push(buf);
  }
  for (let i = 1; i < values.length; i++) {
    const step = values[i] - values[i - 1];
    assert.ok(step >= 0 && step <= 40, `unexpected jump of ${step} at ${i}`);
  }
});
