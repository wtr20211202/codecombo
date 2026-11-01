import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD, LOCK_OVERLAY, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 实例切换回归：项目空间内多轮双向切换不应产生任何 5xx / 意外 4xx。
 *
 * 回归背景：切换前旧项目的 selectedBranch 会经 uiState 残留到新实例，
 * 被套用到无该分支的项目上时 git log 500 弹「服务器异常」——
 * Layout 恢复侧已加项目维度守卫 + CommitsPanel 恢复值合法性校验。
 */
test('多轮双向切换实例无异常', async ({ page }) => {
  // 切换目标是 wsl-server 远程实例记录（e2e-seed-wsl 域 2 播种）；记录缺失
  //（跨拓扑金态无 WSL 域）= 环境边界，按门控 skip（P-20261005-187）
  {
    const unlock = await fetch(`${API_BASE}/api/lock/unlock`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: DEFAULT_PASSWORD }),
    })
    const token = ((await unlock.json()) as { token?: string }).token || ''
    const insts = (await (await fetch(`${API_BASE}/api/instances`, {
      headers: { 'X-Lock-Token': token },
    })).json())?.data as { name?: string }[] | undefined
    test.skip(!(insts || []).some(i => i.name === 'wsl-server'), 'wsl-server 实例记录未播种（跨拓扑金态无 WSL 域），跳过')
  }
  const apiErrs: string[] = []
  let unlocked = false
  page.on('response', async resp => {
    if (resp.status() >= 400) {
      // 解锁前的 boot 请求 423 是锁定态预期行为（前端静默处理），不算异常
      if (!unlocked && resp.status() === 423) return
      // redraw 404 = 远程实例侧持久化恢复的死会话（其服务端重启/会话 GC
      // 不受本测试控制）触发自愈重绘，设计即失败静默，不计入异常
      if (resp.status() === 404 && resp.url().includes('/redraw')) return
      // 子实例（/proxy/）404 = 远端实例二进制缺对应路由——wsl-server :9998 是
      // 长驻 systemd 服务（CLAUDE.md 部署节），二进制手动部署、版本滞后于
      // HEAD 不受本测试控制（实测旧版本缺 morning-brief/ops-ask/ops-confirm/
      // meta/share/ui/snapshot 等：P-20261005-219 新端点只是当日新增的显眼项，
      // 整类同因）。前端对这些能力探测/状态面一律设计为静默降级（useMorningBrief
      // 「晨报不可达=检查单缺席」、share 状态徽标、boot 恢复无快照跳过等，与
      // redraw 同「设计即失败静默」），且切换回归本 spec 守的是 5xx（selectedBranch
      // 污染即 git log 500）——代理面 404 不计入异常，5xx 与本机 4xx 仍严格
      if (resp.status() === 404 && resp.url().includes('/proxy/')) return
      // 子实例（/proxy/）锁定态 423：切换到带锁子实例时前端静默展示子实例
      // 锁屏（本测试随后用默认密码就地解锁），属预期行为不计入异常
      if (resp.status() === 423 && resp.url().includes('/proxy/')) return
      let body = ''
      try { body = (await resp.text()).slice(0, 80) } catch { /* ignore */ }
      apiErrs.push(`${resp.status()} ${resp.url().replace(/^https?:\/\/[^/]+/, '')} ${body}`)
    }
  })

  await page.goto('/')
  const input = page.locator(`${LOCK_OVERLAY} .lock-form input`).first()
  if (await input.isVisible().catch(() => false)) {
    await input.fill(DEFAULT_PASSWORD)
    await page.locator(`${LOCK_OVERLAY} button[type="submit"]`).first().click()
    await expect(input).toBeHidden({ timeout: 10000 })
  }
  const remindBtn = page.getByRole('button', { name: '稍后提醒' })
  if (await remindBtn.isVisible().catch(() => false)) await remindBtn.click()
  await page.waitForTimeout(800)
  unlocked = true

  // 默认密码修改提醒（稍后提醒/立即修改）按实例各自弹出：本机与 WSL 子实例
  // 都是默认密码，切到对方后会再次出现——每次切换后都处置，避免遮罩拦截点击
  async function dismissPwdReminder() {
    const btn = page.getByRole('button', { name: '稍后提醒' })
    if (await btn.isVisible().catch(() => false)) await btn.click()
  }

  // 环境门控：启动恢复的活动实例若为「锁定且非默认密码」的远程实例
  //（如 WSL 侧 120min 自动锁已触发），遮罩无法用默认密码解除，
  // 后续一切点击都会被拦截——该状态无法在本测试内解除，跳过
  if (await page.locator(LOCK_OVERLAY).isVisible().catch(() => false)) {
    test.skip(true, '锁定遮罩在默认密码解锁后仍存在（远程实例锁定态被恢复为活动实例），跳过')
  }

  // 多轮：本机项目空间 <-> 远程项目空间 来回切
  for (let round = 0; round < 2; round++) {
    // 切到远程并进入项目
    await page.locator('.instance-indicator').click()
    await page.locator('.menu-panel .instance-row').filter({ hasText: 'wsl-server' }).click()
    await page.waitForTimeout(2500)

    // WSL 子实例的锁是环境侧状态（token TTL 过期 / 120min 自动锁后回锁）：
    // 中心令牌对子实例无效，切换后会出现子实例自己的锁定遮罩——
    // 先用 e2e 默认密码就地解锁；仍解不开（密码被改）则按既有门控哲学跳过
    if (await page.locator(LOCK_OVERLAY).isVisible().catch(() => false)) {
      const childInput = page.locator(`${LOCK_OVERLAY} .lock-form input`).first()
      await childInput.fill(DEFAULT_PASSWORD)
      await page.locator(`${LOCK_OVERLAY} button[type="submit"]`).first().click()
      await page.waitForTimeout(1200)
      if (await page.locator(LOCK_OVERLAY).isVisible().catch(() => false)) {
        test.skip(true, 'WSL 子实例锁定且非默认密码，无法在测试内解除，跳过')
      }
    }

    await dismissPwdReminder()
    await page.getByText('demo').first().click()
    await page.waitForTimeout(2500)

    // 切回本机并进入项目
    await page.locator('.instance-indicator').click()
    await page.locator('.menu-panel .instance-row').filter({ hasText: '本机' }).click()
    await page.waitForTimeout(2500)
    await dismissPwdReminder()
    // 整词锚定项目名：git-test 夹具卡路径含 "simple-coding" 子串，getByText 会误中
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForTimeout(2500)
  }

  console.log('API_ERRORS:', JSON.stringify(apiErrs))
  expect(apiErrs, apiErrs.join('\n')).toHaveLength(0)
})
