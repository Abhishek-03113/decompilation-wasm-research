// Serves the PPSSPP WebAssembly build and the games, with Bun.
//
// Games live on the server, in a PSP memory stick layout (MEMSTICK_DIR, default ./memstick):
//   memstick/ISO/       disc images (.iso, .cso, .chd): PPSSPP's Games tab
//   memstick/PSP/GAME/  homebrew: PPSSPP's Homebrew & Demos tab
//   memstick/PSP/TEXTURES/<GAMEID>/  texture replacement packs (HD textures)
//   memstick/PSP/SYSTEM/<GAMEID>_ppsspp.ini  per-game settings (graphics etc.) for every player
// The page syncs these into the browser's private storage and boots straight into PPSSPP's game
// list. Players can't add their own files. Saves and global settings stay in each player's browser.
//
// PPSSPP runs on several threads, which in a browser needs SharedArrayBuffer, which browsers only
// allow on cross-origin isolated pages: every response carries COOP and COEP headers. Browsers
// also require a secure context: http://localhost works, anything else needs HTTPS.
//
//   bun run server.ts      ->  http://localhost:8080

import { readdir, stat } from 'node:fs/promises'
import { join, normalize, relative, sep } from 'node:path'

const port = Number(process.env.PORT) || 8080
const publicDir = join(import.meta.dir, 'public')
const memstickDir = normalize(process.env.MEMSTICK_DIR || join(import.meta.dir, 'memstick'))

// Only these memory stick folders go to players. Saves, global settings and the rest stay per
// player. A folder with a pattern syncs only the files directly in it whose names match.
interface SyncedDir { dir: string; pattern?: RegExp }
const SYNCED: SyncedDir[] = [
  { dir: 'ISO' },
  { dir: 'PSP/GAME' },
  { dir: 'PSP/TEXTURES' },
  { dir: 'PSP/SYSTEM', pattern: /^[A-Z0-9]{9}_ppsspp\.ini$/ },   // e.g. ULUS10466_ppsspp.ini
]

// Whether a memory stick path (with / separators) is one players may download.
function isSynced(rel: string): boolean {
  return SYNCED.some(({ dir, pattern }) => {
    if (!rel.startsWith(dir + '/')) return false
    const rest = rel.slice(dir.length + 1)
    return pattern ? !rest.includes('/') && pattern.test(rest) : true
  })
}

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

const contentTypes: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

function contentType(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? contentTypes[path.slice(dot)] : undefined
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: isolationHeaders })
}

// Resolves `rel` inside `root`, or returns null if it would escape it.
function inside(root: string, rel: string): string | null {
  const full = normalize(join(root, rel))
  return full === root || full.startsWith(root + sep) ? full : null
}

interface ManifestFile { path: string; size: number; mtime: number }

async function walk(dir: string, out: ManifestFile[], pattern?: RegExp) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return  // folder missing: nothing to sync from it
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (!pattern) await walk(full, out)
    } else if (e.isFile() && (!pattern || pattern.test(e.name))) {
      const st = await stat(full)
      out.push({ path: relative(memstickDir, full).split(sep).join('/'), size: st.size, mtime: Math.floor(st.mtimeMs) })
    }
  }
}

async function manifest(): Promise<Response> {
  const files: ManifestFile[] = []
  for (const { dir, pattern } of SYNCED) await walk(join(memstickDir, ...dir.split('/')), files, pattern)
  files.sort((a, b) => a.path.localeCompare(b.path))
  const dirs = SYNCED.map(({ dir, pattern }) => ({ dir, pattern: pattern ? pattern.source : null }))
  return new Response(JSON.stringify({ dirs, files }), {
    headers: { ...isolationHeaders, 'Content-Type': contentTypes['.json'], 'Cache-Control': 'no-store' },
  })
}

// Serves a file, honouring a single "Range: bytes=a-b" so interrupted downloads can resume.
function serveFile(req: Request, filePath: string, cacheControl: string): Response {
  const file = Bun.file(filePath)
  const headers: Record<string, string> = { ...isolationHeaders, 'Cache-Control': cacheControl, 'Accept-Ranges': 'bytes' }
  const type = contentType(filePath)
  if (type) headers['Content-Type'] = type
  // With no-cache the browser asks before reusing its copy; the ETag makes that a cheap 304.
  const etag = `"${file.size.toString(36)}-${Math.floor(file.lastModified).toString(36)}"`
  headers['ETag'] = etag
  if (req.headers.get('if-none-match') === etag && !req.headers.get('range')) {
    return new Response(null, { status: 304, headers })
  }

  const range = req.headers.get('range')
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (m && (m[1] || m[2])) {
    const size = file.size
    let start = m[1] ? Number(m[1]) : size - Number(m[2])
    let end = m[1] && m[2] ? Number(m[2]) : size - 1
    if (start < 0) start = 0
    if (end >= size) end = size - 1
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    return new Response(file.slice(start, end + 1), { status: 206, headers })
  }
  return new Response(file, { headers })
}

const server = Bun.serve({
  port,
  // Bun drops a connection after 10 s without traffic by default; a browser busy writing a big
  // game file to disk can pause reading for longer than that.
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)
    const pathname = decodeURIComponent(url.pathname)

    if (pathname === '/memstick/manifest.json') return manifest()

    if (pathname.startsWith('/memstick/')) {
      const rel = pathname.slice('/memstick/'.length)
      // Only files in the synced folders are served; nothing else on the memory stick is public.
      const filePath = inside(memstickDir, rel)
      if (!filePath) return textResponse(403, 'Forbidden')
      // Check the resolved path, so "PSP/GAME/..%2FSAVEDATA/..." can't step out of a synced folder.
      if (!isSynced(relative(memstickDir, filePath).split(sep).join('/'))) return textResponse(404, 'Not found')
      if (!(await Bun.file(filePath).exists())) return textResponse(404, 'Not found')
      return serveFile(req, filePath, 'no-cache')
    }

    const rel = pathname.endsWith('/') ? pathname + 'index.html' : pathname
    const filePath = inside(publicDir, rel)
    if (!filePath) return textResponse(403, 'Forbidden')
    if (!(await Bun.file(filePath).exists())) return textResponse(404, 'Not found')
    // Always revalidate: PPSSPPSDL.js and PPSSPPSDL.wasm must come from the same build. A .wasm
    // cached from an earlier build next to a new .js fails with "ASM_CONSTS[...] is not a function".
    return serveFile(req, filePath, 'no-cache')
  },
})

console.log(`PPSSPP web runtime: http://localhost:${server.port}`)
console.log(`Games from ${memstickDir} (${SYNCED.map((d) => d.dir + (d.pattern ? '/' + d.pattern.source : '')).join(', ')})`)
