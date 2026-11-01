import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 文件树剪贴板粘贴上传（P-20261023-2）五用例：
// ① OS 多文件粘贴（paste 事件 clipboardData.files 主通道）→ 逐文件上传链落地；
// ② 树内复制/粘贴（Ctrl+C/Ctrl+V 内部剪贴板）→ batch 端点 copy 形态递归整树，
//    落点无同名（断言 action=copy + 源保留 + 目标内容）；
// ③ 剪切/粘贴 → 既有 move 形态（源消失 + is-cut 弱化态出现）；
// ④ OS 目录拖入（webkitGetAsEntry 桩）→ 相对路径旁挂字段，dest 下按段建目录；
// ⑤ OS 目录粘贴（零类型项目录形态）→ 诚实引导 toast「拖入文件树」。
//
// 事件构造说明（Chromium）：
// - paste 事件用 new ClipboardEvent('paste', {clipboardData: dt}) 合成（目录
//   形态用例经 defineProperty 覆写 clipboardData 传鸭子对象——DataTransfer 构造
//   无法注入零类型 item 的 folderLike 形态）；
// - webkitGetAsEntry 桩经 DataTransferItem.prototype 补丁注入（合成 DataTransfer
//   的 items 是真对象、webkGetAsEntry 恒 null，原型补丁让既有 items 命中桩
//   entry；用例独享 context/page，补丁不跨用例泄漏）。
//
// 探针宿主与其他文件树用例同款：simple-coding 仓库 docs/ 下种子探针目录，
// afterAll 整目录删除收尾。
const PASTE_DEST = 'e2e-paste-dest'
const COPY_SRC = 'e2e-copy-src'
const COPY_INNER = 'inner.txt'
const COPY_INNER_V = 'copy-source-inner-content'
const MOVE_SRC = 'e2e-move-src.md'
const MOVE_SRC_V = 'move-source-content'
const UPLOAD_URL = '**/api/projects/*/file/upload*'
const BATCH_URL = '**/api/projects/*/files/batch'

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

async function unlockToken(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'admin' }),
  })
  return (await res.json()).token || ''
}

async function projectId(name: string): Promise<string> {
  const token = await unlockToken()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers: { 'X-Lock-Token': token } })).json()
  const mine = ((list?.data || []) as { id: string; name: string }[]).find(p => p.name === name)
  if (!mine) throw new Error(`${name} 项目不存在`)
  return mine.id
}

