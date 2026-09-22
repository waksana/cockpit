const SESSION_URL = 'wss://cockpit-synthetic-only.openai.azure.com/openai/v1/realtime?intent=transcription';
const SECRET = 'synthetic-only-no-credentials';
const MODEL = 'gpt-transcribe';
const MAX_PCM_BYTES = 5_760_000;
const installed = new WeakSet<Window>();

export interface SyntheticSpeechControls {
  sessionResponse(): Response;
  readonly microphoneRequests: number;
  readonly socketCount: number;
  readonly activeMicrophones: number;
  readonly activeSockets: number;
  readonly pendingFinals: number;
  readonly receivedBytes: number;
  readonly diagnostics: readonly string[];
  /** Applies to subsequently opened synthetic sockets, including explicit retries. */
  transcript(text: string): void;
  /** Fails the next credential request; does not bypass Speech's credential cache. */
  failNextSession(): void;
  holdFinal(hold?: boolean): void;
  releaseFinal(): void;
  dispose(): Promise<void>;
}

export function speechSocketRoute(page: string, destination: string | URL, protocols?: string | string[]): 'synthetic' | 'hmr' {
  const origin = new URL(page);
  if (!['http:', 'https:'].includes(origin.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
    throw new Error('Synthetic Speech requires a loopback HTTP lab');
  }
  const url = new URL(destination);
  const names = typeof protocols === 'string' ? [protocols] : protocols ?? [];
  if (url.username || url.password || url.hash) throw new Error('Synthetic Speech blocked WebSocket destination');
  const parameters = [...url.searchParams.keys()];
  if (url.origin === new URL(SESSION_URL).origin && url.pathname === '/openai/v1/realtime'
    && parameters.length === 2 && new Set(parameters).size === 2
    && url.searchParams.get('intent') === 'transcription'
    && url.searchParams.get('Authorization') === `Bearer ${SECRET}`
    && names.length === 1 && names[0] === 'realtime') return 'synthetic';
  if (url.protocol === (origin.protocol === 'https:' ? 'wss:' : 'ws:') && url.host === origin.host
    && url.pathname === '/' && parameters.length === 1 && parameters[0] === 'token'
    && !!url.searchParams.get('token') && names.length === 1 && names[0] === 'vite-hmr') return 'hmr';
  throw new Error('Synthetic Speech blocked WebSocket destination');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface SyntheticTrack { stop(): void }
interface SyntheticStream { getTracks(): SyntheticTrack[] }
export interface SyntheticTone<Stream extends SyntheticStream> {
  readonly stream: Stream;
  resume(): Promise<void>;
  stop(): void;
  close(): Promise<void>;
}

/** A small protocol facade, not a replacement implementation of browser WebSocket. */
export class SyntheticSpeechSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly bufferedAmount = 0;
  readonly extensions = '';
  readonly protocol = 'realtime';
  binaryType: BinaryType = 'blob';
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  private configured = false;
  private committed = false;
  private cleared = false;
  private bytes = 0;
  private finalPending = false;
  readonly url: string;
  private readonly text: string;
  private readonly id: string;
  private readonly changed: (event: string, bytes?: number) => void;
  private readonly deferFinal: () => boolean;
  private readonly closed: () => void;

  constructor(url: string, text: string, id: number, changed: (event: string, bytes?: number) => void,
    deferFinal: () => boolean, closed: () => void) {
    super();
    this.url = url; this.text = text; this.id = `synthetic-speech-${id}`;
    this.changed = changed; this.deferFinal = deferFinal; this.closed = closed;
    queueMicrotask(() => {
      if (this.readyState !== this.CONNECTING) return;
      this.readyState = this.OPEN;
      const event = new Event('open');
      this.onopen?.(event); this.dispatchEvent(event);
    });
  }
  get pendingFinal(): boolean { return this.finalPending; }
  private emit(value: object): void {
    const data = JSON.stringify(value);
    queueMicrotask(() => {
      if (this.readyState !== this.OPEN) return;
      const event = new MessageEvent<string>('message', { data });
      this.onmessage?.(event); this.dispatchEvent(event);
    });
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== this.OPEN) throw new Error('Synthetic Speech socket is not open');
    if (typeof data !== 'string' || data.length > 32_768) throw new Error('Synthetic Speech expects bounded JSON frames');
    const value: unknown = JSON.parse(data);
    if (!record(value)) throw new Error('Synthetic Speech expects a protocol object');
    if (value.type === 'session.update') {
      if (this.configured || !record(value.session) || value.session.type !== 'transcription'
        || !record(value.session.audio) || !record(value.session.audio.input)) throw new Error('Invalid synthetic session update');
      const input = value.session.audio.input;
      if (!record(input.format) || input.format.type !== 'audio/pcm' || input.format.rate !== 24_000
        || !record(input.turn_detection) || input.turn_detection.type !== 'server_vad' || input.turn_detection.silence_duration_ms !== 1000
        || !record(input.transcription) || input.transcription.model !== MODEL
        || typeof input.transcription.prompt !== 'string' || [...input.transcription.prompt].length > 1022) {
        throw new Error('Invalid synthetic audio/VAD/transcription configuration');
      }
      this.configured = true;
      this.changed('session.updated');
      this.emit({ type: 'session.updated', session: value.session });
      return;
    }
    if (!this.configured || this.cleared) throw new Error('Synthetic Speech protocol is out of order');
    if (value.type === 'input_audio_buffer.append') {
      if (this.committed || typeof value.audio !== 'string' || !value.audio.length || value.audio.length > 6400
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.audio)) {
        throw new Error('Invalid synthetic PCM append');
      }
      const bytes = atob(value.audio).length;
      if (!bytes || bytes % 2 || this.bytes + bytes > MAX_PCM_BYTES) throw new Error('Synthetic PCM exceeds recording limits');
      this.bytes += bytes;
      this.changed('audio.append', bytes);
      return;
    }
    if (value.type === 'input_audio_buffer.commit') {
      if (this.committed || typeof value.event_id !== 'string' || value.event_id !== 'speech-final-commit') {
        throw new Error('Invalid synthetic final commit');
      }
      this.committed = true;
      this.changed('audio.commit');
      if (!this.bytes) {
        this.emit({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', event_id: value.event_id } });
      } else {
        this.emit({ type: 'input_audio_buffer.committed', item_id: this.id, previous_item_id: null });
        const points = [...this.text];
        const middle = Math.ceil(points.length / 2);
        for (const delta of [points.slice(0, middle).join(''), points.slice(middle).join('')]) {
          if (delta) this.emit({ type: 'conversation.item.input_audio_transcription.delta',
            item_id: this.id, content_index: 0, delta });
        }
      }
      return;
    }
    if (value.type === 'input_audio_buffer.clear') {
      if (!this.committed) throw new Error('Synthetic clear requires a final commit');
      this.cleared = true;
      this.changed('audio.clear');
      this.emit({ type: 'input_audio_buffer.cleared' });
      this.finalPending = this.bytes > 0;
      if (!this.deferFinal()) this.releaseFinal();
      return;
    }
    throw new Error('Unsupported synthetic Speech protocol frame');
  }
  releaseFinal(): void {
    if (!this.finalPending || this.readyState !== this.OPEN) return;
    this.finalPending = false;
    this.changed('transcript.final');
    this.emit({ type: 'conversation.item.input_audio_transcription.completed',
      item_id: this.id, content_index: 0, transcript: this.text });
  }
  close(): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.finalPending = false;
    this.closed();
    queueMicrotask(() => {
      const event = new Event('close');
      this.onclose?.(event); this.dispatchEvent(event);
    });
  }
}

