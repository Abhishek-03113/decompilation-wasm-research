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
// Downloads are written in place by a worker and saved every 64 MB, so a closed tab resumes where
// it stopped. Files removed on the server are removed here. Saves and settings are never touched.

// At the OPFS root, outside the memory stick. v2: files written by the old writable-stream sync
// could be incomplete after an interrupted download, so every browser downloads them once more.
const SYNC_STATE = '.sync-state-v2.json'
const FINGERPRINT = '#manifest'   // key in the sync state: fingerprint of the last fully synced list

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

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
// With a pattern, only files directly in `dir` whose names match are the server's to remove
// (PSP/SYSTEM holds the player's own settings next to the server's per-game ones).
async function prune(dir, prefix, keep, pattern) {
  for await (const [name, handle] of dir.entries()) {
    const rel = prefix + name
    if (handle.kind === 'directory') {
      if (!pattern) await prune(handle, rel + '/', keep)
    } else if (!keep.has(rel) && (!pattern || pattern.test(name))) {
      await dir.removeEntry(name)
      log('Removed ' + rel + ' (no longer on the server)')
    }
  }
}

// Runs the download in sync-worker.js, which writes the file in place (see there for why).
// Downloads run in sync-worker.js, which writes each file in place (see there for why). A small
// pool of workers is reused across files, so a pack of thousands of small files (an HD texture
// pack fetched from GitHub) doesn't pay for a new worker per file and downloads a few at a time.
// `pieces` ([{url, size}]) comes from a manifest whose files are stored as parts or remote links.
class DownloadPool {
  constructor(size) {
    this.idle = []
    this.waiting = []
    for (let i = 0; i < size; i++) this.idle.push(new Worker('sync-worker.js'))
  }
  async run(job, onBytes, onPiece) {
    const worker = this.idle.pop() || await new Promise((r) => this.waiting.push(r))
    try {
      await new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => {
          if (data.bytes) onBytes(data.bytes)
          else if (data.pieceDone !== undefined) onPiece && onPiece(data.pieceDone)
          else data.done ? resolve() : reject(new Error(data.error))
        }
        worker.onerror = (e) => reject(new Error(e.message || 'sync worker failed'))
        worker.postMessage(job)
      })
    } finally {
      const next = this.waiting.shift()
      if (next) next(worker); else this.idle.push(worker)
    }
  }
  close() { for (const w of this.idle) w.terminate() }
}

// Where the games come from: this site by default, or what config.json names, e.g. when this page
// is hosted on Vercel:
//   {"gamesServer": "https://..."}   another server running server.ts (paths under memstick/)
//   {"manifestUrl": "https://..."}   any endpoint returning the manifest with download links per
//                                     file (supabase/functions/games: a private Storage bucket)
// A games source with a key asks for it once; it's kept in this browser.
const KEY_ITEM = 'ppsspp-games-key'
let gamesBase = ''
let manifestUrl = ''

