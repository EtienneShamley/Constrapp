import { useCompany } from './useCompany'
import { useProfile } from './useProfile'
import { commercialActivationState } from '../lib/commercialActivation'

// ── Phase 2 commercial activation of the signed-in user's company ────────────
//
// No Firestore read of its own: the company document is the one useCompany()
// already subscribes to. Returns lib/commercialActivation.js →
// commercialActivationState — `writable` decides whether a page offers a
// Phase 2 write, `maintenance` whether it shows the read-only notice.
//
// ⚠️ UX ONLY. The trusted backend refuses every Phase 2 operation for a
// company that is not activated; this only keeps the browser from offering it.
export function useCommercialActivation() {
  const { company, companyLoading } = useCompany()
  const { profileLoading } = useProfile()
  return commercialActivationState(company, { companyLoading, profileLoading })
}
