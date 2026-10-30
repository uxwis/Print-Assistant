import React, { useEffect, useState } from 'react'
import { send, onMessage } from '../api'
import { SIZE_PRESETS } from '../../shared/constants'
import { integerMmInput } from '../../shared/printDimensions'

export function FrameSizeCard({action,count,disabled,onBusy}: {action:'create'|'resize';count:number;disabled:boolean;onBusy:(busy:boolean)=>void}) {
  const [preset, setPreset] = useState('')
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const [scaleContent, setScaleContent] = useState(false)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const valid = Number.isFinite(Number(width)) && Number.isFinite(Number(height)) && Number(width) > 0 && Number(height) > 0

  useEffect(() => {
    const off = onMessage((m) => {
      if (m.type === 'frame-created') {
        setMessage(`已新建画板「${m.payload.name}」`)
        setLoading(false)
        onBusy(false)
      }
      if (m.type === 'frame-resized') {
        setMessage(`已调整 ${m.payload.count} 个画板`)
        setLoading(false)
        onBusy(false)
      }
      if (m.type === 'error') { setLoading(false); onBusy(false) }
    })
    return off
  }, [onBusy])

  function pickPreset(name: string) {
    setPreset(name)
    const p = SIZE_PRESETS.find((x) => x.name === name)
    if (p) { setWidth(String(p.w)); setHeight(String(p.h)) }
  }

  function run(type: 'create-frame' | 'resize-frame') {
    if (!valid) return
    setMessage('')
    setLoading(true)
    onBusy(true)
    send(type, { target: 'selection', widthMm: Number(width), heightMm: Number(height), scaleContent })
  }

  return (
    <div className={action==='create' ? 'card' : 'resize-form'}>
      {action==='create' && <div className="card-title">新建画板</div>}
      <fieldset className="print-settings" disabled={disabled || loading}>
      <div className="field">
        <select id="frame-preset" className="select" aria-label="画板尺寸预设" value={preset} onChange={(e) => pickPreset(e.target.value)}>
          <option value="">自定义尺寸</option>
          {SIZE_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
      </div>
      <div className="row">
        <div className="field">
          <label className="field-label" htmlFor="frame-width">宽度 (mm)</label>
          <input id="frame-width" className="input" type="number" min={1} step={1} value={width} onChange={(e) => { setWidth(integerMmInput(e.target.value)); setPreset('') }} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="frame-height">高度 (mm)</label>
          <input id="frame-height" className="input" type="number" min={1} step={1} value={height} onChange={(e) => { setHeight(integerMmInput(e.target.value)); setPreset('') }} />
        </div>
      </div>
      {action==='resize' && <label className="check-line">
        <input type="checkbox" checked={scaleContent} onChange={(e) => setScaleContent(e.target.checked)} />
        <span>同时缩放内容</span>
      </label>}
      <button className={`btn ${action==='create' ? 'btn-primary' : ''}`} disabled={!valid || loading || (action==='resize' && count===0)} onClick={()=>run(action==='create' ? 'create-frame' : 'resize-frame')}>
        {loading ? '正在处理…' : action==='create' ? '新建画板' : '调整选中画板'}</button>
      </fieldset>
      <div className="hint">{action==='create' ? '尺寸不含出血，新画板自动设置成品尺寸。' : '会改变原稿画板大小，并同步设置成品尺寸。'}</div>
      {message && <div className="hint" role="status">{message}</div>}
    </div>
  )
}
