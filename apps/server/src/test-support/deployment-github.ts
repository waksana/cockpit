import type { ReleaseTarget } from '../deployment/contracts.ts';

export interface FixtureRelease { target: ReleaseTarget; bytes: Buffer; assetId: number }

export function fixtureGithub(entries: () => Iterable<FixtureRelease>): typeof fetch {
  return async input => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
    for (const { target, bytes, assetId } of entries()) {
      const base = `/repos/${target.repository}`;
      if (path === `${base}/releases/tags/${target.tag}`) return Response.json({
        id: assetId, tag_name: target.tag, draft: false, prerelease: false, published_at: '2026-09-26T00:00:00Z',
        assets: [{ id: assetId, name: target.asset, size: bytes.length }],
      });
      if (path === `${base}/git/ref/tags/${target.tag}`) return Response.json({ object: { type: 'commit', sha: target.sourceSha } });
      if (path === `${base}/releases/assets/${assetId}`) return new Response(new Uint8Array(bytes));
    }
    return new Response('No fixture', { status: 404 });
  };
}
