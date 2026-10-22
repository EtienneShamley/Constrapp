// ── Keyboard focus containment for dialogs ───────────────────────────────────
//
// PURE helpers: no React, no timers, no library. The DOM touches are two —
// `querySelectorAll` and `focus()` — and both happen in the caller; this file
// only decides WHICH element should receive focus, so the decision is unit
// tested in plain Node against stand-in objects.
//
// Contract (WAI-ARIA dialog pattern, the parts Constrapp adopts):
//   · Tab from the last tabbable control wraps to the first; Shift+Tab from the
//     first wraps to the last. Focus anywhere else inside the panel moves
//     naturally (the helper returns null and the browser does its own thing).
//   · Focus that is NOT on a tabbable control inside the panel — the panel
//     itself (tabIndex -1) right after opening, or something behind the
//     overlay — is pulled back in: to the first control on Tab, the last on
//     Shift+Tab.
//   · A panel with no tabbable control keeps focus on the panel (`fallback`).
//
// First used by the Quant 1B apply dialog (ADR-52); any later dialog may reuse
// it rather than add a focus-trap dependency.

export const TABBABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]'

// A control the Tab key would visit: not disabled, not hidden, not opted out
// with tabindex="-1" and not a hidden input.
export function isTabbable(el) {
  if (!el) return false
  if (el.disabled) return false
  if (el.hidden) return false
  if (typeof el.tabIndex === 'number' && el.tabIndex < 0) return false
  if (el.type === 'hidden') return false
  if (typeof el.getAttribute === 'function' && el.getAttribute('aria-hidden') === 'true') return false
  return true
}

export function tabbableWithin(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return []
  return Array.from(root.querySelectorAll(TABBABLE_SELECTOR)).filter(isTabbable)
}

// Where focus should go for a Tab (`shiftKey` false) or Shift+Tab (`true`)
// press, given the tabbable controls IN DOCUMENT ORDER and the currently
// focused element. `null` means "do not intercept — let the browser move".
export function tabTarget({ shiftKey, active, tabbable, fallback = null }) {
  if (!Array.isArray(tabbable) || tabbable.length === 0) return fallback
  const first = tabbable[0]
  const last = tabbable[tabbable.length - 1]
  const inside = tabbable.includes(active)
  if (shiftKey) return (!inside || active === first) ? last : null
  return (!inside || active === last) ? first : null
}
