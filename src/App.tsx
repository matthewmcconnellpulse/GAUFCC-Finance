import { lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '@/auth/AuthProvider'
import { SyncProvider } from '@/sync/SyncProvider'
import RequireAuth from '@/auth/RequireAuth'
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
const ReportsPage = lazy(() => import('@/modules/reports/ReportsPage'))
const ExpensesPage = lazy(() => import('@/modules/expenses/ExpensesPage'))
const ClaimDetailPage = lazy(() => import('@/modules/expenses/ClaimDetailPage'))
const ApprovalQueuePage = lazy(() => import('@/modules/expenses/ApprovalQueuePage'))
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
              <Route path="funds" element={<Page><FundsPage /></Page>} />
              <Route path="funds/integrity" element={<Page><IntegrityPage /></Page>} />
              <Route path="funds/:id" element={<Page><FundDetailPage /></Page>} />
              <Route path="reports/*" element={<Page><ReportsPage /></Page>} />
              <Route path="financials" element={<Navigate to="/financials/profit-loss" replace />} />
              <Route path="financials/profit-loss" element={<Page><ProfitLossPage /></Page>} />
              <Route path="financials/balance-sheet" element={<Page><BalanceSheetPage /></Page>} />
              <Route path="financials/transactions" element={<Page><TransactionsPage /></Page>} />
              <Route path="financials/investments" element={<Page><InvestmentsPage /></Page>} />
              <Route path="financials/cashflow" element={<Page><CashflowPage /></Page>} />
              <Route path="expenses" element={<Page><ExpensesPage /></Page>} />
              <Route path="expenses/approvals" element={<Page><ApprovalQueuePage /></Page>} />
              <Route path="expenses/:id" element={<Page><ClaimDetailPage /></Page>} />
              <Route path="people" element={<Page><PeoplePage /></Page>} />
              <Route path="people/:id" element={<Page><PersonDetailPage /></Page>} />
              <Route path="imports/*" element={<Page><ImportsPage /></Page>} />
              <Route path="vat" element={<Page><VatPage /></Page>} />
              <Route path="projects" element={<Page><ProjectsPage /></Page>} />
              <Route path="settings/*" element={<Page><SettingsPage /></Page>} />
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
