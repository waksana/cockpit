import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { speechSocketRoute, syntheticSpeechAdapter } from './next-lab-speech';
import { moduleLabFetch } from './next-lab-module-transport';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const page = 'http://127.0.0.1:5187/chat-lab.html?ui=next&modules=1';
const socketUrl = 'wss://cockpit-synthetic-only.openai.azure.com/openai/v1/realtime?intent=transcription&Authorization=Bearer+synthetic-only-no-credentials';

function fixture(t: TestContext, options: { resume?: Promise<void>; closeFails?: boolean } = {}) {
  const sources: { trackStops: number; toneStops: number; contextsClosed: number; live: boolean }[] = [];
  const adapter = syntheticSpeechAdapter(() => {
    const source = { trackStops: 0, toneStops: 0, contextsClosed: 0, live: true };
    sources.push(source);
    const track = { stop() { if (source.live) { source.live = false; source.trackStops++; } } };
    const stream = { getTracks: () => [track] };
    return {
      stream,
      resume: () => options.resume ?? Promise.resolve(),
      stop() { source.toneStops++; },
      async close() { source.contextsClosed++; if (options.closeFails) throw new Error('Synthetic close failure'); },
    };
  });
  t.after(() => adapter.controls.dispose());
  return { ...adapter, sources };
}

function update(prompt = 'Reference vocabulary:\nSynthetic context') {
  return { type: 'session.update', session: { type: 'transcription', audio: { input: {
    format: { type: 'audio/pcm', rate: 24_000 }, transcription: { model: 'gpt-transcribe', prompt },
    turn_detection: { type: 'server_vad', silence_duration_ms: 1000 },
  } } } };
}
function event(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return { ...value };
  throw new Error('Invalid synthetic event');
}

test('routing permits only the designated synthetic provider and exact loopback HMR endpoint', () => {
  assert.equal(speechSocketRoute(page, socketUrl, ['realtime']), 'synthetic');
  assert.equal(speechSocketRoute(page, 'ws://127.0.0.1:5187/?token=fixture-token', 'vite-hmr'), 'hmr');
  assert.equal(speechSocketRoute('https://localhost:5187/chat-lab.html', 'wss://localhost:5187/?token=fixture-token', ['vite-hmr']), 'hmr');
  assert.equal(speechSocketRoute('http://[::1]:5187/chat-lab.html', 'ws://[::1]:5187/?token=fixture-token', 'vite-hmr'), 'hmr');
  for (const [url, protocols] of [
    [socketUrl, 'vite-hmr'],
    [socketUrl, 'realtime,extra'],
    [socketUrl.replace('synthetic-only-no-credentials', 'wrong'), 'realtime'],
    [socketUrl.replace('cockpit-synthetic-only', 'real-resource'), 'realtime'],
    [socketUrl + '&extra=value', 'realtime'],
    [socketUrl + '&intent=transcription', 'realtime'],
    [socketUrl + '#fragment', 'realtime'],
    [socketUrl.replace('wss://', 'wss://user:pass@'), 'realtime'],
    ['ws://127.0.0.1:5187/?token=fixture-token', 'realtime'],
    ['ws://localhost:5187/?token=fixture-token', 'vite-hmr'],
    ['ws://127.0.0.1:5188/?token=fixture-token', 'vite-hmr'],
    ['wss://127.0.0.1:5187/?token=fixture-token', 'vite-hmr'],
    ['ws://127.0.0.1:5187/other?token=fixture-token', 'vite-hmr'],
    ['ws://127.0.0.1:5187/', 'vite-hmr'],
    ['ws://127.0.0.1:5187/?token=', 'vite-hmr'],
    ['ws://127.0.0.1:5187/?token=fixture-token&token=other', 'vite-hmr'],
    ['ws://127.0.0.1:5187/?token=fixture-token&extra=1', 'vite-hmr'],
    ['wss://external.invalid/?token=fixture-token', 'vite-hmr'],
  ]) assert.throws(() => speechSocketRoute(page, url, protocols), /blocked/);
  assert.throws(() => speechSocketRoute('https://production.invalid/chat-lab.html', socketUrl, 'realtime'), /loopback/);
  assert.throws(() => speechSocketRoute('file:///chat-lab.html', socketUrl, 'realtime'), /loopback/);
});

