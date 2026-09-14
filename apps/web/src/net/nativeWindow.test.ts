import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeChatRead, NativeChatPage, NativeChatEvent } from '@cockpit/protocol';
import { NativeWindow } from './nativeWindow';

const query = (extra: Partial<NativeChatRead> = {}): NativeChatRead => ({
  sessionId: 'fixture', source: 'live', direction: 'backward', max: 64, waitMs: 0,
  agentScope: 'primary', bootstrap: false, ...extra,
});
const event = (id: string, type = 'assistant.message', data: Record<string, unknown> = {}): NativeChatEvent => ({
  id, type, timestamp: 1, data: { messageId: id, content: id, ...data },
});
const accept = (window: NativeWindow, events: NativeChatEvent[], extra: Partial<NativeChatRead> = {},
  result: Partial<NativeChatPage> = {}) => {
  const q = query(extra);
  return window.accept({ sessionId: q.sessionId, source: q.source, direction: q.direction,
    events, cursor: 'next', cursorStatus: 'ok', hasMore: false, read: { rpc: 1, events: events.length }, ...result }, q);
};
const forward = { direction: 'forward' as const, cursor: 'forward', includeEphemeral: true };
const all = { agentScope: 'all' as const };
const liveAll = { ...forward, ...all };
const ephemeral = (id: string, type: string, data: Record<string, unknown>, parentId = 'turn'): NativeChatEvent =>
  ({ ...event(id,type,data), ephemeral: true, parentId });
const owned = (agentId: string, value: NativeChatEvent): NativeChatEvent => ({ ...value, agentId });
const start = (id = 'tool', name = 'bash') => event(`start-${id}`, 'tool.execution_start', {
  toolCallId: id, toolName: name, arguments: { command: 'echo test' },
});
const task = (id: string, toolCallId: string) => event(id,'assistant.message',{
  toolRequests: [{ toolCallId, name: 'task', arguments: { prompt: 'Synthetic task' } }],
});
const spawn = (toolCallId: string, agentId: string) => event(`spawn-${toolCallId}`,'subagent.started',{toolCallId,agentId});
const turn = () => event('turn','assistant.turn_start');

test('backward pages preserve append order, duplicates and immutable untouched identities', () => {
  const window = new NativeWindow();
  accept(window,[event('a'),event('z')],{},{hasMore:true,cursor:'older'});
  const old = window.snapshot().messages;
  accept(window,[event('y'),event('b')],{cursor:'older'});
  assert.deepEqual(window.snapshot().messages.map(message => message.id),['y','b','a','z']);
  assert.equal(window.snapshot().messages[2],old[0]);
  const view = window.snapshot().messages;
  accept(window,[event('a'),event('a')],forward,{cursor:'advanced'});
  assert.equal(window.snapshot().messages,view);
  assert.equal(window.live?.cursor,'advanced');
});

test('bootstrap overlap survives disconnect and bounded catchup without old pages appended at the end', () => {
  const window = new NativeWindow();
  accept(window,[event('c'),event('d')],{bootstrap:true},{liveCursor:'tail',hasMore:true});
  accept(window,[event('a'),event('b')],forward,{hasMore:true});
  window.disconnect();
  accept(window,[event('c'),event('d'),event('e')],forward);
  assert.deepEqual(window.snapshot().messages.map(message => message.id),['c','d','e']);
  assert.equal(window.retainedEventCount,3);
  window.disconnect();
  accept(window,[event('f')],forward,{hasMore:true});
  assert.equal(window.snapshot().messages.at(-1)?.id,'f','ordinary catchup publishes each page');
  window.disconnect();
  accept(window,[event('g')],forward);
  assert.equal(window.snapshot().messages.at(-1)?.id,'g');
});

test('expired and crossed identities retain the readable view without substituting history', () => {
  const window = new NativeWindow();
  accept(window,[event('a')]);
  assert.throws(() => accept(window,[],forward,{cursorStatus:'expired'}),/失效/);
  assert.equal(window.snapshot().messages[0].id,'a');
  assert.equal(window.invalid,true);
  assert.throws(() => accept(window,[],{},{sessionId:'other'}),/不匹配/);
});

