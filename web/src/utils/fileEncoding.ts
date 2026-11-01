// 文件编码标签词汇表（P-20261002-146）：与服务端 filepolicy 支持的编码
// （server/filepolicy/encoding.go 的 EncodingGBK/Big5/UTF16LE/UTF16BE，空 = UTF-8）
// 一一对应。编码名是专有名词（GBK/UTF-8…），zh/en 同形，不走 i18n。

/** 编码选项（value 即服务端标签：空串 = UTF-8，保存/载入时原样回传） */
export interface EncodingOption {
  value: string
  label: string
}

/** 编码选择菜单的固定选项序（产品主场景中文 Windows：GBK 紧随 UTF-8） */
export const FILE_ENCODINGS: EncodingOption[] = [
  { value: '', label: 'UTF-8' },
  { value: 'gbk', label: 'GBK' },
  { value: 'big5', label: 'Big5' },
  { value: 'utf16le', label: 'UTF-16 LE' },
  { value: 'utf16be', label: 'UTF-16 BE' },
]

/** 服务端编码标签 → 徽标/提示展示名；未知标签大写兜底（不吞未来新增编码） */
export function encodingLabel(encoding?: string): string {
  const found = FILE_ENCODINGS.find(o => o.value === (encoding || ''))
  return found?.label ?? (encoding ? encoding.toUpperCase() : 'UTF-8')
}

/** 菜单行 data-testid 后缀：空标签给语义化名字（testid 不允许空段） */
export function encodingTestId(encoding: string): string {
  return encoding || 'utf8'
}
