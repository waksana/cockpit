import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = join(repository, 'packages/module-api');
const npmOptions = ['--ignore-scripts', '--no-audit', '--no-fund'];
const fixtures = [
  { name: 'common', types: [], lib: ['ES2022'], source: `
    import { MAX_MODULE_EVENT_BYTES, type SessionMeta, type McpInvocationMeta } from '@waksana/cockpit-module-sdk';
    import { MCP_INVOCATION_META_KEY } from '@waksana/cockpit-module-sdk/runtime';
    declare const session: SessionMeta;
    const id: string = session.sessionId;
    declare const invocation: McpInvocationMeta;
    const toolCallId: string | undefined = invocation.toolCallId;
    void [id, toolCallId, MAX_MODULE_EVENT_BYTES, MCP_INVOCATION_META_KEY];
  ` },
  ...['backend', 'backend-current'].map(name => ({ name, types: ['node'], lib: ['ES2022'], source: `
    import { Readable } from 'node:stream';
    import type { ModuleBackend, ModuleHostApi, ModuleHostIntentBody, ModuleHostIntentResult, ModuleResponse, RoleAssignmentFailure } from '@waksana/cockpit-module-sdk/backend';
    const backend: ModuleBackend = { routes: [] };
    const response: ModuleResponse = { body: Readable.from('ok') };
    const created: ModuleHostIntentResult<'session/new'> = { sessionId: 's' };
    // @ts-expect-error sessionId is part of the canonical host result.
    const invalid: ModuleHostIntentResult<'session/new'> = { id: 's' };
    declare const host: ModuleHostApi;
    const askVersion: 1 | undefined = host.askResponseVersion;
    const chatVersion: 1 | undefined = host.chatReadVersion;
    const promptVersion: 1 | undefined = host.promptReceiptVersion;
    const toolScopeVersion: 1 | undefined = host.toolScopeVersion;
    const scoped: ModuleHostIntentBody<'session/new'> = { cwd: '/workspace',
      toolScope: { builtins: [], mcpServers: [{ name: 'service', tools: ['read'] }] } };
    host.call('session/new', scoped);
    const scopeRead: Promise<import('@waksana/cockpit-module-sdk/backend').SessionToolScope> =
      host.call('session/tool-scope', { sessionId: 's' });
    void [toolScopeVersion, scopeRead];
    const delivered = host.call('prompt', { sessionId: 'native-session', text: 'fixture' }).then(result => {
      const messageId: string | undefined = result.messageId;
      return messageId;
    });
    const roleVersion: 1 | undefined = host.roleAssignmentVersion;
    const directoryVersion: 1 | undefined = host.sessionDirectoryVersion;
    const loadVersion: 1 | undefined = host.sessionLoadVersion;
    const roleBackend: ModuleBackend = { routes: [], roleAssignments: {
      permit: (assignment, signal) => {
        signal.throwIfAborted();
        return assignment.roles.length > 1 ? { allowed: false, reason: 'Conflict' } : { allowed: true };
      },
      saved: async notification => { const id: string = notification.notificationId; void id; },
    } };
    const directory = host.call('session/directory', { limit: 50 });
    const load = host.call('session/load', { sessionId: 's' });
    const notify = host.call('roles/notify', { notificationId: 'a'.repeat(64) });
    void [roleVersion, directoryVersion, loadVersion, roleBackend, directory, load, notify];
    declare const partial: RoleAssignmentFailure;
    const returned = partial.roleAssignment.mutationResult;
    if (returned?.operation === 'create') {
      const actualCreatedId: string = returned.result.sessionId;
      void actualCreatedId;
    }
    const nativeCreation: 'confirmed' | 'unconfirmed' | 'not-applicable' = partial.roleAssignment.nativeCreation;
    void nativeCreation;
    const answer: ModuleHostIntentBody<'respondAsk'> = {
      sessionId: 's', requestId: 'request', answer: 'yes', wasFreeform: false,
    };
    const answered: Promise<{ ok: boolean }> = host.call('respondAsk', answer);
    const read: ModuleHostIntentBody<'session/chat'> = {
      sessionId: 's', source: 'live', direction: 'backward', max: 10, waitMs: 0,
      bootstrap: true, agentScope: 'primary', types: ['assistant.message'],
    };
    const page: ModuleHostIntentResult<'session/chat'> = {
      sessionId: 's', source: 'live', direction: 'backward', events: [],
      cursor: 'opaque', cursorStatus: 'expired', hasMore: false, liveCursor: 'tail',
      read: { rpc: 2, events: 0 },
    };
    const reading: Promise<typeof page> = host.call('session/chat', read);
    // @ts-expect-error An answer must retain its original native request identity.
    host.call('respondAsk', { sessionId: 's', answer: 'yes', wasFreeform: false });
    // @ts-expect-error No arbitrary intent passthrough is exposed.
    host.call('respondPlan', { sessionId: 's', requestId: 'r', action: 'interactive' });
    // @ts-expect-error Expiry cannot be represented as an invented success status.
    const invalidStatus: typeof page.cursorStatus = 'unknown';
    void [askVersion, chatVersion, promptVersion, delivered, answered, reading, invalidStatus];
    void [backend, response, created, invalid];
  ` })),
  ...['frontend-18', 'frontend-19'].map(name => ({ name, types: ['react'], lib: ['ES2022', 'DOM'], source: `
    import type * as React from 'react';
    import type { ModuleFrontend, ModuleGlobalComponent, ModulePage, ModuleNavigation, LegacyModuleFrontendContext, ModuleFrontendContext, ModuleAsset, ComposerProps, SettingsProps, ModuleComponentMiddleware, DraftOwnerOptions, DraftOwner, DraftTransportOutcome } from '@waksana/cockpit-module-sdk/frontend';
    declare const frontend: ModuleFrontendContext;
    declare const asset: ModuleAsset;
    declare const props: ComposerProps;
    const children: React.ReactNode = props.children;
    const apiVersion: 3 = frontend.apiVersion;
    const componentVersion: 1 = frontend.publicComponentsVersion;
    const ownerVersion: 1 = frontend.draftOwnerVersion;
    const messagePresentationVersion: 1 = frontend.messagePresentationVersion;
    const conversationPresentationVersion: 1 = frontend.conversationPresentationVersion;
    const Frame = frontend.components.get('conversationFrame');
    const Header = frontend.components.get('conversationHeader');
    const Transcript = frontend.components.get('conversationTranscript');
    const scroll = frontend.conversation.useScroll({ key: 'synthetic-view', items: [{ id: 'one' }], itemKey: item => item.id });
    scroll.changed({ contentReady: true, newContent: false });
    const transcript: import('@waksana/cockpit-module-sdk/frontend').ConversationTranscriptProps = {
      viewportRef: scroll.viewportRef, contentRef: scroll.contentRef, awayFromBottom: scroll.awayFromBottom,
      hasNewContent: scroll.hasNewContent, onFollow: scroll.follow,
    };
    // @ts-expect-error Presentation does not accept a native session or routing target.
    const badFrame: import('@waksana/cockpit-module-sdk/frontend').ConversationFrameProps = { composer: null, sessionId: 'native' };
    const MessageList = frontend.components.get('messageList');
    const ChatMessage = frontend.components.get('chatMessage');
    const chatMessage: import('@waksana/cockpit-module-sdk/frontend').ChatMessageProps = {
      identity: { owner: 'module', id: 'one', kind: 'message', role: 'user' },
      role: 'user', timestamp: 1000, complete: true, body: '**Hello**',
      attachments: [{ type: 'file', path: '/synthetic/file.txt' }],
      previous: { role: 'assistant', timestamp: 999 }, 'data-message-key': 'one', header: 'Topic',
    };
    const submissionVersion: 2 = frontend.draftSubmissionVersion;
    const Composer: React.ComponentType<ComposerProps> = frontend.components.get('composer');
    // @ts-expect-error Component names remain a finite typed catalog.
    frontend.components.get('invented-slot');
    declare const ownerOptions: DraftOwnerOptions<{ requestId: string }, { accepted: true }>;
    const owner: DraftOwner = frontend.state.createDraft(ownerOptions);
    const noNativeTarget: string | undefined = owner.reference.sessionId;
    const editable: boolean = owner.reference.getSnapshot().editable;
    const actionRevision: number = owner.reference.getSnapshot().actionRevision;
    const result: Promise<import('@waksana/cockpit-module-sdk/frontend').DraftSendResult> = owner.reconcile('original-submission');
    const rejection: DraftTransportOutcome<{ accepted: true }> = { status: 'rejected', reason: 'Not accepted' };
    // @ts-expect-error Enhancer draft bindings cannot settle an owner transaction.
    frontend.state.bindDraft(owner.reference).reconcile('original-submission');
    void [componentVersion, ownerVersion, submissionVersion, Composer, noNativeTarget, editable, actionRevision, result, rejection,
      messagePresentationVersion, MessageList, ChatMessage, chatMessage,
      conversationPresentationVersion, Frame, Header, Transcript, transcript, badFrame];
    const settingsVersion: 1 = frontend.settingsVersion;
    const globalVersion: 1 | undefined = frontend.globalComponentVersion;
    const globalComponent: ModuleGlobalComponent = { id: 'dialog', component: () => null };
    const pageVersion: 1 = frontend.pageVersion;
    const navigation: ModuleNavigation = frontend.navigation;
    const path: string = navigation.path('main');
    const page: ModulePage = { id: 'main', component: () => null };
    navigation.navigate(page.id);
    navigation.home();
    declare const legacy: LegacyModuleFrontendContext;
    // @ts-expect-error Legacy activation does not receive page navigation.
    legacy.navigation.home();
    // @ts-expect-error Legacy activation does not receive complete message presentation.
    legacy.messagePresentationVersion;
    // @ts-expect-error Legacy activation does not receive the shared Chat owner.
    legacy.conversation.useScroll({ key: 'legacy' });
    // @ts-expect-error The host does not pass private router/session props to pages.
    const badPage: ModulePage = { id: 'bad', component: (props: { router: unknown }) => null };
    const declaration: ModuleFrontend = { apiVersion: 3, globalComponents: [globalComponent], pages: [page] };
    // @ts-expect-error Global components receive no host session props.
    const badGlobal: ModuleGlobalComponent = { id: 'bad', component: (props: { sessionId: string }) => null };
    void [globalVersion, declaration, badGlobal, pageVersion, path, badPage];
    declare const settings: SettingsProps;
    const settingsChildren: React.ReactNode = settings.children;
    const labelledBy: string | undefined = settings['aria-labelledby'];
    const middleware: ModuleComponentMiddleware = { id: 'settings', boundary: 'settings', wrap: Base => Base };
    // @ts-expect-error settings do not expose a native session or arbitrary settings store.
    const sessionId = settings.sessionId;
    void [children, apiVersion, settingsVersion, settingsChildren, labelledBy, middleware, sessionId, asset.id];
  ` })),
];

