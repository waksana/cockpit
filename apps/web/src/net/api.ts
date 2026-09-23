// Native requests that neither read nor change store state. The store owns the
// connection lifecycle; these only use its connected client. Tests and synthetic
// fixtures replace individual methods on this object.

import type { DirListing, IntentResult, McpServerGlobal, RoleSelection, SkillGlobal } from '@cockpit/protocol';
import { isSessionUnloadedError, type NetClient } from './client';
import { describeReason, reportUxError } from '../lib/errorReporter';
import { useCockpit, type createCockpitStore } from './store';

type ModelOptions = { reasoningEffort?: string; contextTier?: 'default' | 'long_context' };

export function createCockpitApi(store: ReturnType<typeof createCockpitStore>) {
  const client = () => store.getState().connectedClient();
  const read = async <T,>(send: (net: NetClient) => Promise<T>): Promise<T> => send(client());

  // Observe the original promise: void callers get one diagnostic, awaiting callers
  // still receive the rejection. Transport errors already own a global notice.
  const globalMutation = (operation: string, send: (net: NetClient) => Promise<{ ok: boolean; applied?: boolean; error?: string }>) => {
    let reportedByTransport = false;
    const promise = (async () => {
      const result = await send(client()).catch(error => {
        reportedByTransport = !isSessionUnloadedError(error);
        throw error;
      });
      if (!result.ok || result.applied === false) throw new Error(result.error || '服务器未确认操作');
    })();
    void promise.catch(error => {
      if (!reportedByTransport) reportUxError(`${operation}失败：${describeReason(error, false)}`, { deduplicate: false });
    });
    return promise;
  };

  return {
    listDir: (path?: string): Promise<DirListing> => read(net => net.listDir(path)),
    listRoles: (): Promise<IntentResult<'roles/list'>['roles']> => read(net => net.listRoles()).then(result => result.roles),
    addRoles: (sessionId: string, roles: RoleSelection[]): Promise<IntentResult<'roles/add'>> => read(net => net.addRoles(sessionId, roles)),
    roleReadiness: (sessionId: string): Promise<IntentResult<'roles/readiness'>> => read(net => net.roleReadiness(sessionId)),
    // Native ACKs include queued, confirmation and partial-persistence outcomes.
    // They are not void mutations and never become optimistic session state.
    setModel: (sessionId: string, modelId: string, opts?: ModelOptions): Promise<IntentResult<'setModel'>> =>
      read(net => net.setModel(sessionId, modelId, opts)),
    mcpGlobal: (): Promise<McpServerGlobal[]> => read(net => net.mcpGlobal()).then(result => result.servers),
    mcpSetDefault: (name: string, on: boolean): Promise<void> =>
      globalMutation(`设置 Copilot 全局 MCP ${name}`, net => net.mcpSetDefault(name, on)),
    mcpRefresh: (): Promise<void> => globalMutation('刷新 MCP 配置缓存', net => net.mcpRefresh()),
    skillsGlobal: (cwd?: string): Promise<SkillGlobal[]> => read(net => net.skillsGlobal(cwd)).then(result => result.skills),
    skillsRead: (name: string, cwd?: string): Promise<IntentResult<'skills/read'>> => read(net => net.skillsRead(name, cwd)),
    skillsSetGlobal: (name: string, enabled: boolean, cwd?: string): Promise<void> =>
      globalMutation(`设置 Copilot 全局 Skill ${name}`, net => net.skillsSetGlobal(name, enabled, cwd)),
  };
}
export type CockpitApi = ReturnType<typeof createCockpitApi>;
export const cockpitApi: CockpitApi = createCockpitApi(useCockpit);

// Stable, late-bound loaders for keyed resources; replacing a method never changes their identity.
export const loadGlobalMcp = () => cockpitApi.mcpGlobal();
export const loadGlobalSkills = () => cockpitApi.skillsGlobal();
export const loadRoleCatalog = () => cockpitApi.listRoles();