test('session routing is local, bounded, no-store and explicitly fail-once for manual retry', async t => {
  const f = fixture(t);
  let network = 0;
  const fetcher = moduleLabFetch(async () => { network++; throw new Error('No network expected'); }, page, () => f.controls.sessionResponse());
  const url = `/_modules/cockpit-speech/${'a'.repeat(64)}/api/session`;
  f.controls.failNextSession();
  const failure = await fetcher(url, { method: 'POST', body: '{}' });
  assert.equal(failure.status, 503);
  assert.equal(failure.headers.get('cache-control'), 'no-store');
  assert.equal(event(event(await failure.json()).error).code, 'SYNTHETIC_SESSION_FAILED');
  const success = await fetcher(url, { method: 'POST', body: '{}' });
  const session = event(await success.json());
  assert.equal(session.deployment, 'gpt-transcribe');
  assert.equal(session.socketUrl, 'wss://cockpit-synthetic-only.openai.azure.com/openai/v1/realtime?intent=transcription');
  assert.equal(session.clientSecret, 'synthetic-only-no-credentials');
  assert.ok(typeof session.expiresAt === 'number' && session.expiresAt * 1000 > Date.now());
  assert.equal(success.headers.get('cache-control'), 'no-store');
  await assert.rejects(fetcher(url), /blocked/);
  await assert.rejects(fetcher('/intent/prompt', { method: 'POST' }), /blocked/);
  assert.equal(network, 0);
  assert.equal(f.controls.microphoneRequests, 0);
  assert.equal(f.controls.socketCount, 0);
});

test('real Speech protocol gets exact config echo, ordered deltas, input drain and held canonical final', async t => {
  const f = fixture(t);
  f.controls.transcript('Synthetic 😺 transcript');
  f.controls.holdFinal();
  const socket = f.socket(socketUrl);
  const messages: Record<string, unknown>[] = [];
  let opens = 0, closes = 0, listenerMessages = 0;
  socket.onopen = () => { opens++; };
  socket.onclose = () => { closes++; };
  socket.onmessage = value => { messages.push(event(JSON.parse(value.data))); };
  socket.addEventListener('message', () => { listenerMessages++; });
  assert.throws(() => socket.send(JSON.stringify(update())), /not open/);
  await turn();
  assert.equal(opens, 1);
  socket.send(JSON.stringify(update()));
  socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(4800).toString('base64') }));
  socket.send(JSON.stringify({ type: 'input_audio_buffer.commit', event_id: 'speech-final-commit' }));
  socket.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
  await turn();
  assert.deepEqual(messages.map(message => message.type), [
    'session.updated', 'input_audio_buffer.committed',
    'conversation.item.input_audio_transcription.delta', 'conversation.item.input_audio_transcription.delta',
    'input_audio_buffer.cleared',
  ]);
  assert.deepEqual(messages[0].session, update().session);
  assert.equal(messages[1].previous_item_id, null);
  assert.equal(messages.slice(2, 4).map(message => message.delta).join(''), 'Synthetic 😺 transcript');
  assert.equal(messages[2].item_id, messages[1].item_id);
  assert.equal(messages[2].content_index, 0);
  assert.equal(f.controls.pendingFinals, 1);
  assert.equal(f.controls.receivedBytes, 4800);
  assert.equal(f.controls.activeSockets, 1);
  f.controls.transcript('Only the next attempt adopts this');
  f.controls.releaseFinal(); f.controls.releaseFinal();
  await turn();
  assert.equal(messages.at(-1)?.type, 'conversation.item.input_audio_transcription.completed');
  assert.equal(messages.at(-1)?.transcript, 'Synthetic 😺 transcript');
  assert.equal(f.controls.pendingFinals, 0);
  assert.equal(listenerMessages, messages.length);
  socket.close(); socket.close(); await turn();
  assert.equal(closes, 1);
  assert.equal(f.controls.activeSockets, 0);
  assert.throws(() => socket.send('{}'), /not open/);
  assert.ok(!f.controls.diagnostics.join(' ').includes('Synthetic 😺'));
  assert.ok(!f.controls.diagnostics.join(' ').includes('Reference vocabulary'));
});

