/**
 * Reports module entry — mounted at reports/* so it owns its internal tabs:
 *   /reports          report builder (all report readers, trustees read-only)
 *   /reports/pack     board pack generator (Pulse + CEO only)
 *   /reports/library  saved packs (RLS-scoped)
 *
 * Builder state (period + scope) lives here so it survives tab switches and
 * flows straight into the pack generator.
 */
import { useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { usePermissions } from '@/auth/AuthProvider'
import { ReportTabs } from './components'
import { defaultBuilderState, type BuilderState } from './lib'
import BuilderPage from './BuilderPage'
import PackBuilderPage from './PackBuilderPage'
import PackLibraryPage from './PackLibraryPage'
import './reports.css'

export default function ReportsPage() {
  const { isPulse, isCeo } = usePermissions()
  const canBuildPacks = isPulse || isCeo
  const [builder, setBuilder] = useState<BuilderState>(defaultBuilderState)

  return (
    <div>
      <ReportTabs canBuildPacks={canBuildPacks} />
      <Routes>
        <Route index element={<BuilderPage state={builder} onChange={setBuilder} />} />
        <Route
          path="pack"
          element={
            canBuildPacks ? (
              <PackBuilderPage state={builder} onChange={setBuilder} />
            ) : (
              <Navigate to="/reports" replace />
            )
          }
        />
        <Route path="library" element={<PackLibraryPage />} />
        <Route path="*" element={<Navigate to="/reports" replace />} />
      </Routes>
    </div>
  )
}
