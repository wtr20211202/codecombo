import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 分享 docx 嵌入对象原始文件名还原 + 可预览类型直览 E2E（P-20261118-1，
 * P-20261118-3 预览器壳页+正文抽取+编码规范化改版）：
 *   ① 嵌入块渲染面：原始文件名（GBK 名经 GB18030 还原的 CFB 嵌入 + package
 *      直存条目名）、单行双动作「预览|下载」（html/htm 预览=新标签壳页 &ui=1，
 *      其余 preview=1）；文档阅读列零 iframe（页内展开形态退役——用户实测
 *      「文档内嵌 iframe 撑乱阅读列」主诉的回归锚）
 *   ② preview=1 直连响应头：逐 kind 分型（text/html·text/plain·image/png）+
 *      CSP sandbox + XFO SAMEORIGIN 覆写；名-only CFB 容器被容器魔数守卫
 *      拦回 attachment（P-3 断言反转：旧「CFB→text/html」固化的恰是乱码
 *      坏行为）；完整布局 CFB（正文在场）供给抽取出的 html 正文；白名单外
 *      （svg/zip/伪装图字节）preview 参数忽略回归 attachment
 *   ③ scripts×forms×popups 全 2^3 组合表驱动（复审建议②：防只测前端可达
 *      3 态漏 forms=1 无 scripts=1 等）+ 硬红线：任何组合响应 CSP 恒不含
 *      allow-same-origin / allow-top-navigation
 *   ④ md 渲染：bluemonday 净化生效（script 剥除/结构保留/壳 title=还原名）
 *   ⑤ 新标签预览器壳页（P-20261118-3，页内 iframe 形态退役）：ui=1 服务端
 *      壳页（标题=还原名+注记条常驻风险提示+全幅 iframe）——scripts 风险
 *      确认 checkbox+应用按钮两段式 form GET（零 JS 确认形态钉死，评审
 *      必改⑤）→ 二级「允许表单与弹窗」（forms=1&popups=1 联动）→ 手动关回
 *      → 停脚本回静态；iframe attr 恒不含硬红线 token；原型 JS 交互在
 *      隔离沙箱内生效
 *   ⑥ 真实取证布局 CFB + 壳页诚实回落（P-20261118-7）：0x36 长度前缀+
 *      控制字段形态（旧刚性解析全灭 → 点预览弹下载框的用户实测主诉本尊）
 *      preview 供给抽取正文；正文抽不出时 ui=1 渲染「暂不支持自动预览」
 *      诚实提示页（标题+下载出口+零 iframe）而非静默下载，诊断枚举码
 *      （anchor-miss 等）走 X-Embed-Extract-Diag 响应头粗粒度面
 * 访客面打在分享子服务（主端口 +2，经 /api/share/status 动态获取）。
 * GBK 名还原/正文抽取的字节级断言在 Go 单测（office_test/service_test）
 * 钉死，本 spec 复用其形态构造 CFB 夹具做端到端证据。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ = 'simple-coding'
const DIR = 'e2e-docx-embed'
const DOCX = `${DIR}/spec.docx`

// 「根据IP关联组织.html」的 GBK 字节（任务书字节级取证样本）
const GBK_NAME_HEX = 'b8f9bedd4950b9d8c1aad7e9d6af2e68746d6c'
const GBK_NAME = '根据IP关联组织.html'

const PROTO_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"></head><body>',
  '<button id="go" onclick="document.getElementById(\'out\').textContent=\'clicked\'">run</button>',
  '<div id="out">idle</div>',
  '</body></html>',
].join('\n')
const NOTES_MD = '# 根据IP关联组织\n\n- item one\n\n<script>alert(1)</script>[x](https://example.com)\n'
const NOTES_TXT = 'plain text notes\n'

