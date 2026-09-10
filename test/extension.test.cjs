const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const settle = () => new Promise(resolve => setImmediate(resolve));
function host(options = {}) {
  const panels = [], controllers = [], stores = [];
  const oid = 'a'.repeat(40), root = '/extension-storage/sessions';
  const makePlan = id => ({ version: 1, id, root: `${root}/${id}`, repo: '/repo', startOid: oid, endOid: oid,
    timing: { mode: 'speed', charactersPerSecond: 24, pointerMultiplier: 1 },
    totals: { minimumMs: 1, preferredMs: 1000, weight: 1, records: 2 },
    summary: { commits: 1, animated: 2, snapshots: 0, bytes: 20 } });
  const savedPlan = makePlan('session-one'), replacementPlan = makePlan('session-two');
  const record = name => ({ kind: 'text', ordinal: 0, change: { commitOid: oid,
    pathBase64: Buffer.from(name).toString('base64'), newOid: oid }, reason: null });
  const makeStore = plan => {
    const store = { root: plan.root, clears: 0, clear: async () => { store.clears++; },
      refreshUsage: async () => {}, checkpoint: async () => {},
      readCheckpoint: async () => ({ status: 'paused', timing: plan.timing }), save: async () => {} };
    stores.push(store); return store;
  };
  const oldStore = makeStore(savedPlan), newStore = makeStore(replacementPlan);
  let open, warningGate, workspaceChange, configurationChange;
  const gitCalls = [], preparations = [], savedRoots = [], executedCommands = [];
  const roots = options.roots ?? { '/repo': '/repo' };
  const vscode = {
    env: {}, workspace: { isTrusted: true, workspaceFolders: (options.folders ?? ['/repo']).map(fsPath => ({ uri: { scheme: 'file', fsPath } })),
      onDidChangeWorkspaceFolders: callback => { workspaceChange = callback; return { dispose() {} }; },
      onDidChangeConfiguration: callback => { configurationChange = callback; return { dispose() {} }; },
      getConfiguration: section => ({ get: (key, fallback) => section === 'gitReplay' ? 1024 : options.editor?.[key] ?? fallback }) },
    extensions: { getExtension: () => options.gitRepositories ? { isActive: true, exports: { getAPI: () => ({ repositories: options.gitRepositories.map(fsPath => ({ rootUri: { scheme: 'file', fsPath } })) }) } } : undefined },
    Uri: { joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts), toString() { return this.fsPath; } }) },
    ViewColumn: { Active: 1 }, ProgressLocation: { Notification: 1 },
    commands: { registerCommand: (_, callback) => { open = callback; return { dispose() {} }; }, executeCommand: async name => { executedCommands.push(name); } },
    window: {
      activeTextEditor: options.activeFile ? { document: { uri: { scheme: 'file', fsPath: options.activeFile } } } : undefined,
      registerTreeDataProvider: () => ({ dispose() {} }),
      showErrorMessage: async () => {}, showWarningMessage: async () => warningGate ? await warningGate() : 'Replace session',
      showOpenDialog: async () => options.browse ? [{ scheme: 'file', fsPath: options.browse }] : undefined,
      withProgress: async (_, callback) => callback({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
      createWebviewPanel() {
        vscode.window.activeTextEditor = undefined;
        const panel = { visible: true, messages: [], reveal() {},
          onDidChangeViewState(callback) { this.change = callback; },
          onDidDispose(callback) { this.close = callback; },
          webview: { cspSource: 'local', asWebviewUri: uri => uri,
            onDidReceiveMessage(callback) { panel.receive = callback; },
            postMessage(message) { panel.messages.push(structuredClone(message)); return Promise.resolve(true); } } };
        panels.push(panel); return panel;
      },
    },
  };
  const mocks = {
    vscode,
    'node:fs/promises': { realpath: async value => options.canonical?.[value] ?? value, stat: async () => ({ size: 100 }), readFile: async () => JSON.stringify(savedPlan) },
    './git': { gitText: async (repo, args) => {
      gitCalls.push({ repo, args });
      if (options.gitError) throw new Error(options.gitError);
      if (args.includes('--show-toplevel')) {
        if (!roots[repo]) throw new Error('not a git repository');
        return roots[repo];
      }
      if (args.includes('symbolic-ref') || args.includes('--abbrev-ref')) return 'main';
      if (options.empty?.includes(repo)) throw new Error('Needed a single revision');
      return oid;
    }, commitPage: async (repo, tip) => {
      gitCalls.push({ repo, tip });
      if (options.pageError?.includes(repo)) throw new Error('Git object unavailable');
      return options.pages?.[tip] ?? [{ oid, parentOid: null, subject: 'Commit' }];
    }, objectInfo: async () => {}, disposeGit: async () => {} },
    './plan': { preparePlan: async (repo, startOid, endOid, timing, _, signal) => {
      preparations.push({ repo, startOid, endOid, timing });
      if (options.prepareGate) await options.prepareGate(signal);
      if (options.prepareError) throw new Error(options.prepareError);
      return { ...replacementPlan, repo, startOid, endOid, timing };
    },
      readRecords: async function* (_, offset) { yield { record: record(offset === 100 ? 'b.ts' : 'a.ts'), offset, nextOffset: offset + 100 }; },
      textBlob: async () => Array.from({ length: 200 }, (_, index) => `b line ${index}`).join('\n') },
    './store': { openStore: async () => oldStore, createStore: async () => newStore },
    './replay': { systemClock: {}, createReplay(plan, _, events) {
      let status = 'ready';
      const action = { kind: 'type', target: 'code', editIndex: 0 };
      const controller = { visible: true,
        getState: () => ({ status, timing: plan.timing, totalMs: 1000, record: record('a.ts'),
          position: { recordOffset: 0, playbackElapsedMs: 0 } }),
        emit(firstLine = 0) { if (controller.visible) events.frame({ firstLine, lines: ['active a.ts'], caret: null }, action, 0, 1000); },
        setVisible(visible) { controller.visible = visible; if (visible) controller.emit(); },
        async start() { status = 'running'; events.record(record('a.ts')); controller.emit(); },
        async pause() { status = 'paused'; controller.emit(); },
        resume() { status = 'running'; controller.emit(); },
        setViewport(firstLine) { controller.emit(firstLine); },
        async dispose() {},
      };
      controllers.push(controller); return controller;
    } },
  };
  const extension = {};
  vm.runInNewContext(readFileSync(path.join(__dirname, '../dist/extension.js'), 'utf8'), {
    exports: extension, require: name => mocks[name] ?? require(name.startsWith('.') ? path.join(__dirname, '../dist', name) : name),
    Buffer, performance, setTimeout, clearTimeout, AbortController,
  });
  extension.activate({ globalStorageUri: { fsPath: '/extension-storage' }, extensionUri: { fsPath: '/extension' },
    globalState: { get: () => options.saved === false ? undefined : oldStore.root, update: async (_, value) => { savedRoots.push(value); } }, subscriptions: [] });
  const send = async (type, values = {}, sessionId = options.saved === false ? 'idle' : 'session-one') => {
    panels.at(-1).receive({ type, sessionId, ...values });
    for (let i = 0; i < 5; i++) await settle();
  };
  const setup = () => {
    const message = panels.at(-1).messages.filter(message => message.type === 'setup').at(-1);
    assert.ok(message, 'panel ready should publish repository setup state');
    return message.setup;
  };
  return { panels, controllers, stores, gitCalls, preparations, savedRoots, executedCommands, open: () => open(), send, setup,
    state: () => panels.at(-1).messages.filter(message => message.type === 'state').at(-1),
    prepare: async () => { const current = setup();
      await send('prepare', { repositoryId: current.selectedRepositoryId, startOid: current.commits[0].oid, endOid: current.endOid, timing: savedPlan.timing }); },
    setWarning: callback => { warningGate = callback; },
    configurationChange: () => configurationChange({ affectsConfiguration: section => section === 'editor' }),
    workspaceChange: async folders => { vscode.workspace.workspaceFolders = folders.map(fsPath => ({ uri: { scheme: 'file', fsPath } })); workspaceChange(); for (let i = 0; i < 10; i++) await settle(); },
    close: async () => { panels.at(-1).close(); await settle(); },
    dispose: () => extension.deactivate(),
  };
}

