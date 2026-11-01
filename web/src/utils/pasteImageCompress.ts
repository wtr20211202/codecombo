/**
 * 粘贴图片前端压缩（P-20261003-204）：终端图片粘贴此前原图直传，大截图
 * （Retina 5MB+）上传慢；canvas 重采样（等比缩至最长边 ≤1920px + JPEG 质量
 * 0.85）后体积降一个量级。压缩是纯增强——任何一步失败整体降级原图，
 * 绝不阻塞粘贴。
 *
 * 质量取向「从高」（提案注记）：代码截图 OCR 是主要场景，agent 要读图，
 * 过度压缩得不偿失——① 1920px/0.85 只在「确有收益」时执行：未超尺寸且
 * ≤1MB 的小图原样直传；② 编码结果不比原图小时回退原图（纯色图形 PNG
 * 压得极好，JPEG 重编码反而可能更大）；③ GIF 可能是动图（canvas 重编码
 * 丢帧）、WebP 等罕见类型不冒险，白名单外一律原样直传。
 *
 * 性能：粘贴是用户触发的单次动作非热路径；解码走 createImageBitmap
 * （浏览器离线程），缩放画布 ≤1920×1920，PNG 透明检测一次步进扫描
 * （~3.7M 字节，毫秒级），整体几十毫秒量级，粘贴感知延迟可忽略。
 */

/** 等比缩放上限（最长边）。Retina 截图典型 2560~3840，缩到 1920 代码文字仍可读 */
export const PASTE_IMAGE_MAX_EDGE = 1920
/** JPEG 编码质量：0.85 对文字截图是「清晰可 OCR」档（0.7 以下文字明显发糊） */
export const PASTE_IMAGE_JPEG_QUALITY = 0.85
/** 体积门槛：未超尺寸且 ≤1MB 原样直传——内网传输无感，重编码徒增画质损失 */
export const PASTE_IMAGE_MIN_COMPRESS_BYTES = 1024 * 1024

/** 可压缩类型白名单：剪贴板截图现实上只有 PNG（系统截图）/JPEG（网页图片复制） */
export function isCompressiblePasteImage(type: string): boolean {
  return type === 'image/png' || type === 'image/jpeg'
}

/**
 * 压缩决策（纯函数，单测覆盖阈值矩阵）：返回编码目标 mime，null = 原样直传。
 * hasAlpha 仅对 PNG 有意义——透明 PNG 转 JPEG 会丢 alpha（透明区塌成黑底），
 * 检测到实际透明像素时保留 PNG（仅缩放场景重编码 PNG 才有体积收益）。
 */
export function planPasteImageCompress(
  mime: string,
  width: number,
  height: number,
  bytes: number,
  hasAlpha = false,
): 'image/jpeg' | 'image/png' | null {
  if (!isCompressiblePasteImage(mime)) return null
  const needsScale = Math.max(width, height) > PASTE_IMAGE_MAX_EDGE
  if (!needsScale && bytes <= PASTE_IMAGE_MIN_COMPRESS_BYTES) return null
  if (mime === 'image/png' && hasAlpha) return needsScale ? 'image/png' : null
  return 'image/jpeg'
}

/** 逐像素扫 alpha：任一像素非完全不透明即视为带透明（圆角窗口截图、局部标注等
 * 透明常是局部的，必须全量扫）。RGBA 布局下 alpha 在每像素第 4 字节 */
export function hasTransparentPixels(rgba: Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) return true
  }
  return false
}

/**
 * 压缩入口：tryPasteImage 在构造 File 后、上传前调用。返回压缩产物
 * （File，名字/类型随目标格式）或原 file（无需压缩/任何失败降级）。
 */
export async function compressPasteImage(file: File): Promise<File> {
  try {
    if (!isCompressiblePasteImage(file.type)) return file
    if (typeof createImageBitmap !== 'function') return file
    const bitmap = await createImageBitmap(file)
    try {
      const needsScale = Math.max(bitmap.width, bitmap.height) > PASTE_IMAGE_MAX_EDGE
      // 早退：未超尺寸且不超体积，PNG/JPEG 都无收益（PNG 透明与否均不重编码）
      if (!needsScale && file.size <= PASTE_IMAGE_MIN_COMPRESS_BYTES) return file
      const scale = PASTE_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height)
      const w = Math.max(1, Math.round(bitmap.width * (scale < 1 ? scale : 1)))
      const h = Math.max(1, Math.round(bitmap.height * (scale < 1 ? scale : 1)))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      // willReadFrequently：画后要 getImageData 扫 alpha，CPU 画布免 GPU 回读惩罚
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return file
      ctx.drawImage(bitmap, 0, 0, w, h)
      // PNG 目标格式取决于透明检测（需先画一帧才有像素）；JPEG 无 alpha 直判
      const hasAlpha = file.type === 'image/png'
        ? hasTransparentPixels(ctx.getImageData(0, 0, w, h).data)
        : false
      const target = planPasteImageCompress(file.type, bitmap.width, bitmap.height, file.size, hasAlpha)
      if (!target) return file
      const blob = await new Promise<Blob | null>(resolve =>
        canvas.toBlob(resolve, target, PASTE_IMAGE_JPEG_QUALITY))
      // 编码失败或结果不比原图小：降级原图（重编码不获益就别损失画质）
      if (!blob || blob.size >= file.size) return file
      const ext = target === 'image/jpeg' ? 'jpg' : 'png'
      return new File([blob], `pasted.${ext}`, { type: target })
    } finally {
      bitmap.close()
    }
  } catch {
    // 解码/画布/编码任一失败：压缩是增强不是门槛，降级原图照常上传
    return file
  }
}