/** 最小 CFB 复合文档（512B 规格 mini 链，与 Go office_test buildCFB 同构）：
 *  header + FAT + 目录 + mini-stream + miniFAT 五扇区，Ole10Native 流头带
 *  GBK 原始文件名。流头用真实 Word 有标志布局（4B 总长 + 2B 标志 0x0002 +
 *  ASCIZ 名，P-20261118-2 实证形态——旧无标志夹具曾令本 spec 的端到端
 *  证据停在合成形态，真实产物恒 .bin）。body 缺省 = 名-only 流（P-20261118-3
 *  容器守卫轨：正文抽不出 → attachment）；body 给定 = 完整布局（源/临时
 *  路径 + 4B 数据长度 + 正文，正文抽取轨：preview 供给抽取出的 html）。
 *  realLayout=true（P-20261118-7）：body 给定时按 2026-11-18 字节级取证
 *  形态构造——源路径后还有 空 ASCIZ + [03 00] + u32 临时路径长度前缀
 *  （含结尾 NUL，取证 0x36=54）+ 临时路径 ASCIZ，旧刚性「恰 2 个 ASCIZ」
 *  解析在此把「03 00 36 00」误读 0x00360003≈3.4MB 越界拒 → 点预览弹下载框
 *  （用户实测主诉本尊形态） */
const TMP_PATH_HEX = '433a5c55736572735c61646d696e5c417070446174615c4c6f63616c5c54656d705c' // C:\Users\admin\AppData\Local\Temp\

function buildOleCfb(nameHex: string, body?: string, realLayout = false): Buffer {
  const sect = 512
  const name = Buffer.from(nameHex, 'hex')
  let payload: Buffer
  if (body === undefined) {
    const junk = 16
    payload = Buffer.alloc(4 + 2 + name.length + 1 + junk)
    payload.writeUInt32LE(2 + name.length + 1 + junk, 0)
    payload.writeUInt16LE(0x0002, 4) // 真实 Word 写入器标志字段
    name.copy(payload, 6)
    payload[6 + name.length] = 0
  } else if (realLayout) {
    // 真实 Word 取证布局：名 + 源路径 + 空 ASCIZ + [03 00] + 0x36 长度
    // 前缀 + GBK 临时路径（前缀=临时路径字节+NUL，取证自洽口径）
    const srcPath = Buffer.from('D:\\xls\\', 'utf8')
    const tmpPath = Buffer.concat([Buffer.from(TMP_PATH_HEX, 'hex'), name])
    const bodyBuf = Buffer.from(body, 'utf8')
    payload = Buffer.alloc(4 + 2 + name.length + 1 + srcPath.length + 1 + 1 + 2 + 4 + tmpPath.length + 1 + 4 + bodyBuf.length)
    payload.writeUInt32LE(2 + name.length + 1 + srcPath.length + 1 + 1 + 2 + 4 + tmpPath.length + 1 + 4 + bodyBuf.length, 0)
    payload.writeUInt16LE(0x0002, 4)
    name.copy(payload, 6)
    let off = 6 + name.length
    payload[off++] = 0
    srcPath.copy(payload, off); off += srcPath.length
    payload[off++] = 0
    payload[off++] = 0            // 空 ASCIZ（取证控制字段）
    payload[off++] = 0x03; payload[off++] = 0x00 // [03 00]（取证控制字段）
    payload.writeUInt32LE(tmpPath.length + 1, off); off += 4 // 0x36 长度前缀
    tmpPath.copy(payload, off); off += tmpPath.length
    payload[off++] = 0
    payload.writeUInt32LE(bodyBuf.length, off); off += 4
    bodyBuf.copy(payload, off)
  } else {
    const srcPath = Buffer.from('D:/xls/', 'utf8')
    const tmpPath = Buffer.from('C:/tmp/x/', 'utf8')
    const bodyBuf = Buffer.from(body, 'utf8')
    payload = Buffer.alloc(4 + 2 + name.length + 1 + srcPath.length + 1 + tmpPath.length + 1 + 4 + bodyBuf.length)
    payload.writeUInt32LE(2 + name.length + 1 + srcPath.length + 1 + tmpPath.length + 1 + 4 + bodyBuf.length, 0)
    payload.writeUInt16LE(0x0002, 4)
    name.copy(payload, 6)
    let off = 6 + name.length
    payload[off++] = 0
    srcPath.copy(payload, off); off += srcPath.length
    payload[off++] = 0
    tmpPath.copy(payload, off); off += tmpPath.length
    payload[off++] = 0
    payload.writeUInt32LE(bodyBuf.length, off); off += 4
    bodyBuf.copy(payload, off)
  }
  const k = Math.ceil(payload.length / 64)

  const buf = Buffer.alloc(sect * 5)
  buf.set(Buffer.from('d0cf11e0a1b11ae1', 'hex'), 0)
  buf.writeUInt16LE(9, 30) // 512B 扇区规格
  buf.writeUInt16LE(6, 32) // 64B 迷你扇区
  buf.writeUInt32LE(1, 44) // FAT 扇区数
  buf.writeUInt32LE(1, 48) // 首目录扇区
  buf.writeUInt32LE(4096, 56) // mini 截断
  buf.writeUInt32LE(3, 60) // 首 miniFAT 扇区
  buf.writeUInt32LE(1, 64)
  buf.writeUInt32LE(0xfffffffe, 68) // DIFAT 链终结
  buf.writeUInt32LE(0, 76) // DIFAT[0] = FAT 在扇区 0
  // DIFAT[1..108] 必须显式填 free（0xFFFFFFFF）：读取侧把非 free 的 DIFAT
  // 项都当 FAT 扇区引用，零值会被读成 109 个 0 号扇区引用 → 「FAT 扇区数
  // 超过文件物理扇区数」结构撒谎拒绝（对齐 Go office_test buildCFB 的
  // free 填充纪律）
  for (let i = 1; i < 109; i++) buf.writeUInt32LE(0xffffffff, 76 + 4 * i)
  // FAT（扇区 0）：0=FAT、1=目录、2=mini 容器、3=miniFAT，各自收尾
  const fat = [0xfffffffd, 0xfffffffe, 0xfffffffe, 0xfffffffe]
  for (let i = 0; i < 128; i++) buf.writeUInt32LE(fat[i] ?? 0xffffffff, 512 + 4 * i)
  // 目录（扇区 1）：Root Entry（承载 mini-stream）+ Ole10Native 流项
  const putDir = (off: number, nm: string, typ: number, start: number, size: number) => {
    for (let i = 0; i < nm.length; i++) buf.writeUInt16LE(nm.charCodeAt(i), off + 2 * i)
    buf.writeUInt16LE(0, off + 2 * nm.length)
    buf.writeUInt16LE((nm.length + 1) * 2, off + 64)
    buf[off + 66] = typ
    buf.writeUInt32LE(start, off + 116)
    buf.writeBigUInt64LE(BigInt(size), off + 120)
  }
  putDir(1024, 'Root Entry', 5, 2, k * 64)
  putDir(1024 + 128, '\x01Ole10Native', 2, 0, payload.length)
  payload.copy(buf, 1536) // mini-stream（扇区 2）
  for (let i = 0; i < 128; i++) {
    const v = i < k - 1 ? i + 1 : i === k - 1 ? 0xfffffffe : 0xffffffff
    buf.writeUInt32LE(v, 2048 + 4 * i)
  }
  return buf
}