test('fullscreen uses the native window toggle from setup and playback with no replay changes', async () => {
  for (const saved of [false, true]) {
    const app = host({ saved });
    try {
      await app.open();
      await app.send('fullscreen', {}, 'stale-session');
      await app.send('fullscreen', { command: 'arbitrary.command' });
      assert.equal(app.executedCommands.length, 0);
      await app.send('fullscreen'); await app.send('fullscreen');
      assert.deepEqual(app.executedCommands, ['workbench.action.toggleFullScreen', 'workbench.action.toggleFullScreen']);
      assert.equal(app.controllers.length, 0);
      assert.equal(app.preparations.length, 0);
    } finally { await app.dispose(); }
  }
});

test('reopened panel makes the existing paused replay visible before resume', async () => {
  const app = host();
  try {
    await app.open(); await app.send('resume'); await app.close();
    assert.equal(app.controllers[0].visible, false);
    await app.open(); await app.send('ready');
    assert.equal(app.controllers[0].visible, true);
  } finally { await app.dispose(); }
});

test('concurrent open commands share one recovering panel', async () => {
  const app = host();
  try {
    await Promise.all([app.open(), app.open()]);
    assert.equal(app.panels.length, 1);
  } finally { await app.dispose(); }
});

test('scrolling a browsed file keeps that file selected', async () => {
  const app = host();
  try {
    await app.open(); await app.send('resume'); await app.send('pause');
    await app.send('browse', { offset: 100 });
    assert.equal(app.panels.at(-1).messages.at(-1).activePath, 'b.ts');
    assert.equal(app.panels.at(-1).title, 'b.ts', 'native tab follows the displayed file');
    await app.send('viewport', { firstLine: 6 });
    const state = app.panels.at(-1).messages.at(-1);
    assert.equal(state.activePath, 'b.ts');
    assert.equal(state.frame.firstLine, 6);
    assert.match(state.frame.lines[0], /^b line 6/);
  } finally { await app.dispose(); }
});

