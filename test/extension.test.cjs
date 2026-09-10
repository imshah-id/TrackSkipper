const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const settle = () => new Promise(resolve => setImmediate(resolve));
function host() {
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
  let open, pickGate;
  const vscode = {
    env: {}, workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/repo' } }],
      getConfiguration: () => ({ get: () => 1024 }) },
    Uri: { joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts), toString() { return this.fsPath; } }) },
    ViewColumn: { Active: 1 }, ProgressLocation: { Notification: 1 },
    commands: { registerCommand: (_, callback) => { open = callback; return { dispose() {} }; } },
    window: {
      registerTreeDataProvider: () => ({ dispose() {} }),
      showErrorMessage: async () => {}, showWarningMessage: async () => 'Replace session',
      showInputBox: async () => '6', showQuickPick: async items => pickGate ? await pickGate(items) : items[0],
      withProgress: async (_, callback) => callback({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
      createWebviewPanel() {
        const panel = { visible: true, messages: [], reveal() {},
          onDidChangeViewState(callback) { this.change = callback; },
          onDidDispose(callback) { this.close = callback; },
          webview: { cspSource: 'local', asWebviewUri: uri => uri,
            onDidReceiveMessage(callback) { panel.receive = callback; },
            postMessage(message) { panel.messages.push(message); return Promise.resolve(true); } } };
        panels.push(panel); return panel;
      },
    },
  };
  const mocks = {
    vscode,
    'node:fs/promises': { stat: async () => ({ size: 100 }), readFile: async () => JSON.stringify(savedPlan) },
    './git': { gitText: async (_, args) => args.includes('--show-toplevel') ? '/repo' : oid,
      commitPage: async () => [{ oid, parentOid: null, subject: 'Commit' }], objectInfo: async () => {}, disposeGit: async () => {} },
    './plan': { preparePlan: async () => replacementPlan,
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
    globalState: { get: () => oldStore.root, update: async () => {} }, subscriptions: [] });
  const send = async (type, values = {}, sessionId = 'session-one') => {
    panels.at(-1).receive({ type, sessionId, ...values });
    for (let i = 0; i < 5; i++) await settle();
  };
  return { panels, controllers, stores, open: () => open(), send,
    setPicker: callback => { pickGate = callback; },
    close: async () => { panels.at(-1).close(); await settle(); },
    dispose: () => extension.deactivate(),
  };
}

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
    await app.open();
    let release;
    app.setPicker(items => new Promise(resolve => { release = () => { app.setPicker(undefined); resolve(items[0]); }; }));
    await app.send('configure');
    assert.equal(typeof release, 'function');
    await app.send('clear');
    release();
    for (let i = 0; i < 10; i++) await settle();
    assert.equal(app.stores[0].clears, 1);
    assert.equal(app.stores[1].clears, 0);
  } finally { await app.dispose(); }
});
