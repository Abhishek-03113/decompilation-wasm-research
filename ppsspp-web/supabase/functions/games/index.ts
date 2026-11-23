// Supabase Edge Function: the game list for PPSSPP Web, from a private Storage bucket.
//
// The bucket (ppsspp-games) holds a PSP memory stick layout: ISO/, PSP/GAME/, PSP/TEXTURES/ and
// PSP/SYSTEM/<GAMEID>_ppsspp.ini. Files bigger than the plan's upload limit are stored as parts
// (<name>.part000, .part001, ...) and listed here as one file. Players send the games key
// (Authorization: Bearer <key>); they get the same manifest the Bun server serves, with
// short-lived signed download links instead of paths. The key is the GAMES_KEY Edge Function secret
// or, if that isn't set, the one whose SHA-256 is in public.ppsspp_settings ('games_key_sha256'), a
// table with row-level security and no policies, so only this function's service role reads it.
//
// Remote packs: remote/<name>.json in the bucket (not synced) describes files players download
// straight from their official source, e.g. a texture pack on GitHub:
//   { "base": "https://raw.githubusercontent.com/<owner>/<repo>/<commit>/", "dest": "PSP/TEXTURES/<GAMEID>/",
//     "version": "<commit>", "files": [["path/in/repo.ktx2", size], ...] }
// They're listed as files under `dest` with a link to base + path; bucket files under the same
// `dest` are left out so the two never mix.
//
// Deploy with JWT verification off: the function checks the games key itself.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const BUCKET = 'ppsspp-games'
const LINK_SECONDS = 6 * 60 * 60
// Pages allowed to call this from a browser.
const ORIGINS = ['https://ppsspp-web-omega.vercel.app', 'http://localhost:8080']
const SYNCED = [
  { dir: 'ISO', pattern: null },
  { dir: 'PSP/GAME', pattern: null },
  { dir: 'PSP/TEXTURES', pattern: null },
  { dir: 'PSP/SYSTEM', pattern: '^[A-Z0-9]{9}_ppsspp\\.ini$' },
]

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || ''
  if (!ORIGINS.includes(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization',
    'Access-Control-Max-Age': '600',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Vary': 'Origin',
  }
}

function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b)
  if (x.length !== y.length) return false
  let d = 0
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]
  return d === 0
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

let storedHash: { value: string; at: number } | null = null

// true / false, or null when no key is configured at all.
async function keyOk(given: string): Promise<boolean | null> {
  const secret = Deno.env.get('GAMES_KEY') || ''
  if (secret) return sameText(given, secret)
  if (!storedHash || Date.now() - storedHash.at > 60_000) {
    const { data, error } = await sb.from('ppsspp_settings').select('value').eq('name', 'games_key_sha256').maybeSingle()
    if (error) throw error
    storedHash = { value: data?.value ?? '', at: Date.now() }
  }
  if (!storedHash.value) return null
  return sameText(await sha256(given), storedHash.value)
}

interface Obj { path: string; size: number; mtime: number }

async function walk(prefix: string, out: Obj[]) {
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await sb.storage.from(BUCKET).list(prefix, { limit: 1000, offset })
    if (error) throw error
    for (const e of data) {
      const path = prefix ? `${prefix}/${e.name}` : e.name
      if (e.id === null) await walk(path, out)   // a folder
      else out.push({ path, size: e.metadata?.size ?? 0, mtime: Date.parse(e.updated_at ?? e.created_at ?? '') || 0 })
    }
    if (data.length < 1000) break
  }
}

function synced(path: string): boolean {
  return SYNCED.some(({ dir, pattern }) => {
    if (!path.startsWith(dir + '/')) return false
    const rest = path.slice(dir.length + 1)
    return pattern ? !rest.includes('/') && new RegExp(pattern).test(rest) : true
  })
}

interface RemotePack { base: string; dest: string; version: string; files: [string, number][] }
let remoteCache: { packs: RemotePack[]; at: number } | null = null

async function remotePacks(): Promise<RemotePack[]> {
  if (remoteCache && Date.now() - remoteCache.at < 10 * 60_000) return remoteCache.packs
  const { data, error } = await sb.storage.from(BUCKET).list('remote', { limit: 100 })
  if (error) throw error
  const packs: RemotePack[] = []
  for (const e of data) {
    if (!e.name.endsWith('.json')) continue
    const { data: blob, error: err } = await sb.storage.from(BUCKET).download(`remote/${e.name}`)
    if (err) throw err
    const p = JSON.parse(await blob.text()) as RemotePack
    if (p.base?.startsWith('https://') && p.dest?.endsWith('/') && Array.isArray(p.files)) packs.push(p)
  }
  remoteCache = { packs, at: Date.now() }
  return packs
}

async function manifest() {
  const objs: Obj[] = []
  for (const { dir } of SYNCED) await walk(dir, objs)
  const packs = await remotePacks()
  // Join <name>.partNNN into one file with ordered parts.
  const files = new Map<string, { path: string; size: number; mtime: number; parts: Obj[] }>()
  for (const o of objs) {
    const m = /^(.*)\.part(\d{3})$/.exec(o.path)
    const path = m ? m[1] : o.path
    if (!synced(path) || packs.some((p) => path.startsWith(p.dest))) continue
    const f = files.get(path) ?? { path, size: 0, mtime: 0, parts: [] }
    f.parts.push(o)
    f.size += o.size
    f.mtime = Math.max(f.mtime, o.mtime)
    files.set(path, f)
  }
  const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
  const paths = list.flatMap((f) => f.parts.sort((a, b) => a.path.localeCompare(b.path)).map((p) => p.path))
  const signed = new Map<string, string>()
  for (let i = 0; i < paths.length; i += 100) {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(paths.slice(i, i + 100), LINK_SECONDS)
    if (error) throw error
    for (const s of data) if (s.signedUrl && s.path) signed.set(s.path, s.signedUrl)
  }
  const remote = packs.flatMap((p) => {
    const mtime = parseInt(p.version.slice(0, 8), 16) || 1
    return p.files
      .map(([rel, size]) => ({ path: p.dest + rel, size, mtime,
        parts: [{ url: p.base + rel.split('/').map(encodeURIComponent).join('/'), size }] }))
      .filter((f) => synced(f.path))
  })
  return {
    dirs: SYNCED,
    files: [
      ...list.map((f) => ({
        path: f.path, size: f.size, mtime: f.mtime,
        parts: f.parts.map((p) => ({ url: signed.get(p.path), size: p.size })),
      })),
      ...remote,
    ].sort((a, b) => a.path.localeCompare(b.path)),
  }
}

Deno.serve(async (req) => {
  const headers = cors(req)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  const given = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '')?.[1] || ''
  try {
    const ok = await keyOk(given)
    if (ok === null) return new Response('No games key is configured', { status: 503, headers })
    if (!ok) return new Response('This server needs a key', { status: 401, headers })
    return new Response(JSON.stringify(await manifest()), {
      headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  } catch (e) {
    return new Response('Could not list the games: ' + (e as Error).message, { status: 500, headers })
  }
})
