# Porting PPSSPP to the browser as a runtime: effort plan

Target: [hrydgard/ppsspp](https://github.com/hrydgard/ppsspp), the open-source PSP emulator
(GPL-2.0+, about 525k lines of C++ in `Core/`, `GPU/`, `Common/`, `UI/` and `SDL/`, plus `ext/`).
Goal: a WebAssembly build of PPSSPP that runs in a web page, where the user brings their own
ISO/CSO/CHD files or homebrew. It should be embeddable as a "PSP runtime" in other pages.

This plan was written against upstream commit `7710606` (20 Nov 2026). Paths are relative to the
PPSSPP repo root. Companion doc: [browser-game-ports.md](./browser-game-ports.md).

---

## 1. TL;DR

| Question | Answer |
|---|---|
| Is it feasible? | Yes. PPSSPP is portable C++ with an interpreter, a GLES backend and an SDL frontend, and it already has partial Emscripten support (see §2). |
| Has it been done? | Partly. The libretro core has an `emscripten` target, and [EmulatorJS](https://emulatorjs.org/docs/systems/psp) ships it as its `psp` core. That build has no JIT and no FFmpeg, and needs threads, so it doesn't run on Safari. |
| Fastest route to something running | Embed EmulatorJS's PSP core: **days**, not weeks. Use it as the baseline and benchmark. |
| Route to an owned, standalone runtime | Emscripten build of the standalone SDL frontend: an **MVP in about 4–6 months for one experienced engineer**, **production quality in about 8–11 months**. |
| Hardest parts | CPU speed without a native JIT (§4.7), the emulator thread vs. the browser main loop (§4.3), and GPU readbacks on WebGL2 (§4.4). |
| Biggest risk | Performance on mid-range laptops and phones. The IR interpreter is several times slower than a JIT. A Wasm JIT backend is the long-term fix, and it is a research project. |

---

## 2. What already exists in the PPSSPP source

Found by reading the code at `7710606`:

| Area | What's there | What it means for the port |
|---|---|---|
| `ppsspp_config.h:11` | `__EMSCRIPTEN__` is lumped in with **`PPSSPP_ARCH_X86` + `32BIT` + `SSE2`**. | Code that is only guarded by `ARCH(X86)` will try to build x86 JIT emitters and SSE paths. **First job: add a real `PPSSPP_ARCH_WASM32`** (§4.1). |
| `Core/MIPS/JitCommon/JitCommon.cpp` `CreateNativeJit()` | X86 maps to `X64IRJit`. Any unknown arch falls back to **`IRInterpreterJit`**. | With a WASM arch, you get the IR interpreter for free. It is PPSSPP's fastest non-JIT CPU core. |
| `Core/MemMap.h:95` | Emscripten already forces **`MASKED_PSP_MEMORY`**. | Every PSP address is masked into a single allocation, so the mmap mirror tricks aren't needed. Pair it with `NO_MMAP`, as libretro does. |
| `Common/TimeUtil.cpp` | `sleep_*` call `emscripten_sleep()`. | That only works with ASYNCIFY. If the emulator runs on a pthread, plain `usleep` (which uses Atomics.wait) is better (§4.3). |
| `Common/CPUDetect.cpp`, `FakeCPUDetect.cpp`, `CommonFuncs.h` | Emscripten is excluded from cpuid and `int 3`. | These are already handled. |
| `libretro/Makefile:299` | `platform=emscripten`: `wasm32`, `GLES=1`, `-msimd128 -msse3 -mssse3 -msse4.1 -pthread -DNO_MMAP`. | This is a working recipe. Wasm SIMD plus Emscripten's SSE-to-SIMD headers gets the SSE code to compile. |
| `libretro/Makefile:427` | "ffmpeg does not work with emscripten", so FFmpeg is left out. | No PMF/MPEG cutscene video in that build. ATRAC3/3+ audio still works through `ext/at3_standalone`. Fixing this is in §4.6. |
| `libretro/libretro.cpp:580` | The `ppsspp_cpu_core` option is hidden under Emscripten. | The libretro web build is interpreter-only. |
| `ext/ffmpeg/README.md` | FFmpeg 3.0.2 is vendored as **pure C, with all asm off** (every `ARCH_` and `HAVE_` SIMD flag is 0). | It should compile to Wasm. The "doesn't work" note is probably a build-system problem, not a fundamental one. |
| `Core/FileLoaders/HTTPFileLoader.cpp` and the caching loaders | ISOs can already be streamed with HTTP Range requests, behind read-ahead caches. | This is the basis for "play from URL" hosting of homebrew and demos (§4.5). |
| `headless/`, `pspautotests/`, `frametests.py` | A headless test runner plus the PSP test suite and frame comparisons. | Run these under Node.js for CI accuracy checks (§6). |
| `GPU/GLES`, `Common/GPU/OpenGL` | The GLES3 backend sits behind the `thin3d` abstraction. | Maps to WebGL2 through Emscripten, with some feature gaps (§4.4). |
| `GPU/Software` | A software rasterizer. | Use it as a fallback and for reference testing. It is slow in Wasm. |

Native code generators that must **not** be compiled for Wasm: `Core/MIPS/{x86,ARM,ARM64,RiscV,LoongArch64}`,
`GPU/Common/VertexDecoder{X86,Arm,Arm64,RiscV,LoongArch64}.cpp`, and `Common/x64Emitter`.
The portable fallback for vertex decoding is `GPU/Common/VertexDecoderHandwritten.cpp` plus the
generic C++ step functions.

---

## 3. Choose the route

```
Need PSP in a web page soon, and fine with a generic emulator UI?
 └─ yes → Route A: embed EmulatorJS's psp core (libretro PPSSPP). Days.
 └─ no, want an owned runtime/SDK (custom UI, JS API, branding, own hosting)
     ├─ OK with RetroArch/libretro structure → Route B: own build of libretro core + thin JS host. 4–8 weeks.
     └─ want full PPSSPP (its UI, settings, savestates, debugger, achievements) → Route C: Emscripten SDL frontend. This plan.
```

| | A: EmulatorJS core | B: libretro core + own host | C: standalone PPSSPP Wasm |
|---|---|---|---|
| Effort | 2–5 days | 4–8 weeks | 4–6 months MVP |
| Control over UX and API | Low | Medium | Full |
| Video cutscenes | No | Fixable | Fixable |
| Upstreamable to PPSSPP | n/a | Partly | Yes, as a new platform |
| Long-term perf work (Wasm JIT, WebGPU) | Not yours | Possible | Natural home |

**Recommendation:** do Route A in week 1 as the baseline and benchmark, then build Route C. Keep
Route C upstream-friendly so you aren't carrying a fork forever.

---

## 4. Workstreams for Route C

Estimates are in engineer-weeks for one engineer who knows C++, CMake and graphics, and is new
to the PPSSPP codebase. Ranges cover what's unknown.

### 4.1 Build system and platform definition: 2–3 weeks

- Add `PPSSPP_ARCH_WASM32` (and later `WASM64`) to `ppsspp_config.h`, and stop pretending to be X86.
  Then sweep every `PPSSPP_ARCH(X86)` / `ARCH(SSE2)` guard: about 2 days of grep-and-fix.
- Keep SSE intrinsics working with `-msimd128 -msse4.1` (Emscripten translates them to Wasm SIMD).
  Gate the `PPSSPP_ARCH_SSE2` paths on `__wasm_simd128__`.
- Add a CMake Emscripten preset (`emcmake`) that does the following:
  - excludes all JIT and vertex-decoder JIT sources;
  - sets `USE_DISCORD=OFF` and turns off miniupnp, `libadrenotools`, OpenXR, oboe and Vulkan/D3D/Metal;
  - uses Emscripten ports where they exist (`-sUSE_SDL=2`, zlib, libpng), or else the vendored
    `ext/` copies, which are already portable C.
- Build `ext/` pieces as static libraries: glslang and SPIRV-Cross (only needed if you keep shader
  translation), rcheevos, libchdr, zstd, freetype, lua, armips (debugger; optional).
- Link flags (starting point):
  ```
  -sUSE_SDL=2 -sMAX_WEBGL_VERSION=2 -sMIN_WEBGL_VERSION=2 -sFULL_ES3
  -pthread -sPTHREAD_POOL_SIZE=8 -sPROXY_TO_PTHREAD -sOFFSCREENCANVAS_SUPPORT
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=2GB
  -sWASMFS -sFORCE_FILESYSTEM -sEXPORT_ES6 -sMODULARIZE -sEXPORT_NAME=createPPSSPP
  -sSTACK_SIZE=1MB -O3 -flto
  ```
  The PSP only has 32 MB of RAM (64 MB on Slim), plus VRAM and emulator overhead, so a 2 GB cap is
  plenty. You don't need Memory64.
- Package `assets/` (17 MB: fonts, shaders, UI atlases, `ppge_atlas`, lang) with `--preload-file`,
  or better, lazily fetch it into WASMFS/OPFS so the first load stays small.
- **Exit criterion:** `PPSSPPSDL.wasm` links, and the headless build runs one `pspautotests` test in Node.

### 4.2 CPU core and memory: 2–3 weeks

- Force `CPUCore::IR_INTERPRETER` as the default and remove the "JIT" option from settings under Wasm.
- Memory: `MASKED_PSP_MEMORY` + `NO_MMAP` means `Memory::base` is one `malloc`. Add `MemArenaWasm.cpp`,
  or route through the existing `NO_MMAP` path, so `ReserveViewSpace` and mirrors are no-ops.
- Check the Media Engine (`Core/MIPS/MeCore.cpp`, `MASKED_ME_SPACE`). `NativeJitRunsMediaEngine()`
  is false here, so the ME runs on the interpreter path too.
- Confirm that nothing writes or executes generated code (W^X, `AllocateExecutableMemory`) on Wasm:
  stub it out so it fails loudly.
- **Exit criterion:** CPU tests in `pspautotests/tests/cpu` pass headless under Node, and the numbers match a native IR-interpreter build.

### 4.3 Threads, the main loop and timing: 3–4 weeks (high risk)

PPSSPP's SDL frontend (`SDL/SDLMain.cpp:2546`) runs an **EmuThread** that blocks. It also starts
other threads (battery poll, file read-ahead in `CachingFileLoader` and `RamCachingFileLoader`, and
the `Common/Thread/ThreadManager` worker pool). The browser main thread may never block.

- Use **`-sPROXY_TO_PTHREAD`**: `main()` and the emulator run on a worker, so blocking, `usleep`
  and condition variables just work through `Atomics.wait`. The browser main thread only handles DOM events.
- Rendering from that worker needs **OffscreenCanvas**: `-sOFFSCREENCANVAS_SUPPORT`, and transfer the
  canvas. Chrome, Edge, Firefox and Safari 17+ all support WebGL2 in workers.
  Fallback: `-sOFFSCREEN_FRAMEBUFFER` (slower) or a command buffer proxied to the main thread.
- Collapse the separate render thread: make `NeedsSeparateEmuThread()` false, so emulation and GL
  run on the same worker. That avoids GL-context-per-thread problems in WebGL.
- Pacing: drive frames from the worker's own loop and let the PSP's vblank timing pace it. Present
  through the OffscreenCanvas `commit`/rAF path. Watch out for audio-driven vs. video-driven sync (§4.6).
- Remove `emscripten_sleep` from `TimeUtil.cpp` (it is ASYNCIFY-only) and use `usleep` on pthreads.
- Size the `ThreadManager` pool from `navigator.hardwareConcurrency`, capped at about 4 to 6, and
  pre-spawn it with `PTHREAD_POOL_SIZE`. Spawning a worker during the game causes stalls.
- Disable the battery thread, Discord, UPnP and the HTTP server (`Core/WebServer`) entirely.
- **Exit criterion:** a homebrew title boots to in-game, runs 10 minutes with no deadlocks, and the tab stays responsive.

### 4.4 Graphics: WebGL2 now, WebGPU later: 4–6 weeks for WebGL2

The GLES backend (`GPU/GLES`, `Common/GPU/OpenGL/*`) targets GLES 3.0. WebGL2 is close to it, but
not the same. Things to handle:

| Gap in WebGL2 | Where PPSSPP uses it | Fix |
|---|---|---|
| No `glMapBuffer*` (13 call sites for mapping, depth clamp, dual-source or fetch in `Common/GPU/OpenGL`) | `GLRenderManager` / `GLPushBuffer` | Use the `glBufferSubData` path. Emscripten emulates mapping, but it is slow. |
| No depth clamp, no dual-source blend, no framebuffer fetch, no `glLogicOp` | Blending and depth emulation in `GPU/Common/FragmentShaderGenerator` | These already have fallbacks for weak mobile GPUs. Force those `gl_extensions` flags off. |
| Sync `glReadPixels` / `glGetBufferSubData` stalls badly | Readbacks: CPU access to framebuffers, "read framebuffers to memory" games, screenshots | Default to "skip GPU readbacks", and use PBOs with fences for async reads. Some games will glitch, so keep a per-game compatibility list. |
| GLSL ES 3.00 only | Shader generators (`ShaderWriter`) | Already supported (GLES3 path). Test the uber-shader vs. specialised-shader settings. |
| Shader compile hitching (ANGLE on Windows translates to HLSL) | Shader cache | Persist the shader cache to OPFS. Use `KHR_parallel_shader_compile`. |
| Texture formats | Texture replacement packs, ASTC/BC/ETC | Query the extensions, and decompress on the CPU when one is missing. |

Default settings for web: render resolution 2x (1x on mobile), no MSAA, hardware tessellation off,
texture scaling off. All are configurable.

**WebGPU backend (optional, phase 3): 10–16 weeks.** Model it on the Vulkan backend
(`Common/GPU/Vulkan`, `GPU/Vulkan`). Use `emdawnwebgpu` for Emscripten. Shaders come from the same
generators, emitted as GLSL→SPIR-V→WGSL (via Tint), or written directly as WGSL with `ShaderWriter`.
The gains are fewer readback stalls (async `mapAsync`), compute shaders for texture decode and
depal, and a better fit with modern GPU drivers. This is the cricket07-browser approach
(D3D8→WebGPU), applied to `thin3d`.

### 4.5 Files, saves and loading games: 2–3 weeks

PSP UMD images are up to 1.8 GB. Don't copy them into Wasm memory.

- **Local files:** pick with `<input type=file>` or the File System Access API. Implement a
  `FileLoader` subclass (`Core/FileLoaders/`) that reads byte ranges **synchronously from the
  worker** with `FileReaderSync` on `Blob.slice()`. Put it behind the existing `CachingFileLoader`.
  This keeps memory flat for any ISO size.
- **OPFS:** optionally import the ISO into the Origin Private File System, then use
  `FileSystemSyncAccessHandle` for fast sync reads on later visits.
- **URLs:** `HTTPFileLoader` already does Range requests. Make it use `fetch` in the worker, with
  sync semantics through Atomics, or move it into WASMFS's fetch backend. The server must send
  `Accept-Ranges` and CORS/CORP headers.
- **Memory stick:** mount `ms0:/PSP/SAVEDATA`, `PPSSPP_STATE`, `SYSTEM` (config) and `TEXTURES`
  onto a WASMFS **OPFS backend**, so saves persist. Call `navigator.storage.persist()`. Add
  export/import as a zip, since browser storage can be evicted.
- CSO, CHD (`libchdr`) and zip loaders already exist. Check that they work with the sync-read path.
- **Exit criterion:** load a 1.5 GB ISO from disk with less than 300 MB of tab memory; saves survive a reload.

### 4.6 Audio, video and input: 3–4 weeks

- **Audio:** SDL2 audio through Emscripten goes to Web Audio and needs a user gesture to start.
  For lower latency, write PPSSPP's mixed output into a **SharedArrayBuffer ring buffer read by an
  AudioWorklet**, which bypasses SDL. Add resampling to match `AudioContext.sampleRate`.
  ATRAC3/3+ decoding is already standalone C++ (`ext/at3_standalone`).
- **FFmpeg / cutscenes (PMF, MPEG, AAC/MP3 in some games): 1–3 weeks.** Compile the vendored pure-C
  FFmpeg 3.0.2 with `emcc` (no asm, so it should be straightforward), and fix whatever made libretro
  give up. Fallback: a WebCodecs H.264 bridge (`VideoDecoder`), but that's async and needs plumbing.
- **Input:** keyboard through SDL works. Map the Gamepad API through SDL2's Emscripten joystick
  backend (`SDL/SDLJoystick.cpp`) and verify the "standard" mapping. Add a **touch overlay** for
  mobile: PPSSPP's own `UI/GamepadEmu` touch controls already work with pointer events, so turn them
  on by default for touch devices. Handle Pointer Lock and fullscreen.
- **Exit criterion:** a commercial game with FMV intro plays its cutscene in sync with audio, using a gamepad.

### 4.7 Performance: 3–4 weeks baseline, plus an optional Wasm JIT

Baseline work:
- Profile with Chrome DevTools and `--profiling-funcs` builds. Hot spots will be
  `IRInterpreter.cpp`, VFPU ops, the vertex decoder, texture decoding and the software transform.
- Use Wasm SIMD (`wasm_simd128.h`) in the vertex decoder, texture decoder (`GPU/Common/TextureDecoder`)
  and VFPU matrix ops, where SSE-via-translation isn't enough.
- Tune IR optimisation passes (`IRPassSimplify.cpp`), and turn on "Fast memory" (masked) and
  frame skipping for weak devices.
- Use `-O3 -flto`, and profile-guided `wasm-opt -O4`. Test with and without `-msimd128`.

**Wasm JIT backend (optional, phase 3): 12–20+ weeks, research risk.** PPSSPP's newer JITs all
consume the IR (`IRNativeCommon.cpp`), so a Wasm backend is "IR → Wasm bytecode":
- Batch many IR blocks into one generated Wasm module that imports the shared `WebAssembly.Memory`
  and a function table. Compile it with `new WebAssembly.Module()` from JS. Then insert the
  functions into a shared table and dispatch through `call_indirect`.
- Module compile latency is milliseconds, so use a hot-block threshold: interpret first, compile
  once a block is hot, and compile on a separate worker.
- Invalidating blocks on self-modifying code means swapping table entries.
- Expect about 2–4x over the IR interpreter on CPU-bound games. v86 and other emulators show this
  technique works in browsers.

Rough expectations (to confirm in week 1 with Route A): with the IR interpreter, many 2D and
lighter 3D games reach full speed on a recent desktop. Heavy 3D games (God of War, Gran Turismo
style) and phones will fall short without a JIT.

### 4.8 Web runtime API, UI and embedding: 2–3 weeks

- A JS wrapper around the factory (`createPPSSPP({ canvas, assetsUrl, onReady })`) with
  `loadGame(fileOrUrl)`, `pause()`, `resume()`, `saveState()`, `loadState()`, `setConfig()`, and
  input injection. Expose it through a few `EMSCRIPTEN_KEEPALIVE` C entry points that post
  messages to the EmuThread.
- Option 1: keep PPSSPP's own in-canvas UI (game browser, settings). Option 2: start straight into a
  game for embed mode. Both are settings.
- Web Component `<psp-runtime src="...">` for drop-in use.
- PWA: a service worker caches `.wasm` and assets, so it works offline and installs like an app.
- Disable or hide things that don't make sense on the web: the remote ISO server, the debugger
  web server, the Discord and UPnP UI.

### 4.9 Hosting and delivery: 1 week

- **Cross-origin isolation is required** for SharedArrayBuffer and pthreads:
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`
  (or `credentialless`). Every subresource must also be CORP- or CORS-compatible.
  See the headers table and the Express/Netlify/Cloudflare/Vercel snippets in
  [browser-game-ports.md §5](./browser-game-ports.md).
- **Embedding in third-party pages:** the iframe needs `allow="cross-origin-isolated; gamepad; fullscreen; autoplay"`,
  and the parent page must be isolated too. That's the main friction for "runtime" embedding; document it.
- Serve `.wasm` as `application/wasm` with Brotli. Expect about 15–30 MB uncompressed and 4–8 MB
  with Brotli; measure it. Use hashed filenames with long cache times.
- Licensing: PPSSPP is **GPL-2.0+**. Your web build and JS wrapper that link to it must be
  GPL-compatible, and you must offer the source. Ship **no BIOS (none needed), no games, and no
  copyrighted assets**. Users bring their own dumps, and you can host freely licensed homebrew.

### 4.10 Networking (deferred): 3–6 weeks if wanted

PSP ad hoc multiplayer goes through `Core/HLE/proAdhoc*` and `ext/aemu_postoffice` over UDP/TCP,
which browsers can't open. Bridge it over a WebSocket relay or WebTransport server that talks
aemu_postoffice protocol. Out of scope for the MVP.

---

## 5. Phased timeline (one engineer)

| Phase | Weeks | Scope | Deliverable |
|---|---|---|---|
| 0. Baseline | 1 | Route A running locally; collect FPS for 10 test games; read the code | Benchmark sheet, go/no-go |
| 1. Boot | 2–8 | §4.1, §4.2, start §4.3 | Headless Wasm build passes CPU autotests in Node; homebrew boots in Chrome |
| 2. Playable MVP | 9–18 | §4.3, §4.4 (WebGL2), §4.5, §4.6 without FFmpeg | Commercial games playable in Chrome and Firefox from local ISO; saves persist; gamepad and touch |
| 3. Product | 19–30 | FFmpeg, §4.7 baseline, §4.8, §4.9, compatibility testing, Safari | JS API and Web Component, PWA, docs, hosted demo with homebrew, compatibility list |
| 4. Performance (optional) | 31–50 | Wasm JIT (§4.7), WebGPU backend (§4.4), networking (§4.10) | Heavy 3D games at full speed on mid-range hardware |

Totals: **MVP about 18 weeks (range 14–24)**, **product about 30 weeks (24–40)**, **with the
optional performance phase about 50 weeks or more**. Two engineers (one on CPU/platform, one on
graphics/web) cut the calendar time by roughly 40%. Much of the CPU and graphics work can run in parallel.

---

## 6. Testing strategy

- **CI:** build the Wasm headless target. Run `pspautotests` with Node (`headless.py`/`test.py`
  adapted to call `node PPSSPPHeadless.js`), and diff the results against a native IR-interpreter
  build. The same code on different hosts should give identical output.
- **Frame tests:** `frametests.py` compares GE dumps rendered to PNG. Run them in headless
  Chromium (Playwright) with the WebGL2 backend, against native GLES references.
- **Manual compatibility matrix:** about 30 games covering 2D, 3D, FMV, heavy readbacks and VFPU-heavy titles.
  Test on Chrome, Firefox and Safari across Windows, macOS, Android and iOS. Record FPS and glitches.
- **Soak tests:** 1-hour runs to catch memory growth, worker leaks and audio drift.

---

## 7. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Interpreter too slow for heavy games | High | High | Set expectations with a compatibility list; frameskip and resolution presets; Wasm JIT in phase 4 |
| Deadlocks or stalls from threads moving onto workers | Medium | High | `PROXY_TO_PTHREAD` from day 1; single GL thread; pre-spawned pool; soak tests |
| WebGL2 readback stalls break games | Medium | Medium | Skip-readback default; async PBO; per-game overrides; WebGPU later |
| Safari: SAB/threads, OffscreenCanvas and WebGL quirks | Medium | Medium | Target Chrome and Firefox first; Safari in phase 3; have a fallback build without threads |
| Memory pressure on mobile (tab killed) | Medium | Medium | Stream ISOs (no copies); cap at 1 GB; lazy assets |
| COOP/COEP breaks embedding or third-party scripts | High (for embedders) | Medium | Document the iframe recipe; use `credentialless` COEP where supported |
| Diverging from upstream | Medium | Medium | Platform `#ifdef`s only, no rewrites; send changes upstream early (the maintainers already accept niche platforms) |
| GPL obligations | Certain | Low | Publish the source of the whole web runtime |
| Legal (piracy) | — | High | No ROMs, no hosted commercial content; homebrew demos only; BYO-file UX |

---

## 8. First two weeks: concrete checklist

1. Run EmulatorJS with `EJS_core = 'psp'` and `EJS_threads = true` behind COOP/COEP headers.
   Record FPS for the test set.
2. Install emsdk (latest), then `emcmake cmake -B build-wasm -DHEADLESS=ON` and fix the build
   until it links. Keep a running list of patches.
3. Add `PPSSPP_ARCH_WASM32` and exclude the JIT and vertex-decoder JIT sources.
4. Run `pspautotests/tests/cpu/*` headless in Node and compare with native.
5. Turn on the SDL frontend with `PROXY_TO_PTHREAD` and OffscreenCanvas, and get the PPSSPP main
   menu rendering in Chrome.
6. Write up go/no-go with measured interpreter speed vs. native, and adjust phases 2–4.

---

## 9. References

- PPSSPP source: <https://github.com/hrydgard/ppsspp>. Files cited: `ppsspp_config.h`,
  `Core/MemMap.h`, `Core/MIPS/JitCommon/JitCommon.cpp`, `Core/MIPS/IR/*`, `Common/TimeUtil.cpp`,
  `libretro/Makefile`, `ext/ffmpeg/README.md`, `SDL/SDLMain.cpp`, `Core/FileLoaders/*`,
  `GPU/GLES`, `Common/GPU/OpenGL`
- EmulatorJS PSP docs (threads required, Safari unsupported): <https://emulatorjs.org/docs/systems/psp>
- EmulatorJS changelog adding the `ppsspp` core: <https://cdn.emulatorjs.org/4.3.0-pre/CHANGES.md>
- EmulatorJS system requirements: <https://deepwiki.com/EmulatorJS/EmulatorJS/1.2-system-requirements>
- libretro PPSSPP core docs: <https://docs.libretro.com/library/ppsspp/>
- Wasm vs. JS emulator performance: <https://8bitworkshop.com/docs/posts/2021/webassembly-vs-javascript-emulator-performance.html>
- Emscripten docs: pthreads, `PROXY_TO_PTHREAD`, OffscreenCanvas, WASMFS/OPFS, SIMD
  (<https://emscripten.org/docs/>)
- Companion research: [browser-game-ports.md](./browser-game-ports.md) (hosting headers, netplay, legal)
