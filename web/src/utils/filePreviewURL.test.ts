// filePreviewURL 单测（P-20261119-4 S3）：统一双视图各字节面 URL 的组装与
// 编码契约。端点词表与 server/api/files/preview.go 六端点一一对应——前端
// 只有这一处落字点，路径里的空格/CJK/`&` 必须被 encodeURIComponent 吃掉
//（裸拼会让 path 截断成另一个文件，属越权面）。
import { describe, expect, it } from 'vitest'
import {
  fileDownloadURL,
  fileHtmlViewURL,
  filePreviewURL,
  fileRawURL,
} from './filePreviewURL'

const PROJ = 'proj-1'
const PATH = 'docs/我的 报告&v2.docx'

describe('filePreviewURL 族（projectId/path 编码）', () => {
  it('raw：字节内联端点 + 编码后的 path', () => {
    expect(fileRawURL(PROJ, 'a/b.png')).toBe('/api/projects/proj-1/file/raw?path=a%2Fb.png')
  })

  it('path 含空格/CJK/& 时编码为单参不截断', () => {
    const url = fileRawURL(PROJ, PATH)
    expect(url).toContain(`path=${encodeURIComponent(PATH)}`)
    expect(url).not.toContain(' ')
    // & 被编码 → 只有 path 一个查询键（裸拼会多出 v2.docx 伪键）
    expect(url.split('&')).toHaveLength(1)
  })

  it('htmlview：默认不带 scripts=1，opt-in 时带', () => {
    const base = fileHtmlViewURL(PROJ, 'page.html', false)
    expect(base).toBe('/api/projects/proj-1/file/htmlview?path=page.html')
    expect(base).not.toContain('scripts=1')
    expect(fileHtmlViewURL(PROJ, 'page.html', true)).toBe(
      '/api/projects/proj-1/file/htmlview?path=page.html&scripts=1',
    )
  })

  it('preview：渲染元数据/payload 端点', () => {
    expect(filePreviewURL(PROJ, 'a.csv')).toBe('/api/projects/proj-1/file/preview?path=a.csv')
  })

  it('download：复用既有直链端点（恒 attachment 语义）', () => {
    expect(fileDownloadURL(PROJ, 'a.pdf')).toBe('/api/projects/proj-1/file/download?path=a.pdf')
  })

  it('projectId 同样编码（不信任上游形态）', () => {
    expect(fileRawURL('p 1&x', 'a')).toBe('/api/projects/p%201%26x/file/raw?path=a')
  })
})
