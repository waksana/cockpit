import type { NativeChatEvent } from '@cockpit/protocol';

// SDK 1.0.13 / CLI 1.0.83 synthetic provider probes, 2026-09-14.
// Normalized UUIDs and case labels only; measured event order, parent references,
// ephemeral flags and whitespace are retained. Identical measured cases share data.
const types = ['assistant.turn_start', 'assistant.message_start', 'assistant.message_delta',
  'assistant.message', 'assistant.reasoning_delta', 'assistant.reasoning', 'assistant.turn_end',
  'tool.execution_start', 'tool.execution_complete'];
type Entry = [string, number, string, Record<string, unknown>, boolean];
const body: Entry[] = [
  ['1',0,'8',{},false],
  ['2',1,'1',{messageId:'9'},true],
  ['3',2,'1',{messageId:'9',deltaContent:'Body CASE 1 A. '},true],
  ['4',2,'1',{messageId:'9',deltaContent:'Body CASE 1 B. '},true],
  ['5',2,'1',{messageId:'9',deltaContent:'Body CASE 1 C.'},true],
  ['6',3,'1',{messageId:'9',content:'Body CASE 1 A. Body CASE 1 B. Body CASE 1 C.',toolRequests:[]},false],
  ['7',6,'6',{},false],
];
const reasoning: Entry[] = [
  ['1',0,'11',{},false],
  ['2',4,'1',{reasoningId:'12',deltaContent:'Reason CASE 1 A. '},true],
  ['3',4,'1',{reasoningId:'12',deltaContent:'Reason CASE 1 B.'},true],
  ['4',1,'1',{messageId:'13'},true],
  ['5',2,'1',{messageId:'13',deltaContent:'Body CASE 1 A. '},true],
  ['6',2,'1',{messageId:'13',deltaContent:'Body CASE 1 B. '},true],
  ['7',2,'1',{messageId:'13',deltaContent:'Body CASE 1 C.'},true],
  ['8',3,'1',{messageId:'13',content:'Body CASE 1 A. Body CASE 1 B. Body CASE 1 C.',toolRequests:[],reasoningText:'Reason CASE 1 A. Reason CASE 1 B.'},false],
  ['9',5,'8',{reasoningId:'12',content:'Reason CASE 1 A. Reason CASE 1 B.'},true],
  ['10',6,'8',{},false],
];
const anthropic: Entry[] = [
  ['1',0,'14',{},false],
  ['2',4,'1',{reasoningId:'15',deltaContent:'Think CASE 1.1 A. '},true],
  ['3',4,'1',{reasoningId:'15',deltaContent:'Think CASE 1.1 B.'},true],
  ['4',1,'1',{messageId:'16'},true],
  ['5',2,'1',{messageId:'16',deltaContent:'Body CASE 1.1 A. '},true],
  ['6',2,'1',{messageId:'16',deltaContent:'Body CASE 1.1 B.'},true],
  ['7',4,'1',{reasoningId:'15',deltaContent:'Think CASE 1.2 A. '},true],
  ['8',4,'1',{reasoningId:'15',deltaContent:'Think CASE 1.2 B.'},true],
  ['9',2,'1',{messageId:'16',deltaContent:'Body CASE 1.2 A. '},true],
  ['10',2,'1',{messageId:'16',deltaContent:'Body CASE 1.2 B.'},true],
  ['11',3,'1',{messageId:'16',content:'Body CASE 1.1 A. Body CASE 1.1 B.Body CASE 1.2 A. Body CASE 1.2 B.',toolRequests:[],reasoningText:'Think CASE 1.1 A. Think CASE 1.1 B.Think CASE 1.2 A. Think CASE 1.2 B.'},false],
  ['12',5,'11',{reasoningId:'15',content:'Think CASE 1.1 A. Think CASE 1.1 B.Think CASE 1.2 A. Think CASE 1.2 B.'},true],
  ['13',6,'11',{},false],
];
const request = (toolCallId: string, name: string, label: string, delay: number) =>
  ({ toolCallId, name, arguments: { label, delay }, type: 'function' });

function toolCase(name: string, label: string, error: string, parent = '19'): Entry[] {
  return [
    ['1',0,'16',{},false],
    ['2',1,'1',{messageId:'17'},true],
    ['3',2,'1',{messageId:'17',deltaContent:'Body CASE 1 A. '},true],
    ['4',2,'1',{messageId:'17',deltaContent:'Body CASE 1 B. '},true],
    ['5',3,'1',{messageId:'17',content:'Body CASE 1 A. Body CASE 1 B. ',toolRequests:[request('18',name,label,10)]},false],
    ['6',7,'5',{toolCallId:'18',toolName:name,arguments:{label,delay:10}},false],
    ['7',8,parent,{toolCallId:'18',success:false,error:{message:error,code:label === 'denied' ? 'denied' : 'failure'}},false],
    ['8',6,'7',{},false],
    ['9',0,'8',{},false],
    ['10',1,'9',{messageId:'20'},true],
    ['11',2,'9',{messageId:'20',deltaContent:'Body CASE 2 A. '},true],
    ['12',2,'9',{messageId:'20',deltaContent:'Body CASE 2 B. '},true],
    ['13',2,'9',{messageId:'20',deltaContent:'Body CASE 2 C.'},true],
    ['14',3,'9',{messageId:'20',content:'Body CASE 2 A. Body CASE 2 B. Body CASE 2 C.',toolRequests:[]},false],
    ['15',6,'14',{},false],
  ];
}

