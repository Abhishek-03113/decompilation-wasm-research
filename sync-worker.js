// Downloads one server file into OPFS, in place, with a sync access handle (workers only).
// A writable stream (createWritable) would copy the whole file on every save, which for a ~1 GB
// ISO means gigabytes of copying and a stalled download. Here bytes go straight to their offset and
// flush() makes them durable every 64 MB.
//
// Two modes:
// - One source (a plain file, or a file in a single piece): downloaded in order; a dropped
//   connection resumes with a Range request, and an interrupted download resumes from the
//   file's current size (`offset`).
// - Several pieces (cloud storage with a per-file size limit, e.g. an ISO in 48 MiB parts): up to
//   PARALLEL pieces download at once, each written at its own offset. Finished pieces are reported
//   ({ pieceDone: i }) so the page can record them; `donePieces` skips them on a resume.
//   in:  { parts: ['memstick', 'ISO', 'x.iso'], url, size, offset, headers, pieces, donePieces }
//        pieces: optional [{ url, size }] in order; then `url` is unused and no headers are sent
//   out: { bytes } progress, { pieceDone: i }, then { done: true } or { error }
'use strict'

const FLUSH_EVERY = 64 * 1024 * 1024
const RETRIES = 5
const PARALLEL = 4

// Streams url (from byte `from` of it) into the handle at `at`, counting written bytes in
// cursor.n as it goes, so a retry after a dropped connection continues where this stopped.
async function fetchInto(handle, url, headers, from, at, expect, state, cursor) {
  const res = await fetch(url, { headers: from > 0 ? { ...headers, Range: `bytes=${from}-` } : headers, cache: 'no-store' })
  if (from > 0 && res.status !== 206) throw Object.assign(new Error('range ignored'), { rangeIgnored: true })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (cursor.n + value.byteLength > expect) throw new Error('more data than expected')
    handle.write(value, { at: at + cursor.n })
    cursor.n += value.byteLength
    self.postMessage({ bytes: value.byteLength })
    state.sinceFlush += value.byteLength
    if (state.sinceFlush >= FLUSH_EVERY) { handle.flush(); state.sinceFlush = 0 }
  }
}

async function withRetries(fn, handle) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn() } catch (e) {
      if (attempt + 1 >= RETRIES) throw e
      handle.flush()
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
}

self.onmessage = async ({ data: { parts, url, size, offset, headers = {}, pieces, donePieces = [] } }) => {
  let handle
  try {
    let dir = await navigator.storage.getDirectory()
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true })
    const file = await dir.getFileHandle(parts[parts.length - 1], { create: true })
    handle = await file.createSyncAccessHandle()
    const state = { sinceFlush: 0 }

    if (pieces && pieces.length > 1) {
      // Parallel pieces: give the file its final size, then fill pieces in any order.
      const starts = []
      pieces.reduce((at, p) => { starts.push(at); return at + p.size }, 0)
      if (handle.getSize() !== size) handle.truncate(size)
      const skip = new Set(donePieces)
      const queue = pieces.map((p, i) => i).filter((i) => !skip.has(i))
      const runner = async () => {
        while (queue.length) {
          const i = queue.shift()
          const p = pieces[i]
          let got = 0
          await withRetries(async () => {
            const c = { n: 0 }
            try {
              await fetchInto(handle, p.url, {}, got, starts[i] + got, p.size - got, state, c)
            } catch (e) {
              got = e.rangeIgnored ? 0 : got + c.n
              throw e
            }
            got += c.n
            if (got !== p.size) throw new Error(`piece ${i}: got ${got} of ${p.size} bytes`)
          }, handle)
          handle.flush()
          self.postMessage({ pieceDone: i })
        }
      }
      await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, runner))
    } else {
      // One source, in order, resuming from `offset`.
      const src = pieces && pieces.length === 1 ? { url: pieces[0].url, headers: {} } : { url, headers }
      let pos = Math.min(offset, handle.getSize())
      handle.truncate(pos)
      await withRetries(async () => {
        const c = { n: 0 }
        try {
          await fetchInto(handle, src.url, src.headers, pos, pos, size - pos, state, c)
        } catch (e) {
          if (e.rangeIgnored) { pos = 0; handle.truncate(0) } else pos += c.n
          throw e
        }
        pos += c.n
        if (pos !== size) throw new Error(`got ${pos} of ${size} bytes`)
      }, handle)
    }
    handle.flush()
    self.postMessage({ done: true })
  } catch (e) {
    self.postMessage({ error: `${parts.slice(1).join('/')}: ${e.message}` })
  } finally {
    if (handle) handle.close()
  }
}
