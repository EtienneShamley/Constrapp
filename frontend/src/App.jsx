import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './hooks/useAuth'
import { ProfileProvider } from './hooks/useProfile'
import { CompanyProvider } from './hooks/useCompany'
import { ProjectsProvider } from './hooks/useProjects'
import ProtectedRoute from './components/ProtectedRoute'
import AppShell from './layouts/AppShell'
import AuthLayout from './layouts/AuthLayout'
import Login          from './pages/Login'
import CreateAccount  from './pages/CreateAccount'
import ForgotPassword from './pages/ForgotPassword'
import Dashboard      from './pages/Dashboard'
import Projects       from './pages/Projects'
import BOQ            from './pages/BOQ'
import Budgets        from './pages/Budgets'
import Forecasting    from './pages/Forecasting'
import Contacts       from './pages/Contacts'
import Drawings       from './pages/Drawings'
import PurchaseOrders from './pages/PurchaseOrders'
import QSTakeoff      from './pages/QSTakeoff'
import Subcontractors from './pages/Subcontractors'
import Pulse          from './pages/Pulse'
import Shield         from './pages/Shield'
import Timeline       from './pages/Timeline'
import SitePhotos     from './pages/SitePhotos'
import Reports        from './pages/Reports'

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
                    <Route index                    element={<Dashboard />} />
                    <Route path="projects"          element={<Projects />} />
                    <Route path="boq"               element={<BOQ />} />
                    <Route path="budgets"           element={<Budgets />} />
                    <Route path="forecasting"       element={<Forecasting />} />
                    <Route path="contacts"          element={<Contacts />} />
                    <Route path="drawings"          element={<Drawings />} />
                    <Route path="purchase-orders"   element={<PurchaseOrders />} />
                    <Route path="qs-takeoff"        element={<QSTakeoff />} />
                    <Route path="subcontractors"    element={<Subcontractors />} />
                    <Route path="pulse"             element={<Pulse />} />
                    <Route path="shield"            element={<Shield />} />
                    <Route path="timeline"          element={<Timeline />} />
                    <Route path="site-photos"       element={<SitePhotos />} />
                    <Route path="reports"           element={<Reports />} />
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