async function loadConfig() {
  try {
    const res = await fetch('config.json', { cache: 'no-store' })
    if (!res.ok) return
    const cfg = await res.json()
    if (cfg.gamesServer) gamesBase = String(cfg.gamesServer).replace(/\/*$/, '/')
    if (cfg.manifestUrl) manifestUrl = String(cfg.manifestUrl)
  } catch { /* no config: games come from this site */ }
}

function gamesKey() {
  try { return localStorage.getItem(KEY_ITEM) || '' } catch { return '' }
}

function authHeaders() {
  const key = gamesKey()
  return key ? { Authorization: 'Bearer ' + key } : {}
}

class NeedsKey extends Error {}

async function syncGames() {
  const label = $('sync-label')
  const bar = $('sync-bar')
  const res = await fetch(manifestUrl || gamesBase + 'memstick/manifest.json', { cache: 'no-store', headers: authHeaders() })
  if (res.status === 401) throw new NeedsKey(gamesKey() ? 'That key was not accepted.' : '')
  if (!res.ok) throw new Error('memstick/manifest.json: HTTP ' + res.status)
  const manifest = await res.json()
  const root = await navigator.storage.getDirectory()
  const memstick = await root.getDirectoryHandle('memstick', { create: true })
  const state = await readJson(root, SYNC_STATE)
  root.removeEntry('.sync-state.json').catch(() => {})   // v1 state, no longer used

  // Everything downloaded stays in this browser's storage. A file is fetched again only when the
  // server's copy changes (size or modification time). Files that finished downloading are marked
  // `done`, and a fingerprint of the whole list is kept, so a return visit to an unchanged server
  // skips looking at every file (a texture pack has thousands).
  const fingerprint = await sha256Hex(JSON.stringify([manifest.dirs, manifest.files.map((f) => [f.path, f.size, f.mtime])]))
  const allDone = () => manifest.files.every((f) => {
    const k = state[f.path]
    return k && k.done && k.size === f.size && k.mtime === f.mtime
  })
  const todo = []
  if (state[FINGERPRINT] !== fingerprint || !allDone()) {
    for (const f of manifest.files) {
      const known = state[f.path]
      const sameVersion = known && known.size === f.size && known.mtime === f.mtime
      if (sameVersion && known.done) continue
      const parts = f.path.split('/')
      const dir = await dirFor(memstick, parts.slice(0, -1), true)
      const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true })
      const have = await localSize(handle)
      // A file in several pieces is given its full size before the pieces arrive (in parallel, in
      // any order), so its size says nothing; its finished pieces are listed in `known.pieces`.
      const multi = f.parts && f.parts.length > 1
      if (sameVersion && have === f.size && !known.pieces) { known.done = true; continue }
      todo.push({ f, handle,
        offset: !multi && sameVersion && have < f.size ? have : 0,
        donePieces: multi && sameVersion && known.pieces ? known.pieces.slice() : [] })
    }

    const keep = new Set(manifest.files.map((f) => f.path))
    for (const { dir, pattern } of manifest.dirs) {
      const re = pattern ? new RegExp(pattern) : null
      try { await prune(await dirFor(memstick, dir.split('/'), false), dir + '/', keep, re) } catch { /* folder absent */ }
    }
    for (const k of Object.keys(state)) if (k !== FINGERPRINT && !keep.has(k)) delete state[k]
  }

  const games = manifest.files.filter((f) => f.path.startsWith('ISO/')).length
  const totalSize = manifest.files.reduce((n, f) => n + f.size, 0)
  if (todo.length) {
    if (navigator.storage.persist) {
      const persisted = await navigator.storage.persist()
      if (!persisted) log('Browser storage is best-effort here; the browser may clear it when space runs low.')
    }
    const remaining = (t) => t.donePieces.length
      ? t.f.size - t.donePieces.reduce((n, i) => n + t.f.parts[i].size, 0)
      : t.f.size - t.offset
    const total = todo.reduce((n, t) => n + remaining(t), 0)
    let done = 0, files = 0, failed = null
    bar.hidden = false
    // Save progress every few seconds rather than after every file: with thousands of files,
    // rewriting the state each time would cost more than the downloads.
    let lastSave = 0
    const saveState = async (force) => {
      if (!force && performance.now() - lastSave < 3000) return
      lastSave = performance.now()
      await writeJson(root, SYNC_STATE, state)
    }
    let lastLabel = 0
    const showProgress = () => {
      if (performance.now() - lastLabel < 200) return
      lastLabel = performance.now()
      bar.value = total ? done / total : 1
      label.textContent = `Downloading: ${formatSize(done)} of ${formatSize(total)} (${files} of ${todo.length} files)`
    }
    // Parallel lanes, each a worker thread with its own file. Many small files (a texture pack)
    // are latency-bound, and HTTP/2 carries many requests at once, so they get more lanes; a few
    // big files are bandwidth-bound and need fewer. ?lanes=N overrides this for measuring.
    const avg = total / todo.length
    const asked = parseInt(new URLSearchParams(location.search).get('lanes'), 10)
    const lanes = Math.max(1, Math.min(todo.length, asked > 0 ? Math.min(asked, 64) : avg < 4 * 1024 * 1024 ? 24 : 4))
    const pool = new DownloadPool(lanes)
    const queue = todo.slice()
    const lane = async () => {
      while (queue.length && !failed) {
        const t = queue.shift()
        // `done` is added once it's complete; a file in pieces also lists its finished pieces.
        const entry = state[t.f.path] = { size: t.f.size, mtime: t.f.mtime }
        if (t.f.parts && t.f.parts.length > 1) entry.pieces = t.donePieces.slice()
        const url = gamesBase + 'memstick/' + t.f.path.split('/').map(encodeURIComponent).join('/')
        try {
          await pool.run({ parts: ['memstick', ...t.f.path.split('/')], url, size: t.f.size, offset: t.offset,
            headers: authHeaders(), pieces: t.f.parts, donePieces: t.donePieces },
            (n) => { done += n; showProgress() },
            (i) => { entry.pieces.push(i); saveState(false) })
        } catch (e) {
          failed = e
          break
        }
        entry.done = true
        delete entry.pieces
        files++
        showProgress()
        if (t.f.size >= 8 * 1024 * 1024) log('Downloaded ' + t.f.path + ' (' + formatSize(t.f.size) + ')')
        await saveState(false)
      }
    }
    await Promise.all(Array.from({ length: lanes }, lane))
    pool.close()
    await saveState(true)
    if (failed) throw failed
    if (todo.length > 1) log(`Downloaded ${todo.length} files (${formatSize(total)}) with ${lanes} parallel downloads`)
    bar.hidden = true
  }
  if (allDone()) state[FINGERPRINT] = fingerprint
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
      printErr: (t) => { console.warn(t); if (!/mprotect|Heap resize|CreateDir|Registered VFS/.test(t)) log(t) },
      locateFile: (p) => 'build/' + p,
      preRun: [() => {
        // HOME is where PPSSPP's file browser opens; /opfs/games is then one click away.
        window.Module.ENV.HOME = '/opfs'
      }],
      onRuntimeInitialized: () => resolve(window.Module),
      onAbort: (what) => {
        log('PPSSPP stopped: ' + what)
        // After Start the log is hidden behind the game; go back to the launcher so it's visible.
        $('launcher').hidden = false
        $('stage').classList.remove('on')
        reject(new Error(String(what)))
      },
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
    s.drawnHz = (counts.drawn - lastCounts.drawn) / dt
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
  if (s.emuHz !== undefined) lines.push(`Threads: page ${s.pageHz.toFixed(0)} Hz · emulator ${s.emuHz.toFixed(0)} Hz · drawn ${s.drawnHz.toFixed(0)} Hz`)
  if (s.audioMs !== undefined) lines.push(`Audio: ${s.audioMs.toFixed(0)} ms buffered · ${s.underruns} silent frames`)
  lines.push(`Gamepad: ${s.pad}`)
  return lines.join('\n')
}

