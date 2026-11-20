// Pause every worker after PPSSPP stalls and print the top of each call stack.
const { chromium } = require('playwright')
;(async () => {
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] })
  const page = await browser.newPage()
  await page.goto('http://localhost:8080/')
  await page.waitForTimeout(800)
  await page.click('#menu')
  await page.waitForTimeout(12000)
  const browserSession = await browser.newBrowserCDPSession()
  const { targetInfos } = await browserSession.send('Target.getTargets')
  const workers = targetInfos.filter(t => t.type === 'worker')
  console.log('workers:', workers.length)
  for (const w of workers) {
    const { sessionId } = await browserSession.send('Target.attachToTarget', { targetId: w.targetId, flatten: false })
    const send = (method, params = {}) => browserSession.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: Math.floor(Math.random()*1e9), method, params }) })
    const frames = await new Promise(async (resolve) => {
      const onMsg = (ev) => {
        if (ev.sessionId !== sessionId) return
        const m = JSON.parse(ev.message)
        if (m.method === 'Debugger.paused') { browserSession.off('Target.receivedMessageFromTarget', onMsg); resolve(m.params.callFrames) }
      }
      browserSession.on('Target.receivedMessageFromTarget', onMsg)
      await send('Debugger.enable')
      await send('Debugger.pause')
      setTimeout(() => resolve(null), 3000)
    })
    console.log('--- worker', w.targetId.slice(0, 6), frames ? '' : '(did not pause)')
    if (frames) console.log(frames.slice(0, 14).map(f => '  ' + f.functionName).join('\n'))
    await send('Debugger.resume').catch(() => {})
  }
  await browser.close()
})()