test('one response retains thought and body through prepend, disconnect and authoritative recovery', () => {
  const window = new NativeWindow();
  accept(window,[turn()]);
  accept(window,[],forward);
  accept(window,[
    ephemeral('r1','assistant.reasoning_delta',{reasoningId:'r',deltaContent:'Thought prefix'}),
    ephemeral('start','assistant.message_start',{messageId:'m'}),
    ephemeral('b1','assistant.message_delta',{messageId:'m',deltaContent:'Body prefix'}),
  ],forward);
  assert.deepEqual(window.snapshot().messages.map(message => [message.id,message.thought,message.content]),
    [['m','Thought prefix','Body prefix']]);
  accept(window,[event('older')],{cursor:'older'});
  accept(window,[ephemeral('b2','assistant.message_delta',{messageId:'m',deltaContent:' plus'})],forward);
  assert.equal(window.snapshot().messages.at(-1)?.content,'Body prefix plus');
  window.disconnect();
  accept(window,[],forward);
  accept(window,[
    ephemeral('r-suffix','assistant.reasoning_delta',{reasoningId:'r',deltaContent:' LOST'}),
    ephemeral('b-suffix','assistant.message_delta',{messageId:'m',deltaContent:' LOST'}),
  ],forward);
  assert.equal(window.partial,true);
  assert.equal(window.snapshot().messages.at(-1)?.thought,'Thought prefix');
  const final = { ...event('final','assistant.message',{messageId:'m',content:'Whole body',reasoningText:'Whole thought'}),parentId:'turn' };
  accept(window,[final,final],forward);
  assert.equal(window.partial,false);
  assert.equal(window.snapshot().messages.at(-1)?.thought,'Whole thought');
  const view = window.snapshot().messages;
  accept(window,[ephemeral('late','assistant.reasoning_delta',{reasoningId:'r',deltaContent:' stale'})],forward);
  assert.equal(window.snapshot().messages,view);
  accept(window,[ephemeral('full','assistant.reasoning',{reasoningId:'r',content:'Whole thought'},'final')],forward);
  assert.equal(window.snapshot().messages.length,2);
});

test('long streams retain bounded ephemeral identities, not a replayed token log', () => {
  const window = new NativeWindow();
  accept(window,[],forward);
  accept(window,[ephemeral('start','assistant.message_start',{messageId:'m'})],forward);
  for (let i = 0; i < 400; i++) accept(window,[ephemeral(`d${i}`,'assistant.message_delta',{messageId:'m',deltaContent:'.'})],forward);
  assert.equal(window.snapshot().messages[0].content.length,400);
  assert.ok(window.retainedEventCount <= 256);
});

test('a new reasoning ID cannot append a suffix to an already disconnected response', () => {
  const window = new NativeWindow();
  accept(window,[],forward);
  accept(window,[turn(),
    ephemeral('start','assistant.message_start',{messageId:'m'}),
    ephemeral('prefix','assistant.message_delta',{messageId:'m',deltaContent:'Prefix'}),
  ],forward);
  window.disconnect();
  accept(window,[],forward);
  accept(window,[ephemeral('r-suffix','assistant.reasoning_delta',{reasoningId:'unseen',deltaContent:'Missing beginning'})],forward);
  assert.equal(window.snapshot().messages[0].thought,undefined);
  assert.equal(window.partial,true);
  accept(window,[{...event('final','assistant.message',{messageId:'m',content:'Whole',reasoningText:'Complete thought'}),parentId:'turn'}],forward);
  assert.equal(window.partial,false);
  assert.equal(window.snapshot().messages[0].thought,'Complete thought');
});

test('tool starts are self-contained, and message toolRequests neither create nor locate ordinary executions', () => {
  const window = new NativeWindow();
  accept(window,[event('requests','assistant.message',{content:'',toolRequests:[{toolCallId:'tool',name:'incorrect'}]})]);
  assert.deepEqual(window.snapshot().messages,[]);
  accept(window,[start()],forward);
  assert.equal(window.unresolved,false);
  assert.deepEqual(window.snapshot().messages[0].toolCalls,[{
    toolCallId:'tool',name:'bash',title:'bash',args:'$ echo test',status:'in_progress',
  }]);
});