/** store 模式（零压缩）最小 zip——docx 只被服务端按 zip 结构解，无需 deflate */
function crc32(data: Buffer): number {
  let table = crcTable
  if (!table) {
    table = crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
let crcTable: Uint32Array | null = null

function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const crc = crc32(e.data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(e.data.length, 18)
    lh.writeUInt32LE(e.data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    chunks.push(lh, name, e.data)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(e.data.length, 20)
    cd.writeUInt32LE(e.data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)
    offset += lh.length + name.length + e.data.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cdBuf, eocd])
}

const objectXML = (id: string) =>
  `<w:p><w:r><w:object><o:OLEObject xmlns:o="urn:schemas-microsoft-com:office:office" Type="Embed" ProgID="Package" r:id="${id}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></w:object></w:r></w:p>`

function buildDocx(): Buffer {
  const rel = (id: string, target: string) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="${target}"/>`
  const doc = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    objectXML('rOle') + objectXML('rOleFull') + objectXML('rOleReal') + objectXML('rHtml') + objectXML('rMd') + objectXML('rTxt') +
    objectXML('rPng') + objectXML('rFake') + objectXML('rSvg') + objectXML('rZip') +
    `</w:body></w:document>`
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    rel('rOle', 'embeddings/oleObject2.bin') + rel('rOleFull', 'embeddings/oleObject3.bin') +
    rel('rOleReal', 'embeddings/oleObject4.bin') +
    rel('rHtml', 'embeddings/proto.html') +
    rel('rMd', 'embeddings/notes.md') + rel('rTxt', 'embeddings/notes.txt') +
    rel('rPng', 'embeddings/photo.png') + rel('rFake', 'embeddings/fake.png') +
    rel('rSvg', 'embeddings/proto.svg') + rel('rZip', 'embeddings/bundle.zip') +
    `</Relationships>`
  return buildZip([
    { name: 'word/document.xml', data: Buffer.from(doc) },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(rels) },
    // 名-only CFB（容器守卫轨）、假设完整布局 CFB（正文抽取轨）与真实取证
    // 布局 CFB（P-20261118-7 主刀轨：0x36 长度前缀+控制字段，旧解析全灭）
    { name: 'word/embeddings/oleObject2.bin', data: buildOleCfb(GBK_NAME_HEX) },
    { name: 'word/embeddings/oleObject3.bin', data: buildOleCfb(GBK_NAME_HEX, PROTO_HTML) },
    { name: 'word/embeddings/oleObject4.bin', data: buildOleCfb(GBK_NAME_HEX, PROTO_HTML, true) },
    { name: 'word/embeddings/proto.html', data: Buffer.from(PROTO_HTML) },
    { name: 'word/embeddings/notes.md', data: Buffer.from(NOTES_MD) },
    { name: 'word/embeddings/notes.txt', data: Buffer.from(NOTES_TXT) },
    { name: 'word/embeddings/photo.png', data: Buffer.from('89504e470d0a1a0a', 'hex') },
    { name: 'word/embeddings/fake.png', data: Buffer.from('<script>alert(1)</script>') },
    { name: 'word/embeddings/proto.svg', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') },
    { name: 'word/embeddings/bundle.zip', data: Buffer.from('PK\x03\x04 zipped') },
  ])
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function getProjectId(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const projects = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = projects.find(x => x.name === PROJ)
  if (!p) throw new Error(`project ${PROJ} not found`)
  return p.id
}

async function getShareBase(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${BASE}/api/share/status`)
  const status = ((await res.json()) as { data?: { running: boolean; port: number; scheme: string } }).data
  if (!status?.running) throw new Error('share service not running')
  return `${status.scheme || 'http'}://localhost:${status.port}`
}

