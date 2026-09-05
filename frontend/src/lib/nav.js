// ⚠️ Constrapp PULSE™ and SHIELD™ are DELIBERATELY ABSENT.
//
// Both are unbuilt placeholder screens, and their sidebar entries carried an
// animated "live" indicator (Sidebar.jsx renders one for `pulse`/`shield`)
// that read as running functionality. The /pulse and /shield routes, pages and
// the Sidebar accent branches all remain — nothing is deleted — but for a
// private beta they are not offered in navigation. Restore the entries here
// when the feature ships.
export const NAV = [
  { to: '/',                label: 'Dashboard',        icon: '⊞', end: true   },
  { to: '/projects',        label: 'Projects',          icon: '🏗'             },
  { to: '/contacts',        label: 'Contacts',          icon: '👤'             },
  { to: '/subcontractors',  label: 'Subcontractors',    icon: '👷'             },
]
