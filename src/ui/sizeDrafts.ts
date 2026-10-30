import type { FrameInfo, PrintSizeUpdate } from '../shared/types'
import { preciseMm, integerMmInput, roundedPreset, sizeFitsRatio, matchingPrintPreset } from '../shared/printDimensions'

export interface SizeDraft {
  width: string
  height: string
  widthPx: number
  heightPx: number
  editedAxis?: 'width'|'height'
  freeRatio?: boolean
  automatic?: boolean
}
export type SizeDrafts = Record<string, SizeDraft>

export function fillMatchingPresets(frames:FrameInfo[],previous:SizeDrafts):SizeDrafts {
  const next={...previous}
  for(const frame of frames) {
    const draft=next[frame.id]
    if(frame.printSizeStatus!=='unset' || frame.printSize || (draft && !draft.automatic))continue
    if(draft && draft.widthPx===frame.widthPx && draft.heightPx===frame.heightPx)continue
    const preset=matchingPrintPreset(frame.widthPx,frame.heightPx)
    if(preset)next[frame.id]={width:String(preset.w),height:String(preset.h),widthPx:frame.widthPx,heightPx:frame.heightPx,automatic:true}
    else if(draft?.automatic)delete next[frame.id]
  }
  return next
}

export function draftValues(frame: FrameInfo, draft?: SizeDraft): SizeDraft {
  return draft ?? {width:frame.printSize ? preciseMm(frame.printSize.widthMm) : '',
    height:frame.printSize ? preciseMm(frame.printSize.heightMm) : '', widthPx:frame.widthPx, heightPx:frame.heightPx}
}

export function changeSize(frame: FrameInfo, value: string, axis: 'width'|'height', free=false, previous?:SizeDraft): SizeDraft {
  value=integerMmInput(value)
  const current=previous?.widthPx===frame.widthPx && previous.heightPx===frame.heightPx ? previous : undefined
  // Link the first edit; editing the other dimension explicitly sets a custom ratio.
  if(free || current?.freeRatio || (current?.editedAxis && current.editedAxis!==axis))
    return {...draftValues(frame,previous),[axis]:value,widthPx:frame.widthPx,heightPx:frame.heightPx,editedAxis:axis,freeRatio:true,automatic:false}
  const canonical=frame.printSizeStatus==='valid' ? frame.printSize : roundedPreset(frame.widthPx,frame.heightPx)
  const number = Number(value), ratio = canonical ? canonical.heightMm/canonical.widthMm : frame.heightPx / frame.widthPx
  const other = value !== '' && Number.isFinite(number) && number > 0
    ? preciseMm(axis === 'width' ? number*ratio : number/ratio) : ''
  return {width:axis==='width' ? value : other, height:axis==='height' ? value : other,
    widthPx:frame.widthPx, heightPx:frame.heightPx,editedAxis:axis}
}

export function hasSizeRatioMismatch(frames:FrameInfo[],drafts:SizeDrafts):boolean {
  return frames.some(frame=>{
    const values=draftValues(frame,drafts[frame.id]),size={widthMm:Number(values.width),heightMm:Number(values.height)}
    return Number.isFinite(size.widthMm) && Number.isFinite(size.heightMm) && size.widthMm>0 && size.heightMm>0 &&
      !sizeFitsRatio(frame.widthPx,frame.heightPx,size)
  })
}

export function draftError(frame: FrameInfo, draft: SizeDraft): string | undefined {
  if (draft.widthPx !== frame.widthPx || draft.heightPx !== frame.heightPx) return '原稿尺寸已变化，请重新确认成品尺寸'
  if (!draft.width.trim() || !draft.height.trim() || !Number.isFinite(Number(draft.width)) || !Number.isFinite(Number(draft.height)) || Number(draft.width)<=0 || Number(draft.height)<=0) return '请输入有效的宽高'
  return undefined
}

export function sizeUpdate(frame: FrameInfo, draft: SizeDraft): PrintSizeUpdate {
  return {frameId:frame.id, widthMm:Number(draft.width), heightMm:Number(draft.height), widthPx:draft.widthPx, heightPx:draft.heightPx}
}