test('bounded result-only windows explicitly retain missing metadata and later starts restore actual execution position', () => {
  const window = new NativeWindow();
  accept(window,[event('middle'),event('complete','tool.execution_complete',{
    toolCallId:'tool',success:false,error:{message:'Denied'},
  }),event('last')]);
  const unknown = window.snapshot().messages[1].toolCalls![0];
  assert.equal(unknown.name,undefined);
  assert.equal(unknown.title,'缺少工具开始记录');
  assert.equal(unknown.status,'failed');
  assert.equal(unknown.output,'Denied');
  assert.equal(window.unresolved,false,'missing tool starts never trigger an all-history scan');
  accept(window,[start()]);
  assert.deepEqual(window.snapshot().messages.map(message => message.id),['tool-tool','middle','last']);
  assert.equal(window.snapshot().messages[0].toolCalls![0].status,'failed');
  assert.equal(window.snapshot().messages[0].toolCalls![0].name,'bash');
});

test('unknown tool outcomes are not invented and parallel reverse completions preserve start order', () => {
  const window = new NativeWindow();
  accept(window,[start('a'),start('b'),event('b-done','tool.execution_complete',{toolCallId:'b',success:true}),
    event('a-done','tool.execution_complete',{toolCallId:'a',result:{content:'Unqualified result'}})]);
  assert.deepEqual(window.snapshot().messages.map(message => message.id),['tool-a','tool-b']);
  assert.equal(window.snapshot().messages[0].toolCalls![0].status,undefined);
  assert.equal(window.snapshot().messages[1].toolCalls![0].status,'completed');
});

test('retained output is capped exactly once when an earlier start provides metadata', () => {
  const window = new NativeWindow();
  accept(window,[event('result','tool.execution_complete',{toolCallId:'tool',result:{content:'x'.repeat(100_000)}})]);
  accept(window,[start()]);
  const tool = window.snapshot().messages[0].toolCalls![0];
  assert.equal(tool.args,'$ echo test');
  assert.match(tool.output ?? '',/已截断，共 100000 字符/);
});

test('ask starts repair retained affirmative replies without truncating the user response', () => {
  const window = new NativeWindow();
  const answer = 'answer '.repeat(1000).trim();
  accept(window,[event('result','tool.execution_complete',{toolCallId:'ask',success:true,result:{content:`User responded: ${answer}`}})]);
  accept(window,[start('ask','ask_user')]);
  assert.equal(window.snapshot().messages.find(message => message.id === 'reply-ask')?.content,answer);
  assert.equal(window.snapshot().messages[0].toolCalls![0].output,undefined);
});

test('dedicated skill and plan starts suppress earlier bounded unknown rows without extra ownership reads', () => {
  for (const name of ['skill','exit_plan_mode']) {
    const window = new NativeWindow();
    accept(window,[event('result','tool.execution_complete',{toolCallId:'hidden',success:true})]);
    accept(window,[start('hidden',name)]);
    assert.deepEqual(window.snapshot().messages,[]);
    assert.equal(window.unresolved,false);
  }
});

test('one all-agent window routes nested activity while preserving unrelated message identity', () => {
  const window = new NativeWindow(undefined,true);
  accept(window,[task('root','outer'),spawn('outer','child'),owned('child',event('stable')),
    owned('child',task('inner-owner','inner')),spawn('inner','nested')],all);
  accept(window,[],liveAll);
  const stable = window.snapshot().messages.at(-1)?.subMessages?.[0];
  accept(window,[owned('nested',ephemeral('start','assistant.message_start',{messageId:'shared'})),
    owned('nested',ephemeral('delta','assistant.message_delta',{messageId:'shared',deltaContent:'Nested'})),
    event('root-final','assistant.message',{messageId:'shared',content:'Root independent'})],liveAll);
  accept(window,[event('older')],all);
  const child = window.snapshot().messages.find(message => message.subagent)?.subMessages;
  assert.equal(child?.[0],stable);
  assert.equal(child?.find(message => message.subagent)?.subMessages?.[0].content,'Nested');
  assert.equal(window.snapshot().messages.find(message => message.id === 'shared')?.content,'Root independent');
  window.disconnect();
  accept(window,[owned('nested',event('final','assistant.message',{messageId:'shared',content:'Nested complete'}))],liveAll);
  assert.equal(window.partial,false);
});

