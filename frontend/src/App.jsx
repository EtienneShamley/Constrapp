import { BrowserRouter, Routes, Route } from 'react-router-dom'
import AppShell from './layouts/AppShell'
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
    <BrowserRouter>
      <Routes>
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
      </Routes>
    </BrowserRouter>
  )
}
