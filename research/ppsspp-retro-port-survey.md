# PPSSPP through the retro-port skill: survey and analysis

The [retro-port](https://github.com/Dhaiwat10/retro-port) skill (commit `ecea26b`) packages the
cricket07-browser toolchain: it statically recompiles a 32-bit Windows `.exe` to C, reimplements the
Windows/Direct3D 8 calls, and builds the result for WebAssembly with a WebGPU renderer.
It was installed to `~/.claude/skills/port-pc-game-to-browser`, and its go/no-go survey
(`scripts/survey.py`) was run on the official **PPSSPP 1.20.4 Windows build**
(`ppsspp.org/files/1_20_4/ppsspp_win.zip`).

Companion docs: [ppsspp-browser-port-plan.md](./ppsspp-browser-port-plan.md),
[browser-game-ports.md](./browser-game-ports.md).

## 1. Survey result

| Executable | Size | Verdict |
|---|---|---|
| `PPSSPPWindows64.exe` | 19.8 MB | **NO**: 64-bit. The recompiler only handles 32-bit x86 (PE32/i386). |
| `PPSSPPWindows.exe` | 16.5 MB | **HARD**: uses OpenGL, and the template only speaks Direct3D 8. |

Details for the 32-bit build:

- **Windows calls:** 161 of 514 imported functions are already implemented by the skill's host
  layer, so **353 are missing**. The gaps include registry (`RegOpenKeyExW` …), crypto
  (`CryptGenRandom`), GDI text and drawing, WGL (`ChoosePixelFormat`, `SwapBuffers`),
  `DirectInput8Create`, HID and SetupAPI (controllers), common dialogs, WinHTTP, Winsock and
  IP helper (networking), and MMCSS (`avrt.dll`).
- **DLLs imported (23):** advapi32, avrt, comctl32, comdlg32, dinput8, dwmapi, gdi32, hid, imm32,
  iphlpapi, kernel32, ole32, oleaut32, opengl32, setupapi, shell32, shlwapi, user32, uxtheme, version,
  winhttp, winmm, ws2_32.
- **Graphics:** only `opengl32.dll` shows up as an import. PPSSPP also loads **Direct3D 11 and
  Vulkan at run time**, so the survey can't see them. The real graphics surface is three APIs, none
  of which the template has.
- **Copy protection:** none found.
- **Multiplayer hints:** "1v1", "multiplayer", "versus". These are false positives: they're strings
  from PPSSPP's UI and ad hoc networking settings, not local two-controller play.

## 2. Problems the survey doesn't catch

Even a 32-bit OpenGL-only build would be a poor fit, for reasons beyond the verdict:

1. **PPSSPP generates code at run time.** Its MIPS JIT and vertex-decoder JIT write x86 machine
   code into memory and jump to it. A static recompiler can only translate code that exists in the
   `.exe`, so the JIT would have to be turned off. That needs a source change, at which point you
   are building from source anyway.
2. **SSE2 is the baseline.** PPSSPP's x86 builds assume SSE2 (`PPSSPP_ARCH_SSE2` in
   `ppsspp_config.h`) and use SSE integer intrinsics throughout. The skill's translator doesn't
   support SSE2 integer instructions; it relies on steering games through CPUID onto x87 paths,
   and PPSSPP has no such paths.
3. **The binary is an application, not a 2006 game.** 16 MB of modern C++ with a Win32 desktop UI,
   dialogs, menus, HTTP, sockets and three graphics backends. The host layer would need most of a
   Windows desktop.
4. **There's nothing to recover.** Static recompilation exists for programs whose source is lost.
   PPSSPP is open source (GPL-2.0+), so compiling the source with Emscripten gives readable,
   maintainable, upstreamable code. Recompiling the binary gives machine-translated C that can't
   take upstream fixes.

**Conclusion: the skill's recompilation route doesn't apply to PPSSPP.** Compiling the source
directly with Emscripten, as in the effort plan, stays the right approach. This confirms the plan's
direction and changes no estimates in it.

## 3. What does carry over from the skill

The skill's browser build (`references/web.md`, `determinism.md`, `hosting.md`) solves several of the
same browser problems the PPSSPP plan has. These lessons are worth reusing:

| Skill technique | Where it helps in the PPSSPP plan |
|---|---|
| `-sPROXY_TO_PTHREAD`: the game runs on a worker; the page's main thread only handles events | Same approach as plan §4.3 (threads and main loop), proven on two shipped ports |
| The game thread records render commands; the main thread replays them each animation frame | Fallback if WebGL2 in an OffscreenCanvas worker misbehaves on a browser (§4.3/§4.4). Also the natural design for a WebGPU backend |
| GPU readbacks block the game thread until the data is mapped, answered mid-frame instead of waiting for vsync | Directly relevant to PPSSPP's readback-heavy games (§4.4) |
| No stack guard pages in Wasm, so threads get large stacks (64–256 MB there) | Overflow silently corrupts memory. Raise `STACK_SIZE` and the pthread stack size for PPSSPP's emulator and worker threads, and test for it |
| Virtual clock starts near zero | Avoid precision loss in timers that count from the epoch. Check PPSSPP's `time_now_d()` paths |
| Game files in OPFS via WASMFS, with a manifest, HTTP Range resume and `navigator.storage.persist()`; folder picker when there's no manifest | Matches plan §4.5. The manifest-with-resume design is a good model for hosted homebrew |
| Audio: AudioWorklet reading a ring buffer in shared memory; Play button unlocks audio | Same as plan §4.6 |
| Keyboard via `KeyboardEvent.code`; short taps held at least 50 ms; gamepads polled each frame and only exposed after a press | Small details that save debugging time in §4.6 |
| WebGPU adapter checks with a software fallback, and an explanation instead of a black screen | Needed if the optional WebGPU backend is built |
| Firefox rejects typed arrays over 2 GB in `setBindGroup`; the skill patches Emscripten's bindings at build time | Also needed for a PPSSPP WebGPU backend with memory over 2 GB |
| Headless Node build with the real file system for tests | Same as plan §6 (pspautotests in Node) |
| Deterministic mode (virtual clock, fixed thread schedule) with per-frame memory hashes compared between two runs | Not needed for single-player. Useful for regression tests and replays. PSP multiplayer is ad hoc networking between separate consoles, not two local controllers, so the skill's lockstep netplay doesn't map onto it |
| Hosting behind a password | Needed for game files, not for PPSSPP itself. The runtime is open source and can be public. Only users' own games stay private |

## 4. Reproduce

```bash
git clone --depth 1 https://github.com/Dhaiwat10/retro-port.git
cp -r retro-port/plugins/retro-port/skills/port-pc-game-to-browser ~/.claude/skills/
curl -LO https://www.ppsspp.org/files/1_20_4/ppsspp_win.zip && unzip ppsspp_win.zip -d ppsspp_win
python3 ~/.claude/skills/port-pc-game-to-browser/scripts/survey.py ppsspp_win
```