function resumed(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Exported for isolated tests; the browser entry below supplies only generated audio. */
export function syntheticSpeechAdapter<Stream extends SyntheticStream>(makeTone: (report: (event: string) => void) => SyntheticTone<Stream>) {
  let disposed = false, failSession = false, hold = false;
  let text = 'Synthetic Speech lab transcript';
  let microphoneRequests = 0, socketCount = 0, receivedBytes = 0;
  const diagnostics: string[] = [];
  const sockets = new Set<SyntheticSpeechSocket>();
  const microphones = new Set<() => void>();
  const closing = new Set<Promise<void>>();
  const note = (event: string, bytes = 0) => {
    receivedBytes += bytes;
    diagnostics.push(event);
    if (diagnostics.length > 64) diagnostics.shift();
  };
  const live = () => { if (disposed) throw new Error('Synthetic Speech adapter is disposed'); };
  const controls: SyntheticSpeechControls = {
    sessionResponse() {
      live();
      if (failSession) {
        failSession = false; note('session.failed');
        return Response.json({ error: { code: 'SYNTHETIC_SESSION_FAILED', message: 'Synthetic lab credential failure; retry this recording.' } },
          { status: 503, headers: { 'cache-control': 'no-store' } });
      }
      note('session.created');
      return Response.json({ clientSecret: SECRET, expiresAt: Math.floor(Date.now() / 1000) + 600,
        socketUrl: SESSION_URL, deployment: MODEL }, { headers: { 'cache-control': 'no-store' } });
    },
    get microphoneRequests() { return microphoneRequests; },
    get socketCount() { return socketCount; },
    get activeMicrophones() { return microphones.size; },
    get activeSockets() { return sockets.size; },
    get pendingFinals() { return [...sockets].filter(socket => socket.pendingFinal).length; },
    get receivedBytes() { return receivedBytes; },
    get diagnostics() { return [...diagnostics]; },
    transcript(value) {
      live();
      if ([...value].length > 16_000) throw new Error('Synthetic transcript is too long');
      text = value;
    },
    failNextSession() { live(); failSession = true; },
    holdFinal(value = true) { live(); hold = value; if (!hold) controls.releaseFinal(); },
    releaseFinal() { live(); for (const socket of sockets) socket.releaseFinal(); },
    async dispose() {
      disposed = true;
      for (const stop of microphones) stop();
      for (const socket of sockets) socket.close();
      await Promise.all(closing);
    },
  };
  return {
    controls,
    async microphone(constraints?: MediaStreamConstraints): Promise<Stream> {
      live();
      if (!constraints?.audio || constraints.video) throw new Error('Synthetic lab supports audio-only capture');
      microphoneRequests++;
      const tone = makeTone(note);
      const lifetime = new AbortController();
      const tracks = tone.stream.getTracks().map(track => ({
        track, descriptor: Object.getOwnPropertyDescriptor(track, 'stop'), stop: track.stop.bind(track),
      }));
      let stopped = false;
      const startupTimer = setTimeout(() => {
        note('microphone.resume-timeout'); stop();
      }, 5000);
      const lifetimeTimer = setTimeout(() => { note('microphone.limit'); stop(); }, 125_000);
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(startupTimer); clearTimeout(lifetimeTimer);
        lifetime.abort(new Error('Synthetic microphone was stopped'));
        microphones.delete(stop);
        for (const item of tracks) {
          if (item.descriptor) Object.defineProperty(item.track, 'stop', item.descriptor);
          else Reflect.deleteProperty(item.track, 'stop');
          try { item.stop(); } catch { note('microphone.track-stop-failed'); }
        }
        try { tone.stop(); } catch { note('microphone.tone-stop-failed'); }
        const closed = Promise.resolve().then(() => tone.close()).catch(() => { note('microphone.context-close-failed'); });
        closing.add(closed);
        void closed.then(() => closing.delete(closed));
        note('microphone.stopped');
      };
      microphones.add(stop);
      try {
        for (const { track } of tracks) Object.defineProperty(track, 'stop', { configurable: true, value: stop });
        await resumed(tone.resume(), lifetime.signal);
        lifetime.signal.throwIfAborted();
        clearTimeout(startupTimer);
        note('microphone.ready');
        return tone.stream;
      } catch (error) { stop(); throw error; }
    },
    socket(url: string): SyntheticSpeechSocket {
      live();
      // Even the in-memory socket factory refuses arbitrary or unauthenticated destinations.
      speechSocketRoute('http://127.0.0.1/', url, 'realtime');
      const socket = new SyntheticSpeechSocket(url, text, ++socketCount, note, () => hold, () => {
        sockets.delete(socket); note('socket.closed');
      });
      sockets.add(socket);
      note('socket.created');
      return socket;
    },
  };
}