test('child lifecycle and failed tools remain distinct and primary cards remain static', () => {
  for (const includeChildren of [false,true]) {
    const window = new NativeWindow(undefined,includeChildren);
    accept(window,[task('parent','spawn'),spawn('spawn','child')],all);
    accept(window,[event('done','subagent.completed',{toolCallId:'spawn'}),
      owned('child',start('view','view')),owned('child',event('failed','tool.execution_complete',{toolCallId:'view',success:false}))],liveAll);
    assert.equal(window.snapshot().messages.at(-1)?.subagent?.status,includeChildren ? 'activity' : 'running');
    assert.equal(window.snapshot().messages.at(-1)?.subagent?.prompt,undefined);
  }
});

test('native aliases, legacy data ownership and filtered child windows do not adopt root IDs', () => {
  const window = new NativeWindow(undefined,true);
  accept(window,[task('parent','spawn'),spawn('spawn','legacy'),
    {...owned('alias',event('first')),parentToolCallId:'spawn'},
    event('second','assistant.message',{agentId:'alias',content:'Owned'})],all);
  assert.equal(window.unresolved,false);
  assert.deepEqual(window.snapshot().messages.at(-1)?.subMessages?.map(message => message.id),['first','second']);
  const filtered = new NativeWindow(['alias']);
  accept(filtered,[owned('alias',start()),owned('alias',event('result','tool.execution_complete',{toolCallId:'tool',success:true}))],
    {agentIds:['alias'],agentScope:undefined});
  assert.equal(filtered.snapshot().messages[0].toolCalls![0].status,'completed');
});

test('unknown child ownership is explicit, later lifecycle repair resolves scoped interrupted streams', () => {
  const window = new NativeWindow(undefined,true);
  accept(window,[],liveAll);
  accept(window,[owned('child',ephemeral('start','assistant.message_start',{messageId:'m'}))],liveAll);
  assert.equal(window.unresolved,true);
  window.disconnect();
  accept(window,[task('parent','spawn'),spawn('spawn','child')],all);
  accept(window,[owned('child',event('final','assistant.message',{messageId:'m',content:'Recovered'}))],liveAll);
  assert.equal(window.unresolved,false);
  assert.equal(window.partial,false);
});

test('unreferenced legacy reasoning is retained explicitly and equal text never establishes response ownership', () => {
  const window = new NativeWindow();
  accept(window,[event('m','assistant.message',{content:'Body',reasoningText:'Same'})]);
  accept(window,[event('r','assistant.reasoning',{reasoningId:'r',content:'Same'})]);
  assert.deepEqual(window.snapshot().messages.map(message => message.id),['reasoning-r','m']);
  assert.ok(window.snapshot().messages[0].incomplete);
  assert.equal(window.snapshot().messages[1].thought,'Same');
  accept(window,[event('updated','assistant.message',{messageId:'m',content:'Updated'})],forward);
  assert.equal(window.snapshot().messages[1].thought,'Same','body-only writes do not erase a known thought');
});

test('original whitespace bytes survive response snapshots without completion-based repositioning', () => {
  const window = new NativeWindow();
  accept(window,[],forward);
  accept(window,[ephemeral('start','assistant.message_start',{messageId:'m'}),
    ephemeral('delta','assistant.message_delta',{messageId:'m',deltaContent:'  \\n'})],forward);
  accept(window,[start()],forward);
  accept(window,[{...event('final','assistant.message',{messageId:'m',content:' \n',reasoningText:' \n'}),parentId:'turn'}],forward);
  assert.deepEqual(window.snapshot().messages.map(message => message.id),['m','tool-tool']);
  assert.equal(window.snapshot().messages[0].content,' \n');
  assert.equal(window.snapshot().messages[0].thought,' \n');
});

