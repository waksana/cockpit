// Voice dictation. Two backends behind ONE controller interface so the composer
// never changes:
//
//   1. Azure Speech (preferred). `webkitSpeechRecognition` is broken-by-design in
//      iOS standalone PWAs (it silently never fires) — the whole reason this
//      exists. The Azure JS SDK bypasses that API entirely (getUserMedia +
//      AudioWorklet → WebSocket to Azure), so it works in the installed PWA.
//      The subscription key never reaches the browser: the server mints a 10-min
//      authorization token (speech/token intent), warmed BEFORE the user taps so
//      the actual start() runs inside the tap gesture (iOS requires getUserMedia
//      and AudioContext.resume to happen in the gesture task — no await between).
//
//   2. Web Speech API (fallback) where Azure isn't configured AND the platform
//      isn't an iOS standalone PWA (where it's broken). On iOS-PWA without Azure
//      we surface a clear error instead of silently doing nothing.
//
// JS here is pure logic/behavior (audio capture, token, transcript) — it never
// touches the presentation layer.

import type * as SpeechSDKNS from 'microsoft-cognitiveservices-speech-sdk';

// The Azure SDK is ~440 KB — keep it OUT of the entry bundle. It is dynamically
// imported only when Azure is actually configured, warmed at mount (alongside the
// token) so the eventual start() still runs synchronously inside the tap gesture.
type SpeechSDKModule = typeof import('microsoft-cognitiveservices-speech-sdk');
let sdkModule: SpeechSDKModule | null = null;
async function loadSdk(): Promise<SpeechSDKModule> {
  if (!sdkModule) sdkModule = await import('microsoft-cognitiveservices-speech-sdk');
  return sdkModule;
}

