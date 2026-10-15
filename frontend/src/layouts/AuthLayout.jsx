import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

// The split-screen auth shell for /login, /forgot-password and /create-account,
// recreating the Constrapp v5 prototype's login composition
// (docs/Constrapp_v5.jsx → Login) with design-system tokens.
//
//   ≥ lg   product introduction (≈55%) + sign-in panel (≈45%), the form
//          centred in its panel at a readable 420px max width
//   < lg   single column: compact brand header, the form on a card, footer
//
// Vertical rhythm is compact by default and opens out to the prototype's
// spacing on viewports at least 900px tall, so a 1280×800 laptop is not
// pushed into scrolling the product panel.
//
// The auth guard below is unchanged and must stay FIRST: wait for the auth
// listener, then send a signed-in user to the app before anything renders.
//
// Every feature highlight describes a module PRODUCT.md marks as implemented.
// Planned modules are deliberately absent — the login page advertises only
// what a provisioned user can open today.

const Logo = ({ className }) => (
  <svg aria-hidden="true" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" className={`text-brand-accent shrink-0 ${className}`}>
    <path d="M28 8L16 20L28 32" />
    <path d="M20 8L8 20L20 32" opacity="0.45" />
  </svg>
)

const Spinner = () => (
  <div className="min-h-screen bg-brand-bg flex items-center justify-center" role="status" aria-label="Loading">
    <div className="w-8 h-8 border-2 border-brand-accent border-t-transparent rounded-full animate-spin" />
  </div>
)

// 24×24 stroke icons, drawn inline — no icon library.
const ICONS = {
  budget: (
    <>
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <path d="M8 6h8M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01" />
    </>
  ),
  claims: (
    <>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="m9 14 2 2 4-4" />
    </>
  ),
  supplier: (
    <>
      <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
      <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8M12 17.5v-11" />
    </>
  ),
  forecast: (
    <>
      <path d="M22 7l-8.5 8.5-5-5L2 17" />
      <path d="M16 7h6v6" />
    </>
  ),
  documents: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4M8 9h2M8 13h8M8 17h8" />
    </>
  ),
}

const FEATURES = [
  { icon: 'budget',    title: 'Budgets & Cost Codes',    desc: 'Organise and track project budgets by cost code.' },
  { icon: 'claims',    title: 'Purchasing & Claims',     desc: 'Manage purchase orders, variations and progress claims.' },
  { icon: 'supplier',  title: 'Supplier Cost Control',   desc: 'Track supplier invoices, payments and actual costs.' },
  { icon: 'forecast',  title: 'Forecasting & Cash Flow', desc: 'Understand forecast costs, margins and projected cash movement.' },
  { icon: 'documents', title: 'Project Documentation',   desc: 'Work with BOQ, tender and drawing records.' },
]

export default function AuthLayout() {
  const { user, loading } = useAuth()

  if (loading) return <Spinner />
  if (user) return <Navigate to="/" replace />

  return (
    <div className="min-h-svh bg-brand-bg lg:grid lg:grid-cols-[minmax(0,55fr)_minmax(0,45fr)]">

      {/* LEFT — product introduction (desktop only) */}
      <aside
        aria-label="About Constrapp"
        className="hidden lg:flex relative overflow-hidden flex-col justify-center bg-brand-bg px-14 py-10 xl:px-20 [@media(min-height:900px)]:py-[70px]"
      >
        {/* Depth: the prototype's darkened diagonal wash and two faint circles */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-linear-140 from-black/45 via-black/25 to-black/40" />
        <div aria-hidden="true" className="pointer-events-none absolute -top-[150px] -right-[150px] size-[500px] rounded-full bg-brand-accent/[0.03] border border-brand-accent/[0.08]" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-[100px] -left-[100px] size-[380px] rounded-full bg-brand-blue/[0.03]" />

        <div className="relative my-auto">
          <div className="flex items-center gap-4 mb-8 [@media(min-height:900px)]:mb-[50px]">
            <Logo className="size-10" />
            <span className="text-[34px] font-bold text-brand-text tracking-[-1px] leading-none">Constrapp</span>
          </div>

          {/* Not a heading: each auth page owns the one <h1> ("Sign in", …) */}
          <p className="text-[36px] xl:text-[40px] font-bold text-brand-text leading-[1.1] tracking-[-0.5px] mb-[18px] max-w-[760px]">
            {/* The teal line always starts its own line; the first clause
                balances across one or two lines depending on panel width. */}
            <span className="block text-balance">Commercial control for construction,</span>
            <span className="block text-brand-accent">connected end to end.</span>
          </p>

          <p className="text-[15px] text-brand-text-soft leading-[1.75] max-w-[480px] mb-8 [@media(min-height:900px)]:mb-11">
            Manage budgets, commitments, project costs and forecasts in one
            connected construction workspace.
          </p>

          <ul className="flex flex-col gap-3.5 mb-8 [@media(min-height:900px)]:gap-4 [@media(min-height:900px)]:mb-11">
            {FEATURES.map(f => (
              <li key={f.title} className="flex gap-3.5 items-start">
                <span className="size-9 shrink-0 rounded-[10px] bg-brand-accent/[0.08] border border-brand-accent/[0.14] flex items-center justify-center text-brand-accent">
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="size-[18px]">
                    {ICONS[f.icon]}
                  </svg>
                </span>
                <span className="pt-0.5">
                  <span className="block text-sm font-bold text-brand-text">{f.title}</span>
                  <span className="block text-xs text-brand-text-soft leading-normal mt-0.5">{f.desc}</span>
                </span>
              </li>
            ))}
          </ul>

          <div className="max-w-[440px] rounded-xl border border-brand-accent/[0.19] bg-brand-accent/[0.08] px-5 py-4">
            <p className="text-[13px] font-bold text-brand-accent m-0 mb-1">Australian-built construction management</p>
            <p className="text-xs text-brand-text-soft leading-relaxed m-0">
              Designed for small and mid-sized contractors, with cost codes
              joining every commercial stage.
            </p>
          </div>
        </div>
      </aside>

      {/* RIGHT — the auth form (sign in / reset / create-account stub) */}
      <main className="flex flex-col min-h-svh px-4 py-10 sm:px-8 lg:min-h-0 lg:bg-brand-sidebar lg:border-l lg:border-brand-border lg:px-11 lg:py-[60px]">
        <div className="w-full max-w-md mx-auto my-auto lg:max-w-[420px]">

          {/* Compact brand header (below lg, where the left panel is hidden) */}
          <div className="lg:hidden flex flex-col items-center text-center mb-8">
            <div className="flex items-center gap-3">
              <Logo className="size-9" />
              <span className="text-[28px] font-bold text-brand-text tracking-[-0.75px] leading-none">Constrapp</span>
            </div>
            <p className="mt-3 text-[13px] text-brand-text-soft text-balance m-0">
              Commercial control for construction,{' '}
              <span className="text-brand-accent">connected end to end.</span>
            </p>
          </div>

          {/* Below lg the form sits on a card; at lg the column is the surface */}
          <div className="rounded-2xl border border-brand-border bg-brand-sidebar p-6 sm:p-8 lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0">
            <Outlet />
          </div>

          <p className="lg:hidden mt-8 text-center text-xs text-brand-text-soft">
            Australian-built construction management
          </p>
        </div>
      </main>
    </div>
  )
}
