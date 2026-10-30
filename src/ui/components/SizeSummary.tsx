import React from 'react'
import type { FrameInfo } from '../../shared/types'
import { displayMm } from '../../shared/printDimensions'
import { pxToMm } from '../../shared/constants'

const format = displayMm
export function SizeSummary({frames,unsaved,onEdit,disabled}: {frames:FrameInfo[];unsaved:boolean;onEdit:()=>void;disabled:boolean}) {
  const valid = frames.filter(frame=>frame.printSizeStatus==='valid').length
  const frame = frames[0]
  const text = frames.length===0 ? '请先选中原稿画板' : frames.length>1 ? `${frames.length} 个画板 · ${valid} 个已设置`
    : frame.printSizeStatus==='valid' ? `实际印刷尺寸：${format(frame.printSize!.widthMm)} × ${format(frame.printSize!.heightMm)} mm`
    : frame.printSizeStatus==='stale' ? '实际印刷尺寸：需重新确认' : `实际印刷尺寸：${format(pxToMm(frame.widthPx))}*${format(pxToMm(frame.heightPx))}mm`
  return <div className="card size-summary">
    <div className="size-summary-text"><span title={text}>{text}</span>{(unsaved || frames.some(f=>f.printSizeStatus==='unset')) && <span className="size-status warning">检测尺寸</span>}</div>
    {frames.length>0 && <button className="btn-ghost" disabled={disabled} onClick={onEdit}>{unsaved ? '去设置' : valid===frames.length ? '修改' : '去设置'}</button>}
  </div>
}
