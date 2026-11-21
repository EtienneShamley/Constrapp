import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import CurrencySetupBanner from '../components/CurrencySetupBanner'
import UnconfirmedWrites from '../components/UnconfirmedWrites'

export default function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div data-app-shell className="flex h-screen bg-brand-bg overflow-hidden">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div data-app-content className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar onMenuClick={() => setSidebarOpen(true)} />
        <main data-app-main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <CurrencySetupBanner />
          <UnconfirmedWrites />
          <Outlet />
        </main>
      </div>
    </div>
  )
}
