import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { commitPage, disposeGit, gitText, objectInfo, readTree, TreeFile } from './git';
import { preparePlan, readRecords, textBlob } from './plan';
import { createReplay, systemClock } from './replay';
import { createTextView, frameAt } from './view';
import { createStore, openStore, Store } from './store';
import { panelHtml, validCommand, PanelCommand } from './panel';
import { Checkpoint, Frame, Phase, Plan, LIMITS } from './types';
import { validateTiming } from './timing';
import { createNativeInput } from './input';

let shutdown: (() => Promise<void>) | undefined;
export function activate(context: vscode.ExtensionContext): void {
  const storageRoot = path.join(context.globalStorageUri.fsPath, 'sessions');
  let sidebar: vscode.WebviewView | undefined;
  let sessionLoading: Promise<void> | undefined;
  let panel: vscode.WebviewPanel | undefined, store: Store | undefined, plan: Plan | undefined;
  let replay: ReturnType<typeof createReplay> | undefined, recovery: Checkpoint | null = null;
  let preparation: AbortController | undefined, busy = false, error = '', notice = '';
  let frame: Frame | undefined, phase: Phase | undefined, phaseElapsedMs = 0, phaseDurationMs = 0;
  let browseView: ReturnType<typeof createTextView> | undefined;
  let previewClosed = false, viewportRows = 30;
  let recent: Array<{ offset?: number; pathBase64?: string; label: string }> = [];
  let repositoryFiles: Array<TreeFile & { label: string }> = [];
  let currentCommit = '';
  let treeLoad: AbortController | undefined;
  let activePath = '', lastPost = 0, postTimer: NodeJS.Timeout | undefined;
  let commands = Promise.resolve();
  let opening: Promise<void> | undefined;
  type Repository = { id: string; name: string; path: string; branch: string };
  const setup: { loading: boolean; repositories: Repository[]; selectedRepositoryId: string | null;
    commits: Array<{ oid: string; subject: string }>; nextCursor: string | null; endOid: string | null; error: string | null } = {
    loading: false, repositories: [], selectedRepositoryId: null, commits: [], nextCursor: null, endOid: null, error: null,
  };
  let nativeStatus = 'Off';
  const native = createNativeInput(path.join(context.extensionUri.fsPath, 'native', 'input.py'),
    vscode.workspace.getConfiguration('gitReplay').get<string>('inputPython', '') || (process.platform === 'win32' ? 'python' : 'python3'),
    status => { if (nativeStatus !== status) { nativeStatus = status; send(true); } });
  let discovered = false;
  let repositoryHint: vscode.Uri | undefined;
  const browsedRoots: string[] = [];
  const quota = () => vscode.workspace.getConfiguration('gitReplay').get<number>('storageQuotaMiB', 1024) * 1024 ** 2;
  const sessionId = () => plan?.id ?? 'idle';
  const label = (encoded: string) => Buffer.from(encoded, 'base64').toString('utf8').replace(/[\x00-\x1f\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).slice(0, 1024);
  const editorSettings = () => {
    const configuration = vscode.workspace.getConfiguration('editor', vscode.window.activeTextEditor?.document.uri);
    return { fontFamily: configuration.get<string>('fontFamily', 'monospace'), fontSize: configuration.get<number>('fontSize', 14),
      fontWeight: configuration.get<string>('fontWeight', 'normal'), lineHeight: configuration.get<number>('lineHeight', 0), tabSize: configuration.get<number>('tabSize', 4) };
  };
  let editor = editorSettings();

  function openTab(tab: typeof recent[number]): void {
    const index = recent.findIndex(item => item.label === tab.label);
    if (index < 0) recent = [...recent, tab].slice(-5);
    else recent[index] = tab;
    previewClosed = false;
  }
  function followReplay(): void {
    previewClosed = false; browseView = undefined;
    const state = replay?.getState(), record = state?.record;
    if (record && record.kind !== 'milestone') openTab({ offset: state!.position.recordOffset, label: label(record.change.pathBase64) });
    replay?.follow();
  }

  function send(force = false): void {
    if (!panel?.visible && !sidebar?.visible) return;
    const wait = 100 - (performance.now() - lastPost);
    if (!force && wait > 0) { if (!postTimer) postTimer = setTimeout(() => { postTimer = undefined; send(); }, wait); return; }
    if (postTimer) clearTimeout(postTimer); postTimer = undefined; lastPost = performance.now();
    const state = replay?.getState();
    const title = activePath ? path.posix.basename(activePath) : 'Replay';
    if (panel && panel.title !== title) panel.title = title;
    const status = busy ? 'preparing' : error ? 'error' : state?.status ?? (recovery?.status === 'complete' ? 'complete' : recovery ? 'paused' : 'ready');
    const message = { type: 'state', sessionId: sessionId(), status, notice: error || notice, isError: !!error, canCancelPreparation: !!preparation,
      configured: !!plan, repository: plan ? path.basename(plan.repo) : '', start: plan?.startOid, end: plan?.endOid,
      timing: state?.timing ?? recovery?.timing ?? plan?.timing, totalMs: state?.totalMs ?? (plan?.timing.mode === 'duration' ? plan.timing.durationMs : plan?.totals.preferredMs ?? 0),
      elapsedMs: state?.position.playbackElapsedMs ?? recovery?.pausedPosition?.playbackElapsedMs ?? recovery?.playbackElapsedMs ?? 0,
      summary: plan?.summary, recordNumber: (state?.record?.ordinal ?? -1) + 1, recordCount: plan?.totals.records ?? 0,
      nativeStatus, subject: state?.record?.subject ?? '', frame, phase, phaseElapsedMs, phaseDurationMs,
      files: repositoryFiles.map(({ pathBase64, label, change }) => ({ pathBase64, label, change })), tabs: recent, activePath, editor };
    if (panel?.visible) void panel.webview.postMessage(message);
    if (sidebar?.visible) {
      const { files, tabs, frame, editor, phase, ...summary } = message;
      void sidebar.webview.postMessage(summary);
    }
  }
  function report(cause: unknown): void { error = cause instanceof Error ? cause.message : String(cause); if (!panel && !sidebar) void vscode.window.showErrorMessage(error); send(true); }

  function sendSetup(): void {
    for (const view of [panel, sidebar]) if (view?.visible) void view.webview.postMessage({ type: 'setup', sessionId: sessionId(), setup });
  }

  async function setupAction(action: () => Promise<void>): Promise<void> {
    setup.loading = true; setup.error = null; sendSetup();
    try {
      if (!vscode.workspace.isTrusted || vscode.env.remoteName) throw new Error('Open a trusted local Git workspace to use Git Replay.');
      await action();
    } catch (cause) { setup.error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 4096); }
    finally { setup.loading = false; sendSetup(); }
  }

  async function loadCommits(cursor: string | null): Promise<void> {
    const repository = setup.repositories.find(item => item.id === setup.selectedRepositoryId);
    if (!repository) throw new Error('Choose a repository or browse for a folder.');
    if (cursor !== null && cursor !== setup.nextCursor) throw new Error('Commit page expired. Load the latest commits and try again.');
    const signal = new AbortController().signal;
    setup.commits = []; setup.nextCursor = null;
    if (!setup.endOid) {
      try { setup.endOid = await gitText(repository.path, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], signal); }
      catch (cause) { throw new Error(`Cannot read this repository's latest commit. Create a commit or browse for another folder. ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    const commits = await commitPage(repository.path, cursor ?? setup.endOid, signal);
    setup.commits = commits.slice(0, 100).map(commit => ({ oid: commit.oid, subject: commit.subject.slice(0, 4096) }));
    setup.nextCursor = commits.at(99)?.parentOid ?? commits.at(-1)?.parentOid ?? null;
    if (!setup.commits.length) throw new Error('This repository has no commits. Create a commit or browse for another folder.');
  }

  async function selectRepository(repositoryId: string): Promise<void> {
    if (!setup.repositories.some(repository => repository.id === repositoryId)) throw new Error('Repository selection expired. Refresh repositories or browse for a folder.');
    setup.selectedRepositoryId = repositoryId; setup.endOid = null; setup.commits = []; setup.nextCursor = null;
    await loadCommits(null);
  }

  async function discover(): Promise<void> {
    discovered = true;
    const active = vscode.window.activeTextEditor?.document.uri ?? repositoryHint;
    const candidates = active?.scheme === 'file' ? [path.dirname(active.fsPath)] : [];
    candidates.push(...(vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath));
    try {
      const git = vscode.extensions.getExtension<{ getAPI(version: number): { repositories: Array<{ rootUri: vscode.Uri }> } }>('vscode.git');
      const api = git && (git.isActive ? git.exports : await git.activate()).getAPI(1);
      candidates.push(...(api?.repositories ?? []).filter(repository => repository.rootUri.scheme === 'file').map(repository => repository.rootUri.fsPath));
    } catch { /* Workspace and active-editor roots also work when the Git extension is disabled. */ }
    candidates.push(...browsedRoots);
    const previous = setup.repositories, repositories: Repository[] = [];
    let failure = '';
    for (const candidate of [...new Set(candidates)].slice(0, 100)) {
      try {
        const signal = new AbortController().signal;
        const root = await realpath(await gitText(candidate, ['rev-parse', '--show-toplevel'], signal));
        if (repositories.some(repository => repository.path === root)) continue;
        let branch = 'Detached HEAD';
        try { branch = await gitText(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal); } catch { /* Detached HEAD has no symbolic branch. */ }
        repositories.push({ id: previous.find(repository => repository.path === root)?.id ?? randomBytes(16).toString('hex'), name: path.basename(root), path: root, branch: branch.slice(0, 1024) });
      } catch (cause) { failure = cause instanceof Error ? cause.message : String(cause); }
    }
    setup.repositories = repositories; setup.selectedRepositoryId = null; setup.commits = []; setup.nextCursor = null; setup.endOid = null;
    if (!repositories.length) throw new Error(`No Git repository found. Browse for a repository folder and check that Git is installed.${failure ? ` ${failure}` : ''}`);
    await selectRepository(repositories[0].id);
  }

  async function browseRepository(): Promise<void> {
    const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Use repository', title: 'Choose a Git repository folder' });
    const folder = folders?.[0];
    if (!folder) return;
    if (folder.scheme !== 'file') throw new Error('Choose a local Git repository folder.');
    const signal = new AbortController().signal;
    const root = await realpath(await gitText(folder.fsPath, ['rev-parse', '--show-toplevel'], signal));
    let repository = setup.repositories.find(item => item.path === root);
    if (!repository) {
      if (setup.repositories.length >= 100) throw new Error('Repository list is full. Close unused workspace folders and refresh repositories.');
      let branch = 'Detached HEAD';
      try { branch = await gitText(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal); } catch { /* Detached HEAD. */ }
      repository = { id: randomBytes(16).toString('hex'), name: path.basename(root), path: root, branch: branch.slice(0, 1024) };
      setup.repositories.push(repository);
    }
    if (!browsedRoots.includes(root)) { browsedRoots.unshift(root); browsedRoots.length = Math.min(browsedRoots.length, 100); }
    await selectRepository(repository.id);
  }

  async function loadFiles(): Promise<void> {
    if (!plan) return;
    treeLoad?.abort();
    const activePlan = plan, commit = currentCommit, controller = new AbortController();
    treeLoad = controller;
    try {
      const files = await readTree(activePlan.repo, commit, controller.signal);
      if (plan !== activePlan || currentCommit !== commit || controller.signal.aborted) return;
      repositoryFiles = files.map(file => ({ ...file, label: label(file.pathBase64) }));
      send(true);
    } catch (cause) { if (!controller.signal.aborted && plan === activePlan && currentCommit === commit) report(cause); }
  }

  function attachReplay(): void {
    if (!plan || !store) return;
    const activePlan = plan, activeStore = store;
    replay = createReplay(activePlan, systemClock, {
      frame: (value, action, elapsed, duration) => { if (previewClosed || browseView) return; frame = value; phase = action; phaseElapsedMs = elapsed; phaseDurationMs = duration;
        const record = replay?.getState().record; if (record && record.kind !== 'milestone') activePath = label(record.change.pathBase64); send(); },
      progress: () => send(),
      status: status => { if (status !== 'running') native.stop(); send(); }, error: report,
      save: (record, signal) => activeStore.save(record, activePlan.repo, signal),
      checkpoint: async value => {
        await activeStore.checkpoint(value); recovery = value;
        if (value.status === 'complete') {
          busy = true; notice = 'Verifying reconstructed files…'; send();
          try { const result = await activeStore.verify(activePlan); notice = `Verified ${result.files} files · ${(result.bytes / 1024).toFixed(1)} KiB saved in this session.`; }
          finally { busy = false; }
          send();
        }
      },
      record: record => {
        browseView = undefined;
        const offset = replay!.getState().position.recordOffset;
        const oid = record.kind === 'milestone' ? record.commitOid : record.change.commitOid;
        if (oid !== currentCommit) { currentCommit = oid; repositoryFiles = []; void loadFiles(); }
        if (record.kind !== 'milestone') {
          activePath = label(record.change.pathBase64);
          openTab({ offset, label: activePath });
        }
        send();
      },
    });
    replay.setViewportRows(viewportRows);
    replay.setVisible(panel?.visible ?? false);
  }

  async function prepare(command: PanelCommand): Promise<void> {
    const repository = setup.repositories.find(item => item.id === command.repositoryId);
    if (!repository || command.repositoryId !== setup.selectedRepositoryId || command.endOid !== setup.endOid
      || !setup.commits.length) throw new Error('Replay selection expired. Choose a repository and start commit again.');
    validateTiming(command.timing);
    if (replay?.getState().status === 'running') throw new Error('Pause playback before starting another session.');
    if (store && await vscode.window.showWarningMessage('Replace the current replay session and its scratch files?', { modal: true }, 'Replace session') !== 'Replace session') return;
    native.stop();
    preparation = new AbortController(); const abort = preparation;
    busy = true; error = ''; notice = 'Preparing committed changes…'; send(true);
    let candidateStore: Store | undefined;
    try {
      candidateStore = await createStore(storageRoot, quota());
      const candidateRoot = candidateStore.root;
      const candidatePlan = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Git Replay', cancellable: true }, async (progress, token) => {
        const cancellation = token.onCancellationRequested(() => abort.abort(new Error('Preparation cancelled')));
        try { return await preparePlan(repository.path, command.startOid!, command.endOid!, command.timing!, candidateRoot, abort.signal, { quotaBytes: quota(), progress: message => { notice = message; progress.report({ message }); send(); } }); }
        finally { cancellation.dispose(); }
      });
      await candidateStore.refreshUsage();
      abort.signal.throwIfAborted();
      preparation = undefined; notice = 'Starting replay…'; send(true);
      treeLoad?.abort(); await replay?.dispose(); replay = undefined;
      if (store) await store.clear();
      store = candidateStore; plan = candidatePlan; candidateStore = undefined;
      await context.globalState.update('sessionRoot', store.root);
      recovery = null; frame = undefined; recent = []; repositoryFiles = []; currentCommit = ''; activePath = ''; browseView = undefined;
      notice = `${plan.summary?.commits} commits · ${plan.summary?.animated} animated files · ${plan.summary?.snapshots} snapshot events.`;
      await showPlayback();
      attachReplay(); await replay!.start();
    } catch (cause) { await candidateStore?.clear(); throw cause; }
    finally { preparation = undefined; busy = false; send(true); }
  }

  async function handle(command: PanelCommand): Promise<void> {
    if (command.sessionId !== sessionId()) return;
    error = '';
    if (command.type === 'ready') {
      send(true);
      if (!discovered) await setupAction(discover); else sendSetup();
      return;
    }
    if (command.type === 'showPlayback') { await showPlayback(); send(true); return; }
    if (command.type === 'configure') { await vscode.commands.executeCommand('gitReplay.launcher.focus'); return; }
    if (command.type === 'discover') { await setupAction(discover); return; }
    if (command.type === 'repository') { await setupAction(() => selectRepository(command.repositoryId!)); return; }
    if (command.type === 'repositoryBrowse') { await setupAction(browseRepository); return; }
    if (command.type === 'commits') { await setupAction(() => loadCommits(command.cursor!)); return; }
    if (command.type === 'prepare') { await setupAction(() => prepare(command)); return; }
    if (!plan || !store) return;
    if (['pause', 'stop', 'restart', 'clear'].includes(command.type)) native.stop();
    if (command.type === 'pause') await replay?.pause();
    if (command.type === 'start' || command.type === 'resume') {
      followReplay();
      if (!replay) attachReplay();
      if (replay!.getState().status === 'paused') replay!.resume();
      else if (replay!.getState().status === 'ready') {
        await objectInfo(plan.repo, plan.endOid, new AbortController().signal);
        await replay!.start(recovery ?? undefined);
      } else if (replay!.getState().status === 'stopped' || replay!.getState().status === 'error') {
        await replay!.dispose(); attachReplay(); await replay!.start(recovery ?? undefined);
      }
    }
    if (command.type === 'stop') await replay?.stop();
    if (command.type === 'restart') {
      treeLoad?.abort(); await replay?.dispose(); await store.reset(); recovery = null; frame = undefined; currentCommit = ''; recent = []; repositoryFiles = [];
      attachReplay(); await replay!.start();
    }
    if (command.type === 'speed') await replay?.setSpeed(command.charactersPerSecond!, command.pointerMultiplier!);
    if (command.type === 'viewport') {
      if (browseView) frame = frameAt(browseView, 0, browseView.newText.length, command.firstLine!, 120);
      else replay?.setViewport(command.firstLine!);
    }
    if (command.type === 'follow') followReplay();
    if (command.type === 'viewportSize') { viewportRows = command.rows!; replay?.setViewportRows(viewportRows); }
    if (command.type === 'closeTab' && replay?.getState().status !== 'running') {
      const index = recent.findIndex(tab => command.pathBase64 ? tab.pathBase64 === command.pathBase64 : tab.offset === command.offset);
      if (index < 0) return;
      const [closed] = recent.splice(index, 1);
      if (closed.label === activePath) {
        const next = recent[Math.min(index, recent.length - 1)];
        if (next) await handle({ type: 'browse', sessionId: sessionId(), ...(next.pathBase64 ? { pathBase64: next.pathBase64 } : { offset: next.offset }) });
        else { previewClosed = true; browseView = undefined; frame = undefined; activePath = ''; }
      }
    }
    if (command.type === 'browse' && command.pathBase64 && replay?.getState().status !== 'running') {
      const file = repositoryFiles.find(file => file.pathBase64 === command.pathBase64);
      if (!file) return;
      const signal = new AbortController().signal;
      let text = '', reason = '';
      if (file.mode === '160000') reason = `Submodule commit ${file.oid}`;
      else if (file.mode === '120000') reason = 'Symbolic link';
      else if ((await objectInfo(plan.repo, file.oid, signal)).size > LIMITS.textBytes) reason = 'File exceeds 1 MiB';
      else {
        try { text = await textBlob(plan.repo, file.oid, signal); }
        catch (cause) { if (!(cause instanceof TypeError)) throw cause; reason = 'Non-UTF-8 file'; }
        if (text.includes('\0')) reason = 'Binary file';
      }
      activePath = file.label;
      browseView = createTextView('', reason || text);
      frame = frameAt(browseView, 0, browseView.newText.length, 0, 120);
      openTab({ pathBase64: file.pathBase64, label: activePath });
    }
    if (command.type === 'browse' && command.offset !== undefined && replay?.getState().status !== 'running') {
      for await (const entry of readRecords(plan, command.offset!, new AbortController().signal)) {
        if (entry.record.kind === 'milestone') break;
        activePath = label(entry.record.change.pathBase64);
        openTab({ offset: entry.offset, label: activePath });
        browseView = undefined;
        if (entry.record.kind === 'text') {
          const text = await textBlob(plan.repo, entry.record.change.newOid, new AbortController().signal);
          browseView = createTextView('', text);
          frame = frameAt(browseView, 0, text.length, 0, 120);
        } else frame = { firstLine: 0, lines: [entry.record.reason ?? 'Exact snapshot stored in the session.'], caret: null };
        break;
      }
    }
    if (command.type === 'clear') {
      treeLoad?.abort(); await replay?.dispose(); replay = undefined; await store.clear(); store = undefined; plan = undefined; recovery = null;
      frame = undefined; repositoryFiles = []; recent = []; notice = ''; currentCommit = ''; activePath = '';
      browseView = undefined;
      await context.globalState.update('sessionRoot', undefined);
    }
    send(true);
  }

  function restoreSession(): Promise<void> {
    sessionLoading ??= (async () => {
      if (!plan) {
        const saved = context.globalState.get<string>('sessionRoot');
        if (saved) try {
          store = await openStore(storageRoot, saved, quota());
          const manifestPath = path.join(store.root, 'manifest.json');
          if ((await stat(manifestPath)).size > 1024 * 1024) throw new Error('Session manifest is too large');
          const candidate = JSON.parse(await readFile(manifestPath, 'utf8')) as Plan;
          validateTiming(candidate.timing);
          if (candidate.version !== 1 || candidate.root !== store.root || candidate.id !== path.basename(store.root) || !path.isAbsolute(candidate.repo)) throw new Error('Invalid saved session');
          plan = candidate; recovery = await store.readCheckpoint(); notice = 'Saved session loaded. Resume or restart when ready.';
        } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      }
    })();
    return sessionLoading;
  }
  function showPlayback(): Promise<void> {
    opening ??= openPanel().finally(() => { opening = undefined; });
    return opening;
  }
  function initializeWebview(webview: vscode.Webview, inSidebar = false): void {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
    webview.html = panelHtml({ script: webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'panel.js')).toString(), style: webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'panel.css')).toString(), cspSource: webview.cspSource, nonce: randomBytes(16).toString('hex'), sessionId: sessionId(), sidebar: inSidebar });
    webview.onDidReceiveMessage((value: unknown) => {
      if (!validCommand(value, sessionId())) return;
      if (inSidebar && !['ready', 'discover', 'repository', 'repositoryBrowse', 'commits', 'prepare', 'stop', 'showPlayback'].includes(value.type)) return;
      if (value.type === 'nativeInput') {
        if (value.action === 'stop') { native.stop(); return; }
        if (!panel?.active || !panel.visible || !vscode.window.state.focused || !vscode.workspace.isTrusted
          || busy || replay?.getState().status !== 'running' || Date.now() - value.at! < 0 || Date.now() - value.at! > 250) { native.stop(); return; }
        if (value.action === 'arm') native.start();
        else native.pulse(replay.getState().phase?.kind ?? 'wait', value.at!);
        return;
      }
      if (value.type === 'fullscreen') { void vscode.commands.executeCommand('workbench.action.toggleFullScreen').then(undefined, report); return; }
      if (value.type === 'stop' && preparation) { preparation.abort(new Error('Preparation cancelled')); return; }
      if (busy && value.type !== 'ready') return;
      commands = commands.then(() => handle(value)).catch(report);
    });
  }
  async function openPanel(): Promise<void> {
    repositoryHint = vscode.window.activeTextEditor?.document.uri ?? repositoryHint;
    if (panel) { panel.reveal(); return; }
    if (!vscode.workspace.isTrusted || vscode.env.remoteName) throw new Error('Git Replay needs a trusted local workspace.');
    await restoreSession();
    panel = vscode.window.createWebviewPanel('gitReplay', 'Replay', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
    replay?.setVisible(panel.visible);
    initializeWebview(panel.webview);
    panel.onDidChangeViewState(event => { if (!event.webviewPanel.active || !event.webviewPanel.visible) native.stop(); replay?.setVisible(event.webviewPanel.visible); if (event.webviewPanel.visible) { send(true); sendSetup(); } });
    panel.onDidDispose(() => { native.stop(); panel = undefined; replay?.setVisible(false); void replay?.pause().catch(report); });
  }
  context.subscriptions.push(vscode.commands.registerCommand('gitReplay.open', () => vscode.commands.executeCommand('gitReplay.launcher.focus')));
  context.subscriptions.push(vscode.commands.registerCommand('gitReplay.showReplay', () => showPlayback().catch(report)));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('gitReplay.launcher', {
    async resolveWebviewView(view) {
      repositoryHint = vscode.window.activeTextEditor?.document.uri ?? repositoryHint;
      sidebar = view;
      await restoreSession();
      initializeWebview(view.webview, true);
      view.onDidChangeVisibility(() => { if (view.visible) { send(true); sendSetup(); } });
      view.onDidDispose(() => { if (sidebar === view) sidebar = undefined; });
    },
  }, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.window.onDidChangeWindowState(state => { if (!state.focused) native.stop(); }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    discovered = false;
    if (panel || sidebar) commands = commands.then(() => setupAction(discover)).catch(report);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('editor')) { editor = editorSettings(); send(true); }
  }));
  shutdown = async () => {
    native.stop(); preparation?.abort(); if (postTimer) clearTimeout(postTimer);
    await replay?.pause(); treeLoad?.abort(); await replay?.dispose(); await disposeGit();
  };
}
export async function deactivate(): Promise<void> { await shutdown?.(); shutdown = undefined; }
