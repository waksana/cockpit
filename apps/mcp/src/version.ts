import { readRuntimeIdentity } from '@cockpit/protocol/runtime-identity';

// src/ (tsx) and dist/ both sit beside package.json in source and packaged layouts.
export const MCP_SERVER_VERSION = readRuntimeIdentity(
  new URL('../package.json', import.meta.url),
  new URL('../../../runtime-manifest.json', import.meta.url),
).version;
