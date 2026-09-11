# Git Replay

Replay an inclusive range of Git commits in an isolated VS Code panel. Code appears progressively, with an animated pointer that moves, hovers and clicks inside the preview. By default your actual mouse and keyboard remain independent. Optional VM system input emits guarded native events; source files, index and Git history remain independent.

## Install

Requires desktop VS Code **1.137 or later**, a trusted local Git workspace, and Git 2.45+. Tested on macOS Apple Silicon; Windows/Linux and remote workspaces are not validated. Remote and virtual workspaces are disabled.

1. In VS Code, run **Extensions: Install from VSIX…** and select `trackskipper.vsix`.
2. Open a local Git repository, click the **Git Replay** icon in the left Activity Bar. The setup form opens directly in the sidebar. You can also run **Git Replay: Open** from the Command Palette.
3. Your open repository is detected automatically. Use the repository dropdown or **Browse…** to choose another folder. Select a starting commit and a duration (for example, `6` hours) or typing speed.
4. Select **Start replay**. Preparation flows directly into playback. Use Pause, Resume, Stop, Restart or Clear session as needed.

Commit search filters the loaded page of up to 100 commits; **Older** loads the next page, and **Latest** returns to the newest page. Your selection and timing survive switching editor tabs. **Refresh** redetects repositories and pins the latest HEAD. Start replay to open the code preview in an editor tab. The sidebar keeps your setup choices; **Open playback** returns to an existing preview. Pause playback and choose **＋** in its Explorer to return to sidebar setup.

The start commit is included. The ending commit is pinned to HEAD when the repository is selected or refreshed; later commits do not change a prepared session. Replay follows first-parent history, oldest to newest. Merges appear once against their first parent; renames appear as deletion/addition; empty commits appear as milestones.

## Controls and timing

- **Duration:** fits the phase schedule and reading pauses to the requested active time. A duration below the minimum is rejected.
- **Fixed speed:** 1–200 grapheme clusters per second. Open **Timing** and pause to change typing or pointer speed; the estimated duration updates.
- **Explorer:** shows tracked files and folders at the current replay commit, including unchanged files, with A/M/D badges for its changes. Deleted files remain marked for inspection; untracked files and files from later commits are excluded. Binary, oversized, symlink and submodule entries show a description.
- **Tabs:** while paused, select a tab, close it with its × button or middle-click, and scroll the tab strip horizontally. Tabs keep their order; closing the active tab selects its neighbor. Close the last tab for an empty preview, then select a file or choose **Follow playback**.
- **Scrolling:** playback scrolls smoothly through the code toward each change, keeping surrounding lines steady until the caret approaches a visible edge and adapting to the editor height. It also works with VM system input enabled. Manual scrolling holds your chosen view until **Follow playback**; reduced motion disables the visual animation.
- **Browse:** pause and select any repository file or recent tab. Scroll with the wheel or arrow/page keys. **Follow playback** returns to the active file.
- **Hide:** logical playback continues without rendering. Closing the panel pauses; reopening restores the current session.
- **Recovery:** clean pauses retain position. After an interruption, the incomplete file may replay from its last durable boundary. Sleep or a heartbeat more than two seconds late pauses playback.
- **Clear session:** deletes only this extension's owned session data. Restart reuses the prepared plan.

Preparation, file I/O and explicit pauses add wall-clock time. The displayed active timeline is not a guarantee of completion at a particular clock time. Reduced motion hides the animated pointer.

## VM system input (experimental)

Run VS Code, Python 3, and your input-monitoring app **inside the same VM**. During playback, enable **VM system input**, then click the read-only code preview and leave the pointer over it. The preview becomes the inert input target; there is no separate input box. **Hide controls** hides the VM toggle without switching input off. After hiding, move the pointer back over the preview to resume delivery. If Python is not on PATH, set `gitReplay.inputPython` to its executable and reload the extension.

Replay samples active phases into native **A**, **Backspace**, stationary mouse-move events, and left clicks at the arming position, capped at two actions per second. Text and clicks land on an inert read-only surface over the preview; they do not execute code or change files. These are sample events for monitoring, not an exact reproduction of the commit text or original input. It sends no modifiers, Enter, navigation keys, scrolls, window commands, or launch commands. The pointer is never relocated.

**Escape**, Stop, completion, or unchecking **VM system input** switches the mode off. Escape also restores hidden controls. Pause, clicking elsewhere, pointer movement, or panel/window focus loss suspends delivery while keeping the mode enabled. Return focus and the pointer to the preview to resume automatically after a short quiet period. No input is sent into other controls or apps. Native focus/coordinate changes and held keys/buttons also suspend delivery; stale requests and permission failures still fail closed. There is only one outstanding request, with no event backlog. Down/up events are sent together. The helper exits through stdin closure without opening a terminal or another application window.

Playback's automatic Explorer, tab, and code scrolling keeps VM input armed. User scrolling still suspends delivery. Delayed VM heartbeats are discarded without restarting the helper; fresh requests resume after the same safety checks.

