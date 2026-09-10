(() => {
  'use strict';
  const api = acquireVsCodeApi();
  let sessionId = document.body.dataset.session, state = {}, animation, pointerX = 100, pointerY = 100, phaseKey = '';
  const $ = id => document.getElementById(id);
  const send = (type, values = {}) => api.postMessage({ type, sessionId, ...values });
  const time = ms => { const seconds = Math.max(0, Math.floor((ms || 0) / 1000)); return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':'); };
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const rows = Array.from({ length: 120 }, () => {
    const row = document.createElement('div'), number = document.createElement('span'), content = document.createElement('span');
    row.className = 'code-row'; number.className = 'line-number'; content.className = 'line-content';
    row.append(number, content); return { row, number, content };
  });
  $('code').append(...rows.map(item => item.row));
  let lastLines = null, lastCaret = '', lastFirstLine = -1, lastFiles = '', lastTabs = '';
  function renderCode(frame) {
    if (!frame) return;
    const caretKey = JSON.stringify(frame.caret);
    if (frame.lines === lastLines && caretKey === lastCaret && lastFirstLine === frame.firstLine) return;
    rows.forEach((item, index) => {
      item.row.hidden = index >= frame.lines.length;
      if (item.row.hidden) return;
      item.number.textContent = String(frame.firstLine + index + 1);
      const line = frame.lines[index];
      item.row.classList.toggle('active', frame.caret?.row === index);
      if (frame.caret?.row === index) {
        const cursor = document.createElement('span'); cursor.className = 'caret';
        item.content.replaceChildren(document.createTextNode(line.slice(0, frame.caret.column)), cursor, document.createTextNode(line.slice(frame.caret.column)));
      } else if (item.content.textContent !== line || item.content.querySelector('.caret')) item.content.textContent = line;
    });
    lastLines = frame.lines; lastCaret = caretKey; lastFirstLine = frame.firstLine;
  }
  function stopPointer() { if (animation) cancelAnimationFrame(animation); animation = undefined; $('virtual-pointer').classList.remove('clicking'); }
  function pointer() {
    if (motion.matches || state.status !== 'running' || !state.phase || document.hidden) { stopPointer(); $('virtual-pointer').hidden = true; phaseKey = ''; return; }
    const key = `${state.recordNumber}:${state.phase.kind}:${state.phase.editIndex}:${state.phase.target}`;
    if (key === phaseKey) return;
    phaseKey = key; stopPointer();
    const marker = $('virtual-pointer'); marker.hidden = false;
    const target = state.phase.target === 'file' ? document.querySelector('.file-button.selected') || $('tabs') : document.querySelector('.caret') || $('code');
    const rect = target.getBoundingClientRect();
    const targetX = Math.max(5, Math.min(innerWidth - 25, rect.left + (state.phase.target === 'file' ? 30 : 2)));
    const targetY = Math.max(52, Math.min(innerHeight - 85, rect.top + 8));
    const startX = pointerX, startY = pointerY;
    const moving = state.phase.kind === 'move' || state.phase.kind === 'scroll';
    const duration = moving ? Math.max(1, state.phaseDurationMs - state.phaseElapsedMs) : 0;
    const began = performance.now(); let previous = -Infinity;
    const tick = now => {
      if (now - previous < 1000 / 30) { animation = requestAnimationFrame(tick); return; }
      previous = now;
      const t = duration ? Math.min(1, (now - began) / duration) : 1, eased = t * t * (3 - 2 * t);
      pointerX = startX + (targetX - startX) * eased; pointerY = startY + (targetY - startY) * eased;
      marker.style.transform = `translate(${pointerX}px, ${pointerY}px)`;
      if (t < 1) animation = requestAnimationFrame(tick);
      else { animation = undefined; marker.classList.toggle('clicking', state.phase.kind === 'click'); }
    };
    animation = requestAnimationFrame(tick);
  }
  function render() {
    $('repository').textContent = state.repository || 'No repository selected';
    $('start-commit').textContent = state.start?.slice(0, 12) || 'Select a starting commit';
    $('end-commit').textContent = state.end?.slice(0, 12) || 'Latest commit';
    $('notice').textContent = state.notice || ''; $('notice').hidden = !state.notice; $('notice').classList.toggle('error', !!state.isError);
    const running = state.status === 'running', preparing = state.status === 'preparing';
    const fixed = state.timing?.mode === 'speed', editable = fixed && state.status === 'paused';
    $('timing-mode').textContent = fixed ? 'Fixed typing speed' : 'Finish in duration';
    $('duration-label').textContent = time(state.totalMs);
    $('typing').disabled = $('pointer-speed').disabled = !editable;
    if (fixed) { $('typing').value = state.timing.charactersPerSecond; $('pointer-speed').value = state.timing.pointerMultiplier; }
    $('typing-value').textContent = fixed ? `${state.timing.charactersPerSecond} char/s` : 'Automatic';
    $('pointer-value').textContent = fixed ? `${state.timing.pointerMultiplier}×` : 'Automatic';
    $('timing-hint').textContent = fixed ? 'Pause to adjust speed. Duration updates with your settings.' : 'Typing and pauses fit the duration. Manual pauses extend completion.';
    $('empty').hidden = !!state.frame; $('code-scroll').hidden = !state.frame;
    $('configure-empty').textContent = state.configured ? 'Configure another replay →' : 'Configure replay →';
    $('configure').disabled = $('configure-empty').disabled = running || preparing;
    $('play').disabled = !state.configured || preparing || state.status === 'complete';
    $('play').textContent = running ? 'Ⅱ Pause' : state.status === 'ready' ? '▶ Start' : '▶ Resume';
    $('stop').disabled = !state.configured || ['stopped', 'complete', 'ready'].includes(state.status);
    $('restart').disabled = $('clear').disabled = !state.configured || preparing || running;
    $('follow').disabled = !state.configured;
    $('elapsed').textContent = time(state.elapsedMs); $('total').textContent = time(state.totalMs);
    $('progress').value = state.totalMs ? Math.min(1, state.elapsedMs / state.totalMs) : 0;
    $('status').textContent = state.status || 'Ready'; $('status').dataset.status = state.status || 'ready';
    $('file-path').textContent = state.activePath || 'Git Replay'; $('commit-subject').textContent = state.subject || (state.status === 'complete' ? 'Replay complete' : state.configured ? 'Prepared and ready to replay' : 'Ready when you are');
    $('phase').textContent = state.status === 'complete' ? 'Complete' : state.phase ? `${state.phase.kind} · ${state.recordNumber}/${state.recordCount}` : 'No active replay';
    $('file-count').textContent = String(state.files?.length || 0);
    const filesKey = JSON.stringify([state.files, state.activePath, running]);
    if (filesKey !== lastFiles) {
      lastFiles = filesKey;
      $('files').replaceChildren(...(state.files || []).map(file => {
        const button = document.createElement('button'), tag = document.createElement('span'), name = document.createElement('span');
        button.className = `file-button${file.label === state.activePath ? ' selected' : ''}`; button.title = file.label; button.disabled = running;
        tag.className = 'file-tag'; tag.textContent = file.change; name.textContent = file.label;
        button.append(tag, name); button.addEventListener('click', () => send('browse', { offset: file.offset })); return button;
      }));
    }
    const tabsKey = JSON.stringify([state.tabs, state.activePath, running]);
    if (tabsKey !== lastTabs) {
      lastTabs = tabsKey;
      if (state.tabs?.length) $('tabs').replaceChildren(...state.tabs.map(tab => {
        const button = document.createElement('button'); button.className = `tab${tab.label === state.activePath ? ' selected' : ''}`;
        button.textContent = tab.label.split('/').pop(); button.title = tab.label; button.disabled = running;
        button.addEventListener('click', () => send('browse', { offset: tab.offset })); return button;
      }));
      else { const tab = document.createElement('span'); tab.className = 'tab empty-tab'; tab.textContent = 'Preview'; $('tabs').replaceChildren(tab); }
    }
    $('previous-files').disabled = !state.previousPage; $('next-files').disabled = state.nextPage == null;
    renderCode(state.frame); pointer();
  }
  window.addEventListener('message', event => { if (event.data?.type !== 'state') return; state = event.data; sessionId = state.sessionId; render(); });
  for (const id of ['configure', 'configure-empty']) $(id).addEventListener('click', () => send('configure'));
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
  send('ready');
})();
