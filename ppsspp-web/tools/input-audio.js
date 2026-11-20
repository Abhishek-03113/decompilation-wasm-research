// Checks audio, a (simulated) DualShock 4 and the stats overlay in headless Chromium.
//   bun tools/input-audio.js [outdir]      (server must be running on :8080)
const { chromium } = require('playwright')
const outDir = process.argv[2] || '.'

// A DualShock 4 as Chrome reports it: "standard" mapping, 17 buttons, 4 axes.
const fakePad = () => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }))
  const pad = {
    id: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)',
    index: 0, connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0], buttons, vibrationActuator: null,
  }
  window.__pad = pad
  window.__press = (i, down) => {
    buttons[i] = { pressed: down, touched: down, value: down ? 1 : 0 }
    pad.timestamp = performance.now()
  }
  navigator.getGamepads = () => [pad, null, null, null]
  window.__connectPad = () => {
    const ev = new Event('gamepadconnected')
    Object.defineProperty(ev, 'gamepad', { value: pad })
    window.dispatchEvent(ev)
  }
}

;(async () => {
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] })
  const page = await browser.newPage({ viewport: { width: 960, height: 544 } })
  const lines = []
  page.on('console', (m) => lines.push(m.text()))
  await page.addInitScript(fakePad)
  await page.goto('http://localhost:8080/')
  await page.waitForTimeout(800)
  await page.waitForFunction(() => !document.querySelector('#start').disabled, null, { timeout: 60000 })
  await page.click('#start')
  await page.waitForTimeout(8000)

  // Audio: the mixer should keep the ring ~50 ms ahead, and the worklet should keep draining it.
  const audioState = async () => page.evaluate(() => {
    const t = document.querySelector('#stats').textContent
    const m = t.match(/Audio: (\d+) ms buffered · (\d+) silent/)
    return m ? { ms: +m[1], silent: +m[2], ctx: document.querySelector('#log').textContent.match(/Audio: .*/)?.[0] } : null
  })
  console.log('audio t0:', JSON.stringify(await audioState()))
  await page.waitForTimeout(3000)
  console.log('audio t3:', JSON.stringify(await audioState()))

  // Gamepad: connect, then press D-pad down twice and Cross, screenshotting the menu.
  await page.evaluate(() => window.__connectPad())
  await page.waitForTimeout(1000)
  await page.screenshot({ path: `${outDir}/pad-0.png` })
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => window.__press(13, true))   // standard mapping: 13 = D-pad down
    await page.waitForTimeout(150)
    await page.evaluate(() => window.__press(13, false))
    await page.waitForTimeout(350)
  }
  await page.screenshot({ path: `${outDir}/pad-1.png` })
  console.log('stats overlay:\n' + await page.textContent('#stats'))
  console.log(lines.filter((l) => /[Gg]amepad|[Jj]oystick|Web audio|controller/.test(l) && !/CreateDir/.test(l)).slice(-12).join('\n'))
  await browser.close()
})()
