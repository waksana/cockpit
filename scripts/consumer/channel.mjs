import { secureReleaseUrl, verifyEnvelope, validateReleaseChannel } from './release-transport.mjs';
import { createHash } from 'node:crypto';

export function validateChannel(channel) {
  return validateReleaseChannel(channel);
}

export function verifyConsumerMetadata(envelope, channel, floor = 0, now = Date.now()) {
  const metadata = verifyEnvelope(envelope, validateChannel(channel));
  if (!metadata || metadata.schemaVersion !== 1 || metadata.channel !== 'stable'
    || !Number.isSafeInteger(metadata.sequence) || metadata.sequence < 1
    || !Array.isArray(metadata.targets) || metadata.targets.length > 30
    || Object.keys(metadata).some(key => !['schemaVersion', 'channel', 'sequence', 'issuedAt', 'expiresAt', 'targets'].includes(key))) {
    throw new Error('Invalid consumer release metadata');
  }
  const issued = Date.parse(metadata.issuedAt), expires = Date.parse(metadata.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || metadata.sequence < floor
    || issued > now + 300_000 || expires <= now || expires <= issued) {
    throw new Error('Release metadata is expired, not yet valid or below sequence floor');
  }
  const seen = new Set();
  for (const target of metadata.targets) {
    if (target.moduleId !== 'cockpit' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(target.version)
      || target.platform !== 'linux' || target.arch !== 'x64' || target.nodeMajor !== 24
      || !/^[a-f0-9]{40}$/.test(target.sourceSha) || !/^[a-f0-9]{64}$/.test(target.sha256)
      || !Number.isSafeInteger(target.bytes) || target.bytes < 1 || target.bytes > 400 * 1024 * 1024
      || Object.keys(target).some(key => !['moduleId', 'version', 'platform', 'arch', 'nodeMajor', 'sourceSha', 'sha256', 'bytes', 'url'].includes(key))) {
      throw new Error('Invalid Linux x64 Node24 main release target');
    }
    if (!channel.allowedDownloadOrigins.includes(secureReleaseUrl(target.url).origin)) throw new Error('Target origin outside local policy');
    if (seen.has(target.version)) throw new Error('Ambiguous consumer release version');
    seen.add(target.version);
  }
  return metadata;
}

export function verifyConsumerFloor(envelope, channel, floor, allowAdvance = false) {
  if (!floor || !Number.isSafeInteger(floor.sequence) || floor.sequence < 0
    || (floor.digest !== undefined && !/^[a-f0-9]{64}$/.test(floor.digest))) {
    throw new Error('Invalid retained release sequence/digest floor');
  }
  const metadata = verifyConsumerMetadata(envelope, channel, floor.sequence);
  const digest = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
  if (metadata.sequence === floor.sequence && floor.digest !== digest) {
    throw new Error('Publisher reused a release sequence with different signed metadata (or an unbound legacy floor)');
  }
  if (!allowAdvance && (metadata.sequence !== floor.sequence || digest !== floor.digest)) {
    throw new Error('Release metadata does not match the currently accepted sequence/digest floor');
  }
  return { metadata, digest };
}