- **Windows:** native `SendInput`; Python and VS Code should run at the same privilege level. Blocked injection stops the helper.
- **macOS:** Quartz events and Accessibility focus checks. The helper finds the foreground app through NSWorkspace, requests Electron’s accessibility tree, and verifies the focused field through application-level AX. If the tree remains unavailable, the status includes the AX error code; **Editor: Accessibility Support → on** can expose missing fields. Error **-25204** means AX communication failed; check macOS Accessibility permission for Visual Studio Code and the configured Python executable, then restart the editor. Grant the Python helper Accessibility permission manually if its status requests it. The extension does not open System Settings or request permission automatically.
- **Linux:** X11 with `libX11` and `libXtst`/XTEST. Wayland fails closed; it is not supported.

Global injection cannot guarantee zero side effects under custom hotkeys, remapping software, overlays, or a focus change racing event delivery. Use a disposable VM. A monitor can identify these events as synthetic; detection/counting depends on that app. Automated checks exercise the guards and panel arming; actual native delivery in the three VM operating systems is **not yet validated**. Local macOS permission-denial handling, helper initialization, and repeated foreground/field checks were verified without posting events.

## Storage and limits

Only paths changed in the selected range are saved. This is a sparse reconstruction, not a full checkout. Each completed file is saved atomically as an inert, hashed `.data` file with `.json` metadata under the extension's global storage; original Git path bytes are retained in metadata. Deleted paths have tombstones. Symlinks are saved as inert bytes; submodules retain their object ID. Nothing from the repository is executed.

UTF-8 files up to 1 MiB with lines up to 8 KiB are animated. Binary, invalid UTF-8, larger/wider files and changes over 4,096 hunks use exact-byte snapshot events. Final verification checks expected plan entries and stored bytes. A quota error stops playback without advancing the durable checkpoint; increase **Git Replay: Storage Quota MiB** if needed (default 1 GiB, including plans and temporary writes).

The preview renders at most 120 code rows and 64 KiB of text per frame. It uses VS Code theme colors and editor font settings, a small visible-window syntax highlighter, five recent tabs, indentation guides aligned to your editor tab size, the full repository Explorer and no runtime packages. The preview is a webview; syntax colors support light/dark palettes and common languages, rather than full VS Code language grammars or custom token themes. The host throttles routine updates to 10 Hz; pointer movement is capped at 30 Hz. Git reads use at most two child processes.

This is a reconstruction from commits, not a recording of the original editing session. System input is off unless explicitly armed as described above; no screen-tracker evasion is claimed.

## Develop and verify

Node.js 22+ and Python 3 are required for development and tests. Run `npm ci`, then:

```sh
npm test
npm run test:ui  # Local Chromium check; set CHROME_PATH if needed
npm run benchmark
npm run package
```

Press F5 to open an Extension Development Host. The package contains only compiled code, local webview assets, manifest, README and license.

Automated checks cover pinned first-parent traversal, source/index preservation, Unicode/CRLF rendering, snapshot bytes, quotas, recovery, malformed checkpoints and a virtual six-hour end-to-end replay. A real six-hour run remains **unverified**; no long-run reliability claim is made.

## Measured results

Darwin 25.6.0 arm64, Node 26.8.1, Git 2.55.0; three samples per history, one 256 KiB file changing a fixed-width line per commit. GC runs before retained-heap measurements. Fixture creation is excluded from preparation time.

| Commits | Median preparation | Retained heap delta | Plan bytes |
| ---: | ---: | ---: | ---: |
| 100 | 1.952 s | 24,328 B | 142,660 B |
| 1,000 | 19.787 s | 290,416 B | 1,426,740 B |

For 10× the commits, preparation took 10.13× as long and retained heap grew by 0.25 MiB, below the 10 MiB target. Peak Git children: 2. Process descriptors returned to 13 after each sample (peak 21–22). Fixture creation took 1.60 s and 14.70 s. Peak process RSS deltas were 29.44 and 10.86 MiB; allocator retention makes those order-dependent. Git subprocess RSS was unavailable because the benchmark sandbox blocked the OS profiler. These are observations for this history shape, not a worst-case complexity proof.

Extension-owned working memory includes the active text, edit record, viewport and current repository tree (Git tree output is capped at 8 MiB); history and output grow on disk. Preparation reads every selected change and invokes Git's diff, whose cost depends on the contents. Saves stream each changed target blob. Changing speed rescans the remaining plan to estimate its duration without retaining it in memory.

Validation: **50 automated tests pass**, including a virtual six-hour reconstruction. The VSIX installed and activated in an isolated VS Code **1.137.0** profile (Node 24.18.1). A short replay through the packaged integration, actual webview, controller and store completed with exact bytes and unchanged dirty source; the test harness selected a discovered repository and submitted the inline preparation command. Chromium checks verified inline setup and paging, form persistence, corrected retries, syntax rendering without interpreting source as HTML, 120 row nodes, editor typography, narrow layouts, and reduced motion.

A manual session while using another app, Windows/Linux compatibility, real six-hour reliability, and measured UI/pointer frequencies and pause/stop p95 latency remain unverified. The frequency limits above are implementation caps, not measured real-time guarantees.
