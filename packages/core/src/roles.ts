import type { SessionConfig } from '@github/copilot-sdk';
import type { ModuleRoleResources, ModuleRoleSkill, ModuleSource, RoleSelection, SessionRole } from '@cockpit/protocol';

export interface RoleAssembly {
  roles: SessionRole[];
  config: Pick<SessionConfig, 'systemMessage' | 'skillDirectories' | 'mcpServers'>;
  skills: Array<{ name: string; path: string; module?: ModuleSource }>;
  mcpSources?: Record<string, ModuleSource>;
  /** Display-only provenance for role instruction sections; not part of the fingerprint. */
  instructionSources?: SessionInstructions['sources'];
  fingerprint: string;
}

/** Cockpit-composed text appended to the native system prompt at create/resume. */
export interface SessionInstructions {
  content: string;
  sources: Array<{ label: string; sublabel?: string }>;
}

export interface RoleProvider {
  globalMcpSources?(config: object): ModuleSource[] | undefined;
  globalSkillSources?(path: string): Promise<ModuleSource[] | undefined>;
  list(): Array<SessionRole & { description?: string }>;
  /** Read-only catalog of resources each loaded module's roles assemble; not native global configuration. */
  resources?(): Promise<ModuleRoleResources[]>;
  /** Read one verified packaged role Skill by its opaque, version-bound catalog identity. */
  readSkill?(moduleId: string, resourceId: string): Promise<ModuleRoleSkill>;
  read(sessionId: string): SessionRole[] | Promise<SessionRole[]>;
  save(sessionId: string, roles: SessionRole[]): void;
  assemble(sessionId: string, roles: RoleSelection[]): Promise<RoleAssembly>;
  /** Compose module defaults, the applied role instructions and user instructions. */
  sessionInstructions?(sessionId: string, assembly?: RoleAssembly): Promise<SessionInstructions | undefined>;
}
