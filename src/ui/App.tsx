import React from 'react'
import { send, onMessage, downloadBytes } from './api'
import { PreflightPanel } from './components/PreflightPanel'
import { MarksPanel } from './components/MarksPanel'
import { FrameSizeCard } from './components/FrameSizeCard'
import { PrintSizeCard } from './components/PrintSizeCard'
import { SizeSummary } from './components/SizeSummary'
import { changeSize, draftError, hasSizeRatioMismatch, sizeUpdate, fillMatchingPresets, type SizeDrafts } from './sizeDrafts'
import { displayMm, sizeFitsRatio } from '../shared/printDimensions'
import { ExportPanel } from './components/ExportPanel'
import { DEFAULT_MARKS_CONFIG } from '../shared/constants'
import type { MarksConfig, PreflightResult, CmykDataPayload, FrameInfo, PdfMode, VectorPagePayload, PrintSizesResult, PrintSize } from '../shared/types'
import { buildCmykPdf } from './pdf/cmykPdf'
import { buildCmykVectorPdf } from './pdf/vectorCmyk'
import { BUILTIN_PROFILES, type PrintProfile } from './color/icc'

type Tab = 'preflight' | 'frames' | 'export'

export default function App() {
  const [tab,setTab] = React.useState<Tab>('frames')
  const [frameMode,setFrameMode] = React.useState<'existing'|'new'>('existing')
  const [frameBusy,setFrameBusy] = React.useState(false)
  const [frames,setFrames] = React.useState<FrameInfo[]>([])
  const [preflight,setPreflight] = React.useState<PreflightResult|null>(null)
  const [pfLoading,setPfLoading] = React.useState(false)
  const [marksConfig,setMarksConfig] = React.useState<MarksConfig>(DEFAULT_MARKS_CONFIG)
  const [exportLoading,setExportLoading] = React.useState(false)
  const [exportError,setExportError] = React.useState('')
  const [warnings,setWarnings] = React.useState<string[]>([])
  const [dpi,setDpi] = React.useState(300)
  const [mode,setMode] = React.useState<PdfMode>('vector')
  const [profileId,setProfileId] = React.useState('fogra39-300')
  const [customProfile,setCustomProfile] = React.useState<PrintProfile>()
  const profile = BUILTIN_PROFILES.find(p=>p.id===profileId) ?? (profileId==='custom' ? customProfile : undefined)
  const pendingProfile = React.useRef<PrintProfile|null>(null)
  const pfRequest = React.useRef(0)
  const [drafts,setDrafts] = React.useState<SizeDrafts>({})
  const [sizeErrors,setSizeErrors] = React.useState<Record<string,string>>({})
  const [saving,setSaving] = React.useState(false)
  const [resizeOriginal,setResizeOriginal] = React.useState(false)
  const [scaleContent,setScaleContent] = React.useState(false)
  const needsRatioAdjustment=hasSizeRatioMismatch(frames,drafts)
  const adjustOriginal=resizeOriginal && needsRatioAdjustment
  const saveRequest = React.useRef(0)
  const pendingSave = React.useRef<{requestId:number}|null>(null)
  const unsaved = frames.some(frame=>!!drafts[frame.id])
  const [toast,setToast] = React.useState<{msg:string;error?:boolean}|null>(null)
  const showToast = React.useCallback((msg:string,error?:boolean)=>{
    setToast({msg,error}); setTimeout(()=>setToast(null),3500)
  },[])
  const invalidate = React.useCallback(()=>{pfRequest.current++;setPreflight(null);setPfLoading(false)},[])

  React.useEffect(()=>{
    const off = onMessage(msg=>{
      switch(msg.type) {
        case 'frame-info':
          if (msg.payload.target==='selection') {
            setFrames(msg.payload.frames)
            setDrafts(previous=>fillMatchingPresets(msg.payload.frames,previous))
            if(msg.payload.frames.length)setFrameMode('existing')
          }
          break
        case 'print-sizes-result': {
          const result = msg.payload as PrintSizesResult & {requestId:number}
          if (result.requestId!==pendingSave.current?.requestId) break
          setSaving(false);pendingSave.current=null
          if (result.errors.length) {
            setSizeErrors(Object.fromEntries(result.errors.map(error=>[error.frameId,error.message])))
            showToast('尺寸设置失败，请检查标出的画板',true)
          } else {
            setDrafts(previous=>{
              const next={...previous};for (const id of result.frameIds) delete next[id];return next
            })
            setSizeErrors({});invalidate();showToast(`已设置 ${result.frameIds.length} 个画板的尺寸`)
          }
          break
        }
        case 'frame-created': setFrameMode('existing');setFrameBusy(false);break
        case 'frame-resized':
          setFrameBusy(false)
          setDrafts(previous=>{const next={...previous};for (const id of msg.payload.frameIds ?? []) delete next[id];return next})
          setSizeErrors({});invalidate();break
        case 'preflight-invalidated': invalidate(); break
        case 'preflight-result':
          if (msg.payload.requestId!==pfRequest.current) break
          setPfLoading(false)
          if (msg.payload.stale) showToast('原稿已变化，请重新预检')
          else setPreflight(msg.payload.result)
          break
        case 'rich-black-fixed': invalidate();showToast('已转为单黑，可重新预检更新结果');break
        case 'cmyk-result': {
          const selectedProfile = pendingProfile.current
          if (!selectedProfile) break
          const output = msg.payload.mode==='vector'
            ? buildCmykVectorPdf(msg.payload.pages as VectorPagePayload[],selectedProfile,msg.payload.dpi)
            : buildCmykPdf(msg.payload.images as CmykDataPayload[],selectedProfile).then(bytes=>({bytes,warnings:[] as string[]}))
          output.then(result=>{
            downloadBytes(result.bytes,msg.payload.mode==='vector' ? 'CMYK印刷文件_矢量.pdf' : 'CMYK印刷文件_栅格.pdf','application/pdf')
            setWarnings(result.warnings)
          }).catch(e=>{setExportError(e.message);showToast(e.message,true)})
            .finally(()=>{pendingProfile.current=null;setExportLoading(false)})
          break
        }
        case 'error':
          showToast(msg.payload.message,true)
          setPfLoading(false)
          if (pendingProfile.current) setExportError(msg.payload.message)
          pendingProfile.current=null;setExportLoading(false)
          setSaving(false);pendingSave.current=null;setFrameBusy(false)
          break
      }
    })
    send('init')
    send('get-frame-info',{target:'selection'})
    return off
  },[showToast,invalidate])
  React.useEffect(()=>{invalidate()},[dpi,marksConfig.safetyMargin,invalidate])
  React.useEffect(()=>{
    if(!needsRatioAdjustment){setResizeOriginal(false);setScaleContent(false)}
  },[needsRatioAdjustment])

  const preflightBlocked=frames.some(f=>f.printSizeStatus==='stale' || (f.printSizeStatus==='valid' && !!drafts[f.id]))
  function runPreflight() {
    if (preflightBlocked || !frames.length || saving || frameBusy) return
    const requestId=++pfRequest.current
    setPreflight(null);setPfLoading(true)
    send('run-preflight',{target:'selection',dpi,safetyMargin:marksConfig.safetyMargin,requestId})
  }
  const sizesReady = frames.length>0 && frames.every(f=>f.printSizeStatus!=='stale') && !unsaved
  function doExport() {
    if (!profile || exportLoading || saving || frameBusy || !sizesReady) return
    pendingProfile.current=profile
    setExportError('');setWarnings([]);setExportLoading(true)
    send('export-cmyk',{dpi,mode,config:marksConfig})
  }
  function editSize(frame:FrameInfo,value:string,axis:'width'|'height') {
    setDrafts(previous=>({...previous,[frame.id]:changeSize(frame,value,axis,adjustOriginal,previous[frame.id])}))
    setSizeErrors(previous=>{const next={...previous};delete next[frame.id];return next})
    invalidate()
  }
  function choosePreset(size:PrintSize) {
    setDrafts(previous=>{
      const next={...previous}
      for(const frame of frames)next[frame.id]={width:displayMm(size.widthMm),height:displayMm(size.heightMm),widthPx:frame.widthPx,heightPx:frame.heightPx,freeRatio:true}
      return next
    });setSizeErrors({});invalidate()
  }
  function toggleResizeOriginal(value:boolean) {
    setResizeOriginal(value)
    setSizeErrors({});invalidate()
  }
  function saveSizes() {
    const changed=frames.filter(frame=>!!drafts[frame.id])
    if (!changed.length || saving) return
    const errors:Record<string,string>={}
    for (const frame of changed) {
      const draft=drafts[frame.id],error=draftError(frame,draft)
      if (error) errors[frame.id]=error
      else if(!adjustOriginal && !sizeFitsRatio(frame.widthPx,frame.heightPx,{widthMm:Number(draft.width),heightMm:Number(draft.height)}))errors[frame.id]='此尺寸与原稿比例不同，请启用“按成品比例调整原稿”'
    }
    setSizeErrors(errors)
    if (Object.keys(errors).length) {showToast('尺寸设置失败，请检查标出的画板',true);return}
    const requestId=++saveRequest.current
    pendingSave.current={requestId};setSaving(true)
    send('set-print-sizes',{requestId,updates:changed.map(frame=>sizeUpdate(frame,drafts[frame.id])),options:{resizeOriginal:adjustOriginal,scaleContent:adjustOriginal && scaleContent}})
  }
  function openSizes() {setFrameMode('existing');setTab('frames')}
  const busy=pfLoading||exportLoading||saving||frameBusy
  const sizes=<SizeSummary frames={frames} unsaved={unsaved} onEdit={openSizes} disabled={busy} />
  return <>
    <nav className="tabs" aria-label="插件页面">
      {([{id:'frames',label:'画板'},{id:'preflight',label:'预检'},{id:'export',label:'导出'}] as const).map(t=><button
        key={t.id} className={`tab ${tab===t.id?'active':''}`} aria-current={tab===t.id?'page':undefined} disabled={exportLoading||frameBusy} onClick={()=>setTab(t.id)}>{t.label}</button>)}
    </nav>
    <div className={`content ${tab==='export'?'content-export':''}`}>
      {tab==='frames' && <>
        {frames.length>0 ? <PrintSizeCard frames={frames} drafts={drafts} errors={sizeErrors} disabled={busy} saving={saving} onChange={editSize} onSave={saveSizes}
          onPreset={choosePreset} showResizeOriginal={needsRatioAdjustment} resizeOriginal={adjustOriginal} onResizeOriginal={toggleResizeOriginal} scaleContent={scaleContent} onScaleContent={setScaleContent} />
          : frameMode==='new' ? <div className="frame-create">
            <button className="btn-ghost frame-back" disabled={busy} onClick={()=>setFrameMode('existing')}>← 返回</button>
            <FrameSizeCard action="create" count={0} disabled={busy} onBusy={setFrameBusy} />
          </div> : <div className="frame-empty">
            <svg className="frame-empty-icon" width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M11 5v26M25 5v26M5 11h26M5 25h26" />
            </svg>
            <div className="empty-title">请先选择原稿画板</div>
            <p>选中后即可设置实际印刷尺寸</p>
            <div className="frame-empty-action"><span>还没有画板？</span><button className="btn-ghost" disabled={busy} onClick={()=>setFrameMode('new')}>新建画板</button></div>
          </div>}
      </>}
      {tab==='preflight' && <PreflightPanel profile={profile} result={preflight} loading={pfLoading||exportLoading||saving||frameBusy}
        onRun={runPreflight} onSelect={id=>send('select-node',{nodeId:id})} onFix={id=>send('fix-rich-black',{nodeId:id})}
        sizes={sizes} dpi={dpi} blocked={preflightBlocked} hasSelection={frames.length>0} />}
      {tab==='export' && <ExportPanel onExport={doExport} loading={exportLoading||saving||frameBusy}
        dpi={dpi} onDpi={setDpi} profileId={profileId} onProfileId={setProfileId} profile={profile}
        onImportProfile={p=>setCustomProfile({...p,id:'custom'})} sizes={sizes} sizesReady={sizesReady} mode={mode}
        usingReference={frames.some(f=>f.printSizeStatus==='unset')}
        onMode={v=>{setMode(v);setExportError('');setWarnings([])}} error={exportError} warnings={warnings}
        marksConfig={marksConfig}
        marks={<fieldset className="print-settings" disabled={exportLoading}><MarksPanel config={marksConfig} onConfig={config=>setMarksConfig({...config,markOffset:Math.max(3,config.bleed),markLength:5})} /></fieldset>} />}
    </div>
    {toast && <div className={`toast ${toast.error?'error':''}`}>{toast.msg}</div>}
  </>
}