test('ambiguous response parents retain incomplete reasoning until an exact final event reference resolves it', () => {
  const window = new NativeWindow();
  accept(window,[],forward);
  accept(window,[turn(),
    ephemeral('first','assistant.message_start',{messageId:'a'}),
    ephemeral('a-body','assistant.message_delta',{messageId:'a',deltaContent:'A'}),
    ephemeral('second','assistant.message_start',{messageId:'b'}),
    ephemeral('b-body','assistant.message_delta',{messageId:'b',deltaContent:'B'}),
    ephemeral('r','assistant.reasoning_delta',{reasoningId:'r',deltaContent:'Unresolved'}),
  ],forward);
  assert.deepEqual(window.snapshot().messages.map(message => message.thought),[undefined,undefined,'Unresolved']);
  assert.ok(window.snapshot().messages[2].incomplete);
  accept(window,[{...event('b-final','assistant.message',{messageId:'b',content:'B',reasoningText:'Complete'}),parentId:'turn'}],forward);
  accept(window,[ephemeral('r-full','assistant.reasoning',{reasoningId:'r',content:'Complete'},'b-final')],forward);
  assert.deepEqual(window.snapshot().messages.map(message => [message.id,message.thought]),[['a',undefined],['b','Complete']]);
});

test('thought-only final retains one response and tool requests cannot create execution rows', () => {
  const window = new NativeWindow();
  accept(window,[],forward);
  accept(window,[turn(),ephemeral('r','assistant.reasoning_delta',{reasoningId:'r',deltaContent:'Partial'})],forward);
  accept(window,[{...event('final','assistant.message',{messageId:'m',content:'',reasoningText:'Whole',
    toolRequests:[{name:'bash',toolCallId:'t'}]}),parentId:'turn'}],forward);
  assert.deepEqual(window.snapshot().messages.map(message => [message.id,message.content,message.thought]),[['m','','Whole']]);
  accept(window,[ephemeral('full','assistant.reasoning',{reasoningId:'r',content:'Whole'},'final')],forward);
  assert.equal(window.snapshot().messages.length,1);
});

test('pre-message reasoning keeps its first position through native ID adoption and later prefix repair', () => {
  const window = new NativeWindow();
  accept(window,[],forward);
  accept(window,[turn(),ephemeral('r','assistant.reasoning_delta',{reasoningId:'r',deltaContent:'Thought'})],forward);
  accept(window,[start()],forward);
  accept(window,[{...event('final','assistant.message',{messageId:'m',content:'Body',reasoningText:'Thought'}),parentId:'turn'}],forward);
  const ids = () => window.snapshot().messages.map(message => message.id);
  assert.deepEqual(ids(),['m','tool-tool']);
  accept(window,[event('older')]);
  assert.deepEqual(ids(),['older','m','tool-tool']);
});

test('a bounded window missing turn_start reconciles reasoning by shared native parent without a full reasoning notification', () => {
  for (const disconnected of [false,true]) {
    const window = new NativeWindow();
    accept(window,[],forward);
    accept(window,[ephemeral('thought','assistant.reasoning_delta',{
      reasoningId:'r',deltaContent:'Partial thought',
    },'outside-window-turn')],forward);
    assert.equal(window.snapshot().messages[0].thought,'Partial thought');
    assert.ok(window.snapshot().messages[0].incomplete);
    assert.equal(window.snapshot().messages[0].thoughtKey,'outside-window-turn');
    if (disconnected) window.disconnect();
    const final = {...event('final','assistant.message',{
      messageId:'m',content:'Body',reasoningText:'Whole thought',
    }),parentId:'outside-window-turn'};
    accept(window,[final],forward);
    const cold = new NativeWindow();
    accept(cold,[final]);
    assert.deepEqual(window.snapshot().messages,cold.snapshot().messages);
    assert.equal(window.partial,false);
    accept(window,[ephemeral('stale','assistant.reasoning_delta',{
      reasoningId:'r',deltaContent:' stale suffix',
    },'outside-window-turn')],forward);
    assert.deepEqual(window.snapshot().messages,cold.snapshot().messages);
  }
});

test('missing-turn reasoning never attaches to a final with a different native parent', () => {
  const window = new NativeWindow();
  accept(window,[],forward);
  accept(window,[ephemeral('thought','assistant.reasoning_delta',{
    reasoningId:'r',deltaContent:'Same text',
  },'first-parent')],forward);
  accept(window,[{...event('final','assistant.message',{
    messageId:'m',content:'Body',reasoningText:'Same text',
  }),parentId:'different-parent'}],forward);
  assert.deepEqual(window.snapshot().messages.map(message => message.id),['reasoning-r','m']);
  assert.ok(window.snapshot().messages[0].incomplete);
});
