// Native requests that neither read nor change store state. The store owns the
// connection lifecycle; these only use its connected client. Every caller shows
// its own result, so none of these raise a global notice. Tests and synthetic
// fixtures replace individual methods on this object.

import type { DirListing, IntentResult, McpServerGlobal, ModuleRoleResources, RoleSelection, SkillGlobal } from '@cockpit/protocol';
import { OWNED, type NetClient } from './client';
import { OperationRejected, recordOperationFailure } from '../lib/operationErrors';
import { copy } from '../lib/copy';
import { useCockpit, type createCockpitStore } from './store';

type ModelOptions = { reasoningEffort?: string; contextTier?: 'default' | 'long_context' };

export function createCockpitApi(store: ReturnType<typeof createCockpitStore>) {
  const client = () => store.getState().connectedClient();
  const read = async <T,>(send: (net: NetClient) => Promise<T>): Promise<T> => send(client());

  // Every caller shows its own result in place (docs/frontend-guidelines.md#error-ownership).
  const globalMutation = (
    operation: string, send: (net: NetClient) => Promise<{ ok: boolean; applied?: boolean; error?: string }>,
  ) => {
    const promise = (async () => {
      const result = await send(client());
      if (!result.ok || result.applied === false) {
        const error = new OperationRejected(result.error || '服务器未接受操作');
        recordOperationFailure(error, { message: copy.failed(operation, error.message), mutation: true, uncertain: false });
        throw error;
      }
    })();
    // Awaiting callers still receive the rejection; void callers never leak one.
    void promise.catch(() => {});
    return promise;
  };

  return {
    listDir: (path?: string): Promise<DirListing> => read(net => net.listDir(path, OWNED)),
    listRoles: (): Promise<IntentResult<'roles/list'>['roles']> => read(net => net.listRoles(OWNED)).then(result => result.roles),
    roleResources: (): Promise<ModuleRoleResources[]> => read(net => net.roleResources(OWNED)).then(result => result.modules),
    addRoles: (sessionId: string, roles: RoleSelection[]): Promise<IntentResult<'roles/add'>> => read(net => net.addRoles(sessionId, roles, OWNED)),
    roleReadiness: (sessionId: string): Promise<IntentResult<'roles/readiness'>> => read(net => net.roleReadiness(sessionId, OWNED)),
    // Native ACKs include queued, confirmation and partial-persistence outcomes.
    // They are not void mutations and never become optimistic session state.
    setModel: (sessionId: string, modelId: string, opts?: ModelOptions): Promise<IntentResult<'setModel'>> =>
      read(net => net.setModel(sessionId, modelId, opts, OWNED)),
    mcpGlobal: (): Promise<McpServerGlobal[]> => read(net => net.mcpGlobal(OWNED)).then(result => result.servers),
    mcpSetDefault: (name: string, on: boolean): Promise<void> =>
      globalMutation(`设置 Copilot 全局 MCP ${name}`, net => net.mcpSetDefault(name, on, OWNED)),
    mcpRefresh: (): Promise<void> => globalMutation('刷新 MCP 配置缓存', net => net.mcpRefresh(OWNED)),
    skillsGlobal: (cwd?: string): Promise<SkillGlobal[]> => read(net => net.skillsGlobal(cwd, OWNED)).then(result => result.skills),
    skillsRead: (name: string, cwd?: string): Promise<IntentResult<'skills/read'>> => read(net => net.skillsRead(name, cwd, OWNED)),
    skillsSetGlobal: (name: string, enabled: boolean, cwd?: string): Promise<void> =>
      globalMutation(`设置 Copilot 全局 Skill ${name}`, net => net.skillsSetGlobal(name, enabled, cwd, OWNED)),
  };
}
export type CockpitApi = ReturnType<typeof createCockpitApi>;
export const cockpitApi: CockpitApi = createCockpitApi(useCockpit);

// Stable, late-bound loaders for keyed resources; replacing a method never changes their identity.
export const loadGlobalMcp = () => cockpitApi.mcpGlobal();
export const loadGlobalSkills = () => cockpitApi.skillsGlobal();
export const loadRoleCatalog = () => cockpitApi.listRoles();
export const loadRoleResources = () => cockpitApi.roleResources();