test('empty audio is correlated to final commit, while empty recognition still has a valid final item', async t => {
  const f = fixture(t);
  for (const hasAudio of [false, true]) {
    f.controls.transcript('');
    const socket = f.socket(socketUrl);
    const messages: Record<string, unknown>[] = [];
    socket.onmessage = value => { messages.push(event(JSON.parse(value.data))); };
    await turn();
    socket.send(JSON.stringify(update('')));
    if (hasAudio) socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(4800).toString('base64') }));
    socket.send(JSON.stringify({ type: 'input_audio_buffer.commit', event_id: 'speech-final-commit' }));
    socket.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
    await turn();
    if (hasAudio) {
      assert.equal(messages.at(-1)?.type, 'conversation.item.input_audio_transcription.completed');
      assert.equal(messages.at(-1)?.transcript, '');
    } else {
      assert.deepEqual(messages[1], { type: 'error', error: { code: 'input_audio_buffer_commit_empty', event_id: 'speech-final-commit' } });
      assert.equal(messages.at(-1)?.type, 'input_audio_buffer.cleared');
    }
    socket.close();
  }
});

test('malformed configuration, PCM, sequence and unsupported provider frames fail explicitly', async t => {
  const f = fixture(t);
  const socket = f.socket(socketUrl);
  await turn();
  assert.throws(() => socket.send(new Uint8Array(2)), /JSON/);
  assert.throws(() => socket.send('x'.repeat(32769)), /bounded/);
  assert.throws(() => socket.send('bad JSON'), SyntaxError);
  assert.throws(() => socket.send('[]'), /protocol object/);
  assert.throws(() => socket.send('{"type":"input_audio_buffer.clear"}'), /out of order/);
  const wrong = update(); wrong.session.audio.input.turn_detection.silence_duration_ms = 500;
  assert.throws(() => socket.send(JSON.stringify(wrong)), /configuration/);
  wrong.session.audio.input.turn_detection.silence_duration_ms = 1000;
  wrong.session.audio.input.transcription.model = 'wrong';
  assert.throws(() => socket.send(JSON.stringify(wrong)), /configuration/);
  socket.send(JSON.stringify(update()));
  assert.throws(() => socket.send(JSON.stringify(update())), /session update/);
  for (const audio of ['', '@@@@', 'AA==', 'A'.repeat(6404)]) {
    assert.throws(() => socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio })), /PCM/);
  }
  assert.throws(() => socket.send('{"type":"input_audio_buffer.clear"}'), /requires/);
  assert.throws(() => socket.send('{"type":"input_audio_buffer.commit","event_id":"wrong"}'), /commit/);
  assert.throws(() => socket.send('{"type":"unsupported"}'), /Unsupported/);
  socket.close();
  assert.throws(() => f.socket('wss://external.invalid/'), /blocked/);
});

test('each retry socket starts fresh; closing held work and disposal suppress queued late results', async t => {
  const f = fixture(t);
  f.controls.holdFinal();
  const ids: unknown[] = [];
  let finals = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const socket = f.socket(socketUrl);
    socket.onmessage = value => {
      const message = event(JSON.parse(value.data));
      if (message.type === 'input_audio_buffer.committed') ids.push(message.item_id);
      if (message.type === 'conversation.item.input_audio_transcription.completed') finals++;
    };
    await turn();
    socket.send(JSON.stringify(update()));
    socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(4800).toString('base64') }));
    socket.send(JSON.stringify({ type: 'input_audio_buffer.commit', event_id: 'speech-final-commit' }));
    socket.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
    await turn();
    assert.equal(f.controls.pendingFinals, 1);
    if (!attempt) socket.close();
    else { f.controls.releaseFinal(); await f.controls.dispose(); }
  }
  await turn();
  assert.equal(finals, 0);
  assert.equal(new Set(ids).size, 2);
  assert.equal(f.controls.socketCount, 2);
  assert.equal(f.controls.receivedBytes, 9600);
  assert.equal(f.controls.activeSockets, 0);
  assert.equal(f.controls.pendingFinals, 0);
  assert.throws(() => f.controls.sessionResponse(), /disposed/);
  assert.throws(() => f.socket(socketUrl), /disposed/);
  await assert.rejects(f.microphone({ audio: true }), /disposed/);
});

