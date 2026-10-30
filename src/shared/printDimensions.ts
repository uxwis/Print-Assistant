import { SIZE_PRESETS, mmToPx } from './constants'
import type { PrintSize } from './types'

export const displayMm=(value:number)=>String(Math.round(value))

// Keep calculation precision separate from the integer labels shown in the UI.
export const preciseMm=(value:number)=>String(Number(value.toFixed(2)))
export const integerMmInput=(value:string)=>value==='' ? '' : displayMm(Number(value))

// Include rotated presets without duplicating dimensions already in the list.
export const PRINT_SIZE_OPTIONS = [...SIZE_PRESETS]
for(const p of SIZE_PRESETS) {
  if(!PRINT_SIZE_OPTIONS.some(other=>other.w===p.h && other.h===p.w))
    PRINT_SIZE_OPTIONS.push({name:p.name.replace(`${p.w}×${p.h}`,`${p.h}×${p.w}`)+'（旋转）',w:p.h,h:p.w})
}

export function matchingPrintPreset(widthPx:number,heightPx:number) {
  if(!Number.isFinite(widthPx+heightPx)||widthPx<=0||heightPx<=0)return
  const canonical=roundedPreset(widthPx,heightPx)
  const candidates=PRINT_SIZE_OPTIONS.filter(p=>
    Math.abs((widthPx/heightPx)/(p.w/p.h)-1)<=0.003 &&
    sizeFitsRatio(widthPx,heightPx,{widthMm:p.w,heightMm:p.h}))
  return candidates.sort((a,b)=>{
    const exact=(p:typeof a)=>canonical?.widthMm===p.w && canonical.heightMm===p.h ? 0 : 1
    const ratioError=(p:typeof a)=>Math.abs(Math.log((widthPx/heightPx)/(p.w/p.h)))
    const scaleError=(p:typeof a)=>Math.abs(Math.log(widthPx/mmToPx(p.w)))
    return exact(a)-exact(b) || ratioError(a)-ratioError(b) || scaleError(a)-scaleError(b)
  })[0]
}

// Recognize the integer-pixel rounding of an explicitly chosen standard size.
export function roundedPreset(widthPx:number,heightPx:number,size?:PrintSize): PrintSize | undefined {
  for(const p of SIZE_PRESETS) for(const [widthMm,heightMm] of [[p.w,p.h],[p.h,p.w]]) {
    if(Math.round(mmToPx(widthMm))===widthPx && Math.round(mmToPx(heightMm))===heightPx &&
      (!size || (size.widthMm===widthMm && size.heightMm===heightMm))) return {widthMm,heightMm}
  }
}

export function sizeFitsRatio(widthPx:number,heightPx:number,size:PrintSize):boolean {
  const heightError=Math.abs(size.widthMm*heightPx/widthPx-size.heightMm)
  const widthError=Math.abs(size.heightMm*widthPx/heightPx-size.widthMm)
  const canonical=roundedPreset(widthPx,heightPx)
  const presetFits=canonical && (Math.abs(size.widthMm*canonical.heightMm/canonical.widthMm-size.heightMm)<=0.00501 || Math.abs(size.heightMm*canonical.widthMm/canonical.heightMm-size.widthMm)<=0.00501)
  const pixelFits=Number.isInteger(widthPx) && Number.isInteger(heightPx) &&
    (Math.round(size.widthMm*heightPx/size.heightMm)===widthPx || Math.round(size.heightMm*widthPx/size.widthMm)===heightPx)
  return heightError<=0.00501 || widthError<=0.00501 || !!presetFits || pixelFits
}

// Existing artwork defines the design scale. Only change its aspect ratio;
// physical millimetres are applied separately to the disposable export copy.
export function originalSizeForPrint(widthPx:number,heightPx:number,size:PrintSize): {widthPx:number;heightPx:number} {
  if(sizeFitsRatio(widthPx,heightPx,size))return {widthPx,heightPx}
  const width=Math.max(1,Math.round(widthPx))
  return {widthPx:width,heightPx:Math.max(1,Math.round(width*size.heightMm/size.widthMm))}
}
