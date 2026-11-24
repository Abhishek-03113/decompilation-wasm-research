// Launcher for the PPSSPP WebAssembly build (build/PPSSPPSDL.js).
//
// Games come from the server's memory stick (ISO/ and PSP/GAME/) and are synced into the browser's
// Origin Private File System (OPFS) under memstick/. The WebAssembly side mounts OPFS at /opfs
// before main() runs, so PPSSPP's memory stick is /opfs/memstick: the synced games plus this
// player's own saves and settings. The page shows the games as a library (titles and art read from
// each disc's PARAM.SFO, ICON0 and PIC1); picking one boots it directly, skipping PPSSPP's own menu.
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
    if (!ok) $('check-fails').appendChild(div.cloneNode(true))
    allOk = allOk && ok
  }
  $('check-box').hidden = allOk
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
  showLibrary(manifest)
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

  const games = library.length
  const totalSize = manifest.files.reduce((n, f) => n + f.size, 0)
  if (todo.length) {
    for (const t of todo) {
      const g = byPath.get(t.f.path)
      if (g) {
        g.pending = true
        g.got = t.donePieces.length ? t.donePieces.reduce((n, i) => n + t.f.parts[i].size, 0) : t.offset
      }
    }
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
      bar.firstElementChild.style.width = (total ? done / total * 100 : 100).toFixed(1) + '%'
      for (const g of library) if (g.pending) setPill(g, 'Downloading ' + Math.floor((g.got || 0) / g.file.size * 100) + '%')
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
            (n) => { done += n; const g = byPath.get(t.f.path); if (g) g.got += n; showProgress() },
            (i) => { entry.pieces.push(i); saveState(false) })
        } catch (e) {
          failed = e
          break
        }
        entry.done = true
        delete entry.pieces
        const g = byPath.get(t.f.path)
        if (g) { g.pending = false; setPill(g, 'Downloaded') }
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
    ? `${games} game${games === 1 ? '' : 's'} ready, ${formatSize(totalSize)} in this browser.`
    : 'No games on this server yet.'
  await readLibrary(memstick)
}

// --- Library --------------------------------------------------------------------------------
// One card per game: disc images in ISO/ and homebrew in PSP/GAME/<name>/EBOOT.PBP. Until the
// files are in browser storage a card shows the file name; then its title, game ID and art are
// read from the disc (ISO 9660, or CSO with each block inflated) or from the PBP's header.

const LAST_ITEM = 'ppsspp-last-game'
let library = []
const byPath = new Map()

function gameFiles(manifest) {
  return manifest.files.filter((f) => /^ISO\/[^/]+\.(iso|cso|chd)$/i.test(f.path) || /^PSP\/GAME\/[^/]+\/EBOOT\.PBP$/i.test(f.path))
}

function titleFromPath(path) {
  const parts = path.split('/')
  const name = /EBOOT\.PBP$/i.test(path) ? parts[parts.length - 2] : parts[parts.length - 1].replace(/\.[^.]+$/, '')
  return name.replace(/_+/g, ' ')
}

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function setPill(g, text, ready) {
  g.pill.textContent = text
  g.pill.classList.toggle('ready', !!ready)
}

function showLibrary(manifest) {
  const box = $('games')
  box.textContent = ''
  library = []
  byPath.clear()
  for (const file of gameFiles(manifest)) {
    const g = { file, path: file.path, title: titleFromPath(file.path), ready: false, got: 0 }
    const card = g.card = el('button', 'game')
    card.type = 'button'
    card.setAttribute('aria-disabled', 'true')
    const art = g.art = el('div', 'art')
    art.appendChild(el('span', 'initial', g.title.charAt(0).toUpperCase()))
    const play = el('span', 'play')
    play.innerHTML = '<svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><path d="M2 1.5v11l9-5.5z" fill="#181614"/></svg>'
    art.appendChild(play)
    const meta = el('div', 'meta')
    const row = el('div', 'row')
    g.name = el('b', '', g.title)
    g.pill = el('span', 'pill', 'Checking')
    row.append(g.name, g.pill)
    g.kind = /EBOOT/i.test(file.path) ? 'Homebrew' : file.path.split('.').pop().toUpperCase()
    g.sub = el('small', '', g.kind + ' · ' + formatSize(file.size))
    meta.append(row, g.sub)
    card.append(art, meta)
    card.addEventListener('click', () => { if (g.ready) start(g) })
    box.appendChild(card)
    library.push(g)
    byPath.set(file.path, g)
  }
  $('library-sub').textContent = library.length
    ? `${library.length} game${library.length === 1 ? '' : 's'} on this server.`
    : 'Nothing here yet.'
  if (!library.length) box.appendChild(el('div', 'empty', 'No games on this server yet. Put ISO, CSO or CHD files in its memstick/ISO folder.'))
  box.style.display = library.length ? '' : 'block'
}

