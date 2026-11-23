// Plays PPSSPP's audio on the browser's audio thread.
//
// PPSSPP's mixer thread (PPSSPPWeb_StartAudio in SDLMain.cpp) writes 16-bit stereo frames into a
// ring in WebAssembly memory. This worklet reads the same memory through a SharedArrayBuffer.
// Ring layout, at `ptr`: uint32 write, uint32 read, uint32 underruns, uint32 frames, then
// frames * 2 int16 samples (left, right, left, right, ...).
class PPSSPPAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.header = null
    this.samples = null
    this.mask = 0
    this.port.onmessage = (e) => {
      const { buffer, ptr } = e.data
      this.header = new Uint32Array(buffer, ptr, 4)
      const frames = this.header[3]
      this.mask = frames - 1
      this.samples = new Int16Array(buffer, ptr + 16, frames * 2)
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    const left = out[0]
    const right = out[1] || out[0]
    const n = left.length
    if (!this.header) {
      left.fill(0)
      right.fill(0)
      return true
    }
    const header = this.header
    const samples = this.samples
    const write = Atomics.load(header, 0)
    let read = Atomics.load(header, 1)
    let available = (write - read) >>> 0
    let missing = 0
    for (let i = 0; i < n; i++) {
      if (available > 0) {
        const slot = (read & this.mask) * 2
        left[i] = samples[slot] / 32768
        right[i] = samples[slot + 1] / 32768
        read = (read + 1) >>> 0
        available--
      } else {
        left[i] = 0
        right[i] = 0
        missing++
      }
    }
    Atomics.store(header, 1, read)
    if (missing) Atomics.add(header, 2, missing)
    return true
  }
}

registerProcessor('ppsspp-audio', PPSSPPAudioProcessor)
