import { validateTiming } from './timing';
export type PanelCommand = { type: string; sessionId: string; firstLine?: number; offset?: number; charactersPerSecond?: number; pointerMultiplier?: number };
export function validCommand(value: unknown, sessionId: string): value is PanelCommand {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  if (input.sessionId !== sessionId || typeof input.type !== 'string') return false;
  const keys = ['type', 'sessionId'];
  if (input.type === 'speed') {
    keys.push('charactersPerSecond', 'pointerMultiplier');
    try { validateTiming({ mode: 'speed', charactersPerSecond: input.charactersPerSecond, pointerMultiplier: input.pointerMultiplier }); } catch { return false; }
  } else if (input.type === 'viewport' || input.type === 'browse' || input.type === 'page') {
    const key = input.type === 'viewport' ? 'firstLine' : 'offset'; keys.push(key);
    if (!Number.isSafeInteger(input[key]) || (input[key] as number) < 0) return false;
  } else if (!['ready', 'configure', 'start', 'pause', 'resume', 'stop', 'restart', 'clear', 'follow'].includes(input.type)) return false;
  return Object.keys(input).every(key => keys.includes(key));
}

export function panelHtml(options: { script: string; style: string; cspSource: string; nonce: string; sessionId: string }): string {
  const attr = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${attr(options.cspSource)}; script-src 'nonce-${attr(options.nonce)}';">
<title>Git Replay</title><link rel="stylesheet" href="${attr(options.style)}"></head>
<body data-session="${attr(options.sessionId)}">
<header class="header"><div class="brand"><span class="commit-mark" aria-hidden="true">⎇</span><strong>Git Replay</strong><span class="edition">WORKSPACE</span></div><span class="isolation"><i></i> Isolated session</span><button id="configure" class="quiet">Configure replay</button></header>
<div id="notice" class="notice" role="status" hidden></div>
<div class="layout">
<aside class="sidebar" aria-label="Replay settings">
<section><h2>Repository</h2><div id="repository" class="field">No repository selected</div><div class="range-label"><h2>Commit range</h2><span>inclusive</span></div><label>From</label><div id="start-commit" class="field mono">Select a starting commit</div><label>Through</label><div id="end-commit" class="field mono">Latest commit</div><p class="hint">First-parent history · pinned at preparation</p></section>
<section><h2>Playback</h2><div class="setting-row"><span id="timing-mode">Duration</span><span id="duration-label" class="mono">—</span></div><label for="typing">Typing speed <output id="typing-value">24 char/s</output></label><input id="typing" type="range" min="1" max="200" value="24" disabled><label for="pointer-speed">Pointer speed <output id="pointer-value">1×</output></label><input id="pointer-speed" type="range" min="0.25" max="4" step="0.25" value="1" disabled><p id="timing-hint" class="hint">Configure a duration or fixed typing speed.</p></section>
<section class="changes"><div class="range-label"><h2>Changed files</h2><span id="file-count">0</span></div><div id="files" role="list" aria-label="Changed files"><p class="hint">Files appear when playback starts.</p></div><div class="pager"><button id="previous-files" class="quiet" disabled>Previous</button><button id="next-files" class="quiet" disabled>Next</button></div></section>
<div class="sidebar-bottom"><span class="hint">Your workspace stays untouched.</span><button id="clear" class="quiet" disabled>Clear session</button></div>
</aside>
<main class="editor" aria-label="Replay code preview"><nav id="tabs" class="tabs" aria-label="Recent files"><span class="tab empty-tab">Preview</span></nav>
<div class="editor-meta"><span id="file-path">Git Replay</span><button id="follow" class="quiet" disabled>Follow playback</button></div>
<div id="empty" class="empty"><div class="empty-symbol" aria-hidden="true">↗</div><p class="eyebrow">FROM HISTORY TO MOTION</p><h1>Watch your code take shape.</h1><p>Choose a commit range and replay its changes<br>in a workspace of its own.</p><button id="configure-empty" class="primary">Configure replay <span aria-hidden="true">→</span></button><span class="hint">Local Git objects. Independent mouse. Original files untouched.</span></div>
<div id="code-scroll" class="code-scroll" tabindex="0" aria-label="Read-only replay code" hidden><div id="code" class="code"></div></div>
<div class="editor-foot"><span id="commit-subject">Ready when you are</span><span id="phase">No active replay</span></div>
</main></div>
<footer class="transport"><div class="transport-buttons"><button id="restart" class="quiet" title="Restart replay" aria-label="Restart replay" disabled>↶</button><button id="play" class="primary" disabled>▶ Start</button><button id="stop" class="quiet" disabled>■ Stop</button></div><div class="timeline"><span id="elapsed" class="mono">00:00:00</span><progress id="progress" max="1" value="0" aria-label="Replay progress"></progress><span id="total" class="mono">00:00:00</span></div><span id="status" class="status">Ready</span></footer>
<div id="virtual-pointer" class="virtual-pointer" aria-hidden="true" hidden><svg width="22" height="27" viewBox="0 0 22 27"><path d="M2 2v20l5-5 4 8 4-2-4-8 8-1Z" fill="white" stroke="#181a1f" stroke-width="1.5" stroke-linejoin="round"/></svg><span class="click-ring"></span></div>
<script nonce="${attr(options.nonce)}" src="${attr(options.script)}"></script></body></html>`;
}