test('queued old-session controls cannot clear a newly configured session', async () => {
  const app = host();
  try {
    await app.open(); await app.send('ready');
    let release;
    app.setWarning(() => new Promise(resolve => { release = () => resolve('Replace session'); }));
    await app.prepare();
    assert.equal(typeof release, 'function');
    await app.send('clear');
    release();
    for (let i = 0; i < 10; i++) await settle();
    assert.equal(app.stores[0].clears, 1);
    assert.equal(app.stores[1].clears, 0);
  } finally { await app.dispose(); }
});


test('ready discovers canonical workspace and Git API roots and prefers the active editor repository', async () => {
  const app = host({ saved: false, folders: ['/workspace', '/alias'], activeFile: '/workspace/nested/src/a.ts',
    gitRepositories: ['/workspace/nested'], roots: { '/workspace': '/repo', '/alias': '/alias', '/workspace/nested/src': '/workspace/nested', '/workspace/nested': '/workspace/nested' }, canonical: { '/alias': '/repo' } });
  try {
    await app.open(); await app.send('ready');
    const setup = app.setup();
    assert.equal(setup.repositories.length, 2);
    assert.equal(setup.repositories.find(repo => repo.id === setup.selectedRepositoryId).path, '/workspace/nested');
    assert.equal(setup.commits[0].oid, 'a'.repeat(40));
    assert.equal(setup.endOid, 'a'.repeat(40));
    assert.equal(setup.error, null);
    assert.equal(setup.loading, false);
    await app.prepare();
    assert.equal(app.preparations[0].repo, '/workspace/nested');
    assert.equal(app.controllers[0].getState().status, 'running');
    const reads = app.gitCalls.length;
    app.controllers[0].emit(); app.controllers[0].emit();
    assert.equal(app.gitCalls.length, reads);
    assert.equal('setup' in app.state(), false);
  } finally { await app.dispose(); }
});

test('an empty workspace offers browse and starts a chosen local folder', async () => {
  const app = host({ saved: false, folders: [], roots: { '/chosen': '/chosen' }, browse: '/chosen' });
  try {
    await app.open(); await app.send('ready');
    assert.match(app.setup().error, /browse|folder/i);
    assert.equal(app.setup().selectedRepositoryId, null);
    await app.send('repositoryBrowse');
    assert.equal(app.setup().repositories[0].path, '/chosen');
    assert.equal(app.setup().error, null);
    await app.prepare();
    assert.equal(app.preparations[0].repo, '/chosen');
    assert.equal(app.state().status, 'running');
  } finally { await app.dispose(); }
});

