// Launcher for the PPSSPP WebAssembly build (build/PPSSPPSDL.js).
//
// Games come from the server's memory stick (ISO/ and PSP/GAME/) and are synced into the browser's
// Origin Private File System (OPFS) under memstick/. The WebAssembly side mounts OPFS at /opfs
// before main() runs, so PPSSPP's memory stick is /opfs/memstick: the synced games plus this
// player's own saves and settings. PPSSPP starts on its game list; players can't add files.
'use strict'

const $ = (id) => document.getElementById(id)
const logEl = $('log')

function log(line) {
  logEl.textContent += line + '\n'
  logEl.scrollTop = logEl.scrollHeight
}

function formatSize(bytes) {
  if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(2) + ' GB'
  if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(1) + ' MB'
  return Math.round(bytes / 1024) + ' KB'
}

// --- Browser checks -------------------------------------------------------------------------

function runChecks() {
  const canvas = document.createElement('canvas')
  const checks = [
    ['Cross-origin isolated (threads)', window.crossOriginIsolated === true,
      'Serve the page with the COOP/COEP headers (bun start does this).'],
    ['SharedArrayBuffer', typeof SharedArrayBuffer === 'function', 'Needs cross-origin isolation.'],
    ['WebGL 2', !!canvas.getContext('webgl2'), 'Turn on hardware acceleration in the browser.'],
    ['Private file storage (OPFS)', !!(navigator.storage && navigator.storage.getDirectory),
      'Use a current Chrome, Edge, Firefox or Safari.'],
  ]
  const box = $('checks')
  box.textContent = ''
  let allOk = true
  for (const [name, ok, fix] of checks) {
    const div = document.createElement('div')
    div.className = ok ? 'ok' : 'bad'
    div.textContent = (ok ? '✓ ' : '✗ ') + name + (ok ? '' : ': ' + fix)
    box.appendChild(div)
    allOk = allOk && ok
  }
  return allOk
}

// --- Syncing games from the server ----------------------------------------------------------
// The server lists its memory stick's ISO/ and PSP/GAME/ folders in memstick/manifest.json. Each
// file is copied into OPFS at memstick/<path> once, and again only if the server's copy changes.
// Downloads are written in 64 MB pieces that are saved as they go, so a closed tab resumes where
// it stopped. Files removed on the server are removed here. Saves and settings are never touched.

const SYNC_STATE = '.sync-state.json'   // at the OPFS root, outside the memory stick
const PIECE = 64 * 1024 * 1024

async function readJson(dir, name) {
  try { return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()) } catch { return {} }
}

async function writeJson(dir, name, value) {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable()
  await w.write(JSON.stringify(value))
  await w.close()
}

async function dirFor(root, parts, create) {
  let dir = root
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create })
  return dir
}

async function localSize(fileHandle) {
  try { return (await fileHandle.getFile()).size } catch { return 0 }
}

// Removes files under `dir` (relative path `prefix`) that aren't in `keep`.
async function prune(dir, prefix, keep) {
  for await (const [name, handle] of dir.entries()) {
    const rel = prefix + name
    if (handle.kind === 'directory') {
      await prune(handle, rel + '/', keep)
    } else if (!keep.has(rel)) {
      await dir.removeEntry(name)
      log('Removed ' + rel + ' (no longer on the server)')
    }
  }
}

async function downloadFile(fileHandle, url, size, offset, onBytes) {
  const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {}
  const res = await fetch(url, { headers, cache: 'no-store' })
  if (offset > 0 && res.status !== 206) {
    // The server ignored the range: start over.
    return downloadFile(fileHandle, url, size, 0, onBytes)
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const reader = res.body.getReader()
  let pos = offset
  let writable = await fileHandle.createWritable({ keepExistingData: offset > 0 })
  if (offset > 0) await writable.seek(offset)
  else await writable.truncate(0)
  let inPiece = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    await writable.write(value)
    pos += value.byteLength
    inPiece += value.byteLength
    onBytes(value.byteLength)
    if (inPiece >= PIECE) {
      await writable.close()   // saves this piece for good
      writable = await fileHandle.createWritable({ keepExistingData: true })
      await writable.seek(pos)
      inPiece = 0
    }
  }
  await writable.close()
  if (pos !== size) throw new Error(`${url}: got ${pos} of ${size} bytes`)
}

