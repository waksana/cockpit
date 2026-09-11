import type { ModuleManager } from '@cockpit/core';
import type { ModuleIntentHandlers } from './index.ts';

export function createModuleIntents(modules: ModuleManager): ModuleIntentHandlers {
  return {
    'modules/updates/check': async () => modules.updates.check(),
    'modules/updates/status': async () => ({ operations: modules.updates.status() }),
    'modules/updates/get': async body => ({ operation: modules.updates.get(body.operationId) }),
    'modules/updates/install': async body => modules.updates.install(body),
    'modules/updates/reconcile': async body => modules.updates.reconcile(body),
    'modules/list': async body => ({ modules: await modules.list(body.cwd, body.checkAvailability) }),
    'modules/install': async body => ({ module: await modules.install(body.moduleId) }),
    'modules/install/local': async body => modules.installLocal(body),
    'modules/uninstall': async body => { await modules.uninstall(body.moduleId); return { ok: true }; },
    'modules/config/get': async body => modules.getConfig(body.moduleId),
    'modules/config/set': async body => modules.setConfig(body),
    'modules/config/initialize': async body => ({ operation: await modules.initializeConfig(body) }),
    'modules/config/initialization': async body => ({ operation: modules.configInitialization(body.operationId) }),
    'modules/service': async body => ({ job: await modules.control(body) }),
    'modules/service/job': async body => ({ job: await modules.serviceJob(body.operationId) }),
    'modules/service/status': async body => modules.serviceStatus(body.moduleId),
    'modules/wechat/unbind': async body => { await modules.unbind(body.sessionId, body.operationId); return { ok: true }; },
    'modules/wechat/unbind/get': async body => ({ operation: modules.unbindOperation(body.operationId) }),
  };
}
