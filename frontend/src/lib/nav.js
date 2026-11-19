// ⚠️ Constrapp PULSE™ and SHIELD™ are DELIBERATELY ABSENT.
//
// Both are unbuilt placeholder screens, and their sidebar entries carried an
// animated "live" indicator (Sidebar.jsx renders one for `pulse`/`shield`)
// that read as running functionality. The /pulse and /shield routes, pages and
// the Sidebar accent branches all remain — nothing is deleted — but for a
// private beta they are not offered in navigation. Restore the entries here
// when the feature ships.
//
// `roles` (optional) limits an entry to those roles — a UX filter only, so a
// user is not offered a page that would just tell them it is restricted. It is
// NOT access control: the page gates itself and Firestore Security Rules are
// the enforced boundary. An entry without `roles` is offered to everyone.
//
// Portfolio (L2-C, ADR-78) is the company-wide commercial report: financial
// roles only. The list is spelled out here (it mirrors lib/margin.js →
// FINANCIAL_ROLES, asserted equal by tests/unit/portfolioSurface.test.js) so
// this module stays free of imports.
export const NAV = [
  { to: '/',                label: 'Dashboard',        icon: '⊞', end: true   },
  { to: '/projects',        label: 'Projects',          icon: '🏗'             },
  { to: '/portfolio',       label: 'Portfolio',         icon: '📊', roles: ['company_admin', 'project_manager', 'qs'] },
  { to: '/contacts',        label: 'Contacts',          icon: '👤'             },
  { to: '/subcontractors',  label: 'Subcontractors',    icon: '👷'             },
]

// The entries offered to a role. While the role is unknown (profile loading)
// a role-limited entry is NOT offered.
export const navFor = (role) => NAV.filter(item => !item.roles || item.roles.includes(role))
