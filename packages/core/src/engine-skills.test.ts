import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { test } from 'node:test';
import {
  harness,
  nativeCalls,
  unavailableSession,
} from '../test-support/engine-harness.ts';

test('skill mutation requires native read-back and never saves a Cockpit preference', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.skills = [{ name: 'fixture', description: 'local fixture', source: 'project', enabled: false, userInvocable: true }];
  s.rpc.skills.enable.mock.mockImplementationOnce(async () => {});
  await assert.rejects(h.engine.toggleSessionSkill(s.id, 'fixture', true), /did not confirm/);
  assert.equal(h.prefs().skillsDisabledBySession?.[s.id], undefined);
  await h.engine.toggleSessionSkill(s.id, 'fixture', true);
  assert.equal(h.prefs().skillsDisabledBySession, undefined);
  assert.deepEqual((await h.engine.listSessionSkills(s.id)).map(skill => [skill.name, skill.enabled]), [['fixture', true]]);
});

test('global skill choices use native discovery and atomic config mutation without borrowing or reloading sessions', async t => {
  const h = harness(t, { prefs: { skillsDisabledBySession: { historical: ['fixture'] } } });
  const s = await h.load();
  s.state.skills = [{ name: 'fixture', description: 'resident', source: 'personal-copilot', enabled: true, userInvocable: true }];
  h.discoveredSkills.push({ name: 'fixture', description: 'native', source: 'personal-copilot', enabled: true, userInvocable: true });
  const before = nativeCalls(s);
  const prefs = readFileSync(h.prefsFile, 'utf8');
  h.userSettings.settings.disabledSkills!.value = ['unrelated'];
  await h.engine.setGlobalSkill('fixture', false, h.cwd);
  assert.equal((await h.engine.listGlobalSkills(h.cwd))[0]!.enabled, false);
  assert.equal(h.discoveredSkills[0]!.enabled, true, 'discovery may retain its earlier enablement metadata');
  assert.deepEqual(h.userSettings.settings.disabledSkills!.value, ['unrelated', 'fixture']);
  await h.engine.setGlobalSkill('fixture', true, h.cwd);
  assert.deepEqual(h.userSettings.settings.disabledSkills!.value, ['unrelated']);
  assert.deepEqual(h.runtime.rpc.skills.config.setSkillDisabled.mock.calls.map(call => call.arguments), [
    [{ name: 'fixture', disabled: true }], [{ name: 'fixture', disabled: false }],
  ]);
  assert.deepEqual(nativeCalls(s), before);
  assert.equal(readFileSync(h.prefsFile, 'utf8'), prefs);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
});

test('global skill display uses only the native effective disabledSkills value and never exposes unrelated settings', async t => {
  const h = harness(t);
  const path = join(h.cwd, 'SKILL.md');
  writeFileSync(path, 'native skill body');
  h.discoveredSkills.push({ name: 'fixture', description: 'native', source: 'personal-copilot',
    enabled: true, userInvocable: true, path });
  h.userSettings.settings.disabledSkills = { value: ['fixture'], default: [], isDefault: false };
  h.userSettings.settings.credentials = { value: 'private-native-setting', default: null, isDefault: false };
  const list = await h.engine.listGlobalSkills(h.cwd);
  const body = await h.engine.readSkillBody('fixture', h.cwd);
  assert.equal(list[0]!.enabled, false);
  assert.equal(body.enabled, false);
  assert.equal(body.body, 'native skill body');
  assert.ok(!JSON.stringify({ list, body }).includes('private-native-setting'));
  assert.equal(h.runtime.rpc.skills.config.setSkillDisabled.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.user.settings.get.mock.callCount(), 2);
});

