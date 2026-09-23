import { readFileSync } from 'node:fs';

// The MCP handshake reports the package version; src/ (tsx) and dist/ both sit beside package.json.
function packageVersion(): string {
  const metadata: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const version = metadata && typeof metadata === 'object' && 'version' in metadata ? metadata.version : undefined;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('apps/mcp/package.json has no delivery version');
  return version;
}

export const MCP_SERVER_VERSION = packageVersion();
