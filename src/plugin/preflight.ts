import type { Issue, PreflightResult, PrintSize } from '../shared/types'
import type { PreflightThresholds } from '../shared/constants'
import { imageDpiMinimum, pxToMm } from '../shared/constants'
import { rgbToCmyk } from '../shared/color'
import { readPrintSize, printScale } from './printSize'
import { multiply, maxScale, minScale, imagePixelMatrix, type Linear } from '../shared/geometry'
import {
  getTargetFrames,
  walk,
  relativeMatrix,
  relativeRenderBounds,
  isPrintable,
  nextIssueId,
} from './utils'

export interface PreflightOptions {
  target: 'selection' | 'page'
  thresholds: PreflightThresholds
  safetyMargin: number
}

export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  const start = Date.now()
  const { target, thresholds, safetyMargin } = options
  const frames = getTargetFrames(target)
  if (!frames.length) throw new Error('请先选中需要预检的原稿画板')
  const issues: Issue[] = []
  let nodeCount = 0
  const skippedFrames: PreflightResult['skippedFrames'] = []

  const availableFonts = await figma.listAvailableFontsAsync()
  const fontSet = new Set(
    availableFonts.map((f) => f.fontName.family + '||' + f.fontName.style)
  )

  for (const frame of frames) {
    const saved = readPrintSize(frame)
    const size = saved.status === 'valid' ? saved.size : saved.status==='unset' ? {widthMm:pxToMm(frame.width),heightMm:pxToMm(frame.height)} : undefined
    if (!size) skippedFrames.push({ id: frame.id, name: frame.name, reason: saved.status === 'stale' ? '画板尺寸已变化，请重新确认成品尺寸' : '尚未设置成品尺寸' })
    const nodes: BaseNode[] = [frame]
    walk(frame, (n) => nodes.push(n))

    for (const node of nodes) {
      if (!isPrintable(node)) continue
      nodeCount += 1

      if (node.type === 'TEXT') {
        await checkText(node, frame, thresholds, fontSet, issues, size)
        if (size) checkSafeArea(node, frame, safetyMargin, issues, size)
      }

      if (size) {
        await checkImageDpi(node, frame, thresholds, issues, size)
        checkStroke(node, frame, thresholds, issues, size)
      }
      checkRasterEffect(node, frame, issues)
    }
  }

  return {
    target,
    frameCount: frames.length,
    nodeCount,
    issues,
    errorCount: issues.filter((i) => i.severity === 'error').length,
    warningCount: issues.filter((i) => i.severity === 'warning').length,
    durationMs: Date.now() - start,
    targetDpi: thresholds.targetDpi,
    complete: skippedFrames.length === 0 && frames.length > 0 && !issues.some(i => i.type === 'image-dpi-unavailable'),
    skippedFrames,
  }
}

function physicalMatrix(node: BaseNode, frame: FrameNode, size: PrintSize): Linear {
  const r = relativeMatrix(node, frame), scale = printScale(frame, size)
  return multiply([scale.x,0,0,scale.y], [r[0][0],r[1][0],r[0][1],r[1][1]])
}

// ============ 图片 DPI ============
async function checkImageDpi(
  node: BaseNode,
  frame: FrameNode,
  thresholds: PreflightThresholds,
  issues: Issue[],
  printSize: PrintSize
) {
  if (!('fills' in node) || !('width' in node)) return
  let fills = (node as MinimalFillsMixin).fills
  if (fills === figma.mixed || !Array.isArray(fills)) return

  const physical = physicalMatrix(node, frame, printSize)
  const reported = new Set<string>()

  for (const paint of fills) {
    if (paint.type !== 'IMAGE' || paint.visible === false || paint.opacity === 0) continue
    if (!paint.imageHash) continue
    const image = figma.getImageByHash(paint.imageHash)
    if (!image) {
      issues.push({id:nextIssueId(),type:'image-dpi-unavailable',severity:'info',title:'图片 DPI 无法检查',message:'原图不可用，请检查图片填充',nodeId:node.id,nodeName:node.name,frameName:frame.name})
      continue
    }

    let size: { width: number; height: number }
    try {
      size = await image.getSizeAsync()
    } catch {
      issues.push({ id: nextIssueId(), type: 'image-dpi-unavailable', severity: 'info', title: '图片 DPI 无法检查', message: '无法读取原图像素尺寸，请检查图片是否可用', nodeId: node.id, nodeName: node.name, frameName: frame.name })
      continue
    }

    const pixels = imagePixelMatrix(paint, (node as LayoutMixin).width, (node as LayoutMixin).height, size.width, size.height)
    const pixelPoints = pixels && multiply(physical, pixels)
    const pixelScale = pixelPoints && maxScale(pixelPoints)
    if (!pixelPoints || !pixelScale || !Number.isFinite(pixelScale)) {
      issues.push({ id: nextIssueId(), type: 'image-dpi-unavailable', severity: 'info', title: '图片 DPI 无法检查', message: '图片变换无效，无法确定实际放置尺寸', nodeId: node.id, nodeName: node.name, frameName: frame.name })
      continue
    }
    const dpi = 72 / pixelScale
    const displayedW = Math.hypot(pixelPoints[0],pixelPoints[1])*size.width*25.4/72
    const displayedH = Math.hypot(pixelPoints[2],pixelPoints[3])*size.height*25.4/72

    const key = paint.imageHash
    const minimumDpi = imageDpiMinimum(thresholds.targetDpi)
    if (dpi < minimumDpi && !reported.has(key)) {
      reported.add(key)
      issues.push({
        id: nextIssueId(),
        type: 'low-dpi',
        severity: dpi < minimumDpi * 0.5 ? 'error' : 'warning',
        title: '图片分辨率不足',
        message: `有效约 ${Math.round(dpi)} DPI，建议 ≥ ${minimumDpi} DPI`,
        nodeId: node.id,
        nodeName: node.name,
        frameName: frame.name,
        detail: `原图 ${size.width}×${size.height}px · 完整原图放置约 ${displayedW.toFixed(1)}×${displayedH.toFixed(1)}mm（裁切不增加细节） · 成品 ${printSize.widthMm.toFixed(1)}×${printSize.heightMm.toFixed(1)}mm · 导出 ${thresholds.targetDpi} DPI`,
      })
    }
  }
}

