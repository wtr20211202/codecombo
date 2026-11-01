import { describe, it, expect } from 'vitest'
import { buildRemoteViewUrl, remotePlatformName } from '@/utils/remoteViewUrl'

/** 快捷构造入参 */
function view(remoteUrl: string, ref = 'main', filePath = 'src/app.ts') {
  return buildRemoteViewUrl({ remoteUrl, ref, filePath })
}

describe('buildRemoteViewUrl', () => {
  it('https remote：拼出 blob URL，识别 GitHub 平台', () => {
    expect(view('https://github.com/acme/widget.git')).toEqual({
      url: 'https://github.com/acme/widget/blob/main/src/app.ts',
      platform: 'github',
      host: 'github.com',
    })
  })

  it('SCP 形态 ssh remote（git@host:owner/repo.git）归一化为 https', () => {
    expect(view('git@gitlab.com:acme/widget.git')).toEqual({
      url: 'https://gitlab.com/acme/widget/blob/main/src/app.ts',
      platform: 'gitlab',
      host: 'gitlab.com',
    })
    // 无 .git 后缀同样成立
    expect(view('git@gitee.com:acme/widget', 'dev', 'README.md')?.url)
      .toBe('https://gitee.com/acme/widget/blob/dev/README.md')
  })

  it('ssh:// 形态：剥 user@ 与 ssh 端口，host 走 https 默认端口', () => {
    expect(view('ssh://git@gitlab.com:2222/acme/widget.git', 'feature/x', 'a b.md')?.url)
      .toBe('https://gitlab.com/acme/widget/blob/feature/x/a%20b.md')
  })

  it('自建 Gitea（带端口+子路径）：scheme/端口/子路径原样保留，平台归 generic', () => {
    expect(view('https://git.company.com:3000/gitea/acme/widget.git', 'main', 'docs/指 南.md')).toEqual({
      url: 'https://git.company.com:3000/gitea/acme/widget/blob/main/docs/%E6%8C%87%20%E5%8D%97.md',
      platform: 'generic',
      host: 'git.company.com',
    })
  })

  it('http 自建实例：保留 http scheme（内网无 TLS 场景不强行升 https）', () => {
    expect(view('http://192.168.1.10:3000/acme/widget.git')?.url)
      .toBe('http://192.168.1.10:3000/acme/widget/blob/main/src/app.ts')
  })

  it('分支名含 / 与文件名含 #：分段编码保留路径斜杠、转义 #', () => {
    expect(view('https://github.com/acme/widget.git', 'feat/json-api', 'a#b.md')?.url)
      .toBe('https://github.com/acme/widget/blob/feat/json-api/a%23b.md')
  })

  it('无 remote / 缺分支 / 缺文件路径 → null（入口隐藏）', () => {
    expect(buildRemoteViewUrl({ remoteUrl: '', ref: 'main', filePath: 'a.ts' })).toBeNull()
    expect(buildRemoteViewUrl({ remoteUrl: undefined, ref: 'main', filePath: 'a.ts' })).toBeNull()
    expect(buildRemoteViewUrl({ remoteUrl: 'https://github.com/a/b.git', ref: '', filePath: 'a.ts' })).toBeNull()
    expect(buildRemoteViewUrl({ remoteUrl: 'https://github.com/a/b.git', ref: 'main', filePath: '' })).toBeNull()
  })

  it('本地路径 remote（裸仓库/盘符/UNC/file://）→ null，不误判为平台', () => {
    expect(view('D:/tmp/bare.git')).toBeNull()          // 盘符不能当 host
    expect(view('/var/tmp/bare.git')).toBeNull()        // 无 scheme 无冒号
    expect(view('\\\\nas\\share\\bare.git')).toBeNull() // UNC
    expect(view('file:///tmp/bare.git')).toBeNull()
  })

  it('平台展示名：三大平台用品牌名，generic 用调用方兜底文案', () => {
    expect(remotePlatformName('github', '代码托管平台')).toBe('GitHub')
    expect(remotePlatformName('gitlab', '代码托管平台')).toBe('GitLab')
    expect(remotePlatformName('gitee', '代码托管平台')).toBe('Gitee')
    expect(remotePlatformName('generic', '代码托管平台')).toBe('代码托管平台')
  })
})
