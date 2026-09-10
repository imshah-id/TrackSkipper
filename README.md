# Git Replay

Replay an inclusive range of Git commits in an isolated VS Code panel. Code appears progressively, with an animated pointer that moves, hovers and clicks inside the preview. Your actual mouse, keyboard, source files, index and Git history remain independent.

## Install

Requires desktop VS Code **1.137 or later**, a trusted local Git workspace, and Git 2.45+. Tested on macOS Apple Silicon; Windows/Linux and remote workspaces are not validated. Remote and virtual workspaces are disabled.

1. In VS Code, run **Extensions: Install from VSIX…** and select `trackskipper.vsix`.
2. Open a local Git repository, click the **Git Replay** icon in the left Activity Bar, then **Open Git Replay**. You can also run **Git Replay: Open** from the Command Palette.
3. Choose **Configure replay**, a starting commit, then a duration (for example, `6` hours) or typing speed.
4. Select **Start**. Use Pause, Resume, Stop, Restart or Clear session as needed.

The start commit is included. The ending commit is pinned to HEAD when you configure; later commits do not change a prepared session. Replay follows first-parent history, oldest to newest. Merges appear once against their first parent; renames appear as deletion/addition; empty commits appear as milestones.

## Controls and timing

- **Duration:** fits the phase schedule and reading pauses to the requested active time. A duration below the minimum is rejected.
- **Fixed speed:** 1–200 grapheme clusters per second. Pause to change typing or pointer speed; the estimated duration updates.
- **Browse:** pause and select a changed file or recent tab. Scroll with the wheel or arrow/page keys. **Follow playback** returns to the active file.
- **Hide:** logical playback continues without rendering. Closing the panel pauses; reopening restores the current session.
- **Recovery:** clean pauses retain position. After an interruption, the incomplete file may replay from its last durable boundary. Sleep or a heartbeat more than two seconds late pauses playback.
- **Clear session:** deletes only this extension's owned session data. Restart reuses the prepared plan.

Preparation, file I/O and explicit pauses add wall-clock time. The displayed active timeline is not a guarantee of completion at a particular clock time. Reduced motion hides the animated pointer.

## Storage and limits

Only paths changed in the selected range are saved. This is a sparse reconstruction, not a full checkout. Each completed file is saved atomically as an inert, hashed `.data` file with `.json` metadata under the extension's global storage; original Git path bytes are retained in metadata. Deleted paths have tombstones. Symlinks are saved as inert bytes; submodules retain their object ID. Nothing from the repository is executed.

UTF-8 files up to 1 MiB with lines up to 8 KiB are animated. Binary, invalid UTF-8, larger/wider files and changes over 4,096 hunks use exact-byte snapshot events. Final verification checks expected plan entries and stored bytes. A quota error stops playback without advancing the durable checkpoint; increase **Git Replay: Storage Quota MiB** if needed (default 1 GiB, including plans and temporary writes).

The preview renders at most 120 code rows and 64 KiB of text per frame. It uses a plain text view, five recent tabs, 100-entry pages and no runtime packages. The host throttles routine updates to 10 Hz; pointer movement is capped at 30 Hz. Git reads use at most two child processes.

This is a reconstruction from commits, not a recording of the original editing session. It does not send system input or provide verified screen-tracker evasion.

## Develop and verify

Node.js 22+ is required for development. Run `npm ci`, then:

```sh
npm test
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

Extension-owned working memory is bounded by the active text, edit record, viewport and fixed pages; history and output grow on disk. Preparation reads every selected change and invokes Git's diff, whose cost depends on the contents. Saves stream each changed target blob. Changing speed rescans the remaining plan to estimate its duration without retaining it in memory.

Validation: **26 automated tests pass**, including a virtual six-hour reconstruction. The VSIX installed and activated in an isolated VS Code **1.137.0** profile (Node 24.18.1). A short replay through the packaged integration, actual webview, controller and store completed with exact bytes and unchanged dirty source; the test harness supplied picker responses. Chromium checks verified local assets, 120 row nodes, literal HTML-like source, a pointer that cannot intercept input, narrow navigation and reduced motion.

A manual session while using another app, Windows/Linux compatibility, real six-hour reliability, and measured UI/pointer frequencies and pause/stop p95 latency remain unverified. The frequency limits above are implementation caps, not measured real-time guarantees.