export function installSyntheticSpeech(target: Window): SyntheticSpeechControls {
  const page = new URL(target.location.href);
  if (!['http:', 'https:'].includes(page.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(page.hostname)
    || page.pathname !== '/chat-lab.html') throw new Error('Synthetic Speech is restricted to the loopback Chat Lab');
  if (installed.has(target)) throw new Error('Synthetic Speech is already installed in this lab');
  const realm = target.window;
  const media = target.navigator.mediaDevices;
  if (!media || !realm.AudioContext || !realm.WebSocket) throw new Error('Synthetic Speech requires Web Audio and media APIs');
  const mediaDescriptor = Object.getOwnPropertyDescriptor(media, 'getUserMedia');
  const socketDescriptor = Object.getOwnPropertyDescriptor(target, 'WebSocket');
  const NativeSocket = realm.WebSocket;
  const adapter = syntheticSpeechAdapter(report => {
    const context = new realm.AudioContext({ sampleRate: 24_000 });
    let oscillator: OscillatorNode | undefined;
    let destination: MediaStreamAudioDestinationNode | undefined;
    try {
      oscillator = context.createOscillator();
      destination = context.createMediaStreamDestination();
      oscillator.frequency.value = 220;
      // Deliberately no connection to context.destination: no microphone or speaker access.
      oscillator.connect(destination);
      oscillator.start();
      const source = oscillator, output = destination;
      return {
        stream: output.stream,
        resume: () => context.resume(),
        stop() {
          try { source.stop(); } finally {
            try { source.disconnect(); } finally { output.disconnect(); }
          }
        },
        close: () => context.close(),
      };
    } catch (error) {
      try { oscillator?.disconnect(); } catch { report('microphone.oscillator-disconnect-failed'); }
      try { destination?.disconnect(); } catch { report('microphone.destination-disconnect-failed'); }
      for (const track of destination?.stream.getTracks() ?? []) {
        try { track.stop(); } catch { report('microphone.track-stop-failed'); }
      }
      void Promise.resolve().then(() => context.close()).catch(() => report('microphone.context-close-failed'));
      throw error;
    }
  });
  const Socket = new Proxy(NativeSocket, {
    construct(constructor, args) {
      const destination: unknown = args[0];
      const rawProtocols: unknown = args[1];
      if (!(typeof destination === 'string' || destination instanceof URL)
        || !(rawProtocols === undefined || typeof rawProtocols === 'string'
          || (Array.isArray(rawProtocols) && rawProtocols.every(value => typeof value === 'string')))) {
        throw new Error('Synthetic Speech blocked invalid WebSocket arguments');
      }
      const protocols = typeof rawProtocols === 'string' ? rawProtocols
        : Array.isArray(rawProtocols) ? rawProtocols.filter((value): value is string => typeof value === 'string') : undefined;
      return speechSocketRoute(page.href, destination, protocols) === 'hmr'
        ? new constructor(destination, protocols) : adapter.socket(String(destination));
    },
  });
  const restore = () => {
    if (mediaDescriptor) Object.defineProperty(media, 'getUserMedia', mediaDescriptor);
    else Reflect.deleteProperty(media, 'getUserMedia');
    if (socketDescriptor) Object.defineProperty(target, 'WebSocket', socketDescriptor);
    else Reflect.deleteProperty(target, 'WebSocket');
    installed.delete(target);
  };
  try {
    Object.defineProperty(media, 'getUserMedia', { configurable: true, value: adapter.microphone });
    Object.defineProperty(target, 'WebSocket', { configurable: true, value: Socket });
    installed.add(target);
  } catch (error) { restore(); void adapter.controls.dispose(); throw error; }
  return Object.assign(adapter.controls, {
    dispose: (() => {
      const dispose = adapter.controls.dispose;
      let restored = false;
      return async () => {
        if (!restored) { restored = true; restore(); }
        await dispose();
      };
    })(),
  });
}