let headers: Record<string, string>
let projectId = ''
let shareBase = ''
let dirToken = ''

test.beforeAll(async ({ request }) => {
  headers = await unlockHeaders(request)
  projectId = await getProjectId(request, headers)
  shareBase = await getShareBase(request)
  const list = ((await (await request.get(`${BASE}/api/share`, { headers })).json()) as {
    data?: { token: string; projectId: string; path: string }[]
  }).data || []
  for (const s of list) {
    if (s.projectId === projectId && s.path === DIR) {
      await request.delete(`${BASE}/api/share/${s.token}`, { headers })
    }
  }
  // 夹具 docx 上传（先删后建幂等）
  await request.post(`${BASE}/api/projects/${projectId}/file/delete`, {
    headers, data: { path: DOCX },
  })
  const up = await request.post(`${BASE}/api/projects/${projectId}/file/upload?dest=${DIR}`, {
    headers: { 'X-Lock-Token': headers['X-Lock-Token'] },
    multipart: { files: { name: 'spec.docx', mimeType: 'application/octet-stream', buffer: buildDocx() } },
  })
  expect(up.ok()).toBeTruthy()
  const created = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: DIR } })
  expect(created.ok()).toBeTruthy()
  dirToken = ((await created.json()) as { data?: { token: string } }).data!.token
})

test.afterAll(async ({ request }) => {
  if (dirToken) await request.delete(`${BASE}/api/share/${dirToken}`, { headers })
  await request.post(`${BASE}/api/projects/${projectId}/file/delete`, {
    headers, data: { path: DOCX },
  })
})

/** 分享根内条目取数 URL（path= 相对分享根） */
function embedURL(entry: string, query = ''): string {
  return `${shareBase}/s/${dirToken}/docx-embed?path=spec.docx&e=${encodeURIComponent(entry)}${query}`
}