test('switching to an empty or unreadable repository clears stale commits and rejects the previous selection', async () => {
  const app = host({ folders: ['/repo', '/empty', '/broken'], roots: { '/repo': '/repo', '/empty': '/empty', '/broken': '/broken' }, empty: ['/empty'], pageError: ['/broken'] });
  try {
    await app.open(); await app.send('ready');
    const previous = app.setup();
    for (const folder of ['/empty', '/broken']) {
      const repository = previous.repositories.find(repo => repo.path === folder);
      await app.send('repository', { repositoryId: repository.id });
      assert.equal(app.setup().selectedRepositoryId, repository.id);
      assert.equal(app.setup().commits.length, 0);
      assert.match(app.setup().error, /commit|Git|folder/i);
      await app.send('prepare', { repositoryId: previous.selectedRepositoryId, startOid: previous.commits[0].oid,
        endOid: previous.endOid, timing: { mode: 'duration', durationMs: 1000 } });
      assert.equal(app.preparations.length, 0);
      assert.equal(app.stores[0].clears, 0);
    }
  } finally { await app.dispose(); }
});

test('commit paging stays on pinned history and rejects arbitrary cursors or repository paths', async () => {
  const newest = 'a'.repeat(40), older = 'b'.repeat(40);
  const app = host({ pages: { [newest]: [{ oid: newest, parentOid: older, subject: 'Latest' }], [older]: [{ oid: older, parentOid: null, subject: 'Earlier' }] } });
  try {
    await app.open(); await app.send('ready');
    const selected = app.setup().selectedRepositoryId;
    await app.send('repository', { repositoryId: '/repo' });
    assert.equal(app.setup().selectedRepositoryId, selected);
    const count = app.gitCalls.length;
    await app.send('commits', { cursor: 'c'.repeat(40) });
    assert.equal(app.gitCalls.length, count);
    await app.send('commits', { cursor: older });
    assert.equal(app.setup().commits[0].oid, older);
    assert.equal(app.setup().endOid, newest);
    assert.equal(app.setup().nextCursor, null);
    await app.send('commits', { cursor: null });
    assert.equal(app.setup().commits[0].oid, newest);
    await app.send('prepare', { repositoryId: selected, startOid: older, endOid: newest, timing: { mode: 'duration', durationMs: 1000 } });
    assert.equal(app.preparations.length, 1);
    assert.equal(app.preparations[0].startOid, older);
  } finally { await app.dispose(); }
});

test('Git failures are visible in setup and a workspace change can recover discovery', async () => {
  const options = { saved: false, gitError: 'spawn git ENOENT', roots: { '/repo': '/repo', '/other': '/other' } };
  const app = host(options);
  try {
    await app.open(); await app.send('ready');
    assert.match(app.setup().error, /git/i);
    assert.match(app.setup().error, /install|browse|folder/i);
    options.gitError = undefined;
    await app.workspaceChange(['/other']);
    assert.equal(app.setup().repositories[0].path, '/other');
    assert.equal(app.setup().error, null);
  } finally { await app.dispose(); }
});

test('failed preparation and declined replacement preserve the saved replay', async () => {
  const options = { prepareError: 'Selected start is outside the ending commit first-parent chain' };
  const app = host(options);
  try {
    await app.open(); await app.send('ready'); await app.prepare();
    assert.equal(app.stores[0].clears, 0);
    assert.equal(app.stores[1].clears, 1);
    assert.equal(app.savedRoots.length, 0);
    assert.equal(app.state().sessionId, 'session-one');
    assert.match(app.setup().error, /first-parent/);
    app.setWarning(async () => undefined);
    options.prepareError = undefined;
    await app.prepare();
    assert.equal(app.preparations.length, 1);
    assert.equal(app.stores[0].clears, 0);
  } finally { await app.dispose(); }
});


test('playback uses editor typography and updates it when editor settings change', async () => {
  const options = { editor: { fontFamily: 'Mono Test', fontSize: 17, fontWeight: '500', lineHeight: 23, tabSize: 2 } };
  const app = host(options);
  try {
    await app.open(); await app.send('ready');
    assert.deepEqual(app.state().editor, options.editor);
    options.editor.fontSize = 19;
    app.configurationChange();
    assert.equal(app.state().editor.fontSize, 19);
  } finally { await app.dispose(); }
});

