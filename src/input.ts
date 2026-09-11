import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';

// One outstanding request; no input backlog after Pause, focus loss, or a slow VM.
export function createNativeInput(script: string, python: string, notify: (status: string) => void) {
  let child: ChildProcessWithoutNullStreams | undefined, ready = false, armed = false, pending = false;
  let output = '', timer: NodeJS.Timeout | undefined;
  function stop(status = 'Off'): void {
    const previous = child; child = undefined; ready = armed = pending = false; output = '';
    if (timer) clearTimeout(timer); timer = undefined;
    if (previous) {
      // EOF lets an in-flight down/up pair finish before the helper exits.
      previous.stdin.end();
      const kill = setTimeout(() => previous.kill(), 1000); kill.unref();
      previous.once('exit', () => clearTimeout(kill));
    }
    notify(status);
  }
  return {
    stop,
    start(): void {
      if (child) return;
      stop('Starting…');
      const process = spawn(python, ['-I', '-u', script], { windowsHide: true, shell: false });
      child = process;
      timer = setTimeout(() => { if (child === process) stop('Input helper timed out. Re-enable VM input to retry.'); }, 5000);
      process.on('error', error => { if (child === process) stop(`Cannot start Python: ${error.message}`); });
      process.stdin.on('error', () => { if (child === process) stop('Input helper disconnected.'); });
      process.stderr.on('data', () => { /* Only structured stdout is displayed. */ });
      process.stdout.on('data', chunk => {
        if (child !== process) return;
        output += chunk.toString();
        if (output.length > 4096) { stop('Invalid input helper response.'); return; }
        let newline: number;
        while ((newline = output.indexOf('\n')) >= 0) {
          const line = output.slice(0, newline); output = output.slice(newline + 1);
          try {
            const response = JSON.parse(line);
            if (typeof response.error === 'string') { stop(response.retry === true ? 'Waiting · return to the replay preview' : response.error); return; }
            if (!['ready', 'armed'].includes(response.status)) throw new Error();
            ready = true; armed = response.status === 'armed'; pending = false;
            if (timer) clearTimeout(timer); timer = undefined;
            notify(armed ? 'Armed · Escape to stop' : 'Ready · keep focus in the replay preview');
          } catch { stop('Invalid input helper response.'); return; }
        }
      });
      process.on('exit', () => { if (child === process) stop('Input helper stopped. Re-enable VM input to retry.'); });
    },
    pulse(kind: string, at: number): void {
      if (!child || !ready || pending) return;
      if (!Number.isFinite(at)) { stop('Invalid input heartbeat.'); return; }
      // Drop delayed VM requests without restarting a healthy helper or replaying a backlog.
      if (Date.now() - at < 0 || Date.now() - at > 250) return;
      if (!['type', 'delete', 'move', 'click', 'hover', 'scroll', 'wait', 'save'].includes(kind)) return;
      // Idle phases still verify the field but do not produce input.
      if (armed && !['type', 'delete', 'move', 'click'].includes(kind)) return;
      pending = true;
      child.stdin.write(JSON.stringify(armed ? { op: 'pulse', kind, at } : { op: 'arm', at }) + '\n');
      timer = setTimeout(() => stop('Input helper response timed out.'), 1000);
    },
  };
}
