/**
 * Reports module entry — mounted at reports/* so it owns its internal tabs:
 *   /reports          report builder (all report readers, trustees read-only)
 *   /reports/pack     board pack generator (Pulse + CEO only)
 *   /reports/library  saved packs (RLS-scoped)
 *
 * Builder state (period + scope) lives here so it survives tab switches and
 * flows straight into the pack generator.
 */
import { useEffect, useRef, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { usePermissions } from '@/auth/AuthProvider'
import { ReportTabs } from './components'
import { defaultBuilderState, fetchDefaultPeriod, type BuilderState } from './lib'
import BuilderPage from './BuilderPage'
import PackBuilderPage from './PackBuilderPage'
import PackLibraryPage from './PackLibraryPage'
import ExportPage from './ExportPage'
import './reports.css'

export default function ReportsPage() {
  const { isPulse, isCeo } = usePermissions()
  const canBuildPacks = isPulse || isCeo
  const [builder, setBuilder] = useState<BuilderState>(defaultBuilderState)

  /**
   * The configured opening period, applied once the ledger has answered.
   *
   * The synchronous default (this financial year) renders first so there is
   * never a blank builder, then the resolved default replaces it — unless the
   * reader has already chosen a period in the meantime, which would be
   * infuriating to have snatched back a moment after clicking.
   */
  const chosen = useRef(false)
  const change = (next: BuilderState) => {
    chosen.current = true
    setBuilder(next)
  }
  useEffect(() => {
    let cancelled = false
    void fetchDefaultPeriod().then((period) => {
      if (cancelled || chosen.current) return
      setBuilder((b) => ({ ...b, period }))
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div>
      <ReportTabs canBuildPacks={canBuildPacks} />
      <Routes>
        <Route index element={<BuilderPage state={builder} onChange={change} />} />
        <Route
          path="pack"
          element={
            canBuildPacks ? (
              <PackBuilderPage state={builder} onChange={change} />
            ) : (
              <Navigate to="/reports" replace />
            )
          }
        />
        <Route path="library" element={<PackLibraryPage />} />
        <Route
          path="export"
          element={canBuildPacks ? <ExportPage /> : <Navigate to="/reports" replace />}
        />
        <Route path="*" element={<Navigate to="/reports" replace />} />
      </Routes>
    </div>
  )
}
