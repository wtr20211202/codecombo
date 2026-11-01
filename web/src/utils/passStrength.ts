/**
 * 导出口令强度判定（P-20261003-101）纯函数：弱口令 = 长度 <12 或单字符类。
 * 导出文件是明文凭据 + SSH 私钥的 AES-256-GCM 信封，安全性完全取决于口令
 * 强度——弱口令（123456）的导出文件等于明文，弱口令警示是这条链路的最后防线。
 * 只做「弱」单档布尔判定，不分级不打分：警示不阻断（自托管用户自由度，
 * 8 位下限仍由调用方 validate 把关），强口令零提示零打扰。阈值改动只动这里，
 * 展示在 useRemoteHostTransfer 导出口令弹窗（promptDialog liveHint）。
 */

/** 弱口令判定：长度 <12，或小写/大写/数字/符号四类字符只含一类 → true */
export function isWeakExportPassphrase(pass: string): boolean {
  if (pass.length < 12) return true
  let classes = 0
  if (/[a-z]/.test(pass)) classes++
  if (/[A-Z]/.test(pass)) classes++
  if (/[0-9]/.test(pass)) classes++
  if (/[^a-zA-Z0-9]/.test(pass)) classes++
  return classes < 2
}
