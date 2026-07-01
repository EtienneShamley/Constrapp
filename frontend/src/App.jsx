import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './hooks/useAuth'
import { ProfileProvider } from './hooks/useProfile'
import { CompanyProvider } from './hooks/useCompany'
import { ProjectsProvider } from './hooks/useProjects'
import ProtectedRoute from './components/ProtectedRoute'
import AppShell from './layouts/AppShell'
import AuthLayout from './layouts/AuthLayout'
import ProjectDetailLayout from './layouts/ProjectDetailLayout'
import Login          from './pages/Login'
import CreateAccount  from './pages/CreateAccount'
import ForgotPassword from './pages/ForgotPassword'
import Dashboard      from './pages/Dashboard'
import Projects       from './pages/Projects'
import Contacts       from './pages/Contacts'
import Subcontractors from './pages/Subcontractors'
import Pulse          from './pages/Pulse'
import Shield         from './pages/Shield'
import ProjectOverview   from './pages/project/ProjectOverview'
import ProjectBudget     from './pages/project/ProjectBudget'
import ProjectCostCodes  from './pages/project/ProjectCostCodes'
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
                      <Route path="boq" element={
                        <ProjectPlaceholder
                          icon="📋"
                          title="BOQ & Tender Tool"
                          description="Build a Bill of Quantities, set margin & overheads, and transfer to this project's budget in one click."
                          badge="Coming in Sprint 3"
                        />
                      } />
                      <Route path="budget"      element={<ProjectBudget />} />
                      <Route path="cost-codes"  element={<ProjectCostCodes />} />
                      <Route path="purchase-orders" element={
                        <ProjectPlaceholder
                          icon="🛒"
                          title="Purchase Orders"
                          description="Create, send, and track POs linked to this project's cost codes."
                          badge="Coming Soon"
                        />
                      } />
                      <Route path="progress-claims" element={
                        <ProjectPlaceholder
                          icon="🧾"
                          title="Progress Claims"
                          description="Track progress claims and payment certificates against the project budget."
                          badge="Coming Soon"
                        />
                      } />
                      <Route path="forecasting" element={
                        <ProjectPlaceholder
                          icon="📈"
                          title="Forecasting & Cashflow"
                          description="Income/expense curves, profit analysis, and budget burn forecasting for this project."
                          badge="Coming in Sprint 4"
                        />
                      } />
                      <Route path="variations" element={
                        <ProjectPlaceholder
                          icon="🔀"
                          title="Variations"
                          description="Track scope variations and their impact on this project's budget."
                          badge="Coming Soon"
                        />
                      } />
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
