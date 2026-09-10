import { validateTiming } from './timing';
import { Timing } from './types';
export type PanelCommand = { type: string; sessionId: string; action?: 'arm' | 'pulse' | 'stop'; at?: number; firstLine?: number; rows?: number; offset?: number; pathBase64?: string; charactersPerSecond?: number; pointerMultiplier?: number; repositoryId?: string; cursor?: string | null; startOid?: string; endOid?: string; timing?: Timing };
export function validCommand(value: unknown, sessionId: string): value is PanelCommand {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  if (input.sessionId !== sessionId || typeof input.type !== 'string') return false;
  const keys = ['type', 'sessionId'];
  const oid = (value: unknown) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
  if (input.type === 'nativeInput') {
    keys.push('action', 'at');
    if (!['arm', 'pulse', 'stop'].includes(input.action as string) || !Number.isSafeInteger(input.at) || (input.at as number) < 0) return false;
  } else if (input.type === 'repository' || input.type === 'prepare') {
    keys.push('repositoryId');
    if (typeof input.repositoryId !== 'string' || !input.repositoryId.length || input.repositoryId.length > 1024) return false;
    if (input.type === 'prepare') {
      keys.push('startOid', 'endOid', 'timing');
      if (!oid(input.startOid) || !oid(input.endOid)) return false;
      try { validateTiming(input.timing); } catch { return false; }
    }
  } else if (input.type === 'commits') {
    keys.push('cursor');
    if (input.cursor !== null && !oid(input.cursor)) return false;
  } else if (input.type === 'speed') {
    keys.push('charactersPerSecond', 'pointerMultiplier');
    try { validateTiming({ mode: 'speed', charactersPerSecond: input.charactersPerSecond, pointerMultiplier: input.pointerMultiplier }); } catch { return false; }
  } else if (input.type === 'viewportSize') {
    keys.push('rows');
    if (!Number.isSafeInteger(input.rows) || (input.rows as number) < 1 || (input.rows as number) > 120) return false;
  } else if (['browse', 'closeTab'].includes(input.type) && input.pathBase64 !== undefined) {
    keys.push('pathBase64');
    if (typeof input.pathBase64 !== 'string' || !input.pathBase64.length || input.pathBase64.length > 65536
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.pathBase64)) return false;
  } else if (input.type === 'viewport' || input.type === 'browse' || input.type === 'closeTab') {
    const key = input.type === 'viewport' ? 'firstLine' : 'offset'; keys.push(key);
    if (!Number.isSafeInteger(input[key]) || (input[key] as number) < 0) return false;
  } else if (!['ready', 'configure', 'discover', 'repositoryBrowse', 'start', 'pause', 'resume', 'stop', 'restart', 'clear', 'follow', 'fullscreen'].includes(input.type)) return false;
  return Object.keys(input).every(key => keys.includes(key));
}

