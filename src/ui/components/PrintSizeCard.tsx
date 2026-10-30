import React from 'react'
import type { FrameInfo } from '../../shared/types'
import { draftValues, draftError, type SizeDrafts } from '../sizeDrafts'
import type { PrintSize } from '../../shared/types'
import { integerMmInput, originalSizeForPrint, PRINT_SIZE_OPTIONS } from '../../shared/printDimensions'

export function PrintSizeCard({frames,drafts,errors,disabled,saving,onChange,onSave,onPreset,showResizeOriginal,resizeOriginal,onResizeOriginal,scaleContent,onScaleContent}: {
  frames:FrameInfo[]
  drafts:SizeDrafts
  errors:Record<string,string>
  disabled:boolean
  saving:boolean
  onChange:(frame:FrameInfo,value:string,axis:'width'|'height')=>void
  onSave:()=>void
  onPreset:(size:PrintSize)=>void
  showResizeOriginal:boolean
  resizeOriginal:boolean
  onResizeOriginal:(value:boolean)=>void
  scaleContent:boolean
  onScaleContent:(value:boolean)=>void
}) {
  const changed = frames.some(frame=>!!drafts[frame.id])
  const configured = frames.length>0 && !changed && frames.every(frame=>frame.printSizeStatus==='valid')
  const selectedPreset=frames.length ? PRINT_SIZE_OPTIONS.find(p=>frames.every(frame=>{
    const values=draftValues(frame,drafts[frame.id])
    return Number(values.width)===p.w && Number(values.height)===p.h
  })) : undefined
  return <div className="card print-size-editor">
    <div className="card-title">设置实际印刷尺寸</div>
    {frames.length>0 && <div className="field">
      <select id="size-preset" className="select" aria-label="画板尺寸预设" value={selectedPreset?.name??''} disabled={disabled} onChange={e=>{
        const p=PRINT_SIZE_OPTIONS.find(p=>p.name===e.target.value);if(p)onPreset({widthMm:p.w,heightMm:p.h})
        else for(const frame of frames){onChange(frame,'','width');onChange(frame,'','height')}
      }}><option value="">自定义尺寸</option>{PRINT_SIZE_OPTIONS.map(p=><option key={p.name} value={p.name}>{p.name}</option>)}</select>
    </div>}
    {frames.length===0 ? <div className="hint">请先选中原稿画板。</div> : frames.map(frame=>{
      const draft = drafts[frame.id], values = draftValues(frame,draft)
      const needsConfirm = (draft && (draft.widthPx!==frame.widthPx || draft.heightPx!==frame.heightPx)) || (!draft && frame.printSizeStatus==='stale')
      const error = errors[frame.id] || (draft ? draftError(frame,draft) : undefined)
      const size={widthMm:Number(values.width),heightMm:Number(values.height)}
      const target=resizeOriginal && !needsConfirm && !error && Number.isFinite(size.widthMm) && Number.isFinite(size.heightMm) && size.widthMm>0 && size.heightMm>0
        ? originalSizeForPrint(frame.widthPx,frame.heightPx,size) : undefined
      return <div className="print-size-row" key={frame.id}>
        <div className="print-size-head">
          <span className="print-size-name">{frame.name}</span>
          {needsConfirm ? <button className="btn-ghost size-status warning" disabled={disabled} onClick={()=>onChange(frame,values.width,'width')}>重新确认</button>
            : <span className={`size-status ${draft ? 'warning' : ''}`}>{draft ? '未设置' : frame.printSizeStatus==='valid' ? '已设置' : '未设置'}</span>}
        </div>
        <div className="row">
          <div className="field"><label className="field-label" htmlFor={`print-width-${frame.id}`}>宽度 (mm)</label>
            <input id={`print-width-${frame.id}`} className="input" type="number" min="1" step="1" value={integerMmInput(values.width)} disabled={disabled} aria-invalid={!!error} onChange={e=>onChange(frame,e.target.value,'width')} /></div>
          <div className="field"><label className="field-label" htmlFor={`print-height-${frame.id}`}>高度 (mm)</label>
            <input id={`print-height-${frame.id}`} className="input" type="number" min="1" step="1" value={integerMmInput(values.height)} disabled={disabled} aria-invalid={!!error} onChange={e=>onChange(frame,e.target.value,'height')} /></div>
        </div>
        {error && <div className="size-error" role="alert">{error}</div>}
        {draft?.automatic && !needsConfirm && <div className="size-note">已按比例匹配预置尺寸，请确认后点击“设置尺寸”。</div>}
        {target && <div className="size-note size-resize-preview">{target.widthPx===frame.widthPx && target.heightPx===frame.heightPx
          ? `比例一致，原稿保持 ${Math.round(frame.widthPx)} × ${Math.round(frame.heightPx)} px。`
          : `设置后原稿：${target.widthPx} × ${target.heightPx} px。`}</div>}
      </div>
    })}
    <div className="size-save">
      {showResizeOriginal && <>
        <label className="check-line resize-option"><input type="checkbox" aria-label="按成品比例调整原稿" checked={resizeOriginal} disabled={disabled} onChange={e=>onResizeOriginal(e.target.checked)} /><span>按成品比例调整原稿<span className="resize-option-hint">（比例不一致，建议勾选）</span></span></label>
        {resizeOriginal && <label className="check-line"><input type="checkbox" checked={scaleContent} disabled={disabled} onChange={e=>onScaleContent(e.target.checked)} /><span>等比缩放内容</span></label>}
        {resizeOriginal && <div className="size-note">保留原宽度，调整高度为整数像素；内容按需等比缩放。</div>}
      </>}
      <button className="btn btn-primary" disabled={!changed || disabled} onClick={onSave}>{saving ? '正在设置…' : configured ? '已设置' : '设置尺寸'}</button>
    </div>
  </div>
}
