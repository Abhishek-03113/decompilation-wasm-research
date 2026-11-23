// Downloads one server file into OPFS, in place, with a sync access handle (workers only).
// A writable stream (createWritable) would copy the whole file on every save, which for a ~1 GB
// ISO means gigabytes of copying and a stalled download. Here bytes go straight to their offset,
// flush() makes them durable every 64 MB, and a dropped connection resumes with a Range request.
//   in:  { parts: ['memstick', 'ISO', 'x.iso'], url, size, offset, headers }
//   out: { bytes } progress messages, then { done: true } or { error }
'use strict'

const FLUSH_EVERY = 64 * 1024 * 1024
const RETRIES = 5

self.onmessage = async ({ data: { parts, url, size, offset, headers = {} } }) => {
  let handle
  try {
    let dir = await navigator.storage.getDirectory()
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true })
    const file = await dir.getFileHandle(parts[parts.length - 1], { create: true })
    handle = await file.createSyncAccessHandle()
    let pos = Math.min(offset, handle.getSize())
    handle.truncate(pos)
    let sinceFlush = 0
    for (let attempt = 0; pos < size; attempt++) {
      try {
        const res = await fetch(url, { headers: pos > 0 ? { ...headers, Range: `bytes=${pos}-` } : headers, cache: 'no-store' })
        if (pos > 0 && res.status !== 206) { pos = 0; handle.truncate(0) }   // range ignored: start over
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
        if (pos !== size) throw new Error(`got ${pos} of ${size} bytes`)
      } catch (e) {
        if (attempt + 1 >= RETRIES) throw e
        handle.flush()
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
      }
    }
    handle.flush()
    self.postMessage({ done: true })
  } catch (e) {
    self.postMessage({ error: `${url}: ${e.message}` })
  } finally {
    if (handle) handle.close()
  }
}