test('global skill settings must be readable string arrays, with no discovery or default-value fallback', async t => {
  const h = harness(t);
  h.discoveredSkills.push({ name: 'fixture', description: 'native', source: 'personal-copilot', enabled: true, userInvocable: true });
  h.userSettings.settings.disabledSkills!.value = null;
  assert.equal((await h.engine.listGlobalSkills(h.cwd))[0]!.enabled, true, 'native null is an explicitly unset list');
  for (const value of [false, 'fixture', {}, [false]]) {
    h.userSettings.settings.disabledSkills = { value, default: [], isDefault: false };
    await assert.rejects(h.engine.listGlobalSkills(h.cwd), /disabledSkills must be a string array/);
    await assert.rejects(h.engine.setGlobalSkill('fixture', false, h.cwd), /disabledSkills must be a string array/);
  }
  assert.equal(h.runtime.rpc.skills.config.setSkillDisabled.mock.callCount(), 0);
  h.runtime.rpc.user.settings.get.mock.mockImplementationOnce(async () => { throw new Error('native settings unavailable'); });
  await assert.rejects(h.engine.listGlobalSkills(h.cwd), /native settings unavailable/);
});

test('global skill unknown, ignored, unavailable and malformed discovery never claim success', async t => {
  const h = harness(t);
  await assert.rejects(h.engine.setGlobalSkill('unknown', false, h.cwd), /Unknown skill/);
  assert.equal(h.runtime.rpc.skills.config.setSkillDisabled.mock.callCount(), 0);
  h.discoveredSkills.push({ name: 'fixture', description: 'native', source: 'personal-copilot', enabled: true, userInvocable: true });
  h.runtime.rpc.skills.config.setSkillDisabled.mock.mockImplementationOnce(async () => {});
  await assert.rejects(h.engine.setGlobalSkill('fixture', false, h.cwd), /did not confirm/);
  h.runtime.rpc.skills.discover.mock.mockImplementationOnce(async () => ({ skills: [], errors: ['fixture SKILL.md parse failed'] }));
  await assert.rejects(h.engine.listGlobalSkills(h.cwd), /SKILL.md parse failed/);
  delete h.userSettings.settings.disabledSkills;
  await assert.rejects(h.engine.listGlobalSkills(h.cwd), /unconfirmed/);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
});

test('skill reload diagnostics are explicit rather than silently returning partial success', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.skills.reload.mock.mockImplementationOnce(async () => ({ warnings: ['native load warning'], errors: [] }));
  await assert.rejects(h.engine.refreshSkills(), /native load warning/);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

for (const action of ['listGlobalSkills', 'readSkillBody'] as const) {
  test(`${action} discovers the requested cwd without creating or borrowing sessions`, async t => {
    const h = harness(t);
    const unrelated = await h.load();
    unrelated.state.skills = [{
      name: 'fixture', description: 'unrelated project skill', source: 'project', enabled: true, userInvocable: true,
      path: join(h.cwd, 'must-not-read.md'),
    }];
    const before = nativeCalls(unrelated);
    const prefs = readFileSync(h.prefsFile, 'utf8');
    const directory = join('.engine-test-scratch', 'requested-project');
    h.events.length = 0;
    if (action === 'listGlobalSkills') assert.deepEqual(await h.engine.listGlobalSkills(directory), []);
    else await assert.rejects(h.engine.readSkillBody('fixture', directory), (error: unknown) => error instanceof Error
      && /Unknown skill in this working directory/.test(error.message)
      && (error as { statusCode?: unknown }).statusCode === 404 && (error as { code?: unknown }).code === 'SKILL_NOT_FOUND');
    assert.deepEqual(h.runtime.rpc.skills.discover.mock.calls.map(call => call.arguments),
      [[{ projectPaths: [resolve(directory)] }]]);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
    assert.deepEqual(nativeCalls(unrelated), before);
    assert.equal(readFileSync(h.prefsFile, 'utf8'), prefs, 'discovery must not leave trash or preferences');
    assert.deepEqual(h.events, []);
    assert.equal((await h.engine.getMeta(unrelated.id))?.loaded, true);
    assert.equal(unrelated.listeners.size, 1);
    assert.deepEqual([...h.attached], [unrelated.id]);
  });
}

test('global skill discovery uses server truth even when a loaded session has the same cwd', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.skills = [{
    name: 'stale-session-skill', description: 'not server discovery', source: 'project', enabled: true, userInvocable: true,
  }];
  h.discoveredSkills.push({
    name: 'fixture', description: 'discovered project skill', source: 'project', userInvocable: true,
    path: join(h.cwd, 'SKILL.md'), enabled: true,
  });
  const before = nativeCalls(s);
  assert.deepEqual(await h.engine.listGlobalSkills(h.cwd), [{
    name: 'fixture', description: 'discovered project skill', source: 'project', userInvocable: true, enabled: true,
  }]);
  assert.deepEqual(h.runtime.rpc.skills.discover.mock.calls[0]!.arguments, [{ projectPaths: [h.cwd] }]);
  assert.deepEqual(nativeCalls(s), before);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  assert.equal('trashed' in h.prefs(), false);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
  assert.equal(s.listeners.size, 1);
});

