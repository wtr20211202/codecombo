import { describe, it, expect, beforeEach } from 'vitest'
import {
  extractPasteCandidate,
  looksHighRisk,
  confirmRiskIds,
  isRiskWhitelisted,
  riskWhitelistSize,
  resetRiskWhitelist,
  impactOf,
  previewNeedsConfirm,
} from '../../utils/commandRisk'
import type { TerminalRiskMatch } from '../../api/domains/terminal'

// 高危命令影响面预检前端半件（P-20261005-191）：候选提取/预筛/白名单/
// 影响面描述符纯函数直测（判定事实源在服务端，此处钉触发阀与降级语义）

describe('extractPasteCandidate', () => {
  it('bracketed paste 包裹段剥壳取内文', () => {
    const raw = '\x1b[200~rm -rf build\x1b[201~'
    expect(extractPasteCandidate(raw)).toBe('rm -rf build')
  })

  it('bracketed paste 换行归一（\\r 还原 \\n）', () => {
    const raw = '\x1b[200~echo a\recho b\x1b[201~'
    expect(extractPasteCandidate(raw)).toBe('echo a\necho b')
  })

  it('未包裹但含 ESC 的按键序列不构成候选', () => {
    expect(extractPasteCandidate('\x1b[A')).toBeNull()
  })

  it('单字符键入（无包裹无 ESC）短于最小长度不构成候选', () => {
    expect(extractPasteCandidate('r')).toBeNull()
  })

  it('未包裹的整块粘贴原样候选（预筛兜底判定）', () => {
    expect(extractPasteCandidate('rm -rf build')).toBe('rm -rf build')
  })
})

describe('looksHighRisk（触发阀，宽松从宽）', () => {
  it.each([
    ['rm -rf build', true],
    ['rm -fr dist', true],
    ['rm --recursive node_modules', true],
    ['rm -f secret.key', true],
    ['git reset --hard HEAD~1', true],
    ['git clean -fd', true],
    ['git push origin main --force', true],
    ['git checkout -- .', true],
    ['git restore src/main.go', true],
    ['truncate -s 0 app.log', true],
    ['shred -u secret.txt', true],
    ['docker system prune -af', true],
    ['echo x > config.txt', true],
    // 键入逐字符不会整段命中：单 token 天然 miss
    ['npm run build', false],
    ['echo hello world', false],
    ['git status', false],
    ['git commit -m "fix"', false],
  ])('%s → %s', (text, hit) => {
    expect(looksHighRisk(text)).toBe(hit)
  })
})

describe('会话白名单（同型命令不再拦）', () => {
  beforeEach(() => resetRiskWhitelist())

  it('确认过的模式族放行，未确认的拦截', () => {
    const matches: TerminalRiskMatch[] = [
      { id: 'rm-recursive', level: 'danger', kind: 'rm', segment: 'rm -rf build' },
    ]
    expect(isRiskWhitelisted(matches)).toBe(false)
    confirmRiskIds(['rm-recursive'])
    expect(isRiskWhitelisted(matches)).toBe(true)
    expect(riskWhitelistSize()).toBe(1)
  })

  it('多命中须全部在白名单内才放行', () => {
    confirmRiskIds(['rm-recursive'])
    const mixed: TerminalRiskMatch[] = [
      { id: 'rm-recursive', level: 'danger', kind: 'rm', segment: 'x' },
      { id: 'git-clean', level: 'danger', kind: 'git', segment: 'y' },
    ]
    expect(isRiskWhitelisted(mixed)).toBe(false)
    confirmRiskIds(['git-clean'])
    expect(isRiskWhitelisted(mixed)).toBe(true)
  })

  it('空命中集不放行（结构上不可达，防御式）', () => {
    expect(isRiskWhitelisted([])).toBe(false)
  })
})