async function syncGames() {
  const label = $('sync-label')
  const bar = $('sync-bar')
  const res = await fetch('memstick/manifest.json', { cache: 'no-store' })
  if (!res.ok) throw new Error('memstick/manifest.json: HTTP ' + res.status)
  const manifest = await res.json()
  const root = await navigator.storage.getDirectory()
  const memstick = await root.getDirectoryHandle('memstick', { create: true })
  const state = await readJson(root, SYNC_STATE)

  // Work out what to fetch.
  const todo = []
  for (const f of manifest.files) {
    const parts = f.path.split('/')
    const dir = await dirFor(memstick, parts.slice(0, -1), true)
    const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true })
    const have = await localSize(handle)
    const known = state[f.path]
    const sameVersion = known && known.size === f.size && known.mtime === f.mtime
    if (sameVersion && have === f.size) continue
    todo.push({ f, handle, offset: sameVersion && have < f.size ? have : 0 })
  }

  const keep = new Set(manifest.files.map((f) => f.path))
  for (const d of manifest.dirs) {
    try { await prune(await dirFor(memstick, d.split('/'), false), d + '/', keep) } catch { /* folder absent */ }
  }
  for (const k of Object.keys(state)) if (!keep.has(k)) delete state[k]

  const games = manifest.files.filter((f) => f.path.startsWith('ISO/')).length
  const totalSize = manifest.files.reduce((n, f) => n + f.size, 0)
  if (todo.length) {
    if (navigator.storage.persist) {
      const persisted = await navigator.storage.persist()
      if (!persisted) log('Browser storage is best-effort here; the browser may clear it when space runs low.')
    }
    const total = todo.reduce((n, t) => n + t.f.size - t.offset, 0)
    let done = 0
    bar.hidden = false
    for (const t of todo) {
      state[t.f.path] = { size: t.f.size, mtime: t.f.mtime }
      await writeJson(root, SYNC_STATE, state)
      label.textContent = `Downloading ${t.f.path}${t.offset ? ' (resuming)' : ''}…`
      const url = 'memstick/' + t.f.path.split('/').map(encodeURIComponent).join('/')
      await downloadFile(t.handle, url, t.f.size, t.offset, (n) => {
        done += n
        bar.value = total ? done / total : 1
        label.textContent = `Downloading ${t.f.path}: ${formatSize(done)} of ${formatSize(total)}`
      })
      log('Downloaded ' + t.f.path + ' (' + formatSize(t.f.size) + ')')
    }
    bar.hidden = true
  }
  await writeJson(root, SYNC_STATE, state)
  label.textContent = games
    ? `${games} game${games === 1 ? '' : 's'} ready (${formatSize(totalSize)} in browser storage).`
    : 'No games on this server yet. Put ISO, CSO or CHD files in the server\'s memstick/ISO folder.'
}

// --- Starting PPSSPP ------------------------------------------------------------------------

let started = false

function loadRuntime() {
  return new Promise((resolve, reject) => {
    window.Module = {
      canvas: $('canvas'),
      print: (t) => { console.log(t); log(t) },
      printErr: (t) => { console.warn(t); if (!/mprotect|Heap resize/.test(t)) log(t) },
      locateFile: (p) => 'build/' + p,
      preRun: [() => {
        // HOME is where PPSSPP's file browser opens; /opfs/games is then one click away.
        window.Module.ENV.HOME = '/opfs'
      }],
      onRuntimeInitialized: () => resolve(window.Module),
      onAbort: (what) => { log('Aborted: ' + what); reject(new Error(String(what))) },
    }
    const s = document.createElement('script')
    s.src = 'build/PPSSPPSDL.js'
    s.onerror = () => reject(new Error('build/PPSSPPSDL.js is missing. Run build.sh first.'))
    document.body.appendChild(s)
  })
}