// Random access to a disc image. ISO: plain slices. CSO: a block index; each block is raw deflate,
// or stored when the index entry's top bit is set.
async function discReader(file) {
  const raw = async (off, len) => new Uint8Array(await file.slice(off, off + len).arrayBuffer())
  const head = await raw(0, 24)
  if (String.fromCharCode(...head.subarray(0, 4)) !== 'CISO') return { read: raw, blob: async (off, len) => file.slice(off, off + len) }
  const dv = new DataView(head.buffer)
  const total = Number(dv.getBigUint64(8, true)), bs = dv.getUint32(16, true), align = head[21]
  const index = new DataView((await raw(24, (Math.ceil(total / bs) + 1) * 4)).buffer)
  const cache = new Map()
  const block = async (i) => {
    if (cache.has(i)) return cache.get(i)
    const a = index.getUint32(i * 4, true), b = index.getUint32(i * 4 + 4, true)
    const start = (a & 0x7fffffff) * 2 ** align, end = (b & 0x7fffffff) * 2 ** align
    let data = await raw(start, end - start)
    if (!(a & 0x80000000)) {
      const ds = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      data = new Uint8Array(await new Response(ds).arrayBuffer())
    }
    cache.set(i, data)
    return data
  }
  const read = async (off, len) => {
    const out = new Uint8Array(len)
    for (let p = 0; p < len;) {
      const o = (off + p) % bs
      const d = await block(Math.floor((off + p) / bs))
      const n = Math.min(len - p, bs - o)
      out.set(d.subarray(o, o + n), p)
      p += n
    }
    return out
  }
  return { read, blob: async (off, len) => new Blob([await read(off, len)]) }
}

// Finds a file on an ISO 9660 disc by its folder path: [byte offset, size], or null.
async function isoFind(disc, path) {
  const pvd = await disc.read(16 * 2048, 2048)
  if (String.fromCharCode(...pvd.subarray(1, 6)) !== 'CD001') return null
  let dv = new DataView(pvd.buffer)
  let lba = dv.getUint32(156 + 2, true), size = dv.getUint32(156 + 10, true)
  for (const want of path) {
    const dir = await disc.read(lba * 2048, Math.min(size, 1 << 20))
    dv = new DataView(dir.buffer)
    let found = false
    for (let p = 0; p + 33 < dir.length;) {
      const len = dir[p]
      if (!len) { p = (Math.floor(p / 2048) + 1) * 2048; continue }
      const name = String.fromCharCode(...dir.subarray(p + 33, p + 33 + dir[p + 32])).replace(/;\d+$/, '')
      if (name.toUpperCase() === want) {
        lba = dv.getUint32(p + 2, true); size = dv.getUint32(p + 10, true); found = true
        break
      }
      p += len
    }
    if (!found) return null
  }
  return [lba * 2048, size]
}

// PARAM.SFO: a key table and a data table; strings are UTF-8, 0x0404 entries are 32-bit numbers.
function parseSfo(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (b.length < 20 || dv.getUint32(0, true) !== 0x46535000) return {}
  const keys = dv.getUint32(8, true), data = dv.getUint32(12, true), n = dv.getUint32(16, true)
  const str = (o, len) => new TextDecoder().decode(b.subarray(o, o + len)).replace(/\0[\s\S]*$/, '')
  const out = {}
  for (let i = 0; i < n; i++) {
    const e = 20 + i * 16
    const key = str(keys + dv.getUint16(e, true), 64)
    const fmt = dv.getUint16(e + 2, true), len = dv.getUint32(e + 4, true), off = data + dv.getUint32(e + 12, true)
    out[key] = fmt === 0x0404 ? dv.getUint32(off, true) : str(off, len)
  }
  return out
}

async function gameInfo(file, path) {
  if (/EBOOT\.PBP$/i.test(path)) {
    // PBP header: magic, version, then the offsets of PARAM.SFO, ICON0, ICON1, PIC0, PIC1, SND0, PSP, PSAR.
    const h = new DataView(await file.slice(0, 40).arrayBuffer())
    if (h.getUint32(0, true) !== 0x50425000) return {}
    const part = (i) => [h.getUint32(8 + i * 4, true), h.getUint32(12 + i * 4, true) - h.getUint32(8 + i * 4, true)]
    const [so, sl] = part(0), [io, il] = part(1), [po, pl] = part(4)
    const sfo = parseSfo(new Uint8Array(await file.slice(so, so + sl).arrayBuffer()))
    return { sfo, icon: il > 0 ? file.slice(io, io + il) : null, pic: pl > 0 ? file.slice(po, po + pl) : null }
  }
  if (/\.chd$/i.test(path)) return {}
  const disc = await discReader(file)
  const find = (name) => isoFind(disc, ['PSP_GAME', name])
  const sfoAt = await find('PARAM.SFO')
  if (!sfoAt) return {}
  const sfo = parseSfo(await disc.read(...sfoAt))
  const iconAt = await find('ICON0.PNG'), picAt = await find('PIC1.PNG')
  return { sfo, icon: iconAt && await disc.blob(...iconAt), pic: picAt && await disc.blob(...picAt) }
}

