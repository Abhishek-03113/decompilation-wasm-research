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
      'Serve the page with the COOP/COEP headers (npm start does this).'],
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

async function start(bootPath) {
  if (started) return
  started = true
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
