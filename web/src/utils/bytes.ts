// 字节量展示与占用阈值（P-20261005-176 冻结快照占用可见性）。utils/recording
// 的 formatBytes 是录制域本地语义（无 GB 档），这里收口一个 GB 感知的通用版
// ——新消费方统一走这里，不复制第三份本地实现

/** 字节数 → 人类可读（B/KB/MB/GB；digits = 小数位，0/非法值恒「0 B」） */
export function formatBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const k = 1024
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(k)), units.length - 1)
  return `${(n / k ** i).toFixed(i === 0 ? 0 : digits)} ${units[i]}`
}

/**
 * 占用是否进入预警档（>80%，容量护栏「撞 413 才知」的提前量）。
 * 交叉相乘免浮点除法边界（5·used > 4·cap ⇔ used/cap > 0.8，80% 恰好不预警）；
 * cap 非正数（护栏值未下发）恒 false——不预警比误报安全
 */
export function usageExceeds(totalBytes: number, capBytes: number): boolean {
  if (capBytes <= 0 || totalBytes <= 0) return false
  return totalBytes * 5 > capBytes * 4
}
