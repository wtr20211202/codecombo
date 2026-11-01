/**
 * 换机迁移纯前端助手（P-20261003-147）：口令强度分档、块元数据、字节人性化、
 * 大项目阈值判定——与服务端「白名单为唯一事实源」对齐的展示层词汇。
 * 服务端是校验权威（口令 ≥8 与块勾选服务端重判），本模块只做输入前反馈。
 */

/** 迁移包文件扩展名与服务端导出附件名前缀（展示/保存用） */
export const MIGRATION_FILE_EXT = '.scpkg'

/** 全量包单项目体积黄条警示阈值（提案口径 2GB） */
export const MIGRATION_PROJECT_WARN_BYTES = 2 * 1024 * 1024 * 1024

/** 配置四块词汇（勾选面稳定序） */
export const MIGRATION_BLOCK_KEYS = ['credentials', 'tokens', 'settings', 'instances'] as const
export type MigrationBlockKey = (typeof MIGRATION_BLOCK_KEYS)[number]

/** i18n 键前缀（settings.migration.blocks.<key>） */
export function migrationBlockLabelKey(key: MigrationBlockKey): string {
  return `settings.migration.blocks.${key}`
}

/**
 * 口令强度分档（0~3）：长度主判 + 字符多样性加权。与服务端「≥8 位拒绝」
 * 对齐——score 0 = 不可提交（<8），档位文案与进度条由调用方渲染。
 * 纯函数、逐字符线性扫描，输入前反馈零防解析面
 */
export function passphraseStrength(pass: string): { score: 0 | 1 | 2 | 3; ok: boolean } {
  if (pass.length < 8) return { score: 0, ok: false }
  let kinds = 0
  if (/[a-z]/.test(pass)) kinds++
  if (/[A-Z]/.test(pass)) kinds++
  if (/[0-9]/.test(pass)) kinds++
  if (/[^a-zA-Z0-9]/.test(pass)) kinds++
  if (pass.length >= 16 && kinds >= 3) return { score: 3, ok: true }
  if (pass.length >= 12 && kinds >= 2) return { score: 2, ok: true }
  return { score: 1, ok: true }
}

/** 强度档 i18n 键（settings.migration.strength.<n>） */
export function passphraseStrengthKey(score: 0 | 1 | 2 | 3): string {
  return `settings.migration.strength.${score}`
}

/** 字节人性化（与前端既有 formatBytes 语义一致的独立小件——迁移面板独立
 * 引用不跨面板拉依赖）：<1KB 按字节、<1MB 按 KB、<1GB 按 MB、余按 GB */
export function migrationFormatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let i = -1
  do {
    v /= 1024
    i++
  } while (v >= 1024 && i < units.length - 1)
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** 单项目是否超黄条阈值（预览/导出选档共用） */
export function projectOversize(size: number): boolean {
  return size >= MIGRATION_PROJECT_WARN_BYTES
}

/** 从导出附件名合成保存名（服务端 Content-Disposition 不透 axios 拦截器，
 * 浏览器侧自行合成——exportFileName 惯例）：sc-migration-<yyyymmdd-hhmmss>.scpkg */
export function migrationDownloadName(now = new Date()): string {
  const pad = (x: number) => String(x).padStart(2, '0')
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `sc-migration-${ts}${MIGRATION_FILE_EXT}`
}
