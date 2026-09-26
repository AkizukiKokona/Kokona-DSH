// End-to-end probe for the shell's preload-side features. Serves a fake DSH page from
// 127.0.0.1 (the hostname isDshPage() requires), loads it in a hidden window with the REAL
// built preload, and drives the gestures. Run with `npm run e2e`; the report is written to
// e2e-report.txt in the repo root, because Electron's stdout is not reliable on Windows.
//
// The page deliberately reproduces the core's own CSS for the expanded compaction row, so
// the shell's override can be seen winning rather than assumed to.
const { app, BrowserWindow, ipcMain } = require('electron')
const http = require('node:http')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const lines = []
const actions = []
const report = join(__dirname, '..', 'e2e-report.txt')

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
:root{
  --kokona-surface-glass: rgba(255,255,255,.72);
  --kokona-surface-selected: rgba(0,0,0,.08);
  --we-blur: 16px; --we-saturate: 1.8;
  --dsw-alias-bg-base: #ffffff;
}
body{margin:0;font:14px system-ui}
[data-conversation-scroll]{height:70vh;overflow:auto;padding:8px}
[class*="_compactionRow"]{padding:2px 0}
[class*="_compactionButton"]{display:flex;width:100%;height:28px;border:0;background:transparent}
[class*="_compactionRow"]:has([class*="_compactionBody"]) [class*="_compactionButton"]{position:sticky;top:0;z-index:7;background:var(--dsw-alias-bg-base);border-radius:0}
[data-code-block-banner]{position:sticky;top:28px;background:var(--dsw-alias-bg-base);padding:4px}
</style></head><body>
<div data-conversation-scroll>
  <div class="Sixlwa_compactionRow">
    <button class="Sixlwa_compactionButton"><span>上下文已压缩</span></button>
    <div class="Sixlwa_compactionBody"><div data-code-block-banner>banner</div><p>已压缩 12 条历史记录（约 8000 tokens）</p></div>
  </div>
  <p id="prose">这是一段可以选中的正文文字，用来测试右键菜单。</p>
  <p id="err">Error: cannot modify "D:\\kokonadsh\\src\\shared\\constants.ts": file has not been read — read the file, then retry</p>
  <textarea id="field" rows="3"></textarea>