function parallel(provider: 'openai' | 'anthropic'): Entry[] {
  const first = structuredClone(provider === 'openai' ? reasoning : anthropic);
  // Measured OpenAI tool response ends after B; Anthropic sends both blocks.
  if (provider === 'openai') {
    first.splice(6, 1);
    first.find(entry => entry[1] === 3)![3].content = 'Body CASE 1 A. Body CASE 1 B. ';
  }
  const final = first.find(entry => entry[1] === 3)!;
  final[3].toolRequests = [request('slow','probe_echo','slow',260), request('fast','probe_echo','fast',15)];
  first.pop();
  const tools: Entry[] = [
    ['start-slow',7,final[0],{toolCallId:'slow',toolName:'probe_echo',arguments:{label:'slow',delay:260}},false],
    ['start-fast',7,'start-slow',{toolCallId:'fast',toolName:'probe_echo',arguments:{label:'fast',delay:15}},false],
    ['done-fast',8,'tool-progress',{toolCallId:'fast',success:true,result:{content:'echo:fast',detailedContent:'echo:fast'}},false],
    ['done-slow',8,'done-fast',{toolCallId:'slow',success:true,result:{content:'echo:slow',detailedContent:'echo:slow'}},false],
    ['end',6,'done-slow',{},false],
  ];
  const second = structuredClone(provider === 'openai' ? reasoning : anthropic).map(([id,type,parent,data,eph]): Entry => {
    const normalized = JSON.parse(JSON.stringify(data).replaceAll('CASE 1', 'CASE 2')) as Record<string, unknown>;
    for (const key of ['messageId','reasoningId']) if (typeof normalized[key] === 'string') normalized[key] = `next-${normalized[key]}`;
    return [`next-${id}`,type,type === 0 ? 'end' : `next-${parent}`,normalized,eph];
  });
  return [...first,...tools,...second];
}

function bodyFirst(provider: string): Entry[] {
  return [
    ['1',0,'10',{},false],
    ['2',1,'1',{messageId:'11'},true],
    ['3',2,'1',{messageId:'11',deltaContent:`BODY_FIRST_${provider} A. `},true],
    ['4',4,'1',{reasoningId:'12',deltaContent:`LATE_REASONING_${provider} A. `},true],
    ['5',4,'1',{reasoningId:'12',deltaContent:`LATE_REASONING_${provider} B.`},true],
    ['6',2,'1',{messageId:'11',deltaContent:`BODY_FIRST_${provider} B.`},true],
    ['7',3,'1',{messageId:'11',content:`BODY_FIRST_${provider} A. BODY_FIRST_${provider} B.`,toolRequests:[],reasoningText:`LATE_REASONING_${provider} A. LATE_REASONING_${provider} B.`},false],
    ['8',5,'7',{reasoningId:'12',content:`LATE_REASONING_${provider} A. LATE_REASONING_${provider} B.`},true],
    ['9',6,'7',{},false],
  ];
}
const entries: Record<string, Entry[]> = {
  OPENAI_BODY: body,
  OPENAI_REASONING: reasoning,
  OPENAI_REASONING_CONTENT: reasoning,
  OPENAI_NONSTREAM_REASONING: [
    ['1',0,'5',{},false],
    ['2',3,'1',{messageId:'6',content:'Body CASE complete.',toolRequests:[],reasoningText:'Reason CASE complete.'},false],
    ['3',5,'2',{reasoningId:'7',content:'Reason CASE complete.'},true],
    ['4',6,'2',{},false],
  ],
  OPENAI_DENIED: toolCase('probe_guarded','denied','The user rejected this tool call. User feedback: Synthetic fixture denied'),
  OPENAI_FAILURE: toolCase('probe_echo','failure','Tool execution failed'),
  OPENAI_INVALID: toolCase('probe_nonexistent','invalid',"Tool 'probe_nonexistent' does not exist.",'6'),
  OPENAI_PARALLEL: parallel('openai'),
  ANTHROPIC_PARALLEL: parallel('anthropic'),
  ANTHROPIC_REASONING: anthropic,
  ANTHROPIC_BODY: [
    ['1',0,'7',{},false],
    ['2',1,'1',{messageId:'8'},true],
    ['3',2,'1',{messageId:'8',deltaContent:'Body CASE 1.1 A. '},true],
    ['4',2,'1',{messageId:'8',deltaContent:'Body CASE 1.1 B.'},true],
    ['5',3,'1',{messageId:'8',content:'Body CASE 1.1 A. Body CASE 1.1 B.',toolRequests:[]},false],
    ['6',6,'5',{},false],
  ],
  ANTHROPIC_BODY_THEN_REASONING: bodyFirst('ANTHROPIC'),
  OPENAI_BODY_THEN_REASONING: bodyFirst('OPENAI'),
};

export const nativeCaptures = Object.entries(entries).map(([name, entries]) => {
  const notification: NativeChatEvent[] = entries.map(([id,type,parentId,data,ephemeral], index) =>
    ({ id, type: types[type], parentId, data, timestamp: index + 1, ...(ephemeral ? { ephemeral: true } : {}) }));
  return { name, notification, persisted: notification.filter(event => !event.ephemeral) };
});
