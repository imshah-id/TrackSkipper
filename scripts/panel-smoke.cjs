// Real Chromium check for the setup/playback boundary. Run after npm run build.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { panelHtml } = require('../dist/panel.js');
const root = path.resolve(__dirname, '..');
const oid = n => require('node:crypto').createHash('sha1').update(String(n)).digest('hex');
const setup = { loading: false, repositories: [{ id: 'repo-one', name: 'visageseek', path: '/projects/visageseek', branch: 'main' }, { id: 'repo-two', name: 'website', path: '/projects/website', branch: 'feature/search' }], selectedRepositoryId: 'repo-one', endOid: oid(20),
  commits: ['Add searchable country dropdown', 'Handle missing session state', 'Add session persistence and recovery', 'Update app navigation', 'Configure the project workspace', 'Initialize repository'].map((subject, index) => ({ oid: oid(20 - index), subject })), nextCursor: oid(14), error: null };
const playback = { type: 'state', sessionId: 'playing', status: 'running', configured: true, repository: 'visageseek', start: oid(18), end: oid(20),
  timing: { mode: 'speed', charactersPerSecond: 24, pointerMultiplier: 1 }, totalMs: 21600000, elapsedMs: 4022000,
  editor: { fontFamily: 'Menlo, monospace', fontSize: 14, fontWeight: 'normal', lineHeight: 22, tabSize: 2 },
  recordNumber: 8, recordCount: 32, subject: 'Add session persistence and recovery', activePath: 'src/session.ts',
  phase: { kind: 'click', target: 'code', editIndex: 0 }, phaseElapsedMs: 0, phaseDurationMs: 500,
  files: [{ offset: 0, label: 'src/session.ts', change: 'M' }, { offset: 100, label: 'src/store.ts', change: 'A' }, { offset: 200, label: 'test/session.test.ts', change: 'A' }],
  tabs: [{ offset: 100, label: 'src/store.ts' }, { offset: 0, label: 'src/session.ts' }], nextPage: null, previousPage: false,
  frame: { firstLine: 18, lines: ["import { readFile, rename, writeFile } from 'node:fs/promises';", '',
    'export async function saveCheckpoint(session, position) {', '  const checkpoint = {', '    version: 1,', '    sessionId: session.id,', '    position,', "    status: 'paused',", '  };', '',
    '  await writeFile(session.temporaryPath, JSON.stringify(checkpoint));', '  await rename(session.temporaryPath, session.checkpointPath);', '}', '', '/* Safe, local session data.', '   Recovered after a restart. */', '// </script><img src=x onerror=alert(1)>'], caret: { row: 7, column: 21 } } };