test('generated tracks stop their tone/context without using a real microphone; dispose releases every source', async t => {
  const f = fixture(t);
  await assert.rejects(f.microphone({ audio: false }), /audio-only/);
  await assert.rejects(f.microphone({ audio: true, video: true }), /audio-only/);
  assert.equal(f.controls.microphoneRequests, 0);
  const first = await f.microphone({ audio: { channelCount: 1 }, video: false });
  await f.microphone({ audio: true });
  assert.equal(f.controls.microphoneRequests, 2);
  assert.equal(f.controls.activeMicrophones, 2);
  first.getTracks()[0].stop();
  assert.equal(f.controls.activeMicrophones, 1);
  await f.controls.dispose();
  assert.deepEqual(f.sources, [
    { live: false, trackStops: 1, toneStops: 1, contextsClosed: 1 },
    { live: false, trackStops: 1, toneStops: 1, contextsClosed: 1 },
  ]);
  first.getTracks()[0].stop();
  await f.controls.dispose();
  assert.equal(f.sources[0].toneStops, 1);
});

test('pending/failed audio resume and context close failures release resources with explicit diagnostics', async t => {
  const pending = deferred();
  const f = fixture(t, { resume: pending.promise, closeFails: true });
  const starting = f.microphone({ audio: true });
  const rejected = assert.rejects(starting, /stopped/);
  await f.controls.dispose();
  await rejected;
  pending.resolve(); await turn();
  assert.equal(f.controls.activeMicrophones, 0);
  assert.deepEqual(f.sources, [{ live: false, trackStops: 1, toneStops: 1, contextsClosed: 1 }]);
  assert.ok(f.controls.diagnostics.includes('microphone.context-close-failed'));
  const failing = fixture(t, { resume: Promise.reject(new Error('Synthetic resume failure')) });
  await assert.rejects(failing.microphone({ audio: true }), /resume failure/);
  await failing.controls.dispose();
  assert.equal(failing.sources[0].toneStops, 1);
  assert.equal(failing.sources[0].contextsClosed, 1);
});

test('resource guards bound startup, source lifetime, transcript length and diagnostics', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred();
  const f = fixture(t, { resume: pending.promise });
  const starting = f.microphone({ audio: true });
  const rejected = assert.rejects(starting, /stopped/);
  t.mock.timers.tick(5000); await rejected;
  assert.ok(f.controls.diagnostics.includes('microphone.resume-timeout'));
  pending.resolve();
  const ready = fixture(t);
  await ready.microphone({ audio: true });
  t.mock.timers.tick(125_000);
  assert.equal(ready.controls.activeMicrophones, 0);
  assert.ok(ready.controls.diagnostics.includes('microphone.limit'));
  assert.throws(() => ready.controls.transcript('x'.repeat(16001)), /too long/);
  for (let i = 0; i < 100; i++) ready.controls.sessionResponse();
  assert.equal(ready.controls.diagnostics.length, 64);
});

test('PCM accounting is bounded without retaining or emitting audio bytes', async t => {
  const f = fixture(t);
  const socket = f.socket(socketUrl);
  await turn();
  socket.send(JSON.stringify(update()));
  const append = JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(4800).toString('base64') });
  for (let i = 0; i < 1200; i++) socket.send(append);
  assert.equal(f.controls.receivedBytes, 5_760_000);
  assert.throws(() => socket.send(append), /limits/);
  assert.ok(f.controls.diagnostics.length <= 64);
  assert.ok(f.controls.diagnostics.every(value => !value.includes('AAAA')));
  socket.close();
});
