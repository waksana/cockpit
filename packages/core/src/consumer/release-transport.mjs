import { createHash, createPublicKey, verify } from 'node:crypto';
import { constants, createWriteStream, lstatSync, readFileSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function secureReleaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Release transport requires HTTPS without URL credentials or fragments');
  }
  return url;
}

function credential(channel) {
  if (!channel.tokenFile) return undefined;
  if (!isAbsolute(channel.tokenFile)) throw new Error('Release credential file must be absolute');
  const stat = lstatSync(channel.tokenFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096 || (stat.mode & 0o077)
    || stat.uid !== process.getuid?.()) throw new Error('Release credential file must be an owner-only regular file');
  const token = readFileSync(channel.tokenFile, 'utf8').trim();
  if (!token || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error('Invalid release credential file');
  return token;
}

async function requestResource(url, channel, allowed, fetchImpl, accept, validateRedirect) {
  url = secureReleaseUrl(url.href);
  const authOrigin = secureReleaseUrl(channel.metadataUrl).origin;
  const token = credential(channel);
  for (let redirect = 0; redirect <= 5; redirect++) {
    if (!allowed.includes(url.origin)) throw new Error('Release URL origin is not explicitly trusted');
    const response = await fetchImpl(url, {
      redirect: 'manual', signal: AbortSignal.timeout(60_000),
      headers: { ...(token && url.origin === authOrigin ? { authorization: `Bearer ${token}` } : {}),
        accept },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Release redirect has no location');
      url = secureReleaseUrl(new URL(location, url).href);
      validateRedirect?.(url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Release transport failed (${response.status}); no automatic retry`);
    }
    return response;
  }
  throw new Error('Release redirect limit exceeded');
}

export function requestRelease(url, channel, allowed, fetchImpl = fetch) {
  return requestResource(url, channel, allowed, fetchImpl, 'application/octet-stream');
}

function githubMetadataSource(channel) {
  if (channel.metadataAssetName === undefined) return null;
  if (typeof channel.metadataAssetName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(channel.metadataAssetName)) {
    throw new Error('metadataAssetName must be an explicit safe exact filename');
  }
  const url = secureReleaseUrl(channel.metadataUrl);
  const match = /^\/repos\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/releases\/(latest|tags\/([^/]+))$/.exec(url.pathname);
  if (url.origin !== 'https://api.github.com' || url.href !== channel.metadataUrl || url.search || !match) {
    throw new Error('GitHub metadata discovery requires an exact api.github.com repository releases/latest or releases/tags/<tag> URL');
  }
  let tag;
  if (match[4]) {
    try { tag = decodeURIComponent(match[4]); } catch { throw new Error('Invalid GitHub release tag encoding'); }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(tag)) throw new Error('Invalid explicit GitHub release tag');
  }
  return { url, repository: `${match[1]}/${match[2]}`.toLowerCase(), tag };
}

export function validateReleaseChannel(channel) {
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)
    || Object.keys(channel).some(key => !['metadataUrl', 'metadataAssetName', 'publicKey', 'allowedDownloadOrigins', 'tokenFile'].includes(key))
    || typeof channel.metadataUrl !== 'string' || typeof channel.publicKey !== 'string' || !channel.publicKey
    || !Array.isArray(channel.allowedDownloadOrigins) || !channel.allowedDownloadOrigins.length
    || (channel.tokenFile !== undefined && (typeof channel.tokenFile !== 'string' || !isAbsolute(channel.tokenFile)))) {
    throw new Error('Release channel requires explicit publisher key, HTTPS origins and valid optional fields');
  }
  secureReleaseUrl(channel.metadataUrl);
  for (const origin of channel.allowedDownloadOrigins) {
    if (typeof origin !== 'string' || secureReleaseUrl(origin).origin !== origin) {
      throw new Error('Release download policy entries must be exact HTTPS origins');
    }
  }
  githubMetadataSource(channel);
  return channel;
}

export function verifyEnvelope(envelope, channel) {
  if (!envelope || typeof envelope.payload !== 'string' || envelope.payload.length > 300_000
    || typeof envelope.signature !== 'string' || envelope.signature.length > 200
    || Object.keys(envelope).some(key => !['payload', 'signature'].includes(key))) {
    throw new Error('Invalid signed release envelope');
  }
  const payload = Buffer.from(envelope.payload, 'base64'), signature = Buffer.from(envelope.signature, 'base64');
  if (payload.toString('base64') !== envelope.payload || signature.toString('base64') !== envelope.signature
    || signature.length !== 64) throw new Error('Invalid signed release envelope encoding');
  const key = createPublicKey(channel.publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, payload, key, signature)) {
    throw new Error('Release publisher signature is not trusted');
  }
  return JSON.parse(payload.toString('utf8'));
}

async function readBoundedJson(response, maximum, label) {
  if (!response.body) throw new Error(`${label} response is empty`);
  const chunks = [];
  let size = 0;
  for await (const part of Readable.fromWeb(response.body)) {
    size += part.length;
    if (size > maximum) throw new Error(`${label} exceeds its bounded response size`);
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function githubIdentity(value, source, kind) {
  if (typeof value !== 'string') throw new Error('Missing GitHub release/asset API identity');
  const url = secureReleaseUrl(value);
  const match = /^\/repos\/([^/]+)\/([^/]+)\/releases\/(assets\/)?([1-9][0-9]*)$/.exec(url.pathname);
  if (url.origin !== 'https://api.github.com' || url.href !== value || url.search || !match
    || `${match[1]}/${match[2]}`.toLowerCase() !== source.repository
    || Boolean(match[3]) !== (kind === 'asset') || !Number.isSafeInteger(Number(match[4]))) {
    throw new Error('GitHub release/asset URL must identify the same repository and exact numeric API resource');
  }
  return { url, id: Number(match[4]) };
}

async function discoverMetadataAsset(channel, source, fetchImpl) {
  const response = await requestResource(source.url, channel, [source.url.origin], fetchImpl,
    'application/vnd.github+json', () => { throw new Error('GitHub discovery redirects are refused; configure the canonical repository URL'); });
  const release = await readBoundedJson(response, 1_000_000, 'GitHub release discovery');
  if (!release || typeof release !== 'object' || Array.isArray(release) || !Number.isSafeInteger(release.id)
    || release.id < 1 || release.draft !== false || typeof release.prerelease !== 'boolean'
    || typeof release.tag_name !== 'string' || !release.tag_name
    || (source.tag === undefined ? release.prerelease : release.tag_name !== source.tag)
    || !Array.isArray(release.assets) || release.assets.length > 1000) throw new Error('Malformed or mismatched GitHub release discovery');
  if (githubIdentity(release.url, source, 'release').id !== release.id) throw new Error('GitHub release identity mismatch');
  const names = new Set(), ids = new Set();
  let selected;
  for (const asset of release.assets) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset) || typeof asset.name !== 'string'
      || !asset.name || asset.name.length > 255 || /[\x00-\x1f\x7f]/.test(asset.name)
      || !Number.isSafeInteger(asset.id) || asset.id < 1 || asset.state !== 'uploaded'
      || !Number.isSafeInteger(asset.size) || asset.size < 0) throw new Error('Malformed GitHub release asset');
    const identity = githubIdentity(asset.url, source, 'asset');
    if (identity.id !== asset.id) throw new Error('GitHub asset identity mismatch');
    if (names.has(asset.name) || ids.has(asset.id)) throw new Error('Duplicate GitHub release asset name or identity');
    names.add(asset.name); ids.add(asset.id);
    if (asset.name === channel.metadataAssetName) {
      if (asset.size < 1 || asset.size > 400_000) throw new Error('GitHub metadata asset exceeds the signed-envelope bound');
      selected = identity;
    }
  }
  if (!selected) throw new Error('Configured metadataAssetName is missing from the GitHub release');
  return selected;
}

export async function readReleaseEnvelope(channel, fetchImpl = fetch) {
  const source = githubMetadataSource(channel);
  let url = secureReleaseUrl(channel.metadataUrl), validateRedirect;
  if (source) {
    const selected = await discoverMetadataAsset(channel, source, fetchImpl);
    url = selected.url;
    validateRedirect = redirect => {
      if (redirect.origin === 'https://api.github.com' && githubIdentity(redirect.href, source, 'asset').id !== selected.id) {
        throw new Error('GitHub metadata asset redirect changed its identity');
      }
    };
  }
  const response = await requestResource(url, channel,
    [...new Set([secureReleaseUrl(channel.metadataUrl).origin, ...channel.allowedDownloadOrigins])],
    fetchImpl, 'application/octet-stream', validateRedirect);
  return readBoundedJson(response, 400_000, 'Release metadata');
}

export async function downloadVerifiedArchive(target, channel, destination, fetchImpl = fetch) {
  if (!Number.isSafeInteger(target.bytes) || target.bytes < 1 || target.bytes > 400 * 1024 * 1024
    || !/^[a-f0-9]{64}$/.test(target.sha256)) throw new Error('Invalid signed archive bounds');
  const response = await requestRelease(secureReleaseUrl(target.url), channel, channel.allowedDownloadOrigins, fetchImpl);
  if (!response.body) throw new Error('Release archive response is empty');
  const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    .catch(async error => { await response.body?.cancel(); throw error; });
  let published = false;
  try {
    let size = 0;
    const hash = createHash('sha256');
    const count = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > target.bytes) return callback(new Error('Release archive exceeds its signed size'));
        hash.update(chunk); callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), count,
      createWriteStream(destination, { fd: file.fd, autoClose: false }));
    if (size !== target.bytes || hash.digest('hex') !== target.sha256) {
      throw new Error('Release archive does not match its publisher-signed size and digest');
    }
    await file.sync();
    published = true;
  } finally {
    await file.close();
    if (!published) await unlink(destination);
  }
}
