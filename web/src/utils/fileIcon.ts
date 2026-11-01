// 文件类型图标色（P-20261002-147）：文件树与编辑器 tab 色点共用的同源色表——
// 两面板的类型色识别一致，多 tab/多文件扫读提速
const EXT_COLOR_MAP: Record<string, string> = {
  ts: '#3178c6', tsx: '#3178c6', js: '#f7df1e', jsx: '#f7df1e', mjs: '#f7df1e',
  vue: '#42b883', html: '#e34c26', css: '#563d7c', scss: '#c6538c', less: '#1d365d',
  json: '#a0a0a0', md: '#519aba', py: '#3572a5', go: '#00add8', rs: '#dea584',
  java: '#b07219', kt: '#a97bff', c: '#555', cpp: '#f34b7d', h: '#555',
  cs: '#178600', rb: '#701516', php: '#4f5d95', swift: '#f05138',
  sh: '#89e051', sql: '#e38c00', yaml: '#cb171e', xml: '#e37933',
  docker: '#2496ed', env: '#ecd53f', git: '#f54d27', lock: '#a0a0a0',
}

/** 文件图标点颜色：目录统一强调蓝；文件按扩展名（大小写不敏感、取末段）查表，
 *  无扩展名/未命中回退次级文本色 */
export function getFileIconColor(name: string, isDir: boolean): string {
  if (isDir) return 'var(--accent-blue-light)'
  const ext = name.split('.').pop()?.toLowerCase() || ''
  return EXT_COLOR_MAP[ext] || 'var(--text-secondary)'
}