</div>
</body></html>`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const bail = setTimeout(() => {
  writeFileSync(report, `${lines.join('\n')}\nTIMED OUT`, 'utf8')
  app.exit(1)
}, 40000)

// Dispatched in the page: closes any open menu the way a real click outside would.
const CLOSE_MENU = `(async () => {
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 80))
})()`

async function main() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  // installTitlebar() runs off this, and it is what injects the shell's stylesheet, so the
  // probe has to answer it or none of the shell CSS is in the page at all.
  ipcMain.handle('kokona:get-config', () => ({ titlebar: { theme: 'dark' } }))
  ipcMain.handle('kokona:edit-context', () => [
    { action: 'cut', label: '剪切', accelerator: 'Ctrl+X', enabled: true, separated: false },
    { action: 'copy', label: '复制', accelerator: 'Ctrl+C', enabled: true, separated: false },
    { action: 'paste', label: '粘贴', accelerator: 'Ctrl+V', enabled: false, separated: false },
    { action: 'selectAll', label: '全选', accelerator: 'Ctrl+A', enabled: true, separated: true }
  ])
  ipcMain.on('kokona:edit-action', (_event, action) => actions.push(String(action)))

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      preload: join(__dirname, '..', 'out', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  await win.loadURL(`http://127.0.0.1:${port}/`)
  await sleep(1500)

  // A: the note under the core error, plus the compaction glass.
  const a = await win.webContents.executeJavaScript(`(() => {
    const note = document.querySelector('[data-kokona-fs-note]')
    const btn = document.querySelector('[class*="_compactionButton"]')
    const banner = document.querySelector('[data-code-block-banner]')
    const cs = getComputedStyle(btn)
    return {
      notePresent: note !== null,
      noteLines: note ? note.children.length : 0,
      noteText: note ? note.textContent : '',
      compactionBg: cs.backgroundColor,
      compactionBackdrop: cs.backdropFilter || cs.webkitBackdropFilter,
      bannerBg: banner ? getComputedStyle(banner).backgroundColor : null,
      bannerBackdrop: banner ? (getComputedStyle(banner).backdropFilter || '-') : null
    }
  })()`)
  lines.push('A. 报错下方注释 + 压缩行毛玻璃')
  lines.push(`   note present     : ${a.notePresent}   lines=${a.noteLines}`)
  lines.push(`   note text        : ${a.noteText}`)
  lines.push(`   compaction bg    : ${a.compactionBg}`)
  lines.push(`   compaction blur  : ${a.compactionBackdrop}`)
  lines.push(`   banner bg / blur : ${a.bannerBg} / ${a.bannerBackdrop}`)

  // B: right-click a textarea.
  const b = await win.webContents.executeJavaScript(`(async () => {
    const field = document.getElementById('field')
    field.focus()
    field.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
    await new Promise((r) => setTimeout(r, 300))
    const menu = document.getElementById('kokona-edit-menu')
    return {
      present: menu !== null,
      items: menu ? Array.from(menu.querySelectorAll('.kokona-edit-item')).map((i) => i.textContent + ' [' + i.dataset.enabled + ']') : []
    }
  })()`)
  lines.push('')
  lines.push('B. 右键输入框')
  lines.push(`   menu present     : ${b.present}`)
  lines.push(`   items            : ${b.items.join(' | ')}`)

  // C: right-click a widget -> must stay out of it.
  await win.webContents.executeJavaScript(CLOSE_MENU)
  const c = await win.webContents.executeJavaScript(`(async () => {
    const btn = document.querySelector('[class*="_compactionButton"]')
    btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 30 }))
    await new Promise((r) => setTimeout(r, 300))
    return { present: document.getElementById('kokona-edit-menu') !== null }
  })()`)
  lines.push('')
  lines.push('C. 右键控件（应不接管）')
  lines.push(`   menu present     : ${c.present}   (expected false)`)

  // D: select prose, then right-click it.
  await win.webContents.executeJavaScript(CLOSE_MENU)
  const d = await win.webContents.executeJavaScript(`(async () => {
    const p = document.getElementById('prose')
    const range = document.createRange()
    range.selectNodeContents(p)
    const sel = window.getSelection()
    sel.removeAllRanges(); sel.addRange(range)
    p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 70, clientY: 120 }))
    await new Promise((r) => setTimeout(r, 300))
    const menu = document.getElementById('kokona-edit-menu')
    return {
      present: menu !== null,
      items: menu ? Array.from(menu.querySelectorAll('.kokona-edit-item')).map((i) => i.textContent + ' [' + i.dataset.enabled + ']') : []
    }
  })()`)
  lines.push('')
  lines.push('D. 选中正文后右键')
  lines.push(`   menu present     : ${d.present}`)
  lines.push(`   items            : ${d.items.join(' | ')}`)

  // E: no selection, pointer over text -> the hit-test path.
  await win.webContents.executeJavaScript(CLOSE_MENU)
  const e = await win.webContents.executeJavaScript(`(async () => {
    window.getSelection().removeAllRanges()
    const p = document.getElementById('prose')
    const rect = p.getBoundingClientRect()
    const x = Math.round(rect.left + 12)
    const y = Math.round(rect.top + rect.height / 2)
    p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
    await new Promise((r) => setTimeout(r, 300))
    const menu = document.getElementById('kokona-edit-menu')
    return {
      present: menu !== null,
      hit: document.caretRangeFromPoint ? String(document.caretRangeFromPoint(x, y)?.startContainer?.nodeType) : 'no-api',
      items: menu ? Array.from(menu.querySelectorAll('.kokona-edit-item')).map((i) => i.textContent + ' [' + i.dataset.enabled + ']') : []
    }
  })()`)
  lines.push('')
  lines.push('E. 无选区、指针压在文字上（命中测试路径）')
  lines.push(`   menu present     : ${e.present}`)
  lines.push(`   caret nodeType   : ${e.hit}   (3 = text node)`)
  lines.push(`   items            : ${e.items.join(' | ')}`)

  // F: clicking an item must reach the main process.
  await win.webContents.executeJavaScript(CLOSE_MENU)
  const f = await win.webContents.executeJavaScript(`(async () => {
    const field = document.getElementById('field')
    field.focus()
    field.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
    await new Promise((r) => setTimeout(r, 300))
    const item = document.querySelector('.kokona-edit-item[data-enabled="true"]')
    const label = item ? item.textContent : '(none)'
    if (item) item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    if (item) item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 200))
    return { label, menuGone: document.getElementById('kokona-edit-menu') === null, focused: document.activeElement ? document.activeElement.id : '-' }
  })()`)
  lines.push('')
  lines.push('F. 点击菜单项')
  lines.push(`   clicked          : ${f.label}`)
  lines.push(`   menu closed      : ${f.menuGone}`)
  lines.push(`   focus kept on    : #${f.focused}   (must stay #field, or the action lands nowhere)`)

  lines.push('')
  lines.push(`actions received by main: ${JSON.stringify(actions)}`)

  server.close()
  writeFileSync(report, lines.join('\n'), 'utf8')
  clearTimeout(bail)
  app.exit(0)
}

app.whenReady().then(() =>
  main().catch((error) => {
    lines.push(`PROBE ERROR: ${error && error.stack ? error.stack : String(error)}`)
    writeFileSync(report, lines.join('\n'), 'utf8')
    clearTimeout(bail)
    app.exit(1)
  })
)