test('repository discovery and commit payloads are bounded', async () => {
  const folders = Array.from({ length: 120 }, (_, index) => `/repo-${index}`);
  const app = host({ saved: false, folders, roots: Object.fromEntries(folders.map(folder => [folder, folder])),
    pages: { ['a'.repeat(40)]: Array.from({ length: 120 }, (_, index) => ({ oid: index.toString(16).padStart(40, '0'), parentOid: (index + 1).toString(16).padStart(40, '0'), subject: 'Commit' })) } });
  try {
    await app.open(); await app.send('ready');
    assert.equal(app.setup().repositories.length, 100);
    assert.equal(app.setup().commits.length, 100);
    assert.equal(app.setup().nextCursor, '64'.padStart(40, '0'));
  } finally { await app.dispose(); }
});

test('the Git extension can supply nested repositories when the workspace root is not Git', async () => {
  const app = host({ saved: false, folders: ['/workspace'], gitRepositories: ['/workspace/nested'], roots: { '/workspace/nested': '/workspace/nested' } });
  try {
    await app.open(); await app.send('ready');
    assert.equal(app.setup().repositories[0].path, '/workspace/nested');
    assert.equal(app.setup().error, null);
    const reads = app.gitCalls.length;
    await app.close(); await app.open(); await app.send('ready');
    assert.equal(app.setup().repositories[0].path, '/workspace/nested');
    assert.equal(app.gitCalls.length, reads);
  } finally { await app.dispose(); }
});


test('cancelling preparation removes only the candidate session and preserves the saved replay', async () => {
  const app = host({ prepareGate: signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  try {
    await app.open(); await app.send('ready'); await app.prepare();
    assert.equal(app.state().status, 'preparing');
    await app.send('stop');
    assert.equal(app.stores[0].clears, 0);
    assert.equal(app.stores[1].clears, 1);
    assert.equal(app.savedRoots.length, 0);
    assert.equal(app.state().sessionId, 'session-one');
    assert.equal(app.state().status, 'paused');
    assert.match(app.setup().error, /cancel/i);
  } finally { await app.dispose(); }
});

test('session promotion disables cancellation before clearing the previous session', async () => {
  let preparationSignal, release;
  const app = host({ prepareGate: signal => { preparationSignal = signal; } });
  const clear = app.stores[0].clear;
  app.stores[0].clear = async () => { await new Promise(resolve => { release = resolve; }); await clear(); };
  try {
    await app.open(); await app.send('ready'); await app.prepare();
    assert.equal(typeof release, 'function');
    await app.send('stop');
    assert.equal(preparationSignal.aborted, false, 'Stop must no longer abort once session promotion begins');
    assert.equal(app.state().status, 'preparing');
    assert.equal(app.state().canCancelPreparation, false);
    assert.match(app.state().notice, /starting replay/i);
    release();
    for (let i = 0; i < 10; i++) await settle();
    assert.equal(app.stores[0].clears, 1);
    assert.equal(app.stores[1].clears, 0);
    assert.equal(app.state().sessionId, 'session-two');
    assert.equal(app.state().status, 'running');
  } finally { release?.(); await settle(); await app.dispose(); }
});

test('cancellation accepted immediately before promotion preserves the previous session', async () => {
  let release;
  const app = host();
  app.stores[1].refreshUsage = async () => new Promise(resolve => { release = resolve; });
  try {
    await app.open(); await app.send('ready'); await app.prepare();
    assert.equal(typeof release, 'function');
    assert.equal(app.state().canCancelPreparation, true);
    await app.send('stop');
    release();
    for (let i = 0; i < 10; i++) await settle();
    assert.equal(app.stores[0].clears, 0);
    assert.equal(app.stores[1].clears, 1);
    assert.equal(app.savedRoots.length, 0);
    assert.equal(app.state().sessionId, 'session-one');
    assert.equal(app.state().status, 'paused');
    assert.equal(app.state().canCancelPreparation, false);
    assert.match(app.setup().error, /cancel/i);
  } finally { release?.(); await settle(); await app.dispose(); }
});