test('module SDK archive is standalone across the supported consumer matrix', { timeout: 300_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-module-sdk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (command, args, cwd) => execFileSync(command, args, {
    cwd, encoding: 'utf8', timeout: 120_000, stdio: 'pipe',
  });
  const packOutput = run('pnpm', ['pack', '--pack-destination', root, '--json'], sdkRoot);
  const archive = JSON.parse(packOutput.slice(packOutput.lastIndexOf('\n{') + 1)).filename;
  const files = run('tar', ['-tzf', archive], root).trim().split('\n');
  for (const entry of ['index', 'backend', 'frontend', 'contract', 'wire', 'manifest']) {
    for (const extension of ['js', 'd.ts']) assert.ok(files.includes(`package/dist/${entry}.${extension}`));
  }
  for (const file of ['runtime.js', 'runtime.d.ts', 'LICENSE']) assert.ok(files.includes(`package/${file}`));
  assert.ok(files.every(file => /^(?:package\/(?:dist\/[^/]+|runtime\.(?:js|d\.ts)|package\.json|LICENSE))$/.test(file)),
    'SDK archive must not include host, source, runtime dependencies or workspace files');

  const manifest = JSON.parse(run('tar', ['-xOzf', archive, 'package/package.json'], root));
  assert.equal(manifest.name, '@waksana/cockpit-module-sdk');
  assert.equal(manifest.version, JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')).version);
  assert.equal(manifest.publishConfig.registry, 'https://npm.pkg.github.com');
  assert.equal(manifest.dependencies, undefined);
  assert.doesNotMatch(JSON.stringify(manifest), /(?:workspace|file):/);

  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const consumer = join(root, fixture.name);
      cpSync(join(repository, 'scripts/fixtures/module-sdk', fixture.name), consumer, { recursive: true });
      run('npm', ['ci', ...npmOptions], consumer);
      run('npm', ['install', '--no-save', ...npmOptions, archive], consumer);
      const frontend = fixture.name.startsWith('frontend');
      assert.equal(existsSync(join(consumer, 'node_modules/react')), frontend);
      assert.equal(existsSync(join(consumer, 'node_modules/@types/react')), frontend);
      assert.equal(existsSync(join(consumer, 'node_modules/@types/node')), fixture.name.startsWith('backend'));
      writeFileSync(join(consumer, 'consume.mts'), fixture.source);
      for (const [module, moduleResolution] of [['NodeNext', 'NodeNext'], ['ESNext', 'Bundler']]) {
        writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { noEmit: true, strict: true, skipLibCheck: false, target: 'ES2022',
            module, moduleResolution, lib: fixture.lib, types: fixture.types },
          files: ['consume.mts'],
        }));
        run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], consumer);
      }
      if (fixture.name === 'common') {
        writeFileSync(join(consumer, 'consume.mts'), `
          import type { ModuleBackend } from '@waksana/cockpit-module-sdk/backend';
          import type { ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';
          declare const backend: ModuleBackend, frontend: ModuleFrontendContext;
          void [backend, frontend];
        `);
        assert.throws(() => run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], consumer),
          error => error.status !== 0 && /Cannot find module 'node:stream'/.test(error.stdout)
            && /Cannot find module 'react'/.test(error.stdout),
          'Environment entries must require their peers rather than degrade to any');
      }
      run(process.execPath, ['--input-type=module', '--eval', `
        import assert from 'node:assert/strict';
        import { MAX_MODULE_EVENT_BYTES } from '@waksana/cockpit-module-sdk';
        import { MCP_INVOCATION_META_KEY } from '@waksana/cockpit-module-sdk/runtime';
        import '@waksana/cockpit-module-sdk/backend';
        import '@waksana/cockpit-module-sdk/frontend';
        assert.equal(MAX_MODULE_EVENT_BYTES, 65536);
        assert.equal(MCP_INVOCATION_META_KEY, 'cockpit/invocation');
        await assert.rejects(import('@waksana/cockpit-module-sdk/dist/contract.js'),
          { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
      `], consumer);
    });
  }

  await t.test('runtime-only installation does not auto-install optional peers', () => {
    const consumer = join(root, 'runtime');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}');
    run('npm', ['install', ...npmOptions, archive], consumer);
    for (const dependency of ['react', '@types/react', '@types/node']) {
      assert.equal(existsSync(join(consumer, 'node_modules', dependency)), false);
    }
    assert.equal(run(process.execPath, ['--input-type=module', '--eval',
      "import { MAX_MODULE_EVENT_BYTES } from '@waksana/cockpit-module-sdk/runtime'; process.stdout.write(String(MAX_MODULE_EVENT_BYTES));"],
    consumer), '65536');
  });
});