async function mountOPFS(Module) {
  Module._PPSSPPWeb_MountOPFS()
  for (let i = 0; i < 200; i++) {
    const state = Module._PPSSPPWeb_OPFSState()
    if (state === 1) return
    if (state === -1) throw new Error('Could not mount browser storage at /opfs')
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('Timed out mounting browser storage')
}

// --- Audio ---------------------------------------------------------------------------------
// Browsers only allow audio to start from a user gesture, so the AudioContext is created
// synchronously in the Play / menu click, before any await.
let audio = null

function createAudio() {
  try {
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    const ready = ctx.audioWorklet.addModule('audio-worklet.js').then(() => {
      const node = new AudioWorkletNode(ctx, 'ppsspp-audio', { numberOfInputs: 0, outputChannelCount: [2] })
      node.connect(ctx.destination)
      return node
    })
    audio = { ctx, ready, ring: 0 }
    window.ppssppAudio = audio // for debugging and tools/input-audio.js
  } catch (e) {
    log('Audio unavailable: ' + e.message)
  }
}

async function startAudio(Module) {
  if (!audio) return
  try {
    const node = await audio.ready
    // Stay ~50 ms ahead of the audio thread: low enough for a fighting game, with room for hiccups.
    const targetFrames = Math.round(audio.ctx.sampleRate * 0.05)
    audio.ring = Module._PPSSPPWeb_StartAudio(audio.ctx.sampleRate, targetFrames)
    node.port.postMessage({ buffer: Module.HEAPU8.buffer, ptr: audio.ring })
    if (audio.ctx.state !== 'running') await audio.ctx.resume()
    log(`Audio: ${audio.ctx.sampleRate} Hz AudioWorklet, ${Math.round(targetFrames / audio.ctx.sampleRate * 1000)} ms buffer`)
  } catch (e) {
    log('Audio failed to start: ' + e.message)
  }
}

// --- Stats overlay (F2) ---------------------------------------------------------------------

let statsTimer = 0
let lastCounts = null

function readStats(Module) {
  const now = performance.now()
  const counts = { t: now, page: Module._PPSSPPWeb_Stat(0), emu: Module._PPSSPPWeb_Stat(1), drawn: Module._PPSSPPWeb_Stat(2) }
  const s = {
    inGame: Module._PPSSPPWeb_Perf(4) > 0,
    vps: Module._PPSSPPWeb_Perf(0),
    fps: Module._PPSSPPWeb_Perf(1),
    speed: Module._PPSSPPWeb_Perf(3),
  }
  if (lastCounts) {
    const dt = (now - lastCounts.t) / 1000
    s.pageHz = (counts.page - lastCounts.page) / dt
    s.emuHz = (counts.emu - lastCounts.emu) / dt
  }
  lastCounts = counts
  if (audio && audio.ring) {
    const h = new Uint32Array(Module.HEAPU8.buffer, audio.ring, 4)
    s.audioMs = ((h[0] - h[1]) >>> 0) / audio.ctx.sampleRate * 1000
    s.underruns = h[2]
  }
  const pads = Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter(Boolean)
  s.pad = pads.length ? pads[0].id + (pads[0].mapping === 'standard' ? '' : ' (non-standard mapping)') : 'none'
  return s
}

function formatStats(s) {
  const lines = []
  if (s.inGame) lines.push(`Game: ${s.fps.toFixed(0)} fps · speed ${s.speed.toFixed(0)}% (${s.vps.toFixed(1)} vblanks/s)`)
  else lines.push('Game: not running (menu)')
  if (s.emuHz !== undefined) lines.push(`Threads: page ${s.pageHz.toFixed(0)} Hz · emulator ${s.emuHz.toFixed(0)} Hz`)
  if (s.audioMs !== undefined) lines.push(`Audio: ${s.audioMs.toFixed(0)} ms buffered · ${s.underruns} silent frames`)
  lines.push(`Gamepad: ${s.pad}`)
  return lines.join('\n')
}

function startStats(Module) {
  const box = $('stats')
  const tick = () => { box.textContent = formatStats(readStats(Module)) }
  tick()
  statsTimer = setInterval(tick, 500)
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F2') { box.hidden = !box.hidden; e.preventDefault() }
  }, true)
  $('copy-stats').addEventListener('click', async () => {
    const report = formatStats(readStats(Module)) + '\n' + navigator.userAgent
    try { await navigator.clipboard.writeText(report); $('copy-stats').textContent = 'Copied' }
    catch { log(report); $('copy-stats').textContent = 'Copied to log' }
    setTimeout(() => { $('copy-stats').textContent = 'Copy stats' }, 1500)
  })
}

async function start() {
  if (started) return
  started = true
  createAudio()
  try {
    log('Loading PPSSPP…')
    const Module = await loadRuntime()
    await mountOPFS(Module)
    for (const d of ['/opfs/memstick', '/opfs/memstick/ISO']) {
      try { Module.FS.mkdir(d) } catch (e) { /* already there */ }
    }
    $('launcher').hidden = true
    $('stage').classList.add('on')
    $('canvas').focus()
    // No boot file: PPSSPP opens on its game list (memstick ISO/ folder).
    const args = ['--memstick=/opfs/memstick']
    log('Starting PPSSPP ' + args.join(' '))
    Module.callMain(args)
    await startAudio(Module)
    startStats(Module)
  } catch (e) {
    log('Failed to start: ' + e.message)
    $('launcher').hidden = false
    $('stage').classList.remove('on')
  }
}

// --- Wiring ---------------------------------------------------------------------------------

$('start').addEventListener('click', () => start())
$('fs').addEventListener('click', () => {
  const el = $('stage')
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {})
})
$('reload').addEventListener('click', () => location.reload())

const ok = runChecks()
if (!ok) log('Some browser features are missing; PPSSPP may not start.')
if (navigator.storage && navigator.storage.getDirectory) {
  syncGames()
    .then(() => { $('start').disabled = false; $('start').focus() })
    .catch((e) => { $('sync-label').textContent = 'Could not get the games: ' + e.message; log(e.stack || e.message) })
}