// ============ 文本（四色黑 / 小字 / 缺失字体）============
async function checkText(
  node: TextNode,
  frame: FrameNode,
  thresholds: PreflightThresholds,
  fontSet: Set<string>,
  issues: Issue[],
  size?: PrintSize
) {
  await loadAllFonts(node)

  // 缺失字体
  for (const f of collectFonts(node)) {
    if (!fontSet.has(f.family + '||' + f.style)) {
      issues.push({
        id: nextIssueId(),
        type: 'missing-font',
        severity: 'error',
        title: '字体缺失',
        message: `“${f.family} ${f.style}” 不可用，可能导致字体替换/排版错位`,
        nodeId: node.id,
        nodeName: node.name,
        frameName: frame.name,
        detail: '建议在 Figma 中安装字体或将文字转曲',
      })
    }
  }

  const reported = new Set<string>()

  // 快速路径：整段字号与填充一致
  if (typeof node.fontSize === 'number' && Array.isArray(node.fills)) {
    evaluateTextStyle(size ? node.fontSize * minScale(physicalMatrix(node,frame,size)) : undefined, node.fills as Paint[], node, frame, thresholds, issues, reported)
    return
  }

  // 混合路径：逐字符
  const len = node.characters.length
  for (let i = 0; i < len; i++) {
    const fontSize = node.getRangeFontSize(i, i + 1) as number
    const fills = node.getRangeFills(i, i + 1) as Paint[]
    evaluateTextStyle(size ? fontSize * minScale(physicalMatrix(node,frame,size)) : undefined, fills, node, frame, thresholds, issues, reported)
  }
}

function evaluateTextStyle(
  size: number | undefined,
  fills: Paint[],
  node: TextNode,
  frame: FrameNode,
  thresholds: PreflightThresholds,
  issues: Issue[],
  reported: Set<string>
) {
  // 极小文字
  if (size !== undefined && size < thresholds.minFontSizePt) {
    const key = 'tiny|' + size
    if (!reported.has(key)) {
      reported.add(key)
      issues.push({
        id: nextIssueId(),
        type: 'tiny-text',
        severity: 'warning',
        title: '文字过小',
        message: `实际字号约 ${size.toFixed(2)}pt，可能印刷不清，建议 ≥ ${thresholds.minFontSizePt}pt`,
        nodeId: node.id,
        nodeName: node.name,
        frameName: frame.name,
      })
    }
  }

  const solid = fills.find((p): p is SolidPaint => p.type === 'SOLID' && p.visible !== false)
  if (!solid) return
  const cmyk = rgbToCmyk({
    r: Math.round(solid.color.r * 255),
    g: Math.round(solid.color.g * 255),
    b: Math.round(solid.color.b * 255),
  })

  // 小字四色黑
  if (
    (size === undefined || size <= thresholds.smallTextPt) &&
    cmyk.k >= thresholds.darkKThreshold &&
    (cmyk.c > thresholds.cmyThreshold ||
      cmyk.m > thresholds.cmyThreshold ||
      cmyk.y > thresholds.cmyThreshold)
  ) {
    const key = '4c|' + size + '|' + `${cmyk.c},${cmyk.m},${cmyk.y},${cmyk.k}`
    if (!reported.has(key)) {
      reported.add(key)
      issues.push({
        id: nextIssueId(),
        type: 'four-color-black',
        severity: size === undefined ? 'info' : 'error',
        title: size === undefined ? '文字含多色黑（待确认尺寸）' : '小字使用四色黑',
        message: `${size === undefined ? '尚未判断实际字号' : `实际字号约 ${size.toFixed(2)}pt`}，估算色值 C${cmyk.c} M${cmyk.m} Y${cmyk.y} K${cmyk.k}`,
        detail: '套印偏差易产生彩边/重影，建议改为 C0 M0 Y0 K100 单黑',
        nodeId: node.id,
        nodeName: node.name,
        frameName: frame.name,
        fixable: true,
      })
    }
  }
}

