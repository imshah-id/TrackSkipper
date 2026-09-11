(() => {
  'use strict';
  const api = acquireVsCodeApi(), $ = id => document.getElementById(id);
  const draft = api.getState() || {};
  const inSidebar = document.body.dataset.sidebar === 'true';
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
    const paths = { close: 'm4 4 8 8 M12 4l-8 8', fullscreen: 'M6 2H2v4 M10 2h4v4 M14 10v4h-4 M6 14H2v-4', file: 'M9 1.5H3.5v13h9V5z M9 1.5V5h3.5', folder: 'M1.5 3h5l2 2h6v8h-13z', play: 'M4 2.5v11l9-5.5z', pause: 'M5 3v10 M11 3v10', stop: 'M3.5 3.5h9v9h-9z', restart: 'M2 6a6 6 0 1 1 .5 5 M2 2v4h4', plus: 'M8 2v12 M2 8h12', chevron: 'm4 6 4 4 4-4', settings: 'M2 4h12 M2 12h12 M5 2v4 M11 10v4' };
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
        button.setAttribute('aria-current', String(file.label === state.activePath)); button.setAttribute('aria-label', change ? `${file.label}, ${change}` : file.label);
        tag.className = 'file-tag'; tag.dataset.change = file.change; tag.textContent = file.change; tag.title = change;
        name.className = 'file-name'; name.textContent = file.label.split('/').pop();
        button.append(icon(file.label), name, tag); button.addEventListener('click', () => send('browse', file.pathBase64 ? { pathBase64: file.pathBase64 } : { offset: file.offset })); parent.append(button);
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
    const busy = setup.loading || state.status === 'preparing' || state.status === 'running';
    $('start-replay').disabled = busy || !setup.commits.length || !selectedCommit || !setup.selectedRepositoryId || !setup.endOid;
    $('start-replay').textContent = state.status === 'preparing' ? 'Preparing…' : state.status === 'running' ? 'Replay running' : 'Start replay';
    $('cancel-prepare').hidden = state.status !== 'preparing' || !state.canCancelPreparation;
    $('back').textContent = inSidebar ? 'Open playback' : 'Back to playback';
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
  let codePath = '', codeFirstLine = -1, codeViewport = -1, codeSession = '', scrollAnimation;
  function renderCode(frame) {
    if (!frame) { scrollAnimation?.cancel(); codeViewport = -1; return; }
    const code = $('code'), lineHeight = parseFloat(getComputedStyle(code).lineHeight);
    const viewport = frame.viewportLine ?? frame.firstLine;
    if (codeViewport !== viewport || codeFirstLine !== frame.firstLine || codePath !== state.activePath || codeSession !== sessionId) {
      const previous = codeFirstLine - new DOMMatrixReadOnly(getComputedStyle(code).transform).m42 / lineHeight;
      scrollAnimation?.cancel();
      const target = -(viewport - frame.firstLine) * lineHeight;
      code.style.transform = `translateY(${target}px)`;
      if (codeViewport >= 0 && codePath === state.activePath && codeSession === sessionId && !motion.matches && !document.hidden) {
        const visibleRows = Math.max(1, Math.floor(($('code-scroll').clientHeight - 8) / lineHeight));
        const lastStart = Math.max(viewport, frame.firstLine + frame.lines.length - visibleRows);
        const from = Math.max(frame.firstLine, Math.min(previous, lastStart));
        scrollAnimation = code.animate([{ transform: `translateY(${-(from - frame.firstLine) * lineHeight}px)` }, { transform: `translateY(${target}px)` }],
          { duration: state.phase?.kind === 'scroll' ? 100 : 280, easing: 'ease-out' });
      }
    }
    if (motion.matches || state.status !== 'running') scrollAnimation?.finish();
    // Recompute the resting offset when editor typography changes too.
    code.style.transform = `translateY(${-(viewport - frame.firstLine) * lineHeight}px)`;
    if (codePath !== state.activePath) $('code-scroll').scrollLeft = 0;
    if (codePath !== state.activePath || codeFirstLine !== frame.firstLine) $('code-scroll').scrollTop = 0;
    codePath = state.activePath; codeFirstLine = frame.firstLine; codeViewport = viewport; codeSession = sessionId;
    const language = state.activePath?.split('.').pop().toLowerCase() || ''; let block = false;
    rows.forEach((item, index) => {
      item.row.hidden = index >= frame.lines.length; if (item.row.hidden) return;
      item.number.textContent = String(frame.firstLine + index + 1);
      const line = frame.lines[index];
      const tabSize = Math.max(1, Math.min(16, Number(state.editor?.tabSize) || 4));
      let indent = 0;
      for (const character of line) {
        if (character === ' ') indent++;
        else if (character === '\t') indent += tabSize - indent % tabSize;
        else break;
      }
      item.content.style.setProperty('--indent-width', `${indent}ch`);
      const column = frame.caret?.row === index ? frame.caret.column : -1;
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
  let nativeArmed = false, nativeRequested = false, nativeTimer, nativeQuietUntil = 0, lastNativeStatus = 'Off';
  function nativeStatus() {
    const label = $('native-enabled').checked && !nativeArmed
      ? 'Enabled · click the preview to resume · Escape to turn off' : state.nativeStatus || 'Off';
    if ($('native-status').textContent !== label) $('native-status').textContent = label;
  }
  function suspendNative() {
    if (nativeArmed) { nativeArmed = false; send('nativeInput', { action: 'stop', at: Date.now() }); }
    nativeQuietUntil = performance.now() + 300;
    nativeStatus();
  }
  function stopNative() {
    nativeRequested = false; clearInterval(nativeTimer); nativeTimer = undefined;
    $('native-enabled').checked = false; $('native-pad').hidden = true;
    suspendNative();
  }
  function nativeTick() {
    if (!nativeRequested) return;
    const pad = $('native-pad');
    if (document.hidden || !document.hasFocus() || document.activeElement !== pad || !pad.matches(':hover')
      || pad.hidden || !state.frame || state.status !== 'running') { suspendNative(); return; }
    if (performance.now() < nativeQuietUntil) return;
    if (!nativeArmed) { nativeArmed = true; send('nativeInput', { action: 'arm', at: Date.now() }); }
    else send('nativeInput', { action: 'pulse', at: Date.now() });
  }
  $('native-enabled').addEventListener('change', () => {
    if (!$('native-enabled').checked) stopNative();
    else { $('native-pad').hidden = false; $('code-scroll').scrollTop = $('code-scroll').scrollLeft = 0; nativeStatus(); }
  });
  function armNative(event) {
    if (!event.isTrusted || nativeArmed || !$('native-enabled').checked || state.status !== 'running') return;
    if (event.type === 'keydown' && !$('native-pad').matches(':hover')) { $('native-status').textContent = 'Park the pointer inside the preview before arming.'; return; }
    nativeRequested = true; nativeQuietUntil = 0;
    nativeTimer ??= setInterval(nativeTick, 100);
    nativeTick();
  }
  $('native-pad').addEventListener('click', armNative);
  $('native-pad').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); armNative(event); }
    else if (['a', 'A', 'Backspace'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); }
  });
  $('native-pad').addEventListener('blur', suspendNative);
  $('native-pad').addEventListener('pointerleave', suspendNative);
  document.addEventListener('pointermove', event => { if (event.movementX || event.movementY) suspendNative(); }, true);
  window.addEventListener('blur', suspendNative);
  window.addEventListener('resize', suspendNative);
  document.addEventListener('visibilitychange', () => { if (document.hidden) suspendNative(); });
  // Playback scrolls the Explorer and tabs itself; only user scroll input suspends delivery.
  for (const type of ['wheel', 'touchmove']) document.addEventListener(type, suspendNative, { capture: true, passive: true });
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
    $('native-enabled').disabled = !state.configured || !['running', 'paused'].includes(state.status);
    if ($('native-enabled').checked && !['running', 'paused'].includes(state.status)) stopNative();
    else if (state.status === 'paused') suspendNative();
    if (state.nativeStatus !== lastNativeStatus) {
      lastNativeStatus = state.nativeStatus;
      if (nativeRequested && (state.nativeStatus === 'Off' || state.nativeStatus?.startsWith('Waiting'))) {
        nativeArmed = false; nativeQuietUntil = performance.now() + (state.nativeStatus === 'Off' ? 300 : 1000);
      } else if (nativeRequested && state.nativeStatus && !/^(Starting|Ready|Armed)/.test(state.nativeStatus)) {
        nativeArmed = false; stopNative();
      }
    }
    nativeStatus();
    const running = state.status === 'running', preparing = state.status === 'preparing';
    if (running && editingSetup) { editingSetup = false; saveDraft(); }
    const showingSetup = inSidebar || !state.configured || editingSetup;
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
    $('empty-message').textContent = state.tabs?.length ? 'Opening the first file…' : 'Select a file or follow playback';
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
      const focused = document.activeElement.closest('.tab');
      const focusedLabel = focused?.dataset.path, focusedClose = document.activeElement.classList.contains('tab-close');
      const scrollLeft = $('tabs').scrollLeft;
      $('tabs').replaceChildren(...(state.tabs || []).map(tab => {
        const wrapper = document.createElement('div'), button = document.createElement('button'), label = document.createElement('span'), close = document.createElement('button');
        const target = tab.pathBase64 ? { pathBase64: tab.pathBase64 } : { offset: tab.offset };
        wrapper.className = `tab${tab.label === state.activePath ? ' selected' : ''}`; wrapper.dataset.path = tab.label;
        button.className = 'tab-select'; button.title = tab.label; button.disabled = close.disabled = running;
        label.textContent = tab.label.split('/').pop();
        button.setAttribute('aria-current', String(tab.label === state.activePath)); button.append(icon(tab.label), label);
        button.addEventListener('click', () => send('browse', target));
        close.className = 'tab-close'; close.title = `Close ${tab.label}`; close.setAttribute('aria-label', close.title); close.append(glyph('close'));
        close.addEventListener('click', () => send('closeTab', target));
        wrapper.addEventListener('mousedown', event => { if (event.button === 1) event.preventDefault(); });
        wrapper.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); if (!running) send('closeTab', target); } });
        wrapper.append(button, close); return wrapper;
      }));
      $('tabs').scrollLeft = scrollLeft;
      const active = $('tabs').querySelector('.selected');
      if (active && !controlsHidden) {
        const tabRect = active.getBoundingClientRect(), strip = $('tabs').getBoundingClientRect();
        if (tabRect.left < strip.left) $('tabs').scrollLeft -= strip.left - tabRect.left;
        else if (tabRect.right > strip.right) $('tabs').scrollLeft += tabRect.right - strip.right;
      }
      if (focusedLabel) {
        const replacement = [...$('tabs').children].find(tab => tab.dataset.path === focusedLabel) || active;
        replacement?.querySelector(focusedClose ? '.tab-close' : '.tab-select')?.focus({ preventScroll: true });
      }
      if (!state.tabs?.length) { const tab = document.createElement('span'); tab.className = 'tab empty-tab'; tab.textContent = 'Preview'; $('tabs').append(tab); }
    }
    renderCode(state.frame); reportViewportSize(); pointer();
  }
  window.addEventListener('message', event => {
    if (event.data?.type === 'state') { if (sessionId !== event.data.sessionId) stopNative(); state = event.data; sessionId = state.sessionId; render(); }
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
  $('new-replay').addEventListener('click', () => send('configure'));
  $('back').addEventListener('click', () => { if (inSidebar) send('showPlayback'); else { editingSetup = false; saveDraft(); render(); } });
  $('settings').addEventListener('click', () => { $('playback-settings').hidden = !$('playback-settings').hidden; $('settings').setAttribute('aria-expanded', String(!$('playback-settings').hidden)); });
  $('toggle-controls').addEventListener('click', () => { suspendNative(); controlsHidden = !controlsHidden; renderControls(); if (nativeRequested) $('native-pad').focus({ preventScroll: true }); saveDraft(); phaseKey = ''; pointer(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('native-enabled').checked) { event.preventDefault(); stopNative(); }
    if (event.key === 'Escape' && controlsHidden && !$('playback').hidden) { $('toggle-controls').click(); $('toggle-controls').focus(); }
  });
  $('play').addEventListener('click', () => send(state.status === 'running' ? 'pause' : state.status === 'ready' ? 'start' : 'resume'));
  for (const id of ['stop', 'restart', 'clear', 'follow']) $(id).addEventListener('click', () => send(id));
  const changeSpeed = () => send('speed', { charactersPerSecond: Number($('typing').value), pointerMultiplier: Number($('pointer-speed').value) });
  $('typing').addEventListener('change', changeSpeed); $('pointer-speed').addEventListener('change', changeSpeed);
  let viewportKey = '';
  const reportViewportSize = () => {
    if ($('code-scroll').hidden || !$('setup').hidden || !$('code-scroll').clientHeight) return;
    const lineHeight = parseFloat(getComputedStyle($('code')).lineHeight);
    const rows = Math.max(1, Math.min(120, Math.floor(($('code-scroll').clientHeight - 8) / lineHeight)));
    const key = `${sessionId}:${rows}`;
    if (Number.isFinite(rows) && key !== viewportKey) { viewportKey = key; send('viewportSize', { rows }); }
  };
  new ResizeObserver(reportViewportSize).observe($('code-scroll'));
  $('tabs').addEventListener('wheel', event => {
    if (!event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY) || $('tabs').scrollWidth <= $('tabs').clientWidth) return;
    event.preventDefault(); $('tabs').scrollLeft += event.deltaY;
  }, { passive: false });
  let wheelAt = 0;
  $('code-scroll').addEventListener('wheel', event => {
    if (!state.frame || !event.deltaY || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
    event.preventDefault(); if (performance.now() - wheelAt < 100) return; wheelAt = performance.now();
    scrollAnimation?.finish();
    send('viewport', { firstLine: Math.max(0, (state.frame.viewportLine ?? state.frame.firstLine) + Math.sign(event.deltaY) * 6) });
  }, { passive: false });
  $('code-scroll').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(event.key) || !state.frame) return;
    event.preventDefault(); const amount = event.key.includes('Page') ? 40 : 1;
    scrollAnimation?.finish();
    send('viewport', { firstLine: Math.max(0, (state.frame.viewportLine ?? state.frame.firstLine) + (/Down$/.test(event.key) ? amount : -amount)) });
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopPointer(); else { phaseKey = ''; pointer(); } });
  motion.addEventListener('change', () => { if (motion.matches) scrollAnimation?.finish(); phaseKey = ''; pointer(); });
  window.addEventListener('resize', () => { phaseKey = ''; pointer(); });
  $('hours').value = draft.hours ?? '6'; $('setup-typing').value = draft.typing ?? '24'; $('setup-pointer').value = draft.pointer ?? '1'; $('commit-search').value = draft.search ?? '';
  setTimingMode(draft.timingMode === 'speed' ? 'speed' : 'duration'); updateTiming(); renderControls();
  send('ready');
})();