describe('impactOf 影响面描述符', () => {
  it('路径族计数（含截断下界后缀）', () => {
    const m: TerminalRiskMatch = {
      id: 'rm-recursive', level: 'danger', kind: 'rm', segment: 'x',
      dynamic: { files: 37, bytes: 4500, sizeHuman: '4.4 KB', truncated: true, paths: ['build'] },
    }
    const impact = impactOf(m)
    expect(impact.tone).toBe('dynamic')
    expect(impact.params).toEqual({ n: 37, size: '4.4 KB', suffix: '+' })
  })

  it('git 族按模式 id 分流 dirty/untracked', () => {
    const reset: TerminalRiskMatch = {
      id: 'git-reset-hard', level: 'danger', kind: 'git', segment: 'x',
      dynamic: { dirty: 3 },
    }
    expect(impactOf(reset)).toMatchObject({ key: 'terminal.cmdPreview.impact.dirty', params: { n: 3 }, tone: 'dynamic' })

    const clean: TerminalRiskMatch = {
      id: 'git-clean', level: 'danger', kind: 'git', segment: 'x',
      dynamic: { untracked: 5 },
    }
    expect(impactOf(clean)).toMatchObject({ key: 'terminal.cmdPreview.impact.untracked', params: { n: 5 }, tone: 'dynamic' })
  })

  it('git 计数为 0 → zero 档（降级灰提示不弹卡的依据面）', () => {
    const m: TerminalRiskMatch = {
      id: 'git-reset-hard', level: 'danger', kind: 'git', segment: 'x',
      dynamic: { dirty: 0 },
    }
    expect(impactOf(m).tone).toBe('zero')
  })

  it('overwrite 族按 exists 分流', () => {
    const exists: TerminalRiskMatch = {
      id: 'overwrite-redirect', level: 'warning', kind: 'overwrite', segment: 'x',
      dynamic: { exists: true, bytes: 100, sizeHuman: '100 B' },
    }
    expect(impactOf(exists).tone).toBe('dynamic')
    const fresh: TerminalRiskMatch = {
      id: 'overwrite-redirect', level: 'warning', kind: 'overwrite', segment: 'x',
      dynamic: { exists: false },
    }
    expect(impactOf(fresh).tone).toBe('zero')
  })

  it('无动态计数 → static 档（静态降级照弹卡）', () => {
    const m: TerminalRiskMatch = { id: 'rm-force', level: 'danger', kind: 'rm', segment: 'x' }
    expect(impactOf(m)).toMatchObject({ key: 'terminal.cmdPreview.impact.static', tone: 'static' })
  })
})

describe('previewNeedsConfirm 确认卡弹出判定', () => {
  it('全部命中计数为 0 → 不弹（灰提示降级）', () => {
    expect(previewNeedsConfirm({
      level: 'danger', kind: 'git', detail: '',
      matches: [{ id: 'git-reset-hard', level: 'danger', kind: 'git', segment: 'x', dynamic: { dirty: 0 } }],
    })).toBe(false)
  })

  it('任一命中计数 > 0 → 弹卡', () => {
    expect(previewNeedsConfirm({
      level: 'danger', kind: 'rm', detail: '',
      matches: [
        { id: 'git-reset-hard', level: 'danger', kind: 'git', segment: 'a', dynamic: { dirty: 0 } },
        { id: 'rm-recursive', level: 'danger', kind: 'rm', segment: 'b', dynamic: { files: 2, bytes: 10 } },
      ],
    })).toBe(true)
  })

  it('静态降级（无 dynamic）→ 照弹（信息缺席恰是弹卡的理由）', () => {
    expect(previewNeedsConfirm({
      level: 'danger', kind: 'rm', detail: '',
      matches: [{ id: 'rm-recursive', level: 'danger', kind: 'rm', segment: 'x' }],
    })).toBe(true)
  })

  it('无命中 → 不弹', () => {
    expect(previewNeedsConfirm({ level: '', kind: '', detail: '', matches: [] })).toBe(false)
  })
})
