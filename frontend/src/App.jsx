import { BrowserRouter, Routes, Route } from 'react-router-dom'
import AppShell from './layouts/AppShell'
import Dashboard      from './pages/Dashboard'
import Projects       from './pages/Projects'
import Budgets        from './pages/Budgets'
import Contacts       from './pages/Contacts'
import PurchaseOrders from './pages/PurchaseOrders'
import Drawings       from './pages/Drawings'
import SitePhotos     from './pages/SitePhotos'
import Subcontractors from './pages/Subcontractors'
import Timeline       from './pages/Timeline'
import Reports        from './pages/Reports'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index                    element={<Dashboard />} />
          <Route path="projects"          element={<Projects />} />
          <Route path="budgets"           element={<Budgets />} />
          <Route path="contacts"          element={<Contacts />} />
          <Route path="purchase-orders"   element={<PurchaseOrders />} />
          <Route path="drawings"          element={<Drawings />} />
          <Route path="site-photos"       element={<SitePhotos />} />
          <Route path="subcontractors"    element={<Subcontractors />} />
          <Route path="timeline"          element={<Timeline />} />
          <Route path="reports"           element={<Reports />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
