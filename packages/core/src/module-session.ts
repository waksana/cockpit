import type { CopilotSession, SessionConfig } from '@github/copilot-sdk';
import type { ModuleSelection, SessionModules, SessionDeletionPlan, SessionUnbindApproval } from '@cockpit/protocol';

export type RoleSessionConfig = Pick<SessionConfig, 'systemMessage' | 'skillDirectories' | 'mcpServers' | 'disabledSkills'>;

/** Stores user-selected module versions, never native actual state. */
export interface SessionModuleHost {
  prepare(sessionId: string, cwd: string, selections: ModuleSelection[], operationId: string): Promise<void>;
  configuration(sessionId: string, cwd: string | undefined, applying: boolean): Promise<RoleSessionConfig>;
  connected(sessionId: string, session: CopilotSession, applying: boolean): Promise<void>;
  failed(sessionId: string, error: unknown): Promise<void>;
  assertReady(sessionId: string): Promise<void>;
  read(sessionId: string): Promise<SessionModules | null>;
  deletionPlan?(sessionId: string): Promise<SessionDeletionPlan>;
  unbindForDeletion?(sessionId: string, approval?: SessionUnbindApproval): Promise<void>;
  removed?(sessionId: string): Promise<void>;
  /** Includes still-running control children after their initiating request has rejected. */
  activeCount?(): number;
  onSettled?(listener: () => void): () => void;
}