// What the WebGL side looks like, for bug reports. getContext returns the context PPSSPP created.
function graphicsReport() {
  const c = $('canvas')
  const lines = [`Canvas: ${c.width}x${c.height} drawn at ${c.clientWidth}x${c.clientHeight} css px, devicePixelRatio ${devicePixelRatio}`]
  const gl = c.getContext('webgl2')
  if (!gl) return lines.concat('WebGL 2: no context on the canvas').join('\n')
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  lines.push(`WebGL 2: ${info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}` +
    ` · ${gl.isContextLost() ? 'CONTEXT LOST' : 'context ok'}`)
  const a = gl.getContextAttributes()
  if (a) lines.push(`Context: antialias ${a.antialias} · alpha ${a.alpha} · preserveDrawingBuffer ${a.preserveDrawingBuffer} · ${a.powerPreference}`)
  return lines.join('\n')
}

function startStats(Module) {
  const box = $('stats')
  // A lost WebGL context (GPU reset, driver crash, out of GPU memory) leaves a black canvas.
  $('canvas').addEventListener('webglcontextlost', () => {
    log('WebGL context lost: the GPU process reset or ran out of memory. Reload the page.')
    box.hidden = false
  })
  const tick = () => { box.textContent = formatStats(readStats(Module)) }
  tick()
  statsTimer = setInterval(tick, 500)
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F2') { box.hidden = !box.hidden; e.preventDefault() }
  }, true)
  $('copy-stats').addEventListener('click', async () => {
    const recent = logEl.textContent.trim().split('\n').slice(-40).join('\n')
    const report = formatStats(readStats(Module)) + '\n' + graphicsReport() + '\n' + navigator.userAgent +
      '\n--- last log lines ---\n' + recent
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
    // For debugging, ?boot=ISO/<file> boots one of the synced games directly.
    const args = ['--memstick=/opfs/memstick']
    const boot = new URLSearchParams(location.search).get('boot')
    if (boot && /^[\w .()\[\]/-]+$/.test(boot) && !boot.split('/').includes('..')) args.push('/opfs/memstick/' + boot)
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
function sync() {
  $('key-form').hidden = true
  syncGames()
    .then(() => { $('start').disabled = false; $('start').focus() })
    .catch((e) => {
      if (e instanceof NeedsKey) {
        $('sync-label').textContent = (e.message ? e.message + ' ' : '') + 'The games on this server need a key from its owner.'
        $('key-form').hidden = false
        $('key').focus()
        return
      }
      $('sync-label').textContent = 'Could not get the games: ' + e.message
      log(e.stack || e.message)
    })
}

$('key-form').addEventListener('submit', (e) => {
  e.preventDefault()
  try { localStorage.setItem(KEY_ITEM, $('key').value.trim()) } catch { log('This browser blocks local storage; the key can\'t be kept.') }
  $('key').value = ''
  sync()
})

if (navigator.storage && navigator.storage.getDirectory) {
  loadConfig().then(sync)
}
