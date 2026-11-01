import { describe, it, expect } from 'vitest'
import { isSensitiveName, isSensitivePath } from './sensitiveName'

/**
 * 敏感文件名匹配单测（P-20261005-163）：语料与服务端 scan_test.go 同族互锁
 * ——前端镜像表（utils/sensitiveName.ts）与 server/share/scan.go 改任一侧
 * 必须双侧同步，此处固化前端侧语义基线。
 */
describe('isSensitiveName', () => {
  it('命中模式表各簇', () => {
    expect(isSensitiveName('.env')).toBe(true)
    expect(isSensitiveName('.env.local')).toBe(true)
    expect(isSensitiveName('.env.production')).toBe(true)
    expect(isSensitiveName('id_rsa')).toBe(true)
    expect(isSensitiveName('id_rsa.pub')).toBe(true)
    expect(isSensitiveName('server.pem')).toBe(true)
    expect(isSensitiveName('config.key')).toBe(true)
    expect(isSensitiveName('.npmrc')).toBe(true)
    expect(isSensitiveName('.netrc')).toBe(true)
    expect(isSensitiveName('.git-credentials')).toBe(true)
    expect(isSensitiveName('db.kdbx')).toBe(true)
    expect(isSensitiveName('serviceaccount.json')).toBe(true)
    expect(isSensitiveName('serviceaccount-prod.json')).toBe(true)
    expect(isSensitiveName('credentials.json')).toBe(true)
  })

  it('大小写不敏感（Windows 文件系统与跨平台语义一致）', () => {
    expect(isSensitiveName('.ENV')).toBe(true)
    expect(isSensitiveName('ID_RSA')).toBe(true)
    expect(isSensitiveName('Server.PEM')).toBe(true)
    expect(isSensitiveName('Credentials.JSON')).toBe(true)
  })

  it('普通文件不命中', () => {
    expect(isSensitiveName('main.go')).toBe(false)
    expect(isSensitiveName('env')).toBe(false) // 无前导点：约定俗成密钥名才命中
    expect(isSensitiveName('keys.md')).toBe(false)
    expect(isSensitiveName('my.npmrc.bak')).toBe(false)
    expect(isSensitiveName('credentials.json.example')).toBe(false)
    expect(isSensitiveName('')).toBe(false)
  })
})

describe('isSensitivePath', () => {
  it('取 basename 判定，嵌套路径命中', () => {
    expect(isSensitivePath('config/.env')).toBe(true)
    expect(isSensitivePath('a/b/c/server.key')).toBe(true)
    expect(isSensitivePath('docs/notes.md')).toBe(false)
  })

  it('反斜杠分隔显式归一（不依赖宿主平台分隔符语义）', () => {
    expect(isSensitivePath('config\\.env.local')).toBe(true)
    expect(isSensitivePath('a\\b\\id_rsa')).toBe(true)
  })

  it('空白容差与空路径', () => {
    expect(isSensitivePath('  .env  ')).toBe(true)
    expect(isSensitivePath('')).toBe(false)
    expect(isSensitivePath('   ')).toBe(false)
  })
})
