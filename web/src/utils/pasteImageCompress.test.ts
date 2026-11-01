import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PASTE_IMAGE_JPEG_QUALITY,
  PASTE_IMAGE_MAX_EDGE,
  PASTE_IMAGE_MIN_COMPRESS_BYTES,
  compressPasteImage,
  hasTransparentPixels,
  isCompressiblePasteImage,
  planPasteImageCompress,
} from './pasteImageCompress'

function makeFile(bytes: number, type: string, name = 'pasted.png'): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

/** jsdom 无 ImageBitmap 构造器：测试桩用最小结构满足 compressPasteImage 的消费面 */
class ImageBitmapLike {
  width: number
  height: number
  close(): void { /* no-op */ }
  constructor(width: number, height: number, _source: Blob) {
    this.width = width
    this.height = height
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isCompressiblePasteImage', () => {
  it('白名单只放行 PNG/JPEG（GIF 可能是动图、WebP 罕见不冒险）', () => {
    expect(isCompressiblePasteImage('image/png')).toBe(true)
    expect(isCompressiblePasteImage('image/jpeg')).toBe(true)
    expect(isCompressiblePasteImage('image/gif')).toBe(false)
    expect(isCompressiblePasteImage('image/webp')).toBe(false)
    expect(isCompressiblePasteImage('')).toBe(false)
  })
})

describe('planPasteImageCompress 决策矩阵', () => {
  it('小图（未超尺寸且 ≤1MB）原样直传', () => {
    expect(planPasteImageCompress('image/png', 1000, 800, 512 * 1024)).toBeNull()
    expect(planPasteImageCompress('image/jpeg', 1920, 1080, PASTE_IMAGE_MIN_COMPRESS_BYTES)).toBeNull()
  })

  it('未超尺寸但超体积：不透明 PNG 转 JPEG（PNG 截图编码低效）', () => {
    expect(planPasteImageCompress('image/png', 1000, 800, 2 * 1024 * 1024)).toBe('image/jpeg')
  })

  it('透明 PNG 未超尺寸：转 JPEG 会丢 alpha → 不压缩', () => {
    expect(planPasteImageCompress('image/png', 1000, 800, 2 * 1024 * 1024, true)).toBeNull()
  })

  it('超尺寸（>1920 最长边）：不透明走 JPEG，透明保 PNG（仅缩放重编码才有收益）', () => {
    const big = PASTE_IMAGE_MAX_EDGE + 1
    expect(planPasteImageCompress('image/png', big, 800, 100 * 1024)).toBe('image/jpeg')
    expect(planPasteImageCompress('image/png', 1000, big, 100 * 1024, true)).toBe('image/png')
    // 恰好 1920 不算超尺寸
    expect(planPasteImageCompress('image/png', PASTE_IMAGE_MAX_EDGE, 1080, 100 * 1024)).toBeNull()
  })

  it('JPEG 无 alpha 概念：超尺寸即转（等比缩放 + 重编码）', () => {
    expect(planPasteImageCompress('image/jpeg', 4000, 3000, 5 * 1024 * 1024)).toBe('image/jpeg')
    expect(planPasteImageCompress('image/jpeg', 1000, 800, 2 * 1024 * 1024)).toBe('image/jpeg')
  })

  it('白名单外类型一律不压缩', () => {
    expect(planPasteImageCompress('image/gif', 4000, 3000, 5 * 1024 * 1024)).toBeNull()
    expect(planPasteImageCompress('image/webp', 4000, 3000, 5 * 1024 * 1024, true)).toBeNull()
  })

  it('导出常量与提案锚点一致（1920 / 0.85）', () => {
    expect(PASTE_IMAGE_MAX_EDGE).toBe(1920)
    expect(PASTE_IMAGE_JPEG_QUALITY).toBe(0.85)
  })
})

describe('hasTransparentPixels', () => {
  it('全不透明 → false；任一像素 alpha<255 → true（透明常是局部：圆角/标注）', () => {
    const opaque = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255])
    expect(hasTransparentPixels(opaque)).toBe(false)
    const withAlpha = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 128])
    expect(hasTransparentPixels(withAlpha)).toBe(true)
    const clear = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 0])
    expect(hasTransparentPixels(clear)).toBe(true)
    expect(hasTransparentPixels(new Uint8ClampedArray(0))).toBe(false)
  })
})

describe('compressPasteImage 降级路径（jsdom 无解码/画布能力）', () => {
  it('createImageBitmap 不可用：原样返回同一 File（压缩失败降级原图）', async () => {
    const file = makeFile(2 * 1024 * 1024, 'image/png')
    expect(await compressPasteImage(file)).toBe(file)
  })

  it('白名单外类型（GIF）：不进解码直接原样返回', async () => {
    const file = makeFile(2 * 1024 * 1024, 'image/gif')
    expect(await compressPasteImage(file)).toBe(file)
  })

  it('解码 reject：catch 降级原图不抛出', async () => {
    vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('forced e2e failure')))
    const file = makeFile(2 * 1024 * 1024, 'image/png')
    expect(await compressPasteImage(file)).toBe(file)
  })

  it('画布上下文缺失（jsdom getContext 返回 null）：降级原图', async () => {
    vi.stubGlobal('createImageBitmap', (blob: Blob) =>
      Promise.resolve(new ImageBitmapLike(2600, 1600, blob)))
    const file = makeFile(2 * 1024 * 1024, 'image/png')
    expect(await compressPasteImage(file)).toBe(file)
  })
})
