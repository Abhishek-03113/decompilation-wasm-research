// Launcher for the PPSSPP WebAssembly build (build/PPSSPPSDL.js).
//
// Game files live in the Origin Private File System (OPFS), under games/. The WebAssembly side
// mounts OPFS at /opfs before main() runs, so PPSSPP opens /opfs/games/<file> like a normal file,
// and its memory stick (saves, settings) lives at /opfs/memstick.
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

// --- Game library in OPFS -------------------------------------------------------------------

async function gamesDir() {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle('games', { create: true })
}

async function listGames() {
  const dir = await gamesDir()
  const games = []
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file') continue
    const file = await handle.getFile()
    games.push({ name, size: file.size })
  }
  return games.sort((a, b) => a.name.localeCompare(b.name))
}

async function renderGames() {
  const ul = $('games')
  ul.textContent = ''
  let games = []
  try {
    games = await listGames()
  } catch (e) {
    ul.innerHTML = '<li class="muted"></li>'
    ul.firstChild.textContent = 'Could not open browser storage: ' + e.message
    return
  }
  if (!games.length) {
    const li = document.createElement('li')
    li.className = 'muted'
    li.textContent = 'No games yet. Add your own dump of a PSP game with the button below.'
    ul.appendChild(li)
    return
  }
  for (const g of games) {
    const li = document.createElement('li')
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = g.name
    const size = document.createElement('span')
    size.className = 'size'
    size.textContent = formatSize(g.size)
    const play = document.createElement('button')
    play.className = 'primary'
    play.type = 'button'
    play.textContent = 'Play'
    play.addEventListener('click', () => start('/opfs/games/' + g.name))
    const del = document.createElement('button')
    del.type = 'button'
    del.textContent = 'Remove'
    del.addEventListener('click', async () => {
      if (del.dataset.confirm !== '1') {
        del.dataset.confirm = '1'
        del.textContent = 'Click again to remove'
        return
      }
      const dir = await gamesDir()
      await dir.removeEntry(g.name)
      log('Removed ' + g.name)
      renderGames()
    })
    li.append(name, size, play, del)
    ul.appendChild(li)
  }
}

// Streams the picked file into OPFS with progress, so a 1-2 GB ISO never sits in memory.
async function importGame(file) {
  const safeName = file.name.replace(/[\\/:*?"<>|]/g, '_')
  $('importing').hidden = false
  $('import-label').textContent = 'Copying ' + safeName + ' into browser storage…'
  const bar = $('import-bar')
  bar.value = 0
  try {
    if (navigator.storage.persist) {
      const persisted = await navigator.storage.persist()
      log(persisted ? 'Storage marked persistent.' : 'Storage is best-effort; the browser may evict it when space is low.')
    }
    const dir = await gamesDir()
    const handle = await dir.getFileHandle(safeName, { create: true })
    const writable = await handle.createWritable()
    let done = 0
    const counter = new TransformStream({
      transform(chunk, controller) {
        done += chunk.byteLength
        bar.value = done / file.size
        controller.enqueue(chunk)
      },
    })
    await file.stream().pipeThrough(counter).pipeTo(writable)
    log('Imported ' + safeName + ' (' + formatSize(file.size) + ')')
  } catch (e) {
    log('Import failed: ' + e.message)
  } finally {
    $('importing').hidden = true
    renderGames()
  }
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

async function start(bootPath) {
  if (started) return
  started = true
  createAudio()
  try {
    log('Loading PPSSPP…')
    const Module = await loadRuntime()
    await mountOPFS(Module)
    try { Module.FS.mkdir('/opfs/memstick') } catch (e) { /* already there */ }
    $('launcher').hidden = true
    $('stage').classList.add('on')
    $('canvas').focus()
    const args = ['--memstick=/opfs/memstick']
    if (bootPath) args.push(bootPath)
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

$('pick').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0]
  if (file) importGame(file)
  e.target.value = ''
})
$('menu').addEventListener('click', () => start(null))
$('fs').addEventListener('click', () => {
  const el = $('stage')
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {})
})
$('reload').addEventListener('click', () => location.reload())

const ok = runChecks()
if (!ok) log('Some browser features are missing; PPSSPP may not start.')
if (navigator.storage && navigator.storage.getDirectory) renderGames()