// --- Web Speech API (fallback) minimal typings ------------------------------
interface SpeechAlternative { transcript: string }
interface SpeechResult { isFinal: boolean; 0: SpeechAlternative }
interface SpeechResultList { length: number; [i: number]: SpeechResult }
interface SpeechResultEvent { resultIndex: number; results: SpeechResultList }
interface SpeechErrorEvent { error?: string }
interface SpeechRec {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRec;

function webSpeechCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

function hasGetUserMedia(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

// iOS standalone PWA is exactly where webkitSpeechRecognition is broken; detect it
// so we never fall back to a backend that will silently fail.
function isIosStandalone(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const iOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && 'ontouchend' in document);
  const standalone = (navigator as unknown as { standalone?: boolean }).standalone === true
    || (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches);
  return iOS && standalone;
}

// The mic is worth showing if EITHER backend could work: Azure needs getUserMedia
// (present on essentially all modern HTTPS browsers), Web Speech needs its ctor.
export function isVoiceSupported(): boolean {
  return hasGetUserMedia() || webSpeechCtor() !== null;
}

export interface VoiceController {
  // Warm the speech token ahead of the user gesture (idempotent). Call on mount so
  // start() can run synchronously inside the tap, satisfying iOS's gesture rules.
  prepare: () => void;
  start: () => void;
  stop: () => void;
  readonly listening: boolean;
}

export interface VoiceCallbacks {
  onFinal: (text: string) => void;
  onInterim?: (text: string) => void;
  onStateChange?: (listening: boolean) => void;
  onError?: (message: string) => void;
}

export type SpeechTokenFetcher = () => Promise<{ enabled: boolean; token?: string; region?: string }>;

// Follow the browser language for the Web Speech fallback (Chinese+English friendly).
function preferredLang(): string {
  return (typeof navigator !== 'undefined' && navigator.language) || 'zh-CN';
}

export function createVoiceController(cb: VoiceCallbacks, fetchToken: SpeechTokenFetcher): VoiceController {
  let listening = false;
  // azure: undefined = not yet known, null = not configured (use fallback),
  // object = warmed token ready for a synchronous start().
  let azure: { token: string; region: string } | null | undefined;
  let warming: Promise<void> | null = null;
  let recognizer: SpeechSDKNS.SpeechRecognizer | null = null;
  let webRec: SpeechRec | null = null;
  let manualStop = false;

  const setListening = (v: boolean) => { listening = v; cb.onStateChange?.(v); };

  const prepare = () => {
    if (warming || azure !== undefined) return;
    warming = (async () => {
      try {
        const r = await fetchToken();
        if (r.enabled && r.token && r.region) {
          await loadSdk(); // warm the SDK too, so start() stays synchronous
          azure = { token: r.token, region: r.region };
        } else {
          azure = null; // not configured → fall back to Web Speech
        }
      } catch {
        azure = null; // token mint / SDK load failed → try the fallback path
      } finally {
        warming = null;
      }
    })();
  };

  // --- Azure backend --------------------------------------------------------
  const startAzure = (token: string, region: string) => {
    const SDK = sdkModule;
    if (!SDK) { cb.onError?.('语音组件未就绪，请重试'); return; }
    const cfg = SDK.SpeechConfig.fromAuthorizationToken(token, region);
    // Mixed zh-CN + en-US via at-start Language ID.
    const auto = SDK.AutoDetectSourceLanguageConfig.fromLanguages(['zh-CN', 'en-US']);
    const audio = SDK.AudioConfig.fromDefaultMicrophoneInput();
    const rec = SDK.SpeechRecognizer.FromConfig(cfg, auto, audio);
    rec.recognizing = (_s, e) => { if (e.result.text) cb.onInterim?.(e.result.text); };
    rec.recognized = (_s, e) => {
      if (e.result.reason === SDK.ResultReason.RecognizedSpeech && e.result.text) cb.onFinal(e.result.text);
    };
    rec.canceled = (_s, e) => {
      if (e.reason === SDK.CancellationReason.Error) cb.onError?.(e.errorDetails || '语音识别出错');
      teardownAzure();
    };
    rec.sessionStopped = () => teardownAzure();
    recognizer = rec;
    rec.startContinuousRecognitionAsync(
      () => setListening(true),
      (err) => { cb.onError?.(String(err) || '麦克风启动失败'); teardownAzure(); },
    );
  };

  const teardownAzure = () => {
    const r = recognizer;
    recognizer = null;
    if (listening) setListening(false);
    if (r) { try { r.close(); } catch { /* ignore */ } }
  };

  // --- Web Speech backend (fallback) ----------------------------------------
  const startWebSpeech = () => {
    const Ctor = webSpeechCtor();
    if (!Ctor) { cb.onError?.('当前环境不支持语音输入'); return; }
    const r = new Ctor();
    r.lang = preferredLang();
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = res[0]?.transcript ?? '';
        if (res.isFinal) cb.onFinal(txt);
        else interim += txt;
      }
      if (interim) cb.onInterim?.(interim);
    };
    r.onerror = (e) => {
      const msg = e?.error || 'speech-error';
      if (msg !== 'no-speech' && msg !== 'aborted') cb.onError?.(String(msg));
    };
    r.onend = () => {
      if (listening && !manualStop) { try { r.start(); return; } catch { /* fallthrough */ } }
      setListening(false);
    };
    webRec = r;
    try { r.start(); setListening(true); }
    catch (e) { cb.onError?.((e as Error)?.message || '语音启动失败'); setListening(false); }
  };

  // Route to a backend using the warmed token. Called synchronously from the tap.
  const route = () => {
    if (azure) { startAzure(azure.token, azure.region); return; }
    // Azure not configured: fall back to Web Speech only where it actually works.
    if (isIosStandalone()) {
      cb.onError?.('iOS 主屏模式需在服务器配置 Azure 语音后才能使用语音输入');
      return;
    }
    startWebSpeech();
  };

  return {
    get listening() { return listening; },
    prepare,
    start() {
      if (listening) return;
      manualStop = false;
      if (azure !== undefined) { route(); return; }
      // Token not warmed yet (prepare() was never called, or still in flight).
      // Works on desktop; on iOS prepare() at mount means we rarely hit this.
      prepare();
      warming?.then(route);
    },
    stop() {
      manualStop = true;
      if (recognizer) {
        const r = recognizer;
        recognizer = null;
        try { r.stopContinuousRecognitionAsync(() => { try { r.close(); } catch { /* ignore */ } }); }
        catch { /* ignore */ }
      }
      if (webRec) { try { webRec.stop(); } catch { /* ignore */ } webRec = null; }
      setListening(false);
    },
  };
}
