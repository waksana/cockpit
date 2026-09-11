import { ModuleReleaseTarget as ReleaseTarget, ModuleReleaseMetadata as ReleaseMetadata,
  SignedModuleRelease as SignedEnvelope } from '@cockpit/protocol';
import { secureReleaseUrl, verifyEnvelope, readReleaseEnvelope, downloadVerifiedArchive, validateReleaseChannel } from '../consumer/release-transport.mjs';
export { ReleaseTarget, ReleaseMetadata, validateReleaseChannel };

export interface ReleaseChannel {
  metadataUrl: string;
  metadataAssetName?: string;
  publicKey: string;
  allowedDownloadOrigins: string[];
  tokenFile?: string;
}

export function verifyReleaseMetadata(envelope: unknown, channel: ReleaseChannel, floor = 0, now = Date.now()): ReleaseMetadata {
  validateReleaseChannel(channel);
  const metadata = ReleaseMetadata.parse(verifyEnvelope(SignedEnvelope.parse(envelope), channel));
  const issued = Date.parse(metadata.issuedAt), expires = Date.parse(metadata.expiresAt);
  if (metadata.sequence < floor || issued > now + 300_000 || expires <= now || expires <= issued) {
    throw new Error('Release metadata is expired, not yet valid or below the accepted sequence floor');
  }
  const seen = new Set<string>();
  for (const target of metadata.targets) {
    const key = `${target.moduleId}:${target.version}:${target.platform}:${target.arch}`;
    if (seen.has(key)) throw new Error('Duplicate release target identity');
    seen.add(key);
    const origin = secureReleaseUrl(target.url).origin;
    if (!channel.allowedDownloadOrigins.includes(origin)) throw new Error('Signed release target origin is outside local policy');
  }
  return metadata;
}

export async function checkReleaseChannel(channel: ReleaseChannel, floor = 0, fetchImpl: typeof fetch = fetch) {
  validateReleaseChannel(channel);
  const envelope = await readReleaseEnvelope(channel, fetchImpl);
  return { envelope, metadata: verifyReleaseMetadata(envelope, channel, floor) };
}

/** Destination is a new private staged file; callers never overwrite a running release. */
export async function downloadRelease(
  target: ReleaseTarget, channel: ReleaseChannel, destination: string, fetchImpl: typeof fetch = fetch,
): Promise<void> {
  ReleaseTarget.parse(target);
  validateReleaseChannel(channel);
  await downloadVerifiedArchive(target, channel, destination, fetchImpl);
}
