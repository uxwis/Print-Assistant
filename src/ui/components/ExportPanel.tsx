import React from 'react'
import { Segmented } from './controls'
import { PrintSettings } from './PrintSettings'
import type { PrintProfile } from '../color/icc'
import type { MarksConfig, PdfMode } from '../../shared/types'

export function ExportPanel({ onExport, loading, marks, marksConfig, dpi, onDpi, profileId, onProfileId, profile, onImportProfile, sizes, sizesReady, mode, onMode, error, warnings, usingReference }: {
  onExport: () => void
  loading: boolean
  marks: React.ReactNode
  marksConfig: MarksConfig
  dpi: number
  onDpi: (dpi: number) => void
  profileId: string
  onProfileId: (id: string) => void
  profile?: PrintProfile
  onImportProfile: (profile: PrintProfile) => void
  sizes: React.ReactNode
  sizesReady: boolean
  mode: PdfMode
  onMode: (mode:PdfMode)=>void
  error: string
  warnings: string[]
  usingReference:boolean
}) {
  return (
    <div className="export-panel">
      <div className="export-scroll">
      {sizes}
      {usingReference && <div className="size-note">未设成品尺寸的画板按参考尺寸导出（1 px = 1 pt）。</div>}
      <div className="card export-settings">
      <PrintSettings dpi={dpi} onDpi={onDpi} profileId={profileId} onProfileId={onProfileId}
        profile={profile} onImportProfile={onImportProfile} disabled={loading} />
      <div className="field output-field"><div className="output-label"><span className="field-label">输出方式</span>
        <span className="output-hint" role="status">（{mode === 'vector' ? '文字转曲，图形矢量，照片按 DPI 优化' : '整页图片，适合复杂效果'}）</span></div>
        <Segmented value={mode} onChange={onMode} disabled={loading} options={[{value:'vector',label:'矢量优先'},{value:'raster',label:'整页栅格'}]} />
      </div>
      <details className="marks-disclosure" onToggle={event=>{
        if (event.currentTarget.open) event.currentTarget.scrollIntoView({block:'nearest'})
      }}>
        <summary><span>出血与裁切</span><span className="marks-summary">{marksConfig.bleed} mm{marksConfig.showCropMarks ? ' · 裁切线' : ''}{marksConfig.showBleedBox ? ' · 出血框' : ''}</span></summary>
        <div className="marks-body">{marks}</div>
      </details>
      </div>
      {error && <div className="card export-error" role="alert">{error}
        {mode === 'vector' && <button className="btn" disabled={loading} onClick={()=>onMode('raster')}>切换整页栅格模式</button>}
      </div>}
      {warnings.length>0 && <details className="hint" role="status"><summary>{warnings.length} 项图片提示，查看详情</summary><p>{warnings.join(' ')}</p></details>}
      </div>
      <div className="action-bar">
        {!profile && sizesReady && <div className="hint">请先导入印厂或设备的 CMYK ICC 文件。</div>}
        <button className="btn btn-primary" onClick={onExport} disabled={loading || !profile || !sizesReady}>
          {loading ? <><span className="spin" /> 正在导出…</> : '导出 CMYK PDF'}
        </button>
        {!sizesReady && <div className="hint export-selection-hint">请选中原稿，并设置尺寸或重新确认失效的尺寸。</div>}
      </div>
    </div>
  )
}
