// Boots pspautotests/demos/controller.pbp, holds buttons on a simulated DualShock 4, screenshots
// what the PSP program reports, and checks that the audio worklet keeps consuming samples.
//   bun tools/controller.js <controller.pbp> [outdir]
const { chromium } = require('playwright')
const file = process.argv[2], outDir = process.argv[3] || '.'
const fakePad = () => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }))
  const pad = { id: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)', index: 0, connected: true,
    mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons }
  window.__hold = (list) => { for (let i = 0; i < 17; i++) { const d = list.includes(i); buttons[i] = { pressed: d, touched: d, value: d ? 1 : 0 } } pad.timestamp = performance.now() }
  navigator.getGamepads = () => [pad, null, null, null]
  window.__connectPad = () => { const ev = new Event('gamepadconnected'); Object.defineProperty(ev, 'gamepad', { value: pad }); window.dispatchEvent(ev) }
}
;(async () => {
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 960, height: 544 } })
  await page.addInitScript(fakePad)
  await page.goto('http://localhost:8080/')
  await page.waitForTimeout(800)
  await page.setInputFiles('#pick', file)
  await page.waitForFunction(() => document.querySelector('#games .name'), null, { timeout: 30000 })
  await page.click('#games button.primary')
  await page.waitForTimeout(6000)
  await page.evaluate(() => window.__connectPad())
  await page.waitForTimeout(1000)
  const readPos = () => page.evaluate(() => { const a = window.ppssppAudio; const h = new Uint32Array(Module.HEAPU8.buffer, a.ring, 4); return { write: h[0], read: h[1], silent: h[2], rate: a.ctx.sampleRate, state: a.ctx.state } })
  const a0 = await readPos()
  // Standard mapping: 0 Cross, 1 Circle, 2 Square, 3 Triangle, 4 L1, 5 R1, 8 Share, 9 Options, 12-15 D-pad.
  for (const [name, list] of [['none', []], ['L1+R1', [4, 5]], ['Cross+Triangle', [0, 3]], ['Options+Dpad-up', [9, 12]]]) {
    await page.evaluate((l) => window.__hold(l), list)
    await page.waitForTimeout(700)
    await page.screenshot({ path: `${outDir}/ctrl-${name}.png` })
  }
  const a1 = await readPos()
  const secs = (a1.read - a0.read) / a0.rate
  console.log(`audio: ${a0.state}, read advanced ${a1.read - a0.read} frames (${secs.toFixed(2)} s of audio), silent frames ${a0.silent} -> ${a1.silent}`)
  console.log(await page.textContent('#stats'))
  await browser.close()
})()
