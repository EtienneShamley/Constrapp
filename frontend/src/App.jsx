import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './hooks/useAuth'
import { ProfileProvider } from './hooks/useProfile'
import { CompanyProvider } from './hooks/useCompany'
import { ProjectsProvider } from './hooks/useProjects'
import ProtectedRoute from './components/ProtectedRoute'
import AppShell from './layouts/AppShell'
import AuthLayout from './layouts/AuthLayout'
import ProjectDetailLayout from './layouts/ProjectDetailLayout'
import ProjectCommercialLayout from './layouts/ProjectCommercialLayout'
import Login          from './pages/Login'
import CreateAccount  from './pages/CreateAccount'
import ForgotPassword from './pages/ForgotPassword'
import Dashboard      from './pages/Dashboard'
import Projects       from './pages/Projects'
import Contacts       from './pages/Contacts'
import CompanySettings from './pages/CompanySettings'
import Subcontractors from './pages/Subcontractors'
import Pulse          from './pages/Pulse'
import Shield         from './pages/Shield'
import ProjectOverview   from './pages/project/ProjectOverview'
import ProjectBoq        from './pages/project/ProjectBoq'
import ProjectBudget     from './pages/project/ProjectBudget'
import ProjectCostCodes  from './pages/project/ProjectCostCodes'
import ProjectPurchaseOrders from './pages/project/ProjectPurchaseOrders'
import ProjectProgressClaims from './pages/project/ProjectProgressClaims'
import ProjectInvoices from './pages/project/ProjectInvoices'
import ProjectVariations from './pages/project/ProjectVariations'
import ProjectForecast from './pages/project/ProjectForecast'
import ProjectCommercial from './pages/project/ProjectCommercial'
import ProjectClientInvoices from './pages/project/ProjectClientInvoices'
import ProjectClientReceipts from './pages/project/ProjectClientReceipts'
import ProjectSupplierPayments from './pages/project/ProjectSupplierPayments'
import ProjectCashFlow from './pages/project/ProjectCashFlow'
import ProjectPlaceholder from './pages/project/ProjectPlaceholder'

export default function App() {
  return (
    <AuthProvider>
      <ProfileProvider>
        <CompanyProvider>
          <ProjectsProvider>
            <BrowserRouter>
              <Routes>
                {/* Auth routes — redirect to / if already signed in */}
                <Route element={<AuthLayout />}>
                  <Route path="login"           element={<Login />} />
                  <Route path="create-account"  element={<CreateAccount />} />
                  <Route path="forgot-password" element={<ForgotPassword />} />
                </Route>

                {/* Protected app routes — redirect to /login if not signed in */}
                <Route element={<ProtectedRoute />}>
                  <Route element={<AppShell />}>
                    <Route index               element={<Dashboard />} />
                    <Route path="projects"     element={<Projects />} />

                    {/* Project Detail — every project module lives under a project */}
                    <Route path="projects/:projectId" element={<ProjectDetailLayout />}>
                      <Route index element={<Navigate to="overview" replace />} />
                      <Route path="overview" element={<ProjectOverview />} />
                      {/* BOQ — the measured Bill of Quantities (ADR-32 Part 1).
                          Estimating (margin/overheads), BOQ → Budget transfer,
                          and Tenders are later branches. */}
                      <Route path="boq" element={<ProjectBoq />} />
                      <Route path="budget"      element={<ProjectBudget />} />
                      <Route path="cost-codes"  element={<ProjectCostCodes />} />
                      <Route path="purchase-orders" element={<ProjectPurchaseOrders />} />
                      <Route path="progress-claims" element={<ProjectProgressClaims />} />
                      <Route path="invoices" element={<ProjectInvoices />} />
                      <Route path="forecasting" element={<ProjectForecast />} />
                      <Route path="variations" element={<ProjectVariations />} />
                      {/* Commercial is the project's revenue-and-cash workspace:
                          Project Margin (index), Client Invoices / AR, the
                          Client Receipts register (cash in), the Supplier
                          Payments register (cash out), and Cash Flow — the
                          ACTUAL cash foundation reading both directions
                          together (forecast and charts are later branches). */}
                      <Route path="commercial" element={<ProjectCommercialLayout />}>
                        <Route index element={<ProjectCommercial />} />
                        <Route path="client-invoices" element={<ProjectClientInvoices />} />
                        <Route path="receipts" element={<ProjectClientReceipts />} />
                        <Route path="supplier-payments" element={<ProjectSupplierPayments />} />
                        <Route path="cash-flow" element={<ProjectCashFlow />} />
                      </Route>
                      <Route path="documents" element={
                        <ProjectPlaceholder
                          icon="📐"
                          title="Documents"
                          description="Upload, version, and mark up drawings and documents for this project."
                          badge="Coming in Sprint 4"
                        />
                      } />
                      <Route path="photos" element={
                        <ProjectPlaceholder
                          icon="📷"
                          title="Site Photos"
                          description="Tagged photo uploads for this project."
                          badge="Coming in Sprint 4"
                        />
                      } />
                      <Route path="timeline" element={
                        <ProjectPlaceholder
                          icon="⏱"
                          title="Timeline"
                          description="Gantt-style schedule view with delay detection for this project."
                          badge="Coming in Sprint 4"
                        />
                      } />
                      <Route path="reports" element={
                        <ProjectPlaceholder
                          icon="📊"
                          title="Reports"
                          description="PDF and CSV exports for this project's financial and progress reports."
                          badge="Coming in Sprint 3"
                        />
                      } />
                    </Route>

                    <Route path="contacts"       element={<Contacts />} />
                    <Route path="settings/company" element={<CompanySettings />} />
                    <Route path="subcontractors" element={<Subcontractors />} />
                    <Route path="pulse"          element={<Pulse />} />
                    <Route path="shield"         element={<Shield />} />

                    {/* Legacy top-level module routes are retired — Budgets, BOQ, Forecasting, etc.
                        now live under Project Detail. Send anything unmatched back to Projects. */}
                    <Route path="*" element={<Navigate to="/projects" replace />} />
                  </Route>
                </Route>
              </Routes>
            </BrowserRouter>
          </ProjectsProvider>
        </CompanyProvider>
      </ProfileProvider>
    </AuthProvider>
  )
}
