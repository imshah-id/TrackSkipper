(() => {
  'use strict';
  const api = acquireVsCodeApi(), $ = id => document.getElementById(id);
  const draft = api.getState() || {};
  let sessionId = document.body.dataset.session, state = {}, setup = { loading: true, repositories: [], commits: [] };
  let selectedCommit = draft.selectedCommit || null, selectionKey = draft.selectionKey || '', timingMode = 'duration', editingSetup = !!draft.editingSetup;
  let controlsHidden = !!draft.controlsHidden;
  const send = (type, values = {}) => api.postMessage({ type, sessionId, ...values });
  const time = ms => { const seconds = Math.max(0, Math.floor((ms || 0) / 1000)); return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':'); };
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  function saveDraft() {
    api.setState({ selectedCommit, selectionKey, timingMode, editingSetup, controlsHidden, hours: $('hours').value,
      typing: $('setup-typing').value, pointer: $('setup-pointer').value, search: $('commit-search').value.slice(0, 256) });
  }
  const icon = path => {
    const kind = path.split('.').pop().toLowerCase().replace(/x$/, ''), node = document.createElement('span');
    node.className = 'file-icon'; node.dataset.kind = kind; node.setAttribute('aria-hidden', 'true');
    const mark = ({ ts: 'TS', js: 'JS', json: '{}', md: 'M↓', css: '#', scss: '#', py: 'Py', html: '‹›', dart: 'D', yaml: 'Y', yml: 'Y' })[kind];
    if (mark) node.textContent = mark;
    else node.append(glyph('file'));
    return node;
  };
  function glyph(name) {
    const paths = { fullscreen: 'M6 2H2v4 M10 2h4v4 M14 10v4h-4 M6 14H2v-4', file: 'M9 1.5H3.5v13h9V5z M9 1.5V5h3.5', folder: 'M1.5 3h5l2 2h6v8h-13z', play: 'M4 2.5v11l9-5.5z', pause: 'M5 3v10 M11 3v10', stop: 'M3.5 3.5h9v9h-9z', restart: 'M2 6a6 6 0 1 1 .5 5 M2 2v4h4', plus: 'M8 2v12 M2 8h12', chevron: 'm4 6 4 4 4-4', settings: 'M2 4h12 M2 12h12 M5 2v4 M11 10v4' };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), path = document.createElementNS(svg.namespaceURI, 'path');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('ui-icon');
    path.setAttribute('d', paths[name] || paths.file); svg.append(path); return svg;
  }
  document.querySelectorAll('[data-icon]').forEach(node => node.append(glyph(node.dataset.icon)));
  document.querySelectorAll('[data-fullscreen]').forEach(button => button.addEventListener('click', () => send('fullscreen')));

  function renderControls() {
    $('playback').classList.toggle('controls-hidden', controlsHidden);
    $('controls-label').textContent = controlsHidden ? 'Show controls' : 'Hide controls';
    $('toggle-controls').setAttribute('aria-label', $('controls-label').textContent);
    $('toggle-controls').title = `${$('controls-label').textContent} (Escape to restore)`;
    $('toggle-controls').setAttribute('aria-expanded', String(!controlsHidden));
  }

  let treeSession = '', treePath = '';
  function renderFiles(running) {
    const collapsed = new Set(treeSession === sessionId ? [...$('files').querySelectorAll('.folder:not([open])')].map(node => node.dataset.path) : []);
    const reveal = treeSession !== sessionId || treePath !== state.activePath;
    treeSession = sessionId; treePath = state.activePath;
    const focusedPath = document.activeElement.closest('.folder')?.dataset.path;
    const root = { folders: new Map(), files: [] };
    for (const file of state.files || []) {
      const parts = file.label.split('/'); let branch = root, path = '';
      for (const name of parts.slice(0, -1)) {
        path = path ? `${path}/${name}` : name;
        if (!branch.folders.has(name)) branch.folders.set(name, { name, path, folders: new Map(), files: [] });
        branch = branch.folders.get(name);
      }
      branch.files.push(file);
    }
    const append = (branch, parent, depth) => {
      for (let folder of [...branch.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        let folderLabel = folder.name;
        while (!folder.files.length && folder.folders.size === 1) { folder = folder.folders.values().next().value; folderLabel += ` / ${folder.name}`; }
        const details = document.createElement('details'), summary = document.createElement('summary'), name = document.createElement('span');
        details.className = 'folder'; details.dataset.path = folder.path;
        details.open = !collapsed.has(folder.path) || reveal && state.activePath?.startsWith(`${folder.path}/`);
        summary.style.setProperty('--depth', depth); summary.title = folder.path;
        name.className = 'folder-name'; name.textContent = folderLabel;
        summary.append(glyph('chevron'), glyph('folder'), name); details.append(summary);
        append(folder, details, depth + 1); parent.append(details);
      }
      for (const file of [...branch.files].sort((a, b) => a.label.localeCompare(b.label))) {
        const button = document.createElement('button'), tag = document.createElement('span'), name = document.createElement('span');
        button.className = `file-button${file.label === state.activePath ? ' selected' : ''}`; button.title = file.label; button.disabled = running;
        button.style.setProperty('--depth', depth);
        const change = ({ A: 'Added', D: 'Deleted', M: 'Modified', R: 'Renamed' })[file.change] || file.change;
        button.setAttribute('aria-current', String(file.label === state.activePath)); button.setAttribute('aria-label', `${file.label}, ${change}`);
        tag.className = 'file-tag'; tag.dataset.change = file.change; tag.textContent = file.change; tag.title = change;
        name.className = 'file-name'; name.textContent = file.label.split('/').pop();
        button.append(icon(file.label), name, tag); button.addEventListener('click', () => send('browse', { offset: file.offset })); parent.append(button);
      }
    };
    const fragment = document.createDocumentFragment(); append(root, fragment, 0); $('files').replaceChildren(fragment);
    if (reveal) $('files').querySelector('.file-button.selected')?.scrollIntoView({ block: 'nearest' });
    if (focusedPath) [...$('files').querySelectorAll('.folder')].find(node => node.dataset.path === focusedPath)?.querySelector('summary').focus({ preventScroll: true });
  }

  function renderSelection() {
    $('selected-commit').textContent = selectedCommit ? `${selectedCommit.oid.slice(0, 7)}  ${selectedCommit.subject}` : 'Choose a starting commit';
    $('end-commit').textContent = setup.endOid?.slice(0, 7) || '—';
    $('selection-hint').textContent = selectedCommit ? (selectedCommit.oid === setup.endOid ? 'Replay the latest commit.' : 'Replay the selected commit and every commit after it.') : 'Choose a repository and a starting commit.';
    const busy = setup.loading || state.status === 'preparing';
    $('start-replay').disabled = busy || !setup.commits.length || !selectedCommit || !setup.selectedRepositoryId || !setup.endOid;
    $('start-replay').textContent = state.status === 'preparing' ? 'Preparing…' : 'Start replay';
    $('cancel-prepare').hidden = state.status !== 'preparing' || !state.canCancelPreparation;
    $('back').hidden = !state.configured; $('back').disabled = state.status === 'preparing';
    $('setup-error').textContent = setup.error || ''; $('setup-error').hidden = !setup.error;
  }
  function renderCommits() {
    const query = $('commit-search').value.trim().toLowerCase();
    const commits = setup.commits.filter(commit => `${commit.oid} ${commit.subject}`.toLowerCase().includes(query));
    $('commits').replaceChildren(...commits.map(commit => {
      const label = document.createElement('label'), radio = document.createElement('input'), description = document.createElement('span'), title = document.createElement('span'), meta = document.createElement('span');
      label.className = 'commit-option'; radio.type = 'radio'; radio.name = 'start-commit'; radio.value = commit.oid; radio.checked = selectedCommit?.oid === commit.oid; radio.disabled = setup.loading;
      description.className = 'commit-description'; title.className = 'commit-title'; title.textContent = commit.subject || '(no commit message)'; title.title = commit.subject;
      meta.className = 'commit-meta'; meta.textContent = commit.oid.slice(0, 7) + (commit.oid === setup.endOid ? ' · latest' : '');
      description.append(title, meta); label.append(radio, description);
      radio.addEventListener('change', () => { selectedCommit = commit; renderSelection(); saveDraft(); }); return label;
    }));
    if (!commits.length) {
      const empty = document.createElement('p'); empty.className = 'list-empty';
      empty.textContent = setup.loading ? 'Loading commits…' : query ? 'No matches on this page. Try another search or load older commits.' : 'Choose a repository to load its commits.';
      $('commits').append(empty);
    }
    $('commit-count').textContent = `${setup.commits.length} loaded`;
    $('latest-commits').disabled = setup.loading || !setup.commits.length || setup.commits[0]?.oid === setup.endOid;
    $('older-commits').disabled = setup.loading || !setup.nextCursor;
  }
  function renderSetup() {
    const repository = setup.repositories.find(item => item.id === setup.selectedRepositoryId);
    const key = `${setup.selectedRepositoryId}:${setup.endOid}`;
    if (!setup.loading) {
      if (key !== selectionKey) { selectionKey = key; selectedCommit = null; $('commit-search').value = ''; }
      if (!selectedCommit && setup.commits.length) selectedCommit = setup.commits[0];
    }
    $('repository').replaceChildren(...setup.repositories.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = `${item.name}  ·  ${item.branch}`; return option; }));
    if (!setup.repositories.length) { const option = document.createElement('option'); option.textContent = setup.loading ? 'Finding repositories…' : 'No repository found'; $('repository').append(option); }
    if (repository) $('repository').value = repository.id;
    $('repository').disabled = setup.loading || !setup.repositories.length;
    $('refresh').disabled = $('browse-repository').disabled = setup.loading;
    $('repository-path').textContent = repository?.path || (setup.loading ? 'Looking in your open workspace…' : 'Open a Git workspace, or browse for a repository folder.');
    $('commit-search').disabled = setup.loading || !setup.commits.length;
    renderCommits(); renderSelection();
    if (!setup.loading) saveDraft();
  }
  function setTimingMode(mode) {
    timingMode = mode;
    $('mode-duration').setAttribute('aria-pressed', String(mode === 'duration')); $('mode-speed').setAttribute('aria-pressed', String(mode === 'speed'));
    $('duration-settings').hidden = mode !== 'duration'; $('speed-settings').hidden = mode !== 'speed'; $('hours').disabled = mode !== 'duration';
  }

  // ponytail: tokenize only the bounded visible window; use a full grammar engine if exact language/theme parity becomes necessary.
  function tokens(line, language, block) {
    if (language === 'md' && /^\s*#/.test(line)) return { parts: [[line, 'heading']], block: false };
    if (!/^(dart|ts|tsx|js|jsx|mjs|cjs|json|py|css|scss|c|cpp|h|java|go|rs|sh|rb|yaml|yml)$/.test(language)) return { parts: [[line, '']], block: false };
    const pattern = /\/\/.*|\/\*.*?\*\/|\/\*.*|(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)|\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)\b|[A-Za-z_$][\w$]*|#[^\n]*|[^\w\s]/g;
    const parts = []; let end = 0;
    if (block) { const close = line.indexOf('*/'); end = close < 0 ? line.length : close + 2; parts.push([line.slice(0, end), 'comment']); block = close < 0; }
    pattern.lastIndex = end;
    for (let match; (match = pattern.exec(line));) {
      if (match.index > end) parts.push([line.slice(end, match.index), '']);
      const value = match[0]; let kind = '';
      if (value.startsWith('//') || value.startsWith('/*') || value[0] === '#' && /^(py|sh|rb|yaml|yml)$/.test(language)) { kind = 'comment'; if (value.startsWith('/*')) block = !value.endsWith('*/'); }
      else if (/^["'`]/.test(value)) kind = 'string';
      else if (/^\d/.test(value)) kind = 'number';
      else if (/^(const|let|var|function|class|interface|type|enum|new|this|true|false|null|undefined|def|None|True|False|self|public|private|static|void|int|str|boolean|number|string|final|late|required|factory|abstract|dynamic|double|bool|super|covariant)$/.test(value)) kind = 'declaration';
      else if (/^(import|from|export|default|async|await|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|extends|implements|of|in|yield|as|with|raise|pass|is|on|rethrow|assert|sync|part|library|show|hide|get|set)$/.test(value)) kind = 'keyword';
      else if (/^\s*\(/.test(line.slice(pattern.lastIndex))) kind = 'function';
      else if (/^[A-Z][A-Za-z]+/.test(value)) kind = 'type';
      parts.push([value, kind]); end = pattern.lastIndex;
    }
    if (end < line.length) parts.push([line.slice(end), '']);
    return { parts, block };
  }
  const rows = Array.from({ length: 120 }, () => {
    const row = document.createElement('div'), number = document.createElement('span'), content = document.createElement('span');
    row.className = 'code-row'; number.className = 'line-number'; content.className = 'line-content'; row.append(number, content);
    return { row, number, content, key: '', tokenKey: '', parsed: null };
  });
  $('code').append(...rows.map(item => item.row));
  function renderCode(frame) {
    if (!frame) return;
    const language = state.activePath?.split('.').pop().toLowerCase() || ''; let block = false;
    rows.forEach((item, index) => {
      item.row.hidden = index >= frame.lines.length; if (item.row.hidden) return;
      item.number.textContent = String(frame.firstLine + index + 1);
      const line = frame.lines[index], column = frame.caret?.row === index ? frame.caret.column : -1;
      item.row.classList.toggle('active', column >= 0);
      const tokenKey = JSON.stringify([line, language, block]);
      if (item.tokenKey !== tokenKey) { item.tokenKey = tokenKey; item.parsed = tokens(line, language, block); }
      const parsed = item.parsed; block = parsed.block;
      const key = `${column}:${tokenKey}`; if (item.key === key) return; item.key = key;
      const children = []; let offset = 0, inserted = false;
      const append = (text, kind) => { if (!text) return; const node = document.createElement('span'); if (kind) node.className = `token-${kind}`; node.textContent = text; children.push(node); };
      for (const [text, kind] of parsed.parts) {
        if (!inserted && column >= offset && column <= offset + text.length) {
          const split = column - offset; append(text.slice(0, split), kind);
          const caret = document.createElement('span'); caret.className = 'caret'; children.push(caret); inserted = true; append(text.slice(split), kind);
        } else append(text, kind);
        offset += text.length;
      }
      if (column >= 0 && !inserted) { const caret = document.createElement('span'); caret.className = 'caret'; children.push(caret); }
      item.content.replaceChildren(...children);
    });
  }
  let nativeArmed = false, nativeTimer;
  function stopNative() {
    const wasArmed = nativeArmed;
    nativeArmed = false; clearInterval(nativeTimer); nativeTimer = undefined;
    $('native-enabled').checked = false; $('native-pad').hidden = true;
    if (wasArmed) send('nativeInput', { action: 'stop', at: Date.now() });
  }
  $('native-enabled').addEventListener('change', () => {
    if (!$('native-enabled').checked) stopNative();
    else $('native-pad').hidden = false;
  });
  function armNative(event) {
    if (!event.isTrusted || nativeArmed || !$('native-enabled').checked || state.status !== 'running') return;
    if (event.type === 'keydown' && !$('native-pad').matches(':hover')) { $('native-status').textContent = 'Park the pointer inside the input field before arming.'; return; }
    nativeArmed = true;
    send('nativeInput', { action: 'arm', at: Date.now() });
    nativeTimer = setInterval(() => {
      if (document.hidden || !document.hasFocus() || document.activeElement !== $('native-pad') || state.status !== 'running') { stopNative(); return; }
      send('nativeInput', { action: 'pulse', at: Date.now() });
    }, 100);
  }
  $('native-pad').addEventListener('click', armNative);
  $('native-pad').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); armNative(event); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); stopNative(); }
    else if (['a', 'A', 'Backspace'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); }
  });
  $('native-pad').addEventListener('blur', stopNative);
  $('native-pad').addEventListener('pointerleave', () => { if (nativeArmed) stopNative(); });
  document.addEventListener('pointermove', event => { if (nativeArmed && (event.movementX || event.movementY)) stopNative(); }, true);
  window.addEventListener('blur', stopNative);
  window.addEventListener('resize', stopNative);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopNative(); });
  document.addEventListener('scroll', () => { if (nativeArmed) stopNative(); }, true);
  let animation, pointerX = 100, pointerY = 100, phaseKey = '';
  function stopPointer() { if (animation) cancelAnimationFrame(animation); animation = undefined; $('virtual-pointer').classList.remove('clicking'); }
  function pointer() {
    if (motion.matches || state.status !== 'running' || !state.phase || !['move', 'hover', 'click', 'scroll'].includes(state.phase.kind) || document.hidden || !$('setup').hidden) { stopPointer(); $('virtual-pointer').hidden = true; phaseKey = ''; return; }
    const key = `${state.recordNumber}:${state.phase.kind}:${state.phase.editIndex}:${state.phase.target}`;
    if (key === phaseKey) return; phaseKey = key; stopPointer();
    const marker = $('virtual-pointer'); marker.hidden = false;
    let target = state.phase.target === 'file' ? document.querySelector('.file-button.selected') || $('file-path') : document.querySelector('.caret') || $('code');
    if (target.closest('.folder:not([open])')) target = $('file-path');
    const rect = target.getBoundingClientRect(), scrolling = state.phase.kind === 'scroll';
    const targetX = scrolling ? pointerX : Math.max(5, Math.min(innerWidth - 25, rect.left + (state.phase.target === 'file' ? 30 : 2)));
    const targetY = scrolling ? pointerY : Math.max(5, Math.min(innerHeight - 32, rect.top + 8));
    const startX = pointerX, startY = pointerY, moving = state.phase.kind === 'move';
    const duration = moving ? Math.max(1, state.phaseDurationMs - state.phaseElapsedMs) : 0, began = performance.now(); let previous = -Infinity;
    const tick = now => {
      if (now - previous < 1000 / 30) { animation = requestAnimationFrame(tick); return; } previous = now;
      const t = duration ? Math.min(1, (now - began) / duration) : 1, eased = t * t * (3 - 2 * t);
      pointerX = startX + (targetX - startX) * eased; pointerY = startY + (targetY - startY) * eased;
      marker.style.transform = `translate(${pointerX}px, ${pointerY}px)`;
      if (t < 1) animation = requestAnimationFrame(tick); else { animation = undefined; marker.classList.toggle('clicking', state.phase.kind === 'click'); }
    };
    animation = requestAnimationFrame(tick);
  }
  let lastFiles = '', lastTabs = '', lastEditor = '';
  function render() {
    if ($('native-status').textContent !== (state.nativeStatus || 'Off')) $('native-status').textContent = state.nativeStatus || 'Off';
    $('native-enabled').disabled = state.status !== 'running';
    if (nativeArmed && state.status !== 'running') stopNative();
    if (nativeArmed && !/^(Starting|Ready|Armed)/.test(state.nativeStatus || '')) { nativeArmed = false; stopNative(); }
    const running = state.status === 'running', preparing = state.status === 'preparing';
    if (running && editingSetup) { editingSetup = false; saveDraft(); }
    const showingSetup = !state.configured || editingSetup;
    $('setup').hidden = !showingSetup; $('playback').hidden = showingSetup;
    const showNotice = state.isError || preparing || state.status === 'complete';
    $('notice').textContent = state.notice || ''; $('notice').hidden = !showNotice || !state.notice; $('notice').classList.toggle('error', !!state.isError);
    renderSelection();
    if (showingSetup) { pointer(); return; }
    const editorKey = JSON.stringify(state.editor);
    if (state.editor && editorKey !== lastEditor) {
      lastEditor = editorKey; const style = document.documentElement.style, editor = state.editor;
      const size = Math.max(6, Math.min(100, Number(editor.fontSize) || 14)), height = Number(editor.lineHeight) || 0;
      style.setProperty('--mono', editor.fontFamily); style.setProperty('--code-size', `${size}px`); style.setProperty('--code-weight', editor.fontWeight);
      style.setProperty('--line-height', `${height === 0 ? Math.round(size * 1.5) : height < 8 ? size * height : height}px`); style.setProperty('--tab-size', String(editor.tabSize));
    }
    const fixed = state.timing?.mode === 'speed', editable = fixed && state.status === 'paused';
    $('timing-mode').textContent = fixed ? 'Fixed speed' : `Duration · ${time(state.totalMs)}`;
    $('typing').disabled = $('pointer-speed').disabled = !editable;
    if (fixed) { $('typing').value = state.timing.charactersPerSecond; $('pointer-speed').value = state.timing.pointerMultiplier; }
    $('typing-value').textContent = fixed ? `${state.timing.charactersPerSecond} char/s` : 'Automatic'; $('pointer-value').textContent = fixed ? `${state.timing.pointerMultiplier}×` : 'Automatic';
    $('timing-hint').textContent = fixed ? 'Pause to adjust speed; resume when ready.' : 'Typing and pauses fit the selected duration.';
    $('empty').hidden = !!state.frame; $('code-scroll').hidden = !state.frame;
    $('empty-message').textContent = state.status === 'complete' ? 'Replay complete. This range contains no animated text.' : 'Opening the first file…';
    $('new-replay').disabled = preparing || running;
    $('play').disabled = !state.configured || preparing || state.status === 'complete';
    const playLabel = running ? 'Pause' : state.status === 'ready' ? 'Start' : 'Resume';
    if ($('play-label').textContent !== playLabel) { $('play-icon').replaceChildren(glyph(running ? 'pause' : 'play')); $('play-label').textContent = playLabel; }
    $('stop').disabled = !state.configured || preparing || ['stopped', 'complete', 'ready'].includes(state.status);
    $('restart').disabled = $('clear').disabled = !state.configured || preparing || running;
    $('follow').disabled = !state.configured;
    $('elapsed').textContent = time(state.elapsedMs); $('total').textContent = time(state.totalMs);
    $('progress').value = state.totalMs ? Math.min(1, state.elapsedMs / state.totalMs) : 0;
    $('status').textContent = state.status || 'Ready'; $('status').dataset.status = state.status || 'ready';
    $('workspace-name').textContent = state.repository || 'Replay';
    $('files-hint').textContent = running ? 'Pause to browse files' : 'Select a file to inspect';
    $('file-path').textContent = state.activePath?.replaceAll('/', '  ›  ') || 'Git Replay'; $('file-path').title = state.activePath || '';
    $('commit-subject').textContent = state.subject || 'Git Replay'; $('commit-subject').title = state.subject || '';
    $('phase').textContent = state.status === 'complete' ? 'Complete' : `Change ${state.recordNumber || 0} of ${state.recordCount || 0}`;
    $('file-count').textContent = String(state.files?.length || 0);
    const filesKey = JSON.stringify([sessionId, state.files, state.activePath, running]);
    if (filesKey !== lastFiles) {
      lastFiles = filesKey; renderFiles(running);
    }
    const tabsKey = JSON.stringify([state.tabs, state.activePath, running]);
    if (tabsKey !== lastTabs) {
      lastTabs = tabsKey;
      $('tabs').replaceChildren(...(state.tabs || []).map(tab => {
        const button = document.createElement('button'), label = document.createElement('span');
        button.className = `tab${tab.label === state.activePath ? ' selected' : ''}`; label.textContent = tab.label.split('/').pop(); button.title = tab.label; button.disabled = running;
        button.setAttribute('aria-current', String(tab.label === state.activePath)); button.append(icon(tab.label), label);
        button.addEventListener('click', () => send('browse', { offset: tab.offset })); return button;
      }));
      if (!state.tabs?.length) { const tab = document.createElement('span'); tab.className = 'tab empty-tab'; tab.textContent = 'Preview'; $('tabs').append(tab); }
    }
    $('previous-files').disabled = running || !state.previousPage; $('next-files').disabled = running || state.nextPage == null;
    renderCode(state.frame); pointer();
  }
  window.addEventListener('message', event => {
    if (event.data?.type === 'state') { state = event.data; sessionId = state.sessionId; render(); }
    else if (event.data?.type === 'setup' && event.data.sessionId === sessionId) { setup = event.data.setup; renderSetup(); }
  });
  $('repository').addEventListener('change', () => send('repository', { repositoryId: $('repository').value }));
  $('refresh').addEventListener('click', () => send('discover')); $('browse-repository').addEventListener('click', () => send('repositoryBrowse'));
  $('commit-search').addEventListener('input', () => { renderCommits(); saveDraft(); });
  $('latest-commits').addEventListener('click', () => { $('commit-search').value = ''; send('commits', { cursor: null }); });
  $('older-commits').addEventListener('click', () => { $('commit-search').value = ''; send('commits', { cursor: setup.nextCursor }); });
  $('mode-duration').addEventListener('click', () => { setTimingMode('duration'); saveDraft(); }); $('mode-speed').addEventListener('click', () => { setTimingMode('speed'); saveDraft(); });
  function updateTiming() {
    document.querySelectorAll('[data-hours]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.hours) === Number($('hours').value))));
    $('setup-typing-value').textContent = `${$('setup-typing').value} char/s`; $('setup-pointer-value').textContent = `${$('setup-pointer').value}×`;
    saveDraft();
  }
  document.querySelectorAll('[data-hours]').forEach(button => button.addEventListener('click', () => { $('hours').value = button.dataset.hours; updateTiming(); }));
  for (const id of ['hours', 'setup-typing', 'setup-pointer']) $(id).addEventListener('input', updateTiming);
  $('setup-form').addEventListener('submit', event => {
    event.preventDefault(); if ($('start-replay').disabled || !selectedCommit) return;
    const timing = timingMode === 'duration' ? { mode: 'duration', durationMs: Number($('hours').value) * 3600000 } : { mode: 'speed', charactersPerSecond: Number($('setup-typing').value), pointerMultiplier: Number($('setup-pointer').value) };
    $('start-replay').disabled = true;
    send('prepare', { repositoryId: setup.selectedRepositoryId, startOid: selectedCommit.oid, endOid: setup.endOid, timing });
  });
  $('cancel-prepare').addEventListener('click', () => send('stop'));
  $('new-replay').addEventListener('click', () => { editingSetup = true; render(); renderSetup(); });
  $('back').addEventListener('click', () => { editingSetup = false; saveDraft(); render(); });
  $('settings').addEventListener('click', () => { $('playback-settings').hidden = !$('playback-settings').hidden; $('settings').setAttribute('aria-expanded', String(!$('playback-settings').hidden)); });
  $('toggle-controls').addEventListener('click', () => { controlsHidden = !controlsHidden; renderControls(); saveDraft(); phaseKey = ''; pointer(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && controlsHidden && !$('playback').hidden) { $('toggle-controls').click(); $('toggle-controls').focus(); }
  });
  $('play').addEventListener('click', () => send(state.status === 'running' ? 'pause' : state.status === 'ready' ? 'start' : 'resume'));
  for (const id of ['stop', 'restart', 'clear', 'follow']) $(id).addEventListener('click', () => send(id));
  const changeSpeed = () => send('speed', { charactersPerSecond: Number($('typing').value), pointerMultiplier: Number($('pointer-speed').value) });
  $('typing').addEventListener('change', changeSpeed); $('pointer-speed').addEventListener('change', changeSpeed);
  $('previous-files').addEventListener('click', () => send('page', { offset: 0 }));
  $('next-files').addEventListener('click', () => { if (state.nextPage != null) send('page', { offset: state.nextPage }); });
  let wheelAt = 0;
  $('code-scroll').addEventListener('wheel', event => {
    if (!state.frame || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
    event.preventDefault(); if (performance.now() - wheelAt < 100) return; wheelAt = performance.now();
    send('viewport', { firstLine: Math.max(0, state.frame.firstLine + Math.sign(event.deltaY) * 6) });
  }, { passive: false });
  $('code-scroll').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(event.key) || !state.frame) return;
    event.preventDefault(); const amount = event.key.includes('Page') ? 40 : 1;
    send('viewport', { firstLine: Math.max(0, state.frame.firstLine + (/Down$/.test(event.key) ? amount : -amount)) });
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopPointer(); else { phaseKey = ''; pointer(); } });
  motion.addEventListener('change', () => { phaseKey = ''; pointer(); });
  window.addEventListener('resize', () => { phaseKey = ''; pointer(); });
  $('hours').value = draft.hours ?? '6'; $('setup-typing').value = draft.typing ?? '24'; $('setup-pointer').value = draft.pointer ?? '1'; $('commit-search').value = draft.search ?? '';
  setTimingMode(draft.timingMode === 'speed' ? 'speed' : 'duration'); updateTiming(); renderControls();
  send('ready');
})();
