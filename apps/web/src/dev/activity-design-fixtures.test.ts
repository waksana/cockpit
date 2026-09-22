import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionMeta } from '@cockpit/protocol';
import { ChatMessage } from '@cockpit/protocol/validation';
import { activityDesignSessions } from './activity-design-fixtures';
import { builtinToolPresentation, toolPresentation } from '../lib/toolPresentation';

test('design preview uses valid synthetic sessions and keeps agents separate from tools', () => {
  for (const session of activityDesignSessions()) {
    SessionMeta.parse(session);
    session.messages.forEach(message => ChatMessage.parse(message));
    assert.ok(session.messages.some(message => message.subtype === 'subagent'));
    assert.ok(!session.messages.some(message => message.toolCalls?.some(tool => tool.name === 'task')));
  }
});

test('builtin mappings are exact and extension tools retain their name and wrench', () => {
  for (const [name, entry] of Object.entries(builtinToolPresentation)) {
    for (const prefix of ['', 'functions.']) {
      assert.deepEqual(toolPresentation(prefix + name), { ...entry, builtin: true });
    }
  }
  for (const name of ['chrome-devtools-evaluate_script', 'custom_bash', 'mcp__view', 'constructor']) {
    assert.deepEqual(toolPresentation(name), { icon: 'tool', label: name, builtin: false });
  }
});