test('渲染面：单行双动作链接（html 档预览=壳页 ui=1），文档列零 iframe', async ({ page }) => {
  await page.goto(`${shareBase}/s/${dirToken}`)
  const row = page.locator('.list tbody tr').filter({ hasText: 'spec.docx' })
  await expect(row).toBeVisible()
  await row.click()

  // docx 渲染面注入：可预览嵌入块全部单行 span 双动作（P-20261118-3——
  // 页内 iframe 形态退役，文档阅读列恢复干净）。html 档四块（GBK 还原名
  // ext=html 的 CFB 嵌入×3 + proto.html 直存条目）预览动作指向壳页 &ui=1，
  // 名字还原正是白名单准入的前置（条目名 .bin 不进白名单）
  const art = page.locator('.md-article')
  await expect(art).toBeVisible()
  const uiLinks = art.locator('span.doc-embed a[href*="ui=1"]')
  await expect(uiLinks).toHaveCount(4) // html/htm 档预览=新标签壳页
  const pvLinks = art.locator('span.doc-embed a[href*="preview=1"]')
  await expect(pvLinks).toHaveCount(4) // md/txt/png/伪装png 直连 preview=1

  // GBK 嵌入：原始文件名还原（P-7 时代这里只会显示 oleObject2.bin）+ html
  // 档壳页链接（还原名 ext=html 驱动——名字还原与预览准入的端到端联动证据）
  const oleName = art.locator('.doc-embed-name').filter({ hasText: GBK_NAME })
  await expect(oleName).toHaveCount(3) // 名-only/假设布局/真实布局三块同 GBK 名
  // 下载动作保留；data-embed-ext/url 标记退役（零 JS 挂点）
  await expect(art.locator('a[data-embed-dl]').first()).toHaveAttribute('href', /docx-embed/)
  await expect(art.locator('[data-embed-ext], [data-embed-url]')).toHaveCount(0)
  // 主诉①回归锚：文档阅读列零 iframe/零页内展开容器
  await expect(art.locator('iframe')).toHaveCount(0)
  await expect(art.locator('.doc-embed-frame')).toHaveCount(0)
  // svg（可携脚本）：白名单外维持单链接形态
  await expect(art.locator('a.doc-embed').filter({ hasText: 'proto.svg' })).toBeVisible()
})

test('preview 直连：逐 kind 响应头分型 + 白名单外回归 attachment', async ({ request }) => {
  const html = await request.get(embedURL('word/embeddings/proto.html', '&preview=1'))
  expect(html.status()).toBe(200)
  expect(html.headers()['content-type']).toBe('text/html; charset=utf-8')
  expect(html.headers()['content-security-policy']).toBe('sandbox')
  expect(html.headers()['x-frame-options']).toBe('SAMEORIGIN')

  const txt = await request.get(embedURL('word/embeddings/notes.txt', '&preview=1'))
  expect(txt.headers()['content-type']).toBe('text/plain; charset=utf-8')
  expect(txt.headers()['x-frame-options']).toBe('SAMEORIGIN')

  const png = await request.get(embedURL('word/embeddings/photo.png', '&preview=1'))
  expect(png.headers()['content-type']).toBe('image/png')

  const md = await request.get(embedURL('word/embeddings/notes.md', '&preview=1'))
  const mdBody = await md.text()
  expect(md.headers()['content-type']).toBe('text/html; charset=utf-8')
  expect(mdBody).toContain('<title>notes.md</title>')
  expect(mdBody).toContain('根据IP关联组织')
  expect(mdBody).not.toContain('<script>')
  expect(mdBody).toContain('md-article')

  // GBK CFB 嵌入名-only 容器：还原名 ext=html 命中白名单，但字节仍是 OLE
  // 容器且正文抽不出——容器魔数守卫拦回 attachment（P-20261118-3 断言反转：
  // 旧「CFB→text/html」断言固化的恰是乱码坏行为——容器整体按 text/html
  // 供给正是本案根因）
  const ole = await request.get(embedURL('word/embeddings/oleObject2.bin', '&preview=1'))
  expect(ole.status()).toBe(200)
  expect(ole.headers()['content-type']).toBe('application/octet-stream')
  expect(ole.headers()['content-disposition']).toContain('attachment')

  // 完整布局 CFB（正文在场）：preview 供给抽取出的 html 正文——乱码根除
  // 主刀①的端到端证据（条目名 .bin 不进白名单，还原名 ext=html 驱动准入）
  const oleFull = await request.get(embedURL('word/embeddings/oleObject3.bin', '&preview=1'))
  expect(oleFull.status()).toBe(200)
  expect(oleFull.headers()['content-type']).toBe('text/html; charset=utf-8')
  expect(oleFull.headers()['x-frame-options']).toBe('SAMEORIGIN')
  expect(await oleFull.text()).toContain('<button id="go"')

  // 真实取证布局 CFB（P-20261118-7 主刀轨）：源路径后含 空 ASCIZ+[03 00]+
  // 0x36 长度前缀+临时路径——旧刚性解析在此全灭（误读 0x00360003≈3.4MB
  // 越界拒 → 点预览弹下载框，用户实测主诉本尊形态）；扫描式定位端到端
  // 供给抽取出的 html 正文
  const oleReal = await request.get(embedURL('word/embeddings/oleObject4.bin', '&preview=1'))
  expect(oleReal.status()).toBe(200)
  expect(oleReal.headers()['content-type']).toBe('text/html; charset=utf-8')
  expect(await oleReal.text()).toContain('<button id="go"')
  expect(oleReal.headers()['x-embed-extract-diag']).toBeUndefined()

  // 白名单外/降级：preview 参数忽略回归 attachment（svg/zip/伪装图字节）
  for (const entry of ['word/embeddings/proto.svg', 'word/embeddings/bundle.zip', 'word/embeddings/fake.png']) {
    const r = await request.get(embedURL(entry, '&preview=1'))
    expect(r.headers()['content-type'], entry).toBe('application/octet-stream')
    expect(r.headers()['content-disposition'], entry).toContain('attachment')
  }

  // 无 preview=1：恒 attachment 红线不变
  const plain = await request.get(embedURL('word/embeddings/proto.html'))
  expect(plain.headers()['content-type']).toBe('application/octet-stream')
})

