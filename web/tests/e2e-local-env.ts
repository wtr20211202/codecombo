import path from 'node:path'
import type { APIRequestContext } from '@playwright/test'

/**
 * E2E 本机环境事实的运行时推导——机器盘面与内网信息不落源码（发布面纪律）：
 *  - e2eCloneParentDir：本地克隆/夹具的父目录 = 检出仓的父目录。playwright
 *    一律 cd web 后启动（npm run test:e2e 与 e2e-full.sh 分片同惯例），cwd 上
 *    跳两级即检出仓父目录。此前四个 spec 硬编码开发机盘面路径（正斜杠形态
 *    曾逃过 release-scan HARD 库，见该脚本 workspace 条目注释），发布面不得
 *    再出现。
 *  - discoverGitTestCloneUrl：git-test 推送夹具仓地址，向 Gitea 匿名搜索按
 *    仓名发现（scripts/e2e-seed.sh 同款逻辑——seed 只认仓名不认 owner），
 *    owner 属内网环境信息，源码不落；Gitea 地址可用 E2E_GITEA_URL 覆盖
 *    （跨拓扑/NAT 场景与 e2e-seed.sh 同旋钮）。
 */

export function e2eCloneParentDir(): string {
  return path.resolve(process.cwd(), '..', '..').replace(/\\/g, '/')
}

export async function discoverGitTestCloneUrl(
  request: APIRequestContext,
  giteaUrl = process.env.E2E_GITEA_URL ?? 'http://localhost:3000',
): Promise<string> {
  const res = await request.get(`${giteaUrl}/api/v1/repos/search?q=git-test&limit=5`)
  if (!res.ok()) return ''
  const body = (await res.json().catch(() => null)) as {
    data?: Array<{ name?: string; clone_url?: string }>
  } | null
  return body?.data?.find((r) => r.name === 'git-test')?.clone_url ?? ''
}