export function panelHtml(options: { script: string; style: string; cspSource: string; nonce: string; sessionId: string }): string {
  const attr = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
  const fullscreen = '<button type="button" data-fullscreen class="text-button" aria-label="Toggle VS Code full screen" title="Toggle VS Code full screen. Keeps your sidebar and top bar layout; click again to exit."><span data-icon="fullscreen"></span><span class="fullscreen-label">Full screen</span></button>';
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${attr(options.cspSource)}; script-src 'nonce-${attr(options.nonce)}';">
<title>Git Replay</title><link rel="stylesheet" href="${attr(options.style)}"></head>
<body data-session="${attr(options.sessionId)}">
<div id="notice" class="notice" role="status" hidden></div>
<main id="setup" class="setup">
<div class="setup-content">
<header class="setup-heading"><div><h1>Set up a replay</h1><p>Choose where to start. Replay through the latest commit.</p></div><div class="setup-heading-actions">${fullscreen}<button id="back" class="secondary" hidden>Back to playback</button></div></header>
<section class="repository-section" aria-labelledby="repository-label">
<label id="repository-label" for="repository">Repository</label>
<div class="repository-controls"><select id="repository" disabled><option>Finding repositories…</option></select><button id="refresh" class="secondary" title="Refresh repositories and latest commit">Refresh</button><button id="browse-repository" class="secondary">Browse…</button></div>
<p id="repository-path" class="hint path">Looking in your open workspace</p>
<div id="setup-error" class="error-box" role="alert" hidden></div>
</section>
<form id="setup-form">
<div class="setup-columns">
<section class="commit-section" aria-labelledby="commits-heading">
<div class="section-heading"><h2 id="commits-heading">Starting commit</h2><span id="commit-count" class="hint"></span></div>
<input id="commit-search" type="search" placeholder="Search loaded commits" aria-label="Search loaded commits" autocomplete="off">
<div id="commits" class="commit-list" role="radiogroup" aria-label="Starting commit"><p class="list-empty">Loading commits…</p></div>
<div class="pager"><span class="hint">Newest first · first-parent history</span><div><button id="latest-commits" type="button" class="text-button" disabled>Latest</button><button id="older-commits" type="button" class="text-button" disabled>Older ↓</button></div></div>
</section>
<section class="timing-section" aria-labelledby="timing-heading">
<h2 id="timing-heading">Playback timing</h2>
<div class="segmented" role="group" aria-label="Timing mode"><button id="mode-duration" type="button" aria-pressed="true">Set duration</button><button id="mode-speed" type="button" aria-pressed="false">Set speed</button></div>
<div id="duration-settings"><label for="hours">Finish in</label><div class="duration-input"><input id="hours" type="number" min="0.001" max="720" step="any" value="6" required><span>hours</span></div><div class="presets"><button type="button" data-hours="0.25">15 min</button><button type="button" data-hours="1">1 hour</button><button type="button" data-hours="6" aria-pressed="true">6 hours</button></div><p class="hint">Typing and pauses are paced to fit. Pausing playback extends the finish time.</p></div>
<div id="speed-settings" hidden><label for="setup-typing">Typing speed <output id="setup-typing-value">24 char/s</output></label><input id="setup-typing" type="range" min="1" max="200" value="24"><label for="setup-pointer">Pointer speed <output id="setup-pointer-value">1×</output></label><input id="setup-pointer" type="range" min="0.25" max="4" step="0.25" value="1"><p class="hint">Duration follows the amount of code. You can adjust these speeds while paused.</p></div>
<div class="range-summary"><span class="hint">Selected range · inclusive</span><strong id="selected-commit">Choose a starting commit</strong><span class="hint">↓ through latest <code id="end-commit">—</code></span></div>
<p class="isolation-note">Runs in its own scratch workspace. Your files stay isolated. System input is off unless you enable VM system input during playback.</p>
</section>
</div>
<footer class="setup-actions"><span id="selection-hint" class="hint">Choose a repository and a starting commit.</span><button id="cancel-prepare" type="button" class="secondary" hidden>Cancel</button><button id="start-replay" type="submit" class="primary" disabled>Start replay</button></footer>
</form>
</div>
</main>
<div id="playback" class="playback" hidden>
<div class="workbench">
<aside class="explorer" aria-label="Replayed files"><div class="explorer-heading"><span>EXPLORER</span><button id="new-replay" title="Set up another replay" aria-label="Set up another replay"><span data-icon="plus"></span></button></div><div class="folder-heading"><span data-icon="chevron"></span><strong id="workspace-name">REPLAY</strong><span id="file-count"></span></div><div id="files" aria-label="Repository files at this commit"></div><p id="files-hint" class="files-hint">Pause to browse files</p><button id="clear" class="text-button clear-session" disabled>Clear session</button></aside>
<main class="editor" aria-label="Replay code preview">
<nav id="tabs" class="tabs" aria-label="Recent files"><span class="tab empty-tab">Preview</span></nav>
<div class="breadcrumbs"><span id="file-path">Git Replay</span><div class="editor-actions"><button id="follow" class="text-button" disabled>Follow playback</button><button id="toggle-controls" class="text-button" aria-expanded="true" aria-controls="transport playback-settings native-input" title="Hide playback controls (Escape to restore)"><span data-icon="settings"></span><span id="controls-label">Hide controls</span></button>${fullscreen}</div></div>
<div id="empty" class="editor-empty"><p id="empty-message">Opening the first file…</p></div>
<div id="code-scroll" class="code-scroll" tabindex="0" aria-label="Read-only replay code" hidden><div id="code" class="code"></div><textarea id="native-pad" aria-label="Read-only replay input surface. Click or press Enter to arm. Escape turns VM input off." readonly hidden spellcheck="false"></textarea></div>
<div id="native-input" class="native-input"><label><input id="native-enabled" type="checkbox"> VM system input</label><span id="native-status" role="status">Off</span></div>
<div class="editor-foot"><span id="commit-subject"></span><span id="phase"></span></div>
</main>
</div>
<section id="playback-settings" class="playback-settings" aria-label="Playback settings" hidden><div><strong id="timing-mode">Playback timing</strong><p id="timing-hint" class="hint"></p></div><div><label for="typing">Typing speed <output id="typing-value"></output></label><input id="typing" type="range" min="1" max="200" value="24" disabled></div><div><label for="pointer-speed">Pointer speed <output id="pointer-value"></output></label><input id="pointer-speed" type="range" min="0.25" max="4" step="0.25" value="1" disabled></div></section>
<footer id="transport" class="transport"><button id="restart" class="icon-button" title="Restart replay" aria-label="Restart replay" disabled><span data-icon="restart"></span></button><button id="play" class="transport-play" disabled><span id="play-icon" data-icon="play"></span><span id="play-label">Start</span></button><button id="stop" disabled><span data-icon="stop"></span>Stop</button><span id="status" class="status">Ready</span><div class="timeline"><span id="elapsed">00:00:00</span><progress id="progress" max="1" value="0" aria-label="Replay progress"></progress><span id="total">00:00:00</span></div><button id="settings" aria-expanded="false" aria-controls="playback-settings"><span data-icon="settings"></span>Timing</button></footer>
</div>
<div id="virtual-pointer" class="virtual-pointer" aria-hidden="true" hidden><svg width="22" height="27" viewBox="0 0 22 27"><path d="M2 2v20l5-5 4 8 4-2-4-8 8-1Z" fill="white" stroke="#181a1f" stroke-width="1.5" stroke-linejoin="round"/></svg><span class="click-ring"></span></div>
<script nonce="${attr(options.nonce)}" src="${attr(options.script)}"></script></body></html>`;
}