async function main() {
  const artifacts = path.join(root, 'artifacts/preview'); await fs.mkdir(artifacts, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'git-replay-ui-'));
  let chrome, socket;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === '/') {
        const source = `http://127.0.0.1:${server.address().port}`;
        let html = panelHtml({ script: '/panel.js', style: '/panel.css', cspSource: source, nonce: 'preview', sessionId: 'idle' });
        html = html.replace('<link rel="stylesheet"', '<link rel="stylesheet" href="/host.css"><link rel="stylesheet"');
        const bootstrap = `window.previewBoot=Math.random();window.commands=[];window.fixtureSetup=${JSON.stringify(setup)};window.fixturePlayback=${JSON.stringify(playback)};window.pushState=(state)=>window.postMessage({type:'state',sessionId:'idle',configured:false,status:'ready',...state},'*');window.pushSetup=(setup,sessionId='idle')=>window.postMessage({type:'setup',sessionId,setup},'*');window.acquireVsCodeApi=()=>({getState:()=>JSON.parse(sessionStorage.getItem('draft')||'null'),setState:state=>sessionStorage.setItem('draft',JSON.stringify(state)),postMessage(message){window.commands.push(message);if(message.type==='ready'){pushState({});pushSetup(fixtureSetup);}}});`;
        html = html.replace('<script nonce="preview" src=', `<script nonce="preview">${bootstrap.replaceAll('<', '\\u003c')}</script><script nonce="preview" src=`);
        response.setHeader('Content-Type', 'text/html'); response.end(html);
      } else if (request.url === '/host.css') {
        response.setHeader('Content-Type', 'text/css'); response.end('body { padding: 0 20px; }');
      } else if (['/panel.js', '/panel.css'].includes(request.url)) {
        response.setHeader('Content-Type', request.url.endsWith('js') ? 'text/javascript' : 'text/css'); response.end(await fs.readFile(path.join(root, 'media', request.url.slice(1))));
      } else { response.statusCode = 404; response.end(); }
    } catch (error) { response.statusCode = 500; response.end(String(error)); }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const executable = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium');
    chrome = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', `--user-data-dir=${profile}`, '--remote-debugging-port=0'], { stdio: 'ignore' });
    let launchError; chrome.on('error', error => { launchError = error; });
    let port;
    for (let i = 0; i < 100; i++) {
      if (launchError) throw launchError;
      try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(port, 'Chromium must start');
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0; const pending = new Map();
    socket.onmessage = event => { const message = JSON.parse(event.data); if (message.id) { const item = pending.get(message.id); pending.delete(message.id); message.error ? item.reject(message.error) : item.resolve(message.result); } };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params })); });
    const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value; };
    const settle = expression => evaluate(`(async()=>{${expression};await new Promise(r=>setTimeout(r,30));return true})()`);
    const screenshot = async name => fs.writeFile(path.join(artifacts, name), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    for (let i = 0; i < 100; i++) { if (await evaluate("document.querySelector('#repository')?.value==='repo-one'")) break; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.equal(await evaluate("document.querySelector('#repository').options.length"), 2);
    assert.equal(await evaluate("document.querySelector('#start-replay').disabled"), false);
    await screenshot('setup-desktop.png');
    await settle("document.querySelector('#setup [data-fullscreen]').click()");
    assert.deepEqual(await evaluate('commands.at(-1)'), { type: 'fullscreen', sessionId: 'idle' });
    await settle("document.querySelectorAll('.commit-option input')[2].click();document.querySelector('#commit-search').value='no match';document.querySelector('#commit-search').dispatchEvent(new Event('input'))");
    assert.equal(await evaluate("document.querySelectorAll('.commit-option').length"), 0);
    assert.equal(await evaluate("document.querySelector('#start-replay').disabled"), false, 'filtered selection stays usable');
    await settle(`document.querySelector('#older-commits').click();pushSetup({...fixtureSetup,commits:[{oid:'${oid(14)}',subject:'Earlier change'}],nextCursor:null})`);
    assert.equal(await evaluate("commands.at(-1).cursor"), oid(14));
    assert.ok((await evaluate("document.querySelector('#selected-commit').textContent")).includes('Add session persistence'));
    await settle("document.querySelector('#setup-form').requestSubmit()");
    const prepare = await evaluate('commands.at(-1)');
    assert.deepEqual(prepare, { type: 'prepare', sessionId: 'idle', repositoryId: 'repo-one', startOid: oid(18), endOid: oid(20), timing: { mode: 'duration', durationMs: 21600000 } });
    await settle("pushSetup({...fixtureSetup,error:'Duration is below minimum (10 seconds)'});document.querySelector('#hours').value='1';document.querySelector('#hours').dispatchEvent(new Event('input'))");
    assert.equal(await evaluate("document.querySelector('#start-replay').disabled"), false, 'preparation error allows a corrected retry');
    const previousBoot = await evaluate('window.previewBoot');
    await send('Page.reload');
    for (let i = 0; i < 100; i++) { if (await evaluate(`window.previewBoot && window.previewBoot !== ${previousBoot} && document.querySelector('#repository')?.value==='repo-one'`)) break; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.notEqual(await evaluate('window.previewBoot'), previousBoot);
    assert.ok((await evaluate("document.querySelector('#selected-commit').textContent")).includes('Add session persistence'));
    assert.equal(await evaluate("document.querySelector('#hours').value"), '1', 'draft survives webview context recreation');
    await settle('pushState(fixturePlayback)');
    assert.equal(await evaluate("document.querySelector('.workbench').getBoundingClientRect().left"), 0, 'webview resets the host padding');
    assert.equal(await evaluate("document.querySelector('.workbench').getBoundingClientRect().right"), 1100, 'workbench reaches the right edge');
    const view = await evaluate(`({rows:document.querySelectorAll('.code-row').length,setupHidden:document.querySelector('#setup').hidden,syntax:document.querySelectorAll('.token-keyword').length,images:document.querySelectorAll('#code img').length,text:[...document.querySelectorAll('.line-content')].slice(0,17).map(node=>node.textContent),pointer:getComputedStyle(document.querySelector('#virtual-pointer')).pointerEvents,font:getComputedStyle(document.querySelector('#code')).fontSize,footerHeight:document.querySelector('.transport').getBoundingClientRect().height})`);
    assert.equal(view.rows, 120); assert.equal(view.setupHidden, true); assert.ok(view.syntax > 0); assert.equal(view.images, 0); assert.deepEqual(view.text, playback.frame.lines); assert.equal(view.pointer, 'none'); assert.equal(view.font, '14px'); assert.ok(view.footerHeight < 40);
    await screenshot('playback-desktop.png');
    assert.equal(await evaluate("document.querySelector('#native-pad').hidden"), true);
    await settle("document.querySelector('#native-enabled').click();document.querySelector('#native-pad').click()");
    assert.equal(await evaluate("commands.some(command => command.type === 'nativeInput')"), false, 'scripted clicks cannot arm system input');
    const padPoint = await evaluate("(()=>{const r=document.querySelector('#native-pad').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...padPoint, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...padPoint, button: 'left', clickCount: 1 });
    assert.equal(await evaluate("commands.filter(command=>command.type==='nativeInput').at(-1).action"), 'arm');
    await settle("pushState({...fixturePlayback,nativeStatus:'Armed · Escape to stop'})");
    await screenshot('playback-native-input.png');
    const padText = await evaluate("document.querySelector('#native-pad').value");
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    assert.equal(await evaluate("document.querySelector('#native-pad').value"), padText, 'native input target stays inert');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.equal(await evaluate("commands.filter(command=>command.type==='nativeInput').at(-1).action"), 'stop');
    assert.equal(await evaluate("document.querySelector('#native-enabled').checked"), false);
    await settle("document.querySelector('#native-enabled').click();document.querySelector('#native-pad').focus()");
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 });
    const armsBefore = await evaluate("commands.filter(command=>command.type==='nativeInput' && command.action==='arm').length");
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.equal(await evaluate("commands.filter(command=>command.type==='nativeInput' && command.action==='arm').length"), armsBefore, 'keyboard cannot arm with the pointer outside the inert field');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...padPoint });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.equal(await evaluate("commands.filter(command=>command.type==='nativeInput' && command.action==='arm').length"), armsBefore + 1);
    await settle("pushState({...fixturePlayback,nativeStatus:'Armed · Escape to stop'});document.querySelector('#play').focus()");
    assert.equal(await evaluate("commands.filter(command=>command.type==='nativeInput').at(-1).action"), 'stop', 'leaving the preview suspends delivery');
    assert.equal(await evaluate("document.querySelector('#native-enabled').checked"), true, 'focus loss keeps VM input enabled');
    await settle("pushState({...fixturePlayback,nativeStatus:'Off'});document.querySelector('#toggle-controls').click()");
    assert.equal(await evaluate("document.querySelector('#native-enabled').checked"), true, 'hiding controls keeps VM input enabled');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.native-input')).display"), 'none');
    assert.ok(await evaluate("document.querySelector('#native-pad').getBoundingClientRect().height > 100"), 'the input target covers the preview while controls are hidden');
    const hiddenPad = await evaluate("(()=>{const r=document.querySelector('#native-pad').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
    const resumedArms = await evaluate("commands.filter(command=>command.type==='nativeInput' && command.action==='arm').length");
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hiddenPad });
    await evaluate('new Promise(resolve=>setTimeout(resolve,500))');
    assert.equal(await evaluate("commands.filter(command=>command.type==='nativeInput' && command.action==='arm').length"), resumedArms + 1, 'returning to the hidden-controls preview resumes input without re-enabling');
    await settle("pushState({...fixturePlayback,nativeStatus:'Armed · Escape to stop'})");
    const beforeRetry = await evaluate("commands.filter(command=>command.type==='nativeInput' && command.action==='arm').length");
    await evaluate("(async()=>{for(let i=0;i<13;i++){pushState({...fixturePlayback,nativeStatus:'Waiting · return to the replay preview'});await new Promise(resolve=>setTimeout(resolve,100));}})()");
    assert.equal(await evaluate("commands.filter(command=>command.type==='nativeInput' && command.action==='arm').length"), beforeRetry + 1, 'routine frames cannot postpone recovery forever');
    await settle("pushState({...fixturePlayback,nativeStatus:'Armed · Escape to stop'})");
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.equal(await evaluate("document.querySelector('#native-enabled').checked"), false, 'Escape switches VM input off');
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.transport')).display"), 'none', 'Escape also restores controls');

    await settle('pushState(fixturePlayback)');

    for (const kind of ['type', 'delete', 'wait', 'save']) {
      await settle(`pushState({...fixturePlayback,phase:{...fixturePlayback.phase,kind:${JSON.stringify(kind)}}})`);
      assert.equal(await evaluate("document.querySelector('#virtual-pointer').hidden"), true, 'mouse pointer is hidden while typing or waiting');
    }
    await settle('pushState({...fixturePlayback,phaseDurationMs:2000})');
    await evaluate('new Promise(resolve=>setTimeout(resolve,220))');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.click-ring')).opacity"), '0', 'click feedback fades during a long click phase');
    const beforeScroll = await evaluate("document.querySelector('#virtual-pointer').style.transform");
    await settle("pushState({...fixturePlayback,phase:{...fixturePlayback.phase,kind:'scroll'},frame:{...fixturePlayback.frame,caret:{row:1,column:0}}})");
    assert.equal(await evaluate("document.querySelector('#virtual-pointer').style.transform"), beforeScroll, 'scrolling does not drag the mouse to the caret');
    await settle('pushState(fixturePlayback)');
    const dartPath = 'lib/features/dashboard/dashboard_shell.dart';
    const dartLines = ['class DashboardPage extends StatelessWidget {', '  final String title = "Dashboard";', '  @override', '  Widget build(BuildContext context) => const SizedBox(height: 24);', '}'];
    await settle(`pushState({...fixturePlayback,activePath:${JSON.stringify(dartPath)},files:[{offset:0,label:${JSON.stringify(dartPath)},change:'M'}],tabs:[{offset:0,label:${JSON.stringify(dartPath)}}],frame:{firstLine:0,lines:${JSON.stringify(dartLines)}}})`);
    assert.ok(await evaluate("document.querySelectorAll('.token-declaration').length > 0"), 'Dart declarations are highlighted');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.line-content')].slice(0,5).map(node=>node.textContent)"), dartLines);
    assert.equal(await evaluate("document.querySelector('.file-name').textContent"), 'dashboard_shell.dart', 'filenames come before directory paths');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.folder-name')].map(node=>node.textContent)"), ['lib / features / dashboard']);
    await screenshot('playback-dart.png');
    await settle("document.querySelector('.folder summary').click()");
    assert.equal(await evaluate("document.querySelector('.folder').open"), false, 'folders collapse');
    await settle("pushState({...fixturePlayback,activePath:'lib/features/dashboard/dashboard_shell.dart',files:[{offset:0,label:'lib/features/dashboard/dashboard_shell.dart',change:'M'}],status:'paused'})");
    assert.equal(await evaluate("document.querySelector('.folder').open"), false, 'collapsed folders survive playback updates');
    await settle("document.querySelector('.folder summary').focus()");
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.equal(await evaluate("document.querySelector('.folder').open"), true, 'keyboard expands folders');
    await settle("pushState({...fixturePlayback,status:'paused',activePath:'src/session.ts',files:[...fixturePlayback.files,{offset:300,label:'test/session.ts',change:'M'},{offset:400,label:'README.md',change:'A'}]})");
    assert.equal(await evaluate("document.querySelectorAll('#files > .file-button').length"), 1, 'root files remain outside folders');
    await settle("pushState({...fixturePlayback,status:'paused',files:[...fixturePlayback.files,{pathBase64:'UkVBRE1FLm1k',label:'README.md',change:''}]})");
    assert.equal(await evaluate("document.querySelector('.explorer-heading').textContent.trim()"), 'EXPLORER');
    assert.equal(await evaluate("document.querySelector('.file-button[title=\"README.md\"]').getAttribute('aria-label')"), 'README.md');
    await settle("document.querySelector('.file-button[title=\"README.md\"]').click()");
    assert.equal(await evaluate('commands.at(-1).pathBase64'), 'UkVBRE1FLm1k', 'unchanged files browse by their exact repository path');
    await screenshot('playback-full-explorer.png');
    await settle("pushState({...fixturePlayback,status:'paused',files:[...fixturePlayback.files,{offset:300,label:'test/session.ts',change:'M'}]})");
    await settle("[...document.querySelectorAll('.file-button')].find(node=>node.title==='test/session.ts').click()");
    assert.equal(await evaluate('commands.at(-1).offset'), 300, 'same filenames in different folders browse the right file');
    await settle("document.querySelector('.folder[data-path=\"test\"] summary').click();pushState({...fixturePlayback,status:'paused',activePath:'test/session.test.ts'})");
    assert.equal(await evaluate("document.querySelector('.folder[data-path=\"test\"]').open"), true, 'a newly active file reveals its folder');
    await settle('pushState(fixturePlayback)');
    await settle("document.querySelector('#native-enabled').click();document.querySelector('#settings').click();document.querySelector('#toggle-controls').click()");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.transport')).display"), 'none');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#playback-settings')).display"), 'none');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.tabs')).display"), 'none', 'hidden controls remove the duplicate tab strip');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.native-input')).display"), 'none', 'Hide controls also hides VM input');
    assert.equal(await evaluate("document.querySelector('#native-enabled').checked"), true, 'hiding preserves VM input preference');
    assert.equal(await evaluate("document.querySelector('#toggle-controls').textContent"), 'Show controls');
    await settle('pushState(fixturePlayback)');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.transport')).display"), 'none', 'updates keep controls hidden');
    assert.equal(await evaluate("JSON.parse(sessionStorage.getItem('draft')).controlsHidden"), true, 'visibility preference is saved');
    await screenshot('playback-hidden-controls.png');
    const androidFiles = ['kotlin/com/visageseek/app/MainActivity.kt', 'res/drawable/launch_background.xml', 'res/drawable-v21/launch_background.xml', 'res/mipmap-hdpi/ic_launcher.png', 'res/mipmap-mdpi/ic_launcher.png', 'res/mipmap-xhdpi/ic_launcher.png', 'res/mipmap-xxhdpi/ic_launcher.png', 'res/mipmap-xxxhdpi/ic_launcher.png', 'res/values/styles.xml', 'res/values-night/styles.xml', 'AndroidManifest.xml'].map((name, index) => ({ offset: index * 100, label: `android/app/src/main/${name}`, change: 'A' }));
    const androidFrame = { firstLine: 3, lines: ['<item android:drawable="?android:colorBackground" />', '', '<!-- You can insert your own image assets here -->', '<!-- <item>', '    <bitmap', '        android:gravity="center"', '        android:src="@mipmap/ic_launcher" />'], caret: { row: 6, column: 40 } };
    await settle(`pushState({...fixturePlayback,files:${JSON.stringify(androidFiles)},activePath:'android/app/src/main/res/drawable-v21/launch_background.xml',frame:${JSON.stringify(androidFrame)}})`);
    assert.equal(await evaluate("document.querySelector('.folder-name').textContent"), 'android / app / src / main', 'single-folder chains compact until a real branch');
    assert.equal(await evaluate("document.querySelector('.folder summary').getBoundingClientRect().height"), 22, 'folder rows use compact spacing');
    assert.equal(await evaluate("document.querySelector('.file-button').getBoundingClientRect().height"), 22, 'file rows align with folder rows');
    assert.equal(await evaluate("document.querySelector('.explorer-heading').getBoundingClientRect().height === document.querySelector('.breadcrumbs').getBoundingClientRect().height"), true, 'headers share a baseline');
    await screenshot('playback-android-clean.png');
    await settle('pushState(fixturePlayback)');
    assert.ok(await evaluate("document.querySelector('#playback [data-fullscreen]').getBoundingClientRect().width > 0"), 'fullscreen stays accessible with controls hidden');
    await settle("document.querySelector('#playback [data-fullscreen]').click()");
    assert.deepEqual(await evaluate('commands.at(-1)'), { type: 'fullscreen', sessionId: 'playing' });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.transport')).display"), 'none', 'Escape restores controls');
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.native-input')).display"), 'none', 'Escape restores VM input controls');
    assert.equal(await evaluate("document.querySelector('#native-enabled').checked"), false, 'restoring controls does not re-arm input');
    await settle("document.querySelector('#toggle-controls').click();document.querySelector('#toggle-controls').click()");
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.transport')).display"), 'none', 'Show controls restores the toolbar');
    await settle("document.querySelector('#settings').click()");
    for (const theme of ['vscode-light', 'vscode-high-contrast', 'vscode-high-contrast-light']) {
      await settle(`document.body.className=${JSON.stringify(theme)}`);
      const colors = await evaluate("({background:getComputedStyle(document.body).backgroundColor,foreground:getComputedStyle(document.querySelector('.tab.selected')).color,outline:getComputedStyle(document.querySelector('.file-button.selected')).outlineStyle,scheme:getComputedStyle(document.body).colorScheme})");
      assert.notEqual(colors.background, colors.foreground, 'active tabs stay readable');
      if (theme.endsWith('light')) assert.equal(colors.scheme, 'light');
      if (theme.includes('high-contrast')) assert.equal(colors.outline, 'solid');
      await screenshot(`playback-${theme}.png`);
    }
    await settle("document.body.className='vscode-dark';document.documentElement.style.setProperty('--vscode-editor-background','#24283b');document.documentElement.style.setProperty('--vscode-editorGroupHeader-tabsBackground','#16161e')");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.editor')).backgroundColor"), 'rgb(36, 40, 59)', 'editor honors the active theme');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.transport')).backgroundColor"), 'rgb(22, 22, 30)', 'toolbar honors the active theme');
    await settle("document.documentElement.style.removeProperty('--vscode-editor-background');document.documentElement.style.removeProperty('--vscode-editorGroupHeader-tabsBackground')");
    await settle("document.querySelector('#play').click();pushState({...fixturePlayback,status:'paused'});document.querySelector('#settings').click();document.querySelector('#typing').value='50';document.querySelector('#typing').dispatchEvent(new Event('change'))");
    assert.deepEqual(await evaluate('commands.at(-1)'), { type: 'speed', sessionId: 'playing', charactersPerSecond: 50, pointerMultiplier: 1 });
    assert.equal(await evaluate("document.querySelector('#play-label').textContent"), 'Resume');
    await settle("document.querySelectorAll('.file-button')[1].focus();document.querySelectorAll('.file-button')[1].click()");
    assert.deepEqual(await evaluate('commands.at(-1)'), { type: 'browse', sessionId: 'playing', offset: 100 });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), 'solid', 'keyboard focus stays visible');
    await settle("document.querySelector('#code-scroll').dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown',bubbles:true}))");
    assert.equal((await evaluate('commands.at(-1)')).firstLine, 58);
    await settle("pushState({...fixturePlayback,editor:{...fixturePlayback.editor,fontSize:16,lineHeight:1.5}})");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#code')).lineHeight"), '24px');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#virtual-pointer')).display"), 'none');
    await send('Emulation.setDeviceMetricsOverride', { width: 520, height: 900, deviceScaleFactor: 1, mobile: false });
    await settle("document.querySelector('#settings').click()");
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'playback fits a narrow editor');
    await screenshot('playback-narrow.png');
    await settle("pushState({});pushSetup(fixtureSetup)");
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    await screenshot('setup-narrow.png');
    await settle("document.querySelector('#repository').value='repo-two';document.querySelector('#repository').dispatchEvent(new Event('change'))");
    assert.equal((await evaluate('commands.at(-1)')).repositoryId, 'repo-two');
    await settle("pushSetup({loading:false,repositories:[],commits:[],selectedRepositoryId:null,endOid:null,nextCursor:null,error:'No Git repository found. Browse for a repository folder.'});document.querySelector('#browse-repository').click()");
    assert.equal(await evaluate("document.querySelector('#start-replay').disabled"), true);
    assert.equal((await evaluate('commands.at(-1)')).type, 'repositoryBrowse');
    await screenshot('setup-empty.png');
    const result = { nativeInputArmingAndEscape: true, inertNativeTarget: true, inlineSetup: true, formDraftSurvivesReload: true, commitSelectionSurvivesPaging: true, preparationRetry: true, sourceTextPreserved: true, boundedRows: view.rows, syntaxHighlighting: true, dartHighlighting: true, filenameFirst: true, folderHierarchy: true, folderKeyboardToggle: true, activeFileReveal: true, hideShowControls: true, themeColors: true, highContrast: true, keyboardFocus: true, fileBrowsing: true, pointerDoesNotIntercept: true, reducedMotion: true, typography: true, narrowLayout: true };
    await fs.writeFile(path.join(root, 'artifacts/browser-smoke.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  } finally {
    socket?.close(); if (chrome?.pid) { chrome.kill('SIGTERM'); await new Promise(resolve => { chrome.once('exit', resolve); setTimeout(resolve, 2000).unref(); }); }
    await new Promise(resolve => server.close(resolve)); await fs.rm(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