test('8 组合表驱动：scripts×forms×popups 的 CSP token 组合 + 硬红线', async ({ request }) => {
  for (const scripts of ['0', '1']) {
    for (const forms of ['0', '1']) {
      for (const popups of ['0', '1']) {
        const r = await request.get(embedURL('word/embeddings/proto.html',
          `&preview=1&scripts=${scripts}&forms=${forms}&popups=${popups}`))
        const csp = r.headers()['content-security-policy']
        let want = 'sandbox'
        if (scripts === '1') want += ' allow-scripts allow-fullscreen'
        if (forms === '1') want += ' allow-forms allow-modals'
        if (popups === '1') want += ' allow-popups'
        expect(csp, `scripts=${scripts} forms=${forms} popups=${popups}`).toBe(want)
        expect(csp).not.toContain('allow-same-origin')
        expect(csp).not.toContain('allow-top-navigation')
      }
    }
  }
})

test('新标签预览器壳页：两段式 form GET 开关 + 常驻风险提示 + 硬红线 + 沙箱内交互', async ({ page }) => {
  // ui=1 壳页（服务端渲染，零 JS）：完整布局 CFB（还原名 ext=html）——
  // 修订二/三全部语义迁入壳页，页内 iframe 形态已退役。
  // P-20261119-1 开关区折叠（details/summary 默认收起）：每次应用=整页 GET
  // 重渲染、零 JS 无 open 态保持——收起态复位 4 次，四处交互前都必须先点开
  // summary（收起态内容 display:none，Playwright actionability 拒绝 check/
  // click）；textContent/属性面断言不依赖渲染，收起态可直接做
  await page.goto(embedURL('word/embeddings/oleObject3.bin', '&ui=1'))
  const fr = page.locator('iframe.shell-frame')
  await expect(fr).toBeVisible()
  const ctlSummary = page.locator('details.shell-ctl > summary')
  // 态 0：默认静态——sandbox 空值 + src 无脚本参数 + 注记条停用文案 +
  // 标题=还原文件名
  await expect(page).toHaveTitle(new RegExp(GBK_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  await expect(fr).toHaveAttribute('sandbox', '')
  expect(await fr.getAttribute('src')).toContain('preview=1')
  expect(await fr.getAttribute('src')).not.toContain('scripts=1')
  const note = page.locator('.shell-note')
  await expect(note).toContainText(/脚本已停用|Scripts are disabled/)
  // 开关区折叠（P-20261119-1）：初载=收起态（details 精确形态无 open 属性
  // ——[open] 计 0 兼作形态守卫）；summary 徽标行常驻（收起态唯一告知面）
  await expect(page.locator('details.shell-ctl[open]')).toHaveCount(0)
  await expect(page.locator('details.shell-ctl:not([open])')).toHaveCount(1)
  await expect(ctlSummary).toContainText(/脚本与弹窗|Scripts & popups/)
  await expect(ctlSummary).toContainText(/未放开|blocked/i)
  // 二级 checkbox 不渲染（脚本未运行不出现）；旧页内 toggle 族退役
  await expect(page.locator('input[name="forms"]')).toHaveCount(0)
  await expect(page.locator('.embed-toggle, .doc-embed-frame')).toHaveCount(0)
  // 下载原件动作保留（标题行常驻——details 外，收起态可直接断言）
  await expect(page.locator('.shell-dl')).toHaveAttribute('href', /docx-embed/)

  // 态 1 两段式（零 JS 确认形态钉死，评审必改⑤）：先点开折叠区（收起态
  // 不可交互），scripts 风险确认 checkbox（勾选即知悉风险文案）+ 应用按钮
  // （GET 带参重渲染）
  await expect(page.locator('input[name="scripts"]')).not.toBeChecked() // 属性面，收起态可做
  await ctlSummary.click()
  await page.locator('input[name="scripts"]').check()
  await page.locator('button[type="submit"]').click()
  await expect(fr).toHaveAttribute('sandbox', 'allow-scripts allow-fullscreen')
  expect(await fr.getAttribute('src')).toContain('scripts=1')
  expect(await fr.getAttribute('src')).not.toContain('forms=1')
  expect(await fr.getAttribute('sandbox')).not.toContain('allow-same-origin')
  expect(await fr.getAttribute('sandbox')).not.toContain('allow-top-navigation')
  // 重渲染后收起态复位：徽标已切「已放开脚本」
  await expect(page.locator('details.shell-ctl[open]')).toHaveCount(0)
  await expect(ctlSummary).toContainText(/已放开脚本|scripts enabled/i)

  // 原型 JS 交互生效（隔离沙箱内点击按钮）——抽取正文即原型字节面（iframe
  // 在 details 外，收起态不遮蔽）
  const inner = page.frameLocator('iframe.shell-frame')
  await expect(inner.locator('#out')).toHaveText('idle')
  await inner.locator('#go').click()
  await expect(inner.locator('#out')).toHaveText('clicked')

  // 态 2：先点开折叠区 → 二级 checkbox 出现（脚本运行中）→ 勾选放开表单/
  // 弹窗（forms=1&popups=1 联动）→ 常驻风险提示末态
  await ctlSummary.click()
  const formsBox = page.locator('input[name="forms"]')
  await expect(formsBox).toBeVisible()
  await expect(formsBox).not.toBeChecked()
  await formsBox.check()
  await page.locator('button[type="submit"]').click()
  await expect(fr).toHaveAttribute('sandbox', 'allow-scripts allow-fullscreen allow-forms allow-modals allow-popups')
  expect(await fr.getAttribute('src')).toContain('forms=1')
  expect(await fr.getAttribute('src')).toContain('popups=1')
  // 常驻风险提示随级切换（不自动消失——断言即所见；textContent 面，收起态
  // 亦可断言）
  await expect(note).toContainText(/表单\/弹窗已放开|forms\/popups enabled/)
  await expect(note).toContainText(/真实凭据|real credentials/)
  // 徽标行（收起态唯一常驻告知面）full 档必须自带凭据警示要点（P-20261119-1
  // 必改1——最危险一档的常驻告知不得只活在点开的 details 体内）
  await expect(ctlSummary).toContainText(/真实凭据|real credentials/)
  expect(await fr.getAttribute('sandbox')).not.toContain('allow-same-origin')

  // 手动关回二级（无定时/不自动回落——点开+uncheck+应用）
  await ctlSummary.click()
  await page.locator('input[name="forms"]').uncheck()
  await page.locator('button[type="submit"]').click()
  await expect(fr).toHaveAttribute('sandbox', 'allow-scripts allow-fullscreen')
  expect(await fr.getAttribute('src')).not.toContain('forms=1')
  await expect(note).toContainText(/脚本已放开|scripts enabled/)
  await expect(ctlSummary).toContainText(/已放开脚本|scripts enabled/i)

  // 停止脚本：整级回静态（点开+uncheck+应用）
  await ctlSummary.click()
  await page.locator('input[name="scripts"]').uncheck()
  await page.locator('button[type="submit"]').click()
  await expect(fr).toHaveAttribute('sandbox', '')
  expect(await fr.getAttribute('src')).not.toContain('scripts=1')
  await expect(ctlSummary).toContainText(/未放开|blocked/i)
})

test('全幅预览模式（&full=1）：header 条件不渲染+浮动退出钮+两态互转零状态丢失（P-20261120-2）', async ({ page }) => {
  // 常规态：标题行「全幅预览 ⤢」入口链接在场，href=现 query 克隆 set full
  //（scripts=1 态进入——「点全幅丢脚本态」的 URL 结构回归钉，评审必改2）
  await page.goto(embedURL('word/embeddings/oleObject3.bin', '&ui=1&scripts=1'))
  const frFull = page.locator('iframe.shell-frame')
  const entry = page.locator('.shell-full')
  await expect(entry).toHaveCount(1)
  await expect(entry).toHaveAttribute('href', /scripts=1/)
  await expect(entry).toHaveAttribute('href', /full=1/)
  await expect(page.locator('details.shell-ctl')).toHaveCount(1)

  // 点进全幅：URL 带 full=1；header 整体不渲染（details/入口链接结构性
  // 缺席=服务端条件渲染零死 DOM，CSS 隐藏留死 DOM 的形态被计数守卫否决）
  await entry.click()
  await expect(page).toHaveURL(/full=1/)
  await expect(page.locator('details.shell-ctl')).toHaveCount(0)
  await expect(page.locator('header')).toHaveCount(0)
  // iframe 仍在场且 src 参数链原样（scripts=1 保真、full 不进 iframe src）
  await expect(frFull).toBeVisible()
  expect(await frFull.getAttribute('src')).toContain('scripts=1')
  expect(await frFull.getAttribute('src')).not.toContain('full=1')
  // 全幅态视口满幅（主诉锚：header 缺席时 iframe=body(100vh flex column)
  // 唯一流内子元素，flex:1 自然占满——补回头部高度与本地打开对齐）
  const box = await frFull.boundingBox()
  const vp = page.viewportSize()!
  expect(Math.abs(box!.height - vp.height)).toBeLessThan(2)
  // 浮动退出钮：href=克隆 del full（scripts 态保留、无 full=1）
  const exit = page.locator('.shell-full-exit')
  await expect(exit).toHaveCount(1)
  await expect(exit).toHaveAttribute('href', /scripts=1/)
  expect(await exit.getAttribute('href')).not.toContain('full=1')

  // 点退出：回常规态（URL 无 full=1、header+details 复原、src 带脚本态）
  // ——往返无损闭环
  await exit.click()
  await expect(page.locator('details.shell-ctl')).toHaveCount(1)
  await expect(page.locator('.shell-full-exit')).toHaveCount(0)
  expect(page.url()).not.toContain('full=1')
  await expect(frFull).toHaveAttribute('src', /scripts=1/)

  // 回落态 full=1 忽略（评审必改1 的 e2e 面）：诚实回落页 header 仍在
  // （唯一内容就是 header）、无浮动退出钮无 iframe
  await page.goto(embedURL('word/embeddings/oleObject2.bin', '&ui=1&full=1'))
  await expect(page.locator('.shell-note')).toBeVisible()
  await expect(page.locator('.shell-full-exit')).toHaveCount(0)
  await expect(page.locator('iframe')).toHaveCount(0)
})

test('壳页诚实回落：正文抽不出时 ui=1 显性提示页而非静默下载（P-20261118-7 主诉修复）', async ({ page, request }) => {
  const url = embedURL('word/embeddings/oleObject2.bin', '&ui=1')
  // 诊断枚举面（评审建议b）：粗粒度枚举码在响应头，容器细节不外泄
  const probe = await request.get(url)
  expect(probe.status()).toBe(200)
  expect(probe.headers()['content-type']).toBe('text/html; charset=utf-8')
  expect(probe.headers()['x-embed-extract-diag']).toBe('anchor-miss')
  await probe.dispose()

  // 用户主诉直接体验：点「预览」得到明确交代页（标题=还原名+暂不支持提示
  // +下载出口），而非静默弹下载框
  await page.goto(url)
  await expect(page).toHaveTitle(new RegExp(GBK_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const note = page.locator('.shell-note')
  await expect(note).toContainText(/暂不支持自动预览|can&#39;t be auto-previewed|can't be auto-previewed/)
  await expect(page.locator('.shell-dl')).toHaveAttribute('href', /docx-embed/)
  await expect(page.locator('.shell-dl')).not.toHaveAttribute('href', /preview=1/)
  // 诚实回落无 iframe 无开关（iframe 里也只会 attachment——面一致性）；
  // 无折叠区（P-20261119-1：无开关可折，details 整体缺席与 Go notWant 对账）
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.locator('input[name="scripts"], input[name="forms"]')).toHaveCount(0)
  await expect(page.locator('details')).toHaveCount(0)
})
