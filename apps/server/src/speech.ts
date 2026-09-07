// Azure Speech authorization-token minting. The browser needs to talk to Azure
// Speech for continuous dictation, but the subscription KEY must never reach the
// client — so the server exchanges the key for a short-lived (10-minute) JWT and
// hands only that to the browser (SpeechConfig.fromAuthorizationToken).
//
// Configured via env: AZURE_SPEECH_KEY + AZURE_SPEECH_REGION (e.g. "eastasia").
// When unset, the feature self-disables (enabled:false) and the client falls back
// to the Web Speech API on platforms where it works.

const KEY = process.env.AZURE_SPEECH_KEY?.trim();
const REGION = process.env.AZURE_SPEECH_REGION?.trim();

// Azure tokens live 10 min; refresh a little early and reuse across requests so a
// burst of mic taps doesn't hammer the issueToken endpoint.
const TOKEN_TTL_MS = 9 * 60 * 1000;

interface CachedToken { token: string; at: number }
let cache: CachedToken | null = null;

export interface SpeechTokenResult { enabled: boolean; token?: string; region?: string }

export function speechConfigured(): boolean {
  return !!(KEY && REGION);
}

export async function getSpeechToken(): Promise<SpeechTokenResult> {
  if (!KEY || !REGION) return { enabled: false };
  const now = Date.now();
  if (cache && now - cache.at < TOKEN_TTL_MS) {
    return { enabled: true, token: cache.token, region: REGION };
  }
  const url = `https://${REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': KEY, 'Content-Length': '0' },
  });
  if (!res.ok) {
    throw new Error(`azure issueToken failed: ${res.status} ${res.statusText}`);
  }
  const token = await res.text();
  cache = { token, at: now };
  return { enabled: true, token, region: REGION };
}