// ============ 安全区（文字）============
function checkSafeArea(
  node: TextNode,
  frame: FrameNode,
  safetyMargin: number,
  issues: Issue[],
  size: PrintSize
) {
  if (safetyMargin <= 0 || !node.characters.trim()) return
  const box = relativeRenderBounds(node, frame)
  if (!box || box.width<=0 || box.height<=0) return
  // Entirely clipped text outside the finished page is not near its trim line.
  if (frame.clipsContent && (box.x+box.width<=0 || box.y+box.height<=0 || box.x>=frame.width || box.y>=frame.height)) return
  const scale = printScale(frame,size)
  const mmPerPoint=25.4/72
  const distances = [box.x*scale.x,box.y*scale.y,(frame.width-box.x-box.width)*scale.x,(frame.height-box.y-box.height)*scale.y].map(value=>value*mmPerPoint)
  const closest=Math.min(...distances)
  if (closest < safetyMargin) {
    issues.push({
      id: nextIssueId(),
      type: 'safe-area',
      severity: 'warning',
      title: '文字靠近裁切线',
      message: closest<=0 ? '文字渲染范围触及或超出成品边缘，请检查裁切位置。' : `文字距成品边缘约 ${closest.toFixed(1)}mm，建议至少留 ${safetyMargin}mm。`,
      detail: '按文字渲染范围检查；出血在裁切线外，不增加成品内的安全边距。',
      nodeId: node.id,
      nodeName: node.name,
      frameName: frame.name,
    })
  }
}

// ============ 细线 ============
function checkStroke(
  node: BaseNode,
  frame: FrameNode,
  thresholds: PreflightThresholds,
  issues: Issue[],
  size: PrintSize
) {
  if (!('strokeWeight' in node) || !('strokes' in node)) return
  const strokes = (node as MinimalStrokesMixin).strokes
  if (!Array.isArray(strokes) || strokes.length === 0) return
  const weight = (node as GeometryMixin).strokeWeight
  if (typeof weight !== 'number') return

  const scale = minScale(physicalMatrix(node,frame,size))
  const realWeight = weight * scale
  if (realWeight < thresholds.minLineWidthPt) {
    issues.push({
      id: nextIssueId(),
      type: 'thin-line',
      severity: 'warning',
      title: '线条过细',
      message: `描边约 ${realWeight.toFixed(2)}pt，印刷可能丢失，建议 ≥ ${thresholds.minLineWidthPt}pt`,
      nodeId: node.id,
      nodeName: node.name,
      frameName: frame.name,
    })
  }
}

// ============ 栅格化效果 ============
function checkRasterEffect(node: BaseNode, frame: FrameNode, issues: Issue[]) {
  if (!('effects' in node)) return
  const effects = (node as BlendMixin).effects
  if (!Array.isArray(effects)) return
  const hasRaster = effects.some(
    (e) =>
      e.visible !== false &&
      (e.type === 'DROP_SHADOW' ||
        e.type === 'INNER_SHADOW' ||
        e.type === 'LAYER_BLUR' ||
        e.type === 'BACKGROUND_BLUR')
  )
  if (hasRaster) {
    issues.push({
      id: nextIssueId(),
      type: 'rasterized-effect',
      severity: 'info',
      title: '含阴影/模糊效果',
      message: '矢量模式保留 Figma 原生局部位图；导出会检查实际有效 DPI。提高设置值不会自动增加效果位图细节。',
      nodeId: node.id,
      nodeName: node.name,
      frameName: frame.name,
    })
  }
}

// ============ 字体辅助 ============
async function loadAllFonts(text: TextNode): Promise<void> {
  try {
    if (text.fontName !== figma.mixed) {
      await figma.loadFontAsync(text.fontName)
      return
    }
    const fonts = collectFonts(text)
    for (const f of fonts) {
      try {
        await figma.loadFontAsync(f)
      } catch {
        // 忽略单个字体加载失败
      }
    }
  } catch {
    // 忽略
  }
}

function collectFonts(text: TextNode): FontName[] {
  const map = new Map<string, FontName>()
  const add = (f: FontName) => {
    const key = f.family + '||' + f.style
    if (!map.has(key)) map.set(key, f)
  }
  if (text.fontName !== figma.mixed) {
    add(text.fontName)
  } else {
    for (let i = 0; i < text.characters.length; i++) {
      const f = text.getRangeFontName(i, i + 1)
      if (f !== figma.mixed) add(f)
    }
  }
  return [...map.values()]
}