for (const cwd of [undefined, '']) {
  test(`global skill discovery defaults ${cwd === undefined ? 'omitted' : 'empty'} cwd to the home project path`, async t => {
    const h = harness(t);
    assert.deepEqual(await h.engine.listGlobalSkills(cwd), []);
    assert.deepEqual(h.runtime.rpc.skills.discover.mock.calls[0]!.arguments, [{ projectPaths: [resolve(homedir())] }]);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
    assert.deepEqual((await h.engine.snapshot()).sessions, []);
  });
}

test('readSkillBody reads the discovered local path rather than a matching session skill', async t => {
  const h = harness(t);
  const s = await h.load();
  const path = join(h.cwd, 'skill-body.txt');
  const body = '---\nname: fixture\n---\nLocal native-discovered skill body.\n';
  writeFileSync(path, body);
  h.discoveredSkills.push({ name: 'fixture', description: 'discovered body', source: 'project', userInvocable: true, enabled: true, path });
  s.state.skills = [{
    name: 'fixture', description: 'wrong body', source: 'project', enabled: true, userInvocable: true,
    path: join(h.cwd, 'must-not-read.txt'),
  }];
  const before = nativeCalls(s);
  assert.deepEqual(await h.engine.readSkillBody('fixture', h.cwd), {
    name: 'fixture', description: 'discovered body', source: 'project', userInvocable: true, enabled: true, body,
  });
  assert.deepEqual(h.runtime.rpc.skills.discover.mock.calls[0]!.arguments, [{ projectPaths: [h.cwd] }]);
  assert.deepEqual(nativeCalls(s), before);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
});

test('native global skill discovery failure propagates without a session fallback or trash', async t => {
  const h = harness(t);
  const unrelated = await h.load();
  const before = nativeCalls(unrelated);
  const prefs = readFileSync(h.prefsFile, 'utf8');
  h.runtime.rpc.skills.discover.mock.mockImplementation(async () => { throw new Error('native discovery failed'); });
  await assert.rejects(h.engine.listGlobalSkills(h.cwd), /native discovery failed/);
  await assert.rejects(h.engine.readSkillBody('fixture', h.cwd), /native discovery failed/);
  assert.equal(h.runtime.rpc.skills.discover.mock.callCount(), 2);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  assert.deepEqual(nativeCalls(unrelated), before);
  assert.equal(readFileSync(h.prefsFile, 'utf8'), prefs);
  assert.equal((await h.engine.getMeta(unrelated.id))?.loaded, true);
  assert.deepEqual([...h.attached], [unrelated.id]);
});

test('refreshSkills with no loaded sessions uses native discovery without loading historical sessions', async t => {
  const h = harness(t);
  const s = await h.seed();
  await h.engine.refreshSkills();
  assert.deepEqual(h.runtime.rpc.skills.discover.mock.calls.map(call => call.arguments),
    [[{ projectPaths: [resolve(homedir())] }]]);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  assert.equal(s.rpc.skills.reload.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.equal('trashed' in h.prefs(), false);
});

test('live refreshSkills checks liveness and never resumes an expired or unloaded peer', async t => {
  const h = harness(t);
  const live = await h.load();
  const expired = await h.load();
  const unloaded = await h.seed();
  h.runtime.expire(expired.id);
  const resumes = h.runtime.resumeSession.mock.callCount();
  const expiredCalls = nativeCalls(expired);
  let failure: unknown;
  try { await h.engine.refreshSkills(); }
  catch (error) { failure = error; }
  if (failure) assert.match(String(failure), unavailableSession);
  assert.equal(live.rpc.skills.reload.mock.callCount(), 1);
  assert.deepEqual(nativeCalls(expired), expiredCalls);
  assert.equal(unloaded.rpc.skills.reload.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(expired.id))?.loaded, false);
  assert.equal((await h.engine.getMeta(live.id))?.loaded, true);
});