async function apiFile(pid: string, action: 'create' | 'delete' | 'mkdir', path: string, content = 'probe') {
  const token = await unlockToken()
  await fetch(`${API_BASE}/api/projects/${pid}/file/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ path, content }),
  }).catch(() => {})
}

/** API 读回文件正文（ReadFile 的 data 字段）：内容断言不依赖编辑器链 */
async function apiReadFile(pid: string, path: string): Promise<string> {
  const token = await unlockToken()
  const res = await fetch(`${API_BASE}/api/projects/${pid}/file?path=${encodeURIComponent(path)}`, {
    headers: { 'X-Lock-Token': token },
  })
  const j = await res.json()
  return (j?.data ?? '') as string
}

/** API 文件存在性（HTTP status）：move 断言源消失用（404 = 已挪走） */
async function apiFileStatus(pid: string, path: string): Promise<number> {
  const token = await unlockToken()
  const res = await fetch(`${API_BASE}/api/projects/${pid}/file?path=${encodeURIComponent(path)}`, {
    headers: { 'X-Lock-Token': token },
  })
  return res.status
}

async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, 'simple-coding').first()
  await projectCard.click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.getByText('README.md').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="项目文件"]').click()
    await page.waitForTimeout(800)
  }
}

/** 虚拟列表行进 DOM 保证（file-tree-upload-overwrite 同款） */
async function ensureRowVisible(page: Page, name: string) {
  for (let i = 0; i < 25; i++) {
    if (await itemByName(page, name).isVisible().catch(() => false)) return
    await page.locator('.virtual-list-container').evaluate((el, step) => {
      el.scrollTop = step === 0 ? 0 : el.scrollTop + 200
    }, i)
    await page.waitForTimeout(150)
  }
  throw new Error(`tree row ${name} 未进入虚拟窗口`)
}

async function revealDestDir(page: Page) {
  await ensureRowVisible(page, 'docs')
  for (let i = 0; i < 6; i++) {
    const arrow = (await itemByName(page, 'docs').locator('.dir-arrow').textContent().catch(() => '')) || ''
    if (arrow === '▼') break
    await itemByName(page, 'docs').click()
    await page.waitForTimeout(600)
  }
  await ensureRowVisible(page, PASTE_DEST)
}

test.beforeAll(async () => {
  const pid = await projectId('simple-coding')
  // 探针宿主整树重置（上轮残留会让内容/存在性断言翻车）
  await apiFile(pid, 'delete', `docs/${PASTE_DEST}`)
  await apiFile(pid, 'delete', `docs/${COPY_SRC}`)
  await apiFile(pid, 'delete', `docs/${MOVE_SRC}`)
  await apiFile(pid, 'mkdir', `docs/${PASTE_DEST}`)
  await apiFile(pid, 'mkdir', `docs/${COPY_SRC}`)
  await apiFile(pid, 'create', `docs/${COPY_SRC}/${COPY_INNER}`, COPY_INNER_V)
  await apiFile(pid, 'create', `docs/${MOVE_SRC}`, MOVE_SRC_V)
})

test.afterAll(async () => {
  try {
    const pid = await projectId('simple-coding')
    await apiFile(pid, 'delete', `docs/${PASTE_DEST}`)
    await apiFile(pid, 'delete', `docs/${COPY_SRC}`)
    await apiFile(pid, 'delete', `docs/${MOVE_SRC}`)
  } catch { /* 服务未起等场景忽略 */ }
})

test.describe('文件树剪贴板粘贴上传（P-20261023-2）', () => {
  test('① OS 多文件粘贴：clipboardData.files 主通道直入上传链，逐文件落盘', async ({ page }) => {
    await enterProject(page)
    await revealDestDir(page)
    const pid = await projectId('simple-coding')

    // 点击落点目录行（聚焦 = 粘贴落位目录），树容器获得焦点
    await itemByName(page, PASTE_DEST).click()
    await page.locator('.tree-list').focus()

    // 合成 paste 事件携带两个 File（OS 复制多文件的 clipboardData 形态），
    // 派发到落点行冒泡至 .tree-list 的 @paste 监听
    await page.evaluate((el) => {
      const dt = new DataTransfer()
      dt.items.add(new File(['paste-a-content'], 'e2e-paste-a.md', { type: 'text/markdown' }))
      dt.items.add(new File(['paste-b-content'], 'e2e-paste-b.md', { type: 'text/markdown' }))
      el!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, await itemByName(page, PASTE_DEST).elementHandle())

    // 逐文件串行上传完成浮条撤下；两文件落盘
    await expect(page.getByTestId('upload-float')).toBeHidden({ timeout: 15000 })
    await expect.poll(() => apiReadFile(pid, `docs/${PASTE_DEST}/e2e-paste-a.md`), { timeout: 10000 }).toBe('paste-a-content')
    await expect.poll(() => apiReadFile(pid, `docs/${PASTE_DEST}/e2e-paste-b.md`), { timeout: 10000 }).toBe('paste-b-content')
  })

  test('② 树内复制/粘贴：batch copy 递归整树，源保留目标落地', async ({ page }) => {
    await enterProject(page)
    await revealDestDir(page)
    const pid = await projectId('simple-coding')

    const batchBodies: Array<{ action?: string; entries?: string[]; destDir?: string }> = []
    await page.route(BATCH_URL, async (route) => {
      try { batchBodies.push(JSON.parse(route.request().postData() || '{}')) } catch { /* 非 JSON 忽略 */ }
      await route.continue()
    })

    // Ctrl+点击选中源目录 → Ctrl+C 入内部剪贴板
    await ensureRowVisible(page, COPY_SRC)
    await itemByName(page, COPY_SRC).click({ modifiers: ['Control'] })
    await expect(itemByName(page, COPY_SRC)).toHaveClass(/selected/, { timeout: 3000 })
    await page.locator('.tree-list').focus()
    await page.keyboard.press('Control+c')

    // 单击落点目录（清多选 + 聚焦 = 粘贴落位）→ Ctrl+V
    await ensureRowVisible(page, PASTE_DEST)
    await itemByName(page, PASTE_DEST).click()
    await page.locator('.tree-list').focus()
    await page.keyboard.press('Control+v')

    // batch 端点收到 copy 形态；副本内容与源一致，源保留（复制语义）
    await expect.poll(() => batchBodies.some(b => b.action === 'copy' && b.entries?.includes(`docs/${COPY_SRC}`)), { timeout: 10000 }).toBe(true)
    await expect.poll(() => apiReadFile(pid, `docs/${PASTE_DEST}/${COPY_SRC}/${COPY_INNER}`), { timeout: 10000 }).toBe(COPY_INNER_V)
    await expect.poll(() => apiReadFile(pid, `docs/${COPY_SRC}/${COPY_INNER}`), { timeout: 10000 }).toBe(COPY_INNER_V)
    // 执行反馈 toast（batchCopy.done 聚合文案）
    await expect(page.getByText(new RegExp('已复制 1 项到'))).toBeVisible({ timeout: 5000 })
  })

  test('③ 树内剪切/粘贴：走既有 move 形态，源消失 + 剪切弱化态', async ({ page }) => {
    await enterProject(page)
    await revealDestDir(page)
    const pid = await projectId('simple-coding')

    const batchBodies: Array<{ action?: string; entries?: string[]; destDir?: string }> = []
    await page.route(BATCH_URL, async (route) => {
      try { batchBodies.push(JSON.parse(route.request().postData() || '{}')) } catch { /* 非 JSON 忽略 */ }
      await route.continue()
    })

    await ensureRowVisible(page, MOVE_SRC)
    await itemByName(page, MOVE_SRC).click({ modifiers: ['Control'] })
    await page.locator('.tree-list').focus()
    await page.keyboard.press('Control+x')
    // 剪切态弱化显示（is-cut）
    await expect(itemByName(page, MOVE_SRC)).toHaveClass(/is-cut/, { timeout: 3000 })

    await ensureRowVisible(page, PASTE_DEST)
    await itemByName(page, PASTE_DEST).click()
    await page.locator('.tree-list').focus()
    await page.keyboard.press('Control+v')

    // move 形态：源消失、目标落地（剪切板消费后二次粘贴不重复执行）
    await expect.poll(() => batchBodies.some(b => b.action === 'move' && b.entries?.includes(`docs/${MOVE_SRC}`)), { timeout: 10000 }).toBe(true)
    await expect.poll(() => apiReadFile(pid, `docs/${PASTE_DEST}/${MOVE_SRC}`), { timeout: 10000 }).toBe(MOVE_SRC_V)
    await expect.poll(() => apiFileStatus(pid, `docs/${MOVE_SRC}`), { timeout: 10000 }).toBe(404)
  })

  test('④ OS 目录拖入：webkitGetAsEntry 递归展平，dest 下按段建目录', async ({ page }) => {
    await enterProject(page)
    await revealDestDir(page)
    const pid = await projectId('simple-coding')

    // 原型补丁注入桩 entry（合成 DataTransfer 的 items 恒返回 null entry）：
    // dropdir/ 目录含 a.txt 与 sub/b.txt；用例独享 context 不跨用例泄漏
    await page.evaluate(() => {
      const makeFileEntry = (rel: string, type: string, content: string): FileSystemEntry => ({
        isFile: true,
        isDirectory: false,
        name: rel.split('/').pop()!,
        fullPath: `/${rel}`,
        file: (cb: (f: File) => void) => cb(new File([content], rel.split('/').pop()!, { type })),
      } as unknown as FileSystemEntry)
      const dirEntry: FileSystemEntry = {
        isFile: false,
        isDirectory: true,
        name: 'dropdir',
        fullPath: '/dropdir',
        // 本桩直接作为顶层 entries 由 hasDirectoryEntry 收集，不需要 createReader
      } as unknown as FileSystemEntry
      const makeDir = (name: string, children: FileSystemEntry[]): FileSystemEntry => ({
        isFile: false, isDirectory: true, name, fullPath: `/${name}`,
        createReader: () => {
          // readEntries 规范语义：每批 ≤100，取到空批才算遍历完（非空批恒返
          // 会无限循环——前端 walk 循环正是按此设计，2000 护栏此前被本桩触发过）
          let done = false
          return {
            readEntries: (cb: (es: FileSystemEntry[]) => void) => {
              if (done) cb([])
              else {
                done = true
                cb(children)
              }
            },
          } as unknown as FileSystemDirectoryReader
        },
      } as unknown as FileSystemEntry)
      const readerBatches: Record<string, FileSystemEntry[]> = {
        dropdir: [
          makeFileEntry('dropdir/e2e-drop-a.txt', 'text/x-e2e-a', 'drop-a'),
          makeDir('sub', [makeFileEntry('dropdir/sub/e2e-drop-b.txt', 'text/x-e2e-b', 'drop-b')]),
        ],
      }
      ;(dirEntry as unknown as { createReader: () => FileSystemDirectoryReader }).createReader = () => {
        let done = false
        return {
          readEntries: (cb: (es: FileSystemEntry[]) => void) => {
            if (done) cb([])
            else {
              done = true
              cb(readerBatches.dropdir!)
            }
          },
        } as unknown as FileSystemDirectoryReader
      }
      DataTransferItem.prototype.webkitGetAsEntry = function (this: DataTransferItem) {
        return this.type === 'text/x-e2e-dir' ? dirEntry : null
      } as typeof DataTransferItem.prototype.webkitGetAsEntry
    })

    const row = await itemByName(page, PASTE_DEST).elementHandle()
    await page.evaluate(([el]) => {
      const dt = new DataTransfer()
      // 目录本体以零类型 File 声明（资源管理器拖目录的 items 形态），桩经
      // type 命中返回目录 entry
      dt.items.add(new File([], 'dropdir', { type: 'text/x-e2e-dir' }))
      el!.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      el!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    }, [row])

    // 展平相对路径经 paths 旁挂字段落位：dest 下按段建目录
    await expect(page.getByTestId('upload-float')).toBeHidden({ timeout: 15000 })
    await expect.poll(() => apiReadFile(pid, `docs/${PASTE_DEST}/dropdir/e2e-drop-a.txt`), { timeout: 10000 }).toBe('drop-a')
    await expect.poll(() => apiReadFile(pid, `docs/${PASTE_DEST}/dropdir/sub/e2e-drop-b.txt`), { timeout: 10000 }).toBe('drop-b')
  })

  test('⑤ OS 目录粘贴：目录形态项出诚实引导 toast，零上传', async ({ page }) => {
    await enterProject(page)
    await revealDestDir(page)

    let uploadCount = 0
    await page.route(UPLOAD_URL, async (route) => {
      uploadCount++
      await route.continue()
    })

    await itemByName(page, PASTE_DEST).click()
    await page.locator('.tree-list').focus()

    // paste 事件携目录形态载荷（types 含 Files、零类型项、files 空）：
    // DataTransfer 构造无法注入该形态，经 defineProperty 覆写 clipboardData
    await page.evaluate((el) => {
      const fakeDt = {
        files: [],
        types: ['Files'],
        items: [{ kind: 'file', type: '' }],
      }
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(ev, 'clipboardData', { value: fakeDt })
      el.dispatchEvent(ev)
    }, await page.locator('.tree-list').elementHandle())

    await expect(page.getByText('请将文件夹拖入文件树')).toBeVisible({ timeout: 5000 })
    await page.waitForTimeout(800)
    expect(uploadCount).toBe(0)
  })
})
