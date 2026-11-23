// Downloads one server file into OPFS, in place, with a sync access handle (workers only).
// A writable stream (createWritable) would copy the whole file on every save, which for a ~1 GB
// ISO means gigabytes of copying and a stalled download. Here bytes go straight to their offset,
// flush() makes them durable every 64 MB, and a dropped connection resumes with a Range request.
// A file stored as parts (cloud storage with a per-file size limit) is joined back together here.
//   in:  { parts: ['memstick', 'ISO', 'x.iso'], url, size, offset, headers, pieces }
//        pieces: optional [{ url, size }] in order; then `url` is unused and no headers are sent
//   out: { bytes } progress messages, then { done: true } or { error }
'use strict'

const FLUSH_EVERY = 64 * 1024 * 1024
const RETRIES = 5

self.onmessage = async ({ data: { parts, url, size, offset, headers = {}, pieces } }) => {
  let handle
  try {
    let dir = await navigator.storage.getDirectory()
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true })
    const file = await dir.getFileHandle(parts[parts.length - 1], { create: true })
    handle = await file.createSyncAccessHandle()
    let pos = Math.min(offset, handle.getSize())
    handle.truncate(pos)
    let sinceFlush = 0

    // Each segment is fetched on its own; `start` is where it begins in the whole file.
    const segments = pieces
      ? pieces.reduce((acc, p) => { acc.push({ url: p.url, size: p.size, start: acc.length ? acc.at(-1).start + acc.at(-1).size : 0, headers: {} }); return acc }, [])
      : [{ url, size, start: 0, headers }]

    for (const seg of segments) {
      const end = seg.start + seg.size
      for (let attempt = 0; pos < end; attempt++) {
        try {
          const from = pos - seg.start
          const h = from > 0 ? { ...seg.headers, Range: `bytes=${from}-` } : seg.headers
          const res = await fetch(seg.url, { headers: h, cache: 'no-store' })
          if (from > 0 && res.status !== 206) { pos = seg.start; handle.truncate(pos) }   // range ignored: redo this segment
          else if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const reader = res.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            handle.write(value, { at: pos })
            pos += value.byteLength
            sinceFlush += value.byteLength
            self.postMessage({ bytes: value.byteLength })
            if (sinceFlush >= FLUSH_EVERY) { handle.flush(); sinceFlush = 0 }
          }
          if (pos !== end) throw new Error(`got ${pos - seg.start} of ${seg.size} bytes`)
        } catch (e) {
          if (attempt + 1 >= RETRIES) throw e
          handle.flush()
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        }
      }
    }
    if (pos !== size) throw new Error(`got ${pos} of ${size} bytes`)
    handle.flush()
    self.postMessage({ done: true })
  } catch (e) {
    self.postMessage({ error: `${parts.slice(1).join('/')}: ${e.message}` })
  } finally {
    if (handle) handle.close()
  }
}
