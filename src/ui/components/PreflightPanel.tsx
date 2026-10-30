import React from 'react'
import type { Issue, PreflightResult } from '../../shared/types'
import { SoftProofCard } from './SoftProofCard'
import type { PrintProfile } from '../color/icc'
import { imageDpiMinimum } from '../../shared/constants'

const SEVERITY_LABEL: Record<string, string> = {
  error: '错误',
  warning: '警告',
  info: '提示',
}

function IssueItem({
  issue,
  onSelect,
  onFix,
}: {
  issue: Issue
  onSelect: (id: string) => void
  onFix: (id: string) => void
}) {
  return (
    <div className={`issue ${issue.severity}`}>
      <div className="issue-head">
        <span>{issue.title}</span>
        <span className="badge">{SEVERITY_LABEL[issue.severity]}</span>
      </div>
      <div className="issue-msg">{issue.message}</div>
      {issue.detail && <div className="issue-detail">{issue.detail}</div>}
      {(issue.frameName || issue.nodeName) && (
        <div className="issue-meta">
          {issue.frameName ? `画板：${issue.frameName}` : ''}
          {issue.frameName && issue.nodeName ? ' · ' : ''}
          {issue.nodeName ? `图层：${issue.nodeName}` : ''}
        </div>
      )}
      <div className="issue-actions">
        {issue.nodeId && (
          <button className="btn-ghost" onClick={() => onSelect(issue.nodeId!)}>
            定位图层
          </button>
        )}
        {issue.fixable && (
          <button className="btn-ghost" onClick={() => onFix(issue.nodeId!)}>
            一键转单黑
          </button>
        )}
      </div>
    </div>
  )
}

export function PreflightPanel({
  profile,
  result,
  loading,
  onRun,
  onSelect,
  onFix,
  sizes,
  dpi,
  blocked,
  hasSelection,
}: {
  profile?: PrintProfile
  result: PreflightResult | null
  loading: boolean
  onRun: () => void
  onSelect: (id: string) => void
  onFix: (id: string) => void
  sizes: React.ReactNode
  dpi: number
  blocked: boolean
  hasSelection: boolean
}) {
  return (
    <div>
      {sizes}
      <div className="card">
        <button className="btn btn-primary" onClick={onRun} disabled={loading || blocked || !hasSelection}>
          {loading ? <span className="spin" /> : '开始预检'}
        </button>
        <div className="hint">
          图片建议 ≥ {imageDpiMinimum(dpi)} DPI · 字体、细线、安全区
        </div>
      </div>


      {result && (
        <>
          {!result.complete && <div className="card preflight-incomplete" role="status">
            <strong>预检未完成</strong>
            {result.skippedFrames.map(f=><div className="hint" key={f.id}>“{f.name}”：{f.reason}。已跳过图片 DPI、实际字号、细线和安全区检查。</div>)}
            {result.issues.some(i=>i.type==='image-dpi-unavailable') && <div className="hint">部分图片的 DPI 无法读取，请检查下方提示。</div>}
          </div>}
          <div className="summary">
            <div className="summary-item">
              <div className={`summary-num ${result.errorCount > 0 ? 'error' : 'ok'}`}>
                {result.errorCount}
              </div>
              <div className="summary-label">错误</div>
            </div>
            <div className="summary-item">
              <div className={`summary-num ${result.warningCount > 0 ? 'warning' : 'ok'}`}>
                {result.warningCount}
              </div>
              <div className="summary-label">警告</div>
            </div>
            <div className="summary-item">
              <div className="summary-num ok">{result.frameCount}</div>
              <div className="summary-label">画板</div>
            </div>
          </div>

          {result.issues.length === 0 ? (
            <div className="empty">
              <div className="status-symbol" aria-hidden="true">{result.complete ? '✓' : '○'}</div>
              <div className="empty-title">{result.complete ? '未发现问题' : '已检查的项目未发现问题'}</div>
              <div>{result.complete ? '请结合软打样确认印刷效果' : '设置成品尺寸后重新预检'}</div>
            </div>
          ) : (
            result.issues.map((i) => (
              <IssueItem key={i.id} issue={i} onSelect={onSelect} onFix={onFix} />
            ))
          )}
        </>
      )}
      <SoftProofCard profile={profile} />
    </div>
  )
}
