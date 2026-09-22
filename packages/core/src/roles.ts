import type { SessionConfig } from '@github/copilot-sdk';
import type { ModuleSource, RoleSelection, SessionRole } from '@cockpit/protocol';

export interface RoleAssembly {
  roles: SessionRole[];
  config: Pick<SessionConfig, 'systemMessage' | 'skillDirectories' | 'mcpServers'>;
  skills: Array<{ name: string; path: string; module?: ModuleSource }>;
  mcpSources?: Record<string, ModuleSource>;
  fingerprint: string;
}

export interface RoleProvider {
  list(): Array<SessionRole & { description?: string }>;
  read(sessionId: string): SessionRole[];
  save(sessionId: string, roles: SessionRole[]): void;
  assemble(sessionId: string, roles: RoleSelection[]): Promise<RoleAssembly>;
}
