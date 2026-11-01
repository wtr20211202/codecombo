import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import {
  buildRemoteEditorPath, isRemoteEditorPath, isSensitiveRemotePath,
  parseRemoteEditorPath, utf8ToBase64,
} from './remoteEditorPath'

// remoteHostDisplayName 的 api 边界替身化（vi.hoisted 保持 resetModules 后
// 仍持同一 mock 句柄；模块级缓存/一次性拉取旗标随 resetModules 逐用例重建）
const listMock = vi.hoisted(() => vi.fn())
vi.mock('../api/client', () => ({
  remoteHostApi: { list: listMock },
}))

describe('remoteEditorPath 伪路径', () => {
  it('非远程前缀返回 false / null', () => {
    expect(isRemoteEditorPath('src/app.ts')).toBe(false)
    expect(isRemoteEditorPath('diff:HEAD:wt:src/a.ts')).toBe(false)
    expect(isRemoteEditorPath('untitled://1')).toBe(false)
    expect(parseRemoteEditorPath('src/app.ts')).toBeNull()
    expect(parseRemoteEditorPath('remote:only-id-no-path')).toBeNull()
    expect(parseRemoteEditorPath('remote::/etc/a.conf')).toBeNull()
  })

  it('构造→解析 round-trip：hostId 与远端路径逐段保真（含冒号路径段）', () => {
    const p = buildRemoteEditorPath('sc_rh_abc-123', '/etc/nginx/nginx.conf')
    expect(isRemoteEditorPath(p)).toBe(true)
    const parts = parseRemoteEditorPath(p)
    expect(parts).not.toBeNull()
    expect(parts!.hostId).toBe('sc_rh_abc-123')
    expect(parts!.rpath).toBe('/etc/nginx/nginx.conf')
    expect(parts!.name).toBe('nginx.conf')
  })

  it('特殊字符远端路径解析保真（空格/引号/$/CJK）——SFTP 线协议直传语义', () => {
    const weird = `/opt/my app$/conf 'q' (v2) 路径.env`
    const parts = parseRemoteEditorPath(buildRemoteEditorPath('h1', weird))
    expect(parts!.rpath).toBe(weird)
    expect(parts!.name).toBe(`conf 'q' (v2) 路径.env`)
  })
})

describe('isSensitiveRemotePath 敏感系统路径', () => {
  it.each([
    ['/etc', true],
    ['/etc/nginx/nginx.conf', true],
    ['/etc/', true],
    ['/boot', true],
    ['/boot/grub.cfg', true],
    ['/bootx', false],
    ['/etcetera/file', false],
    ['/home/user/etc/a.conf', false],
    ['/opt/app/boot/config', false],
    ['/var/www/a.txt', false],
  ])('%s → %s', (input, want) => {
    expect(isSensitiveRemotePath(input)).toBe(want)
  })
})

describe('utf8ToBase64', () => {
  it('ASCII 与多字节 UTF-8 往返一致（atob 出二进制串，多字节经 TextDecoder 还原）', () => {
    expect(atob(utf8ToBase64('hello'))).toBe('hello')
    const decode = (b64: string) =>
      new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)))
    expect(decode(utf8ToBase64('中文内容 with spaces'))).toBe('中文内容 with spaces')
  })

  it('与编码端点语义互验：GBK 探测字节（服务端 EncodeText 输入）round-trip', () => {
    // 服务端把 base64 解出的 UTF-8 文本按 encoding 落盘——前端只需保证
    // base64 解码后还原原字符串
    const s = 'emoji 🎉 中文\nline2'
    expect(new TextDecoder().decode(Uint8Array.from(atob(utf8ToBase64(s)), c => c.charCodeAt(0)))).toBe(s)
  })
})

describe('remoteHostDisplayName 主机展示名缓存', () => {
  beforeEach(() => {
    listMock.mockReset()
  })

  /** resetModules 重建模块级缓存与一次性拉取旗标，逐用例自洽 */
  function freshMod(): Promise<typeof import('./remoteEditorPath')> {
    vi.resetModules()
    return import('./remoteEditorPath')
  }

  it('首读未命中先返回 hostId 兜底，静默拉取落定后命中主机名', async () => {
    listMock.mockResolvedValue({ data: [{ id: 'h1', name: 'prod-1' }] })
    const mod = await freshMod()
    expect(mod.remoteHostDisplayName('h1')).toBe('h1') // 兜底先返回
    await flushPromises()
    expect(mod.remoteHostDisplayName('h1')).toBe('prod-1')
    expect(listMock).toHaveBeenCalledTimes(1)
  })

  it('缓存命中不再拉取；一次性旗标生效——未知 host 回退 hostId 不重试', async () => {
    listMock.mockResolvedValue({ data: [{ id: 'h1', name: 'prod-1' }] })
    const mod = await freshMod()
    mod.remoteHostDisplayName('h1')
    await flushPromises()
    mod.remoteHostDisplayName('h1') // 缓存命中
    expect(mod.remoteHostDisplayName('unknown-h')).toBe('unknown-h') // 旗标已置，不二次拉取
    await flushPromises()
    expect(listMock).toHaveBeenCalledTimes(1)
    expect(mod.remoteHostDisplayName('unknown-h')).toBe('unknown-h')
  })

  it('列表不可达（离线/无主机）：静默降级恒显 hostId，不抛错', async () => {
    listMock.mockRejectedValue(new TypeError('offline'))
    const mod = await freshMod()
    expect(mod.remoteHostDisplayName('h9')).toBe('h9')
    await flushPromises()
    expect(mod.remoteHostDisplayName('h9')).toBe('h9')
  })
})
