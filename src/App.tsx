import { lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, usePermissions } from '@/auth/AuthProvider'
import { SyncProvider } from '@/sync/SyncProvider'
import RequireAuth from '@/auth/RequireAuth'
import RequireModule from '@/auth/RequireModule'
import ErrorBoundary from '@/components/ErrorBoundary'
import AppShell from '@/layout/AppShell'
import SignIn from '@/auth/SignIn'
import ForgotPassword from '@/auth/ForgotPassword'
import ResetPassword from '@/auth/ResetPassword'
import { LoadingRows } from '@/components/ui'

// Module pages — lazy-loaded; each module owns its directory
const DashboardPage = lazy(() => import('@/modules/dashboard/DashboardPage'))
const FundsPage = lazy(() => import('@/modules/funds/FundsPage'))
const FundDetailPage = lazy(() => import('@/modules/funds/FundDetailPage'))
const IntegrityPage = lazy(() => import('@/modules/funds/IntegrityPage'))
const ReconciliationPage = lazy(() => import('@/modules/recon/ReconciliationPage'))
const ReportsPage = lazy(() => import('@/modules/reports/ReportsPage'))
const ExpensesPage = lazy(() => import('@/modules/expenses/ExpensesPage'))
const ClaimDetailPage = lazy(() => import('@/modules/expenses/ClaimDetailPage'))
const ApprovalQueuePage = lazy(() => import('@/modules/expenses/ApprovalQueuePage'))
const ExpensesReportPage = lazy(() => import('@/modules/expenses/ExpensesReportPage'))
const MonthEndPage = lazy(() => import('@/modules/monthend/MonthEndPage'))
const CloseSharePage = lazy(() => import('@/modules/monthend/CloseSharePage'))
const PeoplePage = lazy(() => import('@/modules/people/PeoplePage'))
const PersonDetailPage = lazy(() => import('@/modules/people/PersonDetailPage'))
const OnboardingFormPage = lazy(() => import('@/modules/people/OnboardingFormPage'))
const ImportsPage = lazy(() => import('@/modules/imports/ImportsPage'))
const TransactionsPage = lazy(() => import('@/modules/financials/TransactionsPage'))
const ProfitLossPage = lazy(() =>
  import('@/modules/financials/ReportPage').then((m) => ({ default: m.ProfitLossPage })),
)
const BalanceSheetPage = lazy(() =>
  import('@/modules/financials/ReportPage').then((m) => ({ default: m.BalanceSheetPage })),
)
const InvestmentsPage = lazy(() => import('@/modules/investments/InvestmentsPage'))
const CashflowPage = lazy(() => import('@/modules/cashflow/CashflowPage'))
const VatPage = lazy(() => import('@/modules/vat/VatPage'))
const ProjectsPage = lazy(() => import('@/modules/projects/ProjectsPage'))
const SettingsPage = lazy(() => import('@/modules/settings/SettingsPage'))

function Page({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingRows cols={3} rows={8} />}>{children}</Suspense>
    </ErrorBoundary>
  )
}

/**
 * A page behind a module check. `pick` names the canSee… flag rather than
 * taking a boolean, so the route table reads as the access rule itself and a
 * new route cannot forget to consult permissions.
 */
function Guarded({
  pick,
  title,
  children,
}: {
  pick: (p: ReturnType<typeof usePermissions>) => boolean
  title: string
  children: ReactNode
}) {
  const permissions = usePermissions()
  return (
    <Page>
      <RequireModule allowed={pick(permissions)} title={title}>
        {children}
      </RequireModule>
    </Page>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SyncProvider>
          <Routes>
            {/* Public */}
            <Route path="/sign-in" element={<SignIn />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            {/* Read-only month end progress behind a share token — no login. */}
            <Route path="/close/:token" element={<CloseSharePage />} />
            {/* Tokenised onboarding — no login needed to start */}
            <Route
              path="/onboard/:token"
              element={
                <Page>
                  <OnboardingFormPage />
                </Page>
              }
            />

            {/* Authenticated app */}
            <Route
              element={
                <RequireAuth>
                  <AppShell />
                </RequireAuth>
              }
            >
              <Route index element={<Page><DashboardPage /></Page>} />
              <Route path="funds" element={<Guarded pick={(p) => p.canSeeFunds} title="the funds register"><FundsPage /></Guarded>} />
              <Route path="funds/integrity" element={<Guarded pick={(p) => p.canSeeFunds} title="the data integrity checks"><IntegrityPage /></Guarded>} />
              <Route path="reconciliation" element={<Guarded pick={(p) => p.canSeeFinancials} title="the reconciliation"><ReconciliationPage /></Guarded>} />
              <Route path="funds/:id" element={<Guarded pick={(p) => p.canSeeFunds} title="fund pages"><FundDetailPage /></Guarded>} />
              <Route path="reports/*" element={<Guarded pick={(p) => p.canSeeReports} title="reports and board packs"><ReportsPage /></Guarded>} />
              <Route path="financials" element={<Navigate to="/financials/profit-loss" replace />} />
              <Route path="financials/profit-loss" element={<Guarded pick={(p) => p.canSeeFinancials} title="the profit and loss"><ProfitLossPage /></Guarded>} />
              <Route path="financials/balance-sheet" element={<Guarded pick={(p) => p.canSeeFinancials} title="the balance sheet"><BalanceSheetPage /></Guarded>} />
              <Route path="financials/transactions" element={<Guarded pick={(p) => p.canSeeFinancials} title="the transaction register"><TransactionsPage /></Guarded>} />
              <Route path="financials/investments" element={<Guarded pick={(p) => p.isPulse || p.isCeo} title="investments"><InvestmentsPage /></Guarded>} />
              <Route path="financials/cashflow" element={<Guarded pick={(p) => p.canSeeCashflow} title="the cash flow forecast"><CashflowPage /></Guarded>} />
              <Route path="expenses" element={<Page><ExpensesPage /></Page>} />
              <Route path="expenses/approvals" element={<Page><ApprovalQueuePage /></Page>} />
              <Route path="expenses/report" element={<Page><ExpensesReportPage /></Page>} />
              <Route path="expenses/:id" element={<Page><ClaimDetailPage /></Page>} />
              <Route path="month-end" element={<Guarded pick={(p) => p.canSeeMonthEnd} title="the month end close"><MonthEndPage /></Guarded>} />
              <Route path="people" element={<Guarded pick={(p) => p.canSeePeople} title="people records"><PeoplePage /></Guarded>} />
              <Route path="people/:id" element={<Guarded pick={(p) => p.canSeePeople} title="people records"><PersonDetailPage /></Guarded>} />
              <Route path="imports/*" element={<Guarded pick={(p) => p.canSeeImports} title="imports"><ImportsPage /></Guarded>} />
              <Route path="vat" element={<Guarded pick={(p) => p.canSeeVat} title="the VAT workings"><VatPage /></Guarded>} />
              <Route path="projects" element={<Guarded pick={(p) => p.canSeeProjects} title="projects"><ProjectsPage /></Guarded>} />
              <Route path="settings/*" element={<Guarded pick={(p) => p.canEditSettings} title="settings"><SettingsPage /></Guarded>} />
              <Route
                path="*"
                element={
                  <div className="py-20 text-center">
                    <h1 className="font-display text-[26px] text-ink">Page not found</h1>
                    <p className="text-stone-500 text-[12.5px] mt-2">
                      That page doesn't exist — use the sidebar to find your way back.
                    </p>
                  </div>
                }
              />
            </Route>
          </Routes>
        </SyncProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
