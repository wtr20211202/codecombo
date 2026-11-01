import { describe, expect, it } from 'vitest'
import { isValidCloneUrl, looksLikeGitUrl } from './cloneUrl'

/**
 * 克隆 URL 形态校验（P-20261003-70）：与服务端 server/api/gitops/clone_test.go
 * TestPrecheckCloneURL_Forms 用同一张用例表——改用例须两侧同步，保证双端同规则。
 */
describe('isValidCloneUrl', () => {
  it('合法形态放行（含异形但从宽）', () => {
    const valid = [
      'https://github.com/user/repo.git',
      'http://gitea.lan:3000/user/repo.git',
      'git@github.com:user/repo.git',
      'ssh://git@gitlab.com:2222/user/repo.git', // 自定义端口 ssh:// 长形放行
      'file:///nonexistent-src', // 本地文件 URL（既有单测/e2e 夹具形态）
      '/nonexistent-sc-precheck-src', // 本地绝对路径（既有单测夹具形态）
      'D:/workspace/repo', // Windows 盘符路径
      '\\\\nas\\share\\repo', // UNC 路径
      './sibling/repo',
      '~/src/repo',
      'https://host/répo', // 非 ASCII 但非空白/全角——从宽放行（宁可漏报）
    ]
    for (const u of valid) {
      expect(isValidCloneUrl(u), u).toBe(true)
    }
  })

  it('打错形态与空白/全角字符判非法', () => {
    const invalid = [
      'https//github.com/user/repo.git', // 少冒号（提案动机形态）
      'git@github.com/user/repo.git', // SCP 少冒号（@ 后无 :）
      'github.com/user/repo.git', // 缺协议前缀也非本地路径形态
      'https://github.com/a b/repo.git', // 含普通空格
      'https://github.com/a\u3000b/repo.git', // 全角空格（粘进中文空格）
      'https://github.com/a\u00a0b/repo.git', // NBSP（网页复制常见）
      'ｈｔｔｐｓ://github.com/user/repo.git', // 全角字母
      'https://github.com/user/repo（备份）', // 全角括号（CJK 标点）
    ]
    for (const u of invalid) {
      expect(isValidCloneUrl(u), u).toBe(false)
    }
  })

  it('空串按非法处理（调用方以非空为前置条件）', () => {
    expect(isValidCloneUrl('')).toBe(false)
  })
})

/**
 * 粘贴建议检测（P-20261003-170）：与 isValidCloneUrl 反向——只认远程形态，
 * 本地路径（isValidCloneUrl 放行的盘符/UNC/./ ~/）一律不命中防误报。
 */
describe('looksLikeGitUrl', () => {
  it('协议前缀长形与 SCP 短形命中', () => {
    const hits = [
      'https://github.com/user/repo.git',
      'http://gitea.lan:3000/user/repo.git',
      'git@github.com:user/repo.git',
      'ssh://git@gitlab.com:2222/user/repo.git',
      'file:///srv/repos/demo.git', // file:// 也是合法克隆源，同样建议
      '  https://github.com/user/repo.git  ', // 首尾空白 trim 后仍命中
    ]
    for (const u of hits) {
      expect(looksLikeGitUrl(u), u).toBe(true)
    }
  })

  it('本地路径形态不命中（防误报核心）', () => {
    const misses = [
      'D:/workspace/go/my-project', // Windows 盘符
      'D:\\workspace\\my-project', // 反斜杠形态
      '/home/user/myrepo', // Unix 绝对路径
      '\\\\nas\\share\\repo', // UNC
      './sibling/repo',
      '~/src/repo',
      'my-project', // 裸目录名
      'github.com/user/repo.git', // 缺协议前缀（也非 SCP 形态）
      'https //github.com/user/repo.git', // 畸形协议（少冒号）不命中
      '',
      '   ',
    ]
    for (const u of misses) {
      expect(looksLikeGitUrl(u), u).toBe(false)
    }
  })
})
