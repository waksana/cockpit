import { open } from 'node:fs/promises';
import { z } from 'zod';
import type { PinnedRelease, ReleaseTarget } from './contracts.ts';
import { fileHash, responseBytes } from './files.ts';

const asset = z.object({ id: z.number().int().positive(), name: z.string(), size: z.number().int().positive() });
const release = z.object({
  id: z.number().int().positive(), tag_name: z.string(), draft: z.boolean(), prerelease: z.boolean(),
  published_at: z.string().nullable(), assets: z.array(asset),
});
const reference = z.object({ object: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/), type: z.string() }) });
const downloads = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

export class GithubReleases {
  constructor(private readonly timeout: number, private readonly fetcher: typeof fetch = fetch, private readonly token?: string) {}

  private headers(binary = false): Record<string, string> {
    return {
      Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private async json(path: string): Promise<unknown> {
    const response = await this.fetcher(`https://api.github.com/${path}`, {
      headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(this.timeout),
    });
    if (!response.ok) throw new Error(`GitHub release lookup failed: HTTP ${response.status}`);
    return JSON.parse((await responseBytes(response, 4 * 1024 * 1024)).toString('utf8'));
  }

  async pin(target: ReleaseTarget): Promise<PinnedRelease> {
    const base = `repos/${target.repository}`;
    const data = release.parse(await this.json(`${base}/releases/tags/${encodeURIComponent(target.tag)}`));
    if (data.draft || data.prerelease || !data.published_at || data.tag_name !== target.tag) {
      throw new Error('Deployment requires an already published, non-prerelease Release');
    }
    let ref = reference.parse(await this.json(`${base}/git/ref/tags/${encodeURIComponent(target.tag)}`)).object;
    for (let depth = 0; ref.type === 'tag' && depth < 4; depth++) {
      ref = reference.parse(await this.json(`${base}/git/tags/${ref.sha}`)).object;
    }
    if (ref.type !== 'commit' || ref.sha !== target.sourceSha) throw new Error('Release tag does not resolve to the reviewed source commit');
    const matches = data.assets.filter(entry => entry.name === target.asset);
    if (matches.length !== 1 || matches[0]!.size > 1024 ** 3) throw new Error('Missing, duplicate or oversized Release archive');
    const file = matches[0]!;
    return { ...target, releaseId: data.id, assetId: file.id, assetSize: file.size, publishedAt: data.published_at };
  }

  async download(pin: PinnedRelease, destination: string): Promise<void> {
    let url = new URL(`https://api.github.com/repos/${pin.repository}/releases/assets/${pin.assetId}`);
    const signal = AbortSignal.timeout(this.timeout);
    let response: Response | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (url.protocol !== 'https:' || !downloads.has(url.hostname) || url.username || url.password) {
        throw new Error('Release download redirected outside the trusted GitHub asset endpoints');
      }
      response = await this.fetcher(url, {
        headers: url.hostname === 'api.github.com' ? this.headers(true) : {}, redirect: 'manual', signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Release redirect is missing its destination');
      url = new URL(location, url);
      response = undefined;
    }
    if (!response?.ok || !response.body) throw new Error(`Release download failed: HTTP ${response?.status ?? 'redirect limit'}`);
    const file = await open(destination, 'wx', 0o600);
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > pin.assetSize) throw new Error('Release archive exceeds its pinned size');
        await file.write(chunk);
      }
      await file.sync();
    } finally { await file.close(); }
    if (bytes !== pin.assetSize || await fileHash(destination) !== pin.sha256) {
      throw new Error('Release archive differs from its pinned size or SHA256');
    }
  }
}
