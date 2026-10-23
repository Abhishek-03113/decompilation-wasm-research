# Porting and Hosting Games in the Browser

Research notes on how existing games, including closed-source PC games from the 2000s, end up running in a browser tab. The main case study is [`Dhaiwat10/cricket07-browser`](https://github.com/Dhaiwat10/cricket07-browser/). It runs EA Sports Cricket 07 (2006, Windows/Direct3D 8) in the browser with gamepad support and online 1v1 play.

> Status notes on browser APIs are current as of late 2025 / 2026. Check [webassembly.org/features](https://webassembly.org/features/) and [caniuse.com](https://caniuse.com) before you rely on a feature.

---

## 1. The big picture

A game running in the browser needs four things:

1. **CPU code the browser can run.** That means WebAssembly (Wasm) or JavaScript.
2. **APIs the game expects.** Graphics, audio, input, files, threads and timers all have to map onto Web APIs.
3. **The game's assets.** Textures, models, audio and levels have to reach the browser somehow.
4. **Somewhere to host it.** Static files, the correct HTTP headers, and optionally a server for multiplayer.

Each porting approach answers (1) and (2) differently.

| Approach | You need | How it works | Performance | Examples |
|---|---|---|---|---|
| **Engine export** | Project source in Unity/Godot/etc. | The engine compiles itself and your game to Wasm and WebGL/WebGPU | Good | Unity WebGL, Godot HTML5, Defold, Bevy, raylib |
| **Source port** | Game source code (open-sourced, leaked or decompiled) | Recompile the C/C++ with Emscripten and replace platform layers with SDL2/Web APIs | Near native | Doom, Quake (ioquake3), Xash3D, OpenTTD, SM64/OoT decomp ports |
| **Emulation** | Original binary or ROM | Run an emulator, itself compiled to Wasm, that interprets or JITs the guest CPU | Slow to moderate; fine for old consoles and DOS | js-dos/DOSBox, v86, EmulatorJS/RetroArch, Ruffle (Flash) |
| **Compatibility layer** | Original Windows binary | Emulate x86 and reimplement Win32 in Wasm | Slow | Boxedwine |
| **Static recompilation** | Original binary plus lots of effort | Translate machine code to C ahead of time, compile to Wasm, reimplement the OS/graphics APIs | Near native | **cricket07-browser**, N64Recomp-style projects, the Rugby 06 web port |
| **Streaming** | Native build and GPU servers | Run the game remotely and stream video over WebRTC | Depends on the network | Cloud gaming services |

When the source is available, choose source port or engine export. Without source, emulation is easiest for old platforms. Static recompilation is the high-effort, high-payoff route for a specific x86 PC game.

---

## 2. Case study: cricket07-browser

### 2.1 What it is

- MIT-licensed code that contains **no game files and no game code**. Users supply their own copy.
- The game runs in a browser tab with keyboard, mouse and gamepad, plus deterministic online 1v1.
- The same translated C also builds a native macOS (Apple Silicon) app with clang, SDL2 and wgpu-native.

### 2.2 Pipeline

```
 game.exe (x86, PE)
     │
     │  ghidra/export.sh        Ghidra 12 finds function boundaries
     ▼
 function list
     │
     │  translator/x86toc.py    capstone + pefile; each x86 function → one C function
     ▼                          (~31,547 functions, ~1.3M instructions)
 out_all/*.c
     │
     ├── clang ───────────────► native macOS binary (SDL2 + wgpu-native)
     │
     └── Emscripten (emcc) ───► recomp.wasm + recomp.js (browser, WebGPU)
                                 + host/  (Win32 / D3D8 / DSound / DInput replacements)
                                 + runtime/ (runtime helpers, x86 interpreter for sound banks)
```

Build commands from the README:

```bash
ghidra/export.sh                 # export function list from your exe
cp host/profile.h work/profile.h # edit for your exe version
./build.sh                       # translate + native build
./build_web.sh                   # Wasm build
python3 web/serve.py             # http://localhost:8007, choose your game folder
npx wrangler deploy              # optional: netplay room server (Cloudflare Worker)
```

### 2.3 Key techniques

**Static recompilation, not emulation.** Each x86 function becomes a C function. The guest registers (`eax`, `ecx`, ...) are C locals and are written back to memory only around calls. The README says that change made the build about 30% faster and the Wasm about 25% smaller. The C compiler and the Wasm engine then optimise the result much as they would hand-written code.

**Original memory layout.** The executable is placed at its original image base inside Wasm linear memory. Absolute pointers, C++ vtables and jump tables therefore work without relocation. `call` pushes a real return address onto a real guest stack. The heap is limited to a 1.25 GB window inside the 4 GB Wasm32 address space.

**Code found only at runtime.** The sound engine stores small x86 programs inside its sound-bank data. No ahead-of-time translator can see that code, so `runtime/interp.c` runs it with a small x86 interpreter. Most recompilation projects end up with a fallback like this.

**Replacement Windows APIs (`host/`):**

| Windows API | Browser replacement |
|---|---|
| Direct3D 8 | WebGPU (via Emscripten's `emdawnwebgpu` port) |
| D3D8 pixel shaders (`ps.1.1`) | Translated to WGSL |
| D3D8 vertex shaders (`vs.1.1`) | Executed on the CPU |
| Fixed-function pipeline | One large "uber" WGSL shader |
| DirectSound | Web Audio |
| DirectInput | DOM keyboard/mouse events + Gamepad API |
| Files | WASMFS; game folder copied once into browser-private storage |
| Threads, mutexes, timers | pthreads (Web Workers + SharedArrayBuffer) and a custom scheduler |

**WebGPU only on the main thread.** The game thread runs in a Worker (`PROXY_TO_PTHREAD`). It records each frame as a command list, and the page replays that list on `requestAnimationFrame`.

**Timing bugs.** `Date.now()`-style clocks count from 1970. Values that large overflowed the game's timer arithmetic, so the virtual clock starts near zero. A tight lock/unlock loop in the sound code also starved the timer thread. The fix was mutex hand-off: on release, the lock passes straight to a waiting thread.

**Deterministic scheduler and lockstep netplay.** `host/sched.c` runs one game thread at a time on a virtual clock, so a match depends only on the inputs. Netplay (`host/netplay.c`) is lockstep. Each frame, both clients wait for both players' inputs and then advance, and only inputs go over the network. The two clients periodically hash memory to detect desyncs. A Cloudflare Worker (`server/`) acts as a room/relay server. This design was adapted from an earlier Rugby 06 browser port.

**Testing the translator.** `tests/difftest.py` runs each function in a CPU emulator and as translated C on the same random inputs, then compares registers and every byte of memory touched. Use this kind of differential testing for any recompiler.

### 2.4 Emscripten build details (`build_web.sh`)

- `-O2` by default, with incremental builds that hash each generated `.c` file together with the flags and use up to 10 parallel jobs.
- **WASMFS** for the filesystem.
- **pthreads** with `PROXY_TO_PTHREAD` and a 16-thread pool.
- Memory growth allowed up to 4 GB, an 8 MB main stack, and a modular factory export (`createRecomp`).
- A post-link patch copies the `setBindGroup` dynamic offsets, because Firefox rejects typed-array views into memories larger than 2 GB.
- A separate Node build (`NODERAWFS`, `EXIT_RUNTIME`) runs headless for testing, with worker stacks raised to 256 MB because the recompiled code nests deeply.

### 2.5 Hosting (`web/serve.py`)

The local server sends:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
Cache-Control:                no-store
Content-Type:                 application/wasm   (for .wasm)
```

COOP and COEP make the page **cross-origin isolated**, which `SharedArrayBuffer` and therefore pthreads require. See [section 5](#5-hosting).

### 2.6 Limitations noted by the project

- Wasm32 allows at most 4 GB, and the game heap gets 1.25 GB of it.
- Wasm stacks have no guard page, so a stack overflow silently corrupts memory instead of crashing.
- The native build supports macOS on Apple Silicon only.
- Setup is heavy: Ghidra 12, Emscripten, SDL2, wgpu-native and Python with capstone/pefile.
- Both netplay peers need an identical build and identical game files.

---

## 3. Choosing an approach

```
Do you have the source code?
├── Yes ── Is it built with an engine that has a web export (Unity, Godot, ...)?
│          ├── Yes → Engine export (section 4.1)
│          └── No  → Source port with Emscripten (section 4.2)
└── No ─── Is the original platform old or slow (DOS, NES–N64, PS1, Flash)?
           ├── Yes → Emulator in Wasm (section 4.3)
           └── No (Win32 PC game, 2000s+) →
                   ├── Quick, slow, generic → Boxedwine / x86 emulation (section 4.4)
                   ├── Decompile to source → Source port (long term)
                   └── Static recompilation → cricket07 approach (section 4.5)
```

---

## 4. Techniques in detail

### 4.1 Engine web exports

| Engine | Target | Notes |
|---|---|---|
| Unity | WebGL 2 (WebGPU experimental in Unity 6) | Pre-compressed `.br`/`.gz` builds need correct `Content-Encoding` headers. Avoid multithreading unless you can serve COOP/COEP. |
| Godot 4 | WebGL 2 | Threaded builds need cross-origin isolation, and Godot 4.3+ has a single-threaded export option. C# web export is limited. |
| Unreal | — | Official HTML5 support was removed in UE 4.24. Community forks and third-party pixel streaming exist. |
| Bevy / macroquad / raylib / SDL apps | WebGL 2 / WebGPU | Compiled through Rust `wasm32-unknown-unknown` or Emscripten. |
| Defold, PlayCanvas, Phaser, Babylon.js, Three.js | WebGL / WebGPU | Built for the web from the start. |

### 4.2 Source ports with Emscripten

This is the standard route for C/C++ games such as Doom, Quake, Half-Life (Xash3D) and the decompiled N64 games.

1. **Make it build natively on Linux/macOS first** with SDL2 for windowing, input and audio.
2. **Switch to `emcc`/`em++`.** Emscripten ships ports with `-sUSE_SDL=2`, `-sUSE_SDL_MIXER=2` and similar flags.
3. **Graphics:**
   - OpenGL ES 2/3 maps directly to WebGL 1/2 (`-sFULL_ES3`, `-sMAX_WEBGL_VERSION=2`).
   - Desktop GL 1.x immediate mode needs `-sLEGACY_GL_EMULATION` or a layer such as gl4es.
   - Direct3D needs a translation layer. Options are a custom D3D → WebGPU layer (as in cricket07), a D3D → GL layer, or rewriting the renderer.
   - WebGPU is available through `emdawnwebgpu` (Dawn bindings) or wgpu via Rust.
4. **The main loop.** Browsers must get control back every frame. Either:
   - restructure the code as `emscripten_set_main_loop(frame, 0, 1)`, or
   - keep the blocking `while (running)` loop and use **Asyncify** (`-sASYNCIFY`, which costs code size and speed) or **JSPI** (`-sJSPI`, which is cheaper), or
   - run the game on a pthread (`-sPROXY_TO_PTHREAD`) so the main thread stays free. cricket07 does this.
5. **Filesystem:**
   - `--preload-file assets@/` packs assets into a `.data` file.
   - **IDBFS** persists saves to IndexedDB, and **WASMFS + OPFS** gives fast persistent files.
   - To avoid redistributing assets, let the user pick files with `<input type="file" webkitdirectory>` or `showDirectoryPicker()`, then copy them into OPFS or IndexedDB. cricket07 does this.
6. **Audio.** Use SDL audio or OpenAL, which Emscripten maps to Web Audio. Browsers keep the `AudioContext` suspended until a user gesture, so add a "Click to start" screen.
7. **Input.** Use keyboard and mouse DOM events, the Pointer Lock API for mouselook, the Gamepad API (SDL2 maps it to `SDL_GameController`), and touch events for mobile.
8. **Threads.** `-pthread -sPTHREAD_POOL_SIZE=N` needs `SharedArrayBuffer`, which needs COOP/COEP headers.

Example minimal flags:

```bash
emcc main.c game/*.c -O3 \
  -sUSE_SDL=2 -sMAX_WEBGL_VERSION=2 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB \
  -sASYNCIFY \
  --preload-file assets@/assets \
  -o index.html
```

### 4.3 Emulators in the browser

| Target | Projects |
|---|---|
| DOS | js-dos (DOSBox / DOSBox-X in Wasm), em-dosbox |
| Full x86 PC (Win9x/Linux) | v86 (x86 → Wasm JIT), Boxedwine |
| Retro consoles | EmulatorJS (RetroArch cores), RetroArch web build |
| Flash | Ruffle (Rust → Wasm) |
| Adventure games | ScummVM (official web build) |

Users supply the ROMs, ISOs or disk images. The emulator can be hosted publicly, but the game data has the same licensing issues as in section 6.

### 4.4 Win32 compatibility layers

Boxedwine combines an x86 CPU emulator with a Wine-derived userland and runs in Wasm. It runs many old Windows games without per-game work, but it is far slower than recompilation and its 3D support is limited. Use it for quick prototypes or for 2D and low-end 3D titles.

### 4.5 Static recompilation (the cricket07 approach)

General recipe, based on cricket07 and similar projects (N64Recomp, XenonRecomp, the Rugby 06 web port):

1. **Disassemble and find functions.** Use Ghidra, IDA or radare2, and export function entry points. Indirect jumps and jump tables are the hardest part.
2. **Translate instructions to C.** Model registers and flags as variables and memory as `uint8_t mem[]` at the original addresses. Emit one C function per guest function and turn indirect calls into a lookup table keyed by address.
3. **Handle edge cases.** These include self-modifying code, code in data (cricket07's sound banks), x87 FPU precision, SSE/MMX, exceptions/SEH, and `setjmp`/`longjmp`.
4. **Keep an interpreter as a fallback** for code that only appears at runtime.
5. **Replace the OS imports.** Each imported DLL function (`kernel32`, `user32`, `d3d8`, `dsound`, `dinput8`, `winmm`, ...) gets a host implementation that operates on guest memory.
6. **Replace the graphics API.** Translate D3D state and shaders to WebGPU/WGSL or WebGL/GLSL. Vertex shaders can run on the CPU if that is simpler.
7. **Do differential testing.** Run a CPU emulator and the translated code side by side on random state and compare the results.
8. **Make it deterministic** (optional). A single-threaded virtual clock and scheduler enables replays and lockstep netplay.

Advantages: near-native speed, a native build from the same C, and no redistribution of the game's code.
Costs: a large engineering effort, a toolchain per game or binary, and a dependency on one exact executable version (cricket07's `profile.h`).

---

## 5. Hosting

### 5.1 Required and recommended headers

| Header | Why |
|---|---|
| `Content-Type: application/wasm` | Required by `WebAssembly.instantiateStreaming`. Without it, loading falls back to slower paths or fails. |
| `Cross-Origin-Opener-Policy: same-origin` | Needed for cross-origin isolation (`SharedArrayBuffer`, pthreads, high-resolution timers) |
| `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`) | Same reason. Every cross-origin subresource then needs CORS or CORP. |
| `Cross-Origin-Resource-Policy: same-origin` / `cross-origin` | Lets resources load in COEP pages |
| `Content-Encoding: br` / `gzip` | `.wasm` and `.data` files compress very well |
| `Cache-Control` | Long cache plus content-hashed filenames for release builds, `no-store` during development (as in cricket07) |

Check in the console that `self.crossOriginIsolated === true`.

### 5.2 Platform cheat sheet

| Host | Custom headers? | How |
|---|---|---|
| **Cloudflare Pages / Workers** | Yes | A `_headers` file or Worker code. Workers + Durable Objects also suit netplay room servers, and cricket07 uses Workers. |
| **Netlify** | Yes | `_headers` file or `netlify.toml` |
| **Vercel** | Yes | `headers` in `vercel.json` |
| **GitHub Pages** | No | Workaround: the [`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker) shim injects COOP/COEP from a service worker |
| **itch.io** | Partial | Enable "SharedArrayBuffer support" in the HTML5 project settings. Respect its file count and size limits. |
| **S3 + CloudFront** | Yes | CloudFront response-headers policy |
| **Self-hosted (Nginx / Express)** | Yes | See below |

`_headers` example (Cloudflare Pages / Netlify):

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
```

`vercel.json` example:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
      ]
    }
  ]
}
```

### 5.3 Hosting with Express (ties into this repo)

```js
const express = require('express')
const path = require('path')
const app = express()

// Cross-origin isolation → SharedArrayBuffer / Wasm threads
app.use((req, res, next) => {
  res.set({
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  })
  next()
})

// Correct MIME type for streaming compilation
express.static.mime.define({ 'application/wasm': ['wasm'] })

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  setHeaders: (res, file) => {
    if (file.endsWith('.html')) res.set('Cache-Control', 'no-cache')
  },
}))

app.listen(8007, () => console.log('http://localhost:8007'))
```

Notes:

- Add `compression()` middleware, or better, serve pre-compressed `.br` files with `Content-Encoding: br`.
- Recent `express.static` versions already map `.wasm` to `application/wasm`. Keep the explicit mapping for older versions.
- Browsers treat `localhost` as a secure context, so isolation works in local development. Production needs HTTPS.

### 5.4 Asset delivery strategies

| Strategy | When |
|---|---|
| Bundle with the page (`--preload-file`, Unity `.data`) | Assets you own or are allowed to redistribute |
| Lazy or streaming fetch (`fetch` + OPFS cache, HTTP range requests) | Large games, faster first load |
| **Bring your own files** (directory picker → OPFS/IndexedDB) | Commercial games you cannot redistribute (cricket07, many emulator front ends) |
| Service worker caching | Offline play and instant reloads (PWA) |

### 5.5 Multiplayer and netplay

- **Lockstep** (cricket07, classic RTS games): send only inputs and keep the simulation deterministic. It is cheap on bandwidth, but latency equals the slowest peer, and any nondeterminism (float differences, thread timing, `Math.random`) causes desyncs. Hash state periodically to catch them.
- **Rollback** (GGPO-style): predict remote inputs, then rewind and re-simulate when the real inputs arrive. It feels better for fighting and sports games but needs fast save and restore of state. With static recompilation, Wasm memory can be snapshotted.
- **Transport:** WebSockets through a relay (simple, TCP head-of-line blocking), WebRTC DataChannels (P2P, can be set unordered and unreliable, needs STUN/TURN and signalling), or WebTransport (QUIC, needs a server).
- **Room servers:** Cloudflare Durable Objects, a small Node/Express + `ws` server, or Socket.IO.

---

## 6. Legal and ethical considerations

- **Do not redistribute copyrighted game binaries or assets.** cricket07 ships only translation tools and host code under MIT, and the user provides their own copy. Users pick their install folder and the files stay in the browser's private storage.
- Trademarks: include a disclaimer of affiliation, as cricket07 does for EA.
- Reverse engineering for interoperability is treated differently by jurisdiction (US DMCA §1201(f), EU Software Directive Art. 6). This is not legal advice.
- Browser ports that hosted full commercial game data publicly have received takedowns from publishers. The "bring your own files" model is the safer pattern.
- Open-source engines and games (Doom/Quake engines, OpenTTD) and decompilation projects that require the original ROM to extract assets follow the same principle: share code, not assets.

---

## 7. Browser platform features that matter (as of 2025–2026)

| Feature | Status | Why it matters |
|---|---|---|
| WebAssembly SIMD, threads, bulk memory | All major browsers | Performance and pthreads |
| **WebGPU** | Chrome/Edge 113+, Safari 26 (2025), Firefox 141+ on Windows (macOS ARM from 145; Linux/Android in progress) | Modern GPU API. Translating D3D/Vulkan is easier than with WebGL. |
| WebGL 2 | Universal | Safe fallback renderer |
| **Memory64** (Wasm > 4 GB) | Chrome 133, Firefox 134; not Safari | Removes the 4 GB limit cricket07 works within, but 64-bit pointers are slower |
| **JSPI** | Chrome/Edge 137+; others in progress | Cheaper alternative to Asyncify for blocking code |
| Wasm exception handling, tail calls, GC | Broadly shipped | C++ exceptions without JS trampolines, plus managed languages |
| OPFS | All major browsers | Fast persistent file storage for game data and saves |
| Gamepad API, Pointer Lock, Fullscreen | Universal; mobile Safari has quirks | Input and immersion |
| Web Audio + AudioWorklet | Universal | Low-latency mixing off the main thread |

---

## 8. Common pitfalls checklist

- [ ] **Main-thread blocking.** Never spin-wait on the main thread. Use a main-loop callback, Asyncify/JSPI, or `PROXY_TO_PTHREAD`.
- [ ] **WebGPU/WebGL calls from Workers.** Use OffscreenCanvas, or record commands in a worker and replay them on the main thread as cricket07 does.
- [ ] **Missing COOP/COEP headers.** pthreads silently fail, or `SharedArrayBuffer is not defined`.
- [ ] **Wrong `.wasm` MIME type.** `instantiateStreaming` fails.
- [ ] **Audio suspended until the user clicks.** Add a start overlay.
- [ ] **Timer epoch and precision.** Old games assume small tick counts (see cricket07), and browsers coarsen `performance.now()` unless the page is cross-origin isolated.
- [ ] **Stack overflows corrupt memory silently.** Increase `-sSTACK_SIZE` and the pthread stack sizes.
- [ ] **Memory limits.** 4 GB is the Wasm32 maximum, and mobile browsers often kill tabs well below 1–2 GB.
- [ ] **Firefox and typed arrays over 2 GB.** Some APIs reject large views (the cricket07 `setBindGroup` patch).
- [ ] **Case-sensitive filesystems.** Windows games use mixed-case paths, so normalise them in the file layer.
- [ ] **Float determinism** for netplay. x87 80-bit vs. Wasm f64 differences matter for lockstep.
- [ ] **Download size.** Use Brotli, split assets, and show a progress bar.

---

## 9. A practical learning path

1. Build a small SDL2 game natively, then compile it with Emscripten (`emcc ... -o index.html`).
2. Serve it with Express (section 5.3) and confirm `crossOriginIsolated` after adding threads.
3. Port an open-source game such as Doom (`doomgeneric`) or a Quake engine.
4. Try emulator hosting with js-dos or EmulatorJS and a freeware ROM or game.
5. Read the cricket07 source in this order: `translator/x86toc.py` → `host/` (d3d8 → WebGPU) → `host/sched.c` and `host/netplay.c` → `tests/difftest.py`.
6. Deploy to Cloudflare Pages or Vercel with headers, and add a WebSocket or Durable Object room server for multiplayer.

---

## 10. References

- cricket07-browser: https://github.com/Dhaiwat10/cricket07-browser/ (README, `build_web.sh`, `web/serve.py`)
- Emscripten docs: https://emscripten.org/docs/
  - Porting guide: https://emscripten.org/docs/porting/index.html
  - Pthreads: https://emscripten.org/docs/porting/pthreads.html
  - Asyncify / JSPI: https://emscripten.org/docs/porting/asyncify.html
  - Filesystem (WASMFS/OPFS): https://emscripten.org/docs/api_reference/Filesystem-API.html
- WebAssembly feature status: https://webassembly.org/features/
- WebGPU supported in major browsers (web.dev, Nov 2025): https://web.dev/blog/webgpu-supported-major-browsers
- WebGPU overview: https://en.wikipedia.org/wiki/WebGPU
- Is Memory64 actually worth using? (SpiderMonkey blog, Jan 2025): https://spidermonkey.dev/blog/2025/01/15/is-memory64-actually-worth-using.html
- Cross-origin isolation guide: https://web.dev/articles/coop-coep
- coi-serviceworker (GitHub Pages workaround): https://github.com/gzuidhof/coi-serviceworker
- Ghidra: https://ghidra-sre.org/
- N64Recomp (static recompilation for N64): https://github.com/N64Recomp/N64Recomp
- js-dos: https://js-dos.com/ · v86: https://github.com/copy/v86 · Boxedwine: https://github.com/danoon2/Boxedwine
- EmulatorJS: https://emulatorjs.org/ · Ruffle: https://ruffle.rs/
- GGPO (rollback netcode): https://www.ggpo.net/
