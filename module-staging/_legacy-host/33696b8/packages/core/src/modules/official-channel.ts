import type { ReleaseChannel } from './release-channel.ts';

export function officialReleaseChannel(): ReleaseChannel {
  return {
    metadataUrl: 'https://github.com/waksana/cockpit/releases/download/modules-stable/modules.signed.json',
    publicKey: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA+5YjWR8qPjNwdM2Kw5n1nA4UjYVbJnPy96bkdfPhNKs=\n-----END PUBLIC KEY-----\n',
    allowedDownloadOrigins: ['https://github.com', 'https://release-assets.githubusercontent.com'],
  };
}
