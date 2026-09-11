export interface Channel {
  metadataUrl: string;
  metadataAssetName?: string;
  publicKey: string;
  allowedDownloadOrigins: string[];
  tokenFile?: string;
}
export function secureReleaseUrl(value: string): URL;
export function validateReleaseChannel(channel: unknown): Channel;
export function requestRelease(url: URL, channel: Channel, allowed: string[], fetchImpl?: typeof fetch): Promise<Response>;
export function verifyEnvelope(envelope: unknown, channel: Channel): unknown;
export function readReleaseEnvelope(channel: Channel, fetchImpl?: typeof fetch): Promise<unknown>;
export function downloadVerifiedArchive(target: { url: string; bytes: number; sha256: string },
  channel: Channel, destination: string, fetchImpl?: typeof fetch): Promise<void>;
