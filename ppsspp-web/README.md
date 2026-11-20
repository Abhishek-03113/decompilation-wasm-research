# PPSSPP Web

[PPSSPP](https://github.com/hrydgard/ppsspp) (the PSP emulator) compiled to WebAssembly and served
by an Express app. You load your own game dump into the page; it is copied into the browser's
private storage (OPFS) once and booted from there. First target game: **Tekken 6**.

| PPSSPP's menu in the browser | `cube.iso` booted from browser storage, 60 fps |
|---|---|
| ![PPSSPP main menu](docs/menu.png) | ![Cube demo](docs/cube.png) |

## Run it

```sh
sh build.sh          # ~30-40 min the first time: Emscripten SDK, SDL3, PPSSPP at 7710606 + patches/
npm install
npm start            # http://localhost:8080
```

Then **Add game file…** (ISO, CSO or CHD), wait for the copy, and press **Play**.
Use current Chrome or Edge first; Firefox and Safari are untested so far. The page has to be served
with the COOP/COEP headers that `server.js` sends, from `localhost` or HTTPS, or threads are disabled
and PPSSPP won't start.

## How it works

- **CPU:** PPSSPP's IR interpreter (no JIT can run in WebAssembly). Emscripten is now its own
  architecture (`PPSSPP_ARCH_WASM32`) instead of pretending to be x86.
- **Threads:** the emulator runs on a pthread (a Web Worker). Once per animation frame the page's
  main thread handles input and replays the GL commands the emulator recorded, with WebGL2. It never
  waits for the emulator.
- **Files:** OPFS is mounted at `/opfs` with Emscripten's WASMFS before `main()` runs. Games go in
  `/opfs/games`; the memory stick (saves, settings) is `/opfs/memstick`, so both persist.
- **Memory:** PSP addresses are masked into one 256 MB block.

## Status (20 Nov 2026)

| Check | Result |
|---|---|
| PSP CPU tests (pspautotests `cpu/`, headless in Node) | 38/61 pass. Native PPSSPP passes 41; the only differences are 3 FPU rounding-mode tests (WebAssembly has no rounding modes). The other 20 failures are upstream. |
| Speed, same CPU test run | WebAssembly 6.5 s vs native 3.3 s (same interpreter), roughly 2× slower |
| PPSSPP UI in headless Chromium | Works, 60 fps |
| Import → OPFS → boot an ISO | Works (`pspautotests/demos/cube.iso`, 60 fps on a software GPU) |
| Tekken 6 | Not tried yet: needs your own dump |

## Bugs fixed on the way (all in `patches/ppsspp-wasm.patch`)

1. Emscripten was treated as x86, so the x86 JIT would be used. Added a WebAssembly architecture.
2. `sleep` used `emscripten_sleep`, which needs Asyncify. Pthreads can use `usleep`.
3. **Memory corruption:** with `NO_MMAP` PPSSPP reserved 160 MB for PSP memory, but masked
   addresses reach 256 MB (64 MB Slim RAM ends at `0x0C000000`). Writes past the end overwrote the
   heap, including thread structures. Now 256 MB, allocated once.
4. **Frozen at the intro screen:** browsers report a 0 Hz refresh rate, and the menu frame limiter
   computed `1/0` → a sleep of ~35 minutes. Found by pausing the workers through the Chrome DevTools
   protocol (`tools/stacks.js`).
5. Browser main loop for the SDL frontend, non-blocking GL replay, OPFS mount, build fixes for
   armips, OpenXR headers, ad hoc networking sockets and missing includes.

## Next for Tekken 6

1. Load your Tekken 6 dump; turn on **Settings → Graphics → Show FPS counter** and note the speed in
   menus and in a fight. PPSSPP's compat list already sets `RequireDefaultCPUClock` and
   `ForceMax60FPS` for it.
2. If it's slow: profile with Chrome DevTools, then
   - re-enable SSE paths through Wasm SIMD (`-msse4.1`, fix the few x86-only spots),
   - tune the IR passes for the hottest blocks,
   - later, a JIT that compiles PSP code to WebAssembly modules.
3. FFmpeg for cutscenes (currently off), SDL3_ttf, an AudioWorklet for audio, gamepad mapping checks.

## Tools

- `tools/boot.js <file>`: imports a file through the page in headless Chromium, boots it, prints frame counters, screenshots.
- `tools/smoke2.js`: opens the PPSSPP menu and prints frame counters.
- `tools/stacks.js`: pauses every worker and prints its call stack (build with `WASM_DEBUG=ON`).

PPSSPP is GPL-2.0-or-later, and so is this folder's patch set. Never commit or host game files.