async function readLibrary(memstick) {
  for (const g of library) {
    try {
      const parts = g.path.split('/')
      const dir = await dirFor(memstick, parts.slice(0, -1), false)
      const file = await (await dir.getFileHandle(parts[parts.length - 1])).getFile()
      const { sfo = {}, icon, pic } = await gameInfo(file, g.path)
      if (sfo.TITLE) { g.title = sfo.TITLE.trim(); g.name.textContent = g.title }
      if (sfo.DISC_ID) g.sub.textContent = sfo.DISC_ID.replace(/^([A-Z]{4})(\d+)$/, '$1-$2') + ' · ' + formatSize(g.file.size)
      const hasPic = pic && pic.size > 0
      if (hasPic) g.art.style.backgroundImage = `url(${URL.createObjectURL(pic)})`
      if (icon && icon.size > 0) {
        const i = el('span', 'icon' + (hasPic ? '' : ' alone'))
        i.style.backgroundImage = `url(${URL.createObjectURL(icon)})`
        g.art.prepend(i)
      }
      if (hasPic || (icon && icon.size > 0)) g.art.querySelector('.initial')?.remove()
    } catch (e) {
      log('Could not read the title of ' + g.path + ': ' + e.message)
    }
    g.ready = true
    g.card.setAttribute('aria-disabled', 'false')
    g.card.setAttribute('aria-label', 'Play ' + g.title)
    setPill(g, 'Ready', true)
  }
  pickFeatured()
}

// The nav's Play button starts ?boot=<path> when given (tools/boot-game.js), else the last game played.
// ?menu makes it open PPSSPP's own menu with no game, for the tools that test the menu.
let featured = null
function pickFeatured() {
  const q = new URLSearchParams(location.search)
  if (q.has('menu')) {
    featured = { path: '', title: 'PPSSPP menu' }
    $('start').textContent = 'Open PPSSPP menu'
    $('start').disabled = false
    return
  }
  const boot = q.get('boot')
  let last = ''
  try { last = localStorage.getItem(LAST_ITEM) || '' } catch {}
  featured = (boot && (byPath.get(boot) || { path: boot, title: boot })) || byPath.get(last) || library[0] || null
  $('start').textContent = featured ? 'Play ' + featured.title : 'Play'
  $('start').disabled = !featured
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
  // The HUD (Library, Fullscreen, Copy stats) stays out of the way while a game runs. It shows when
  // the mouse moves, and whenever PPSSPP isn't running the game (its pause menu, or after leaving it).
  const stage = $('stage')
  let moved = 0
  window.addEventListener('mousemove', () => { moved = performance.now() })
  const tick = () => {
    const s = readStats(Module)
    box.textContent = formatStats(s)
    if (s.inGame) $('booting').hidden = true
    stage.classList.toggle('chrome', !s.inGame || performance.now() - moved < 2500)
  }
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

async function start(game) {
  if (started || !game) return
  started = true
  if (game.path) try { localStorage.setItem(LAST_ITEM, game.path) } catch {}
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
    // The game goes on the command line, so PPSSPP boots it directly instead of opening its menu.
    const args = ['--memstick=/opfs/memstick']
    $('booting').hidden = !game.path
    if (game.path) {
      if (!/^[\w .()\[\]/-]+$/.test(game.path) || game.path.split('/').includes('..')) throw new Error('Bad game path ' + game.path)
      args.push('/opfs/memstick/' + game.path)
    }
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

$('start').addEventListener('click', () => start(featured))
$('fs').addEventListener('click', () => {
  const el = $('stage')
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {})
})
$('reload').addEventListener('click', () => location.reload())

const ok = runChecks()
if (!ok) log('Some browser features are missing; PPSSPP may not start.')
function sync() {
  $('key-box').hidden = true
  syncGames()
    .then(() => { if (!$('start').disabled) $('start').focus() })
    .catch((e) => {
      if (e instanceof NeedsKey) {
        $('sync-label').textContent = 'Locked.'
        $('key-label').innerHTML = '<strong>This library is private.</strong> '
        $('key-label').append((e.message ? e.message + ' ' : '') + 'Enter the key from its owner.')
        $('key-box').hidden = false
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
