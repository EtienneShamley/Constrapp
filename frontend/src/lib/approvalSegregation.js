// ── Approval segregation (maker-checker) — UX mirror of the Rules ────────────
//
// A company may require that a document is approved by someone OTHER than the
// person who prepared it. The policy is one document,
//
//     companies/{companyId}/approvalPolicy/current   { segregationEnabled: true }
//
// readable by any member of the company and written ONLY by the operator tool.
// When it is on, Firestore Rules refuse four client-written approvals by a
// preparer (frontend/firestore.rules → independentApprover /
// independentOfStampedPreparers):
//
//   · budget version approval (budgetApprovals draft → approved): preparers =
//     `createdBy` and `updatedBy` (drafts are never edited, so in practice the
//     capturer);
//   · budget adjustment approval (budgetAdjustments draft → approved): the same;
//   · purchase-order SEND (draft | pending_approval → sent): preparers =
//     `createdBy` and `lastMaterialEditBy`; a PO WITHOUT a `lastMaterialEditBy`
//     string is refused for EVERYONE (its preparer was never recorded — a
//     material save records it);
//   · tender-package AWARD (issued → awarded): the same as a PO send.
//
// ⚠️ UX ONLY. Nothing here enforces anything: the Rules are the boundary and
// stay authoritative. These helpers keep the browser from offering an action
// the Rules would refuse, and explain a refusal that does happen.
//
// STRICT: only the boolean `true` turns segregation on, exactly as the Rules
// read it. A policy that is still loading or could not be read is NOT KNOWN:
// nothing is blocked, and nothing claims that self-approval is permitted.

export const SEGREGATION_EXPLANATION =
  'Your company requires approvals by someone other than the person who prepared the document.'

// The four Rules-enforced actions, with the words each surface uses.
export const APPROVAL_ACTION = {
  BUDGET_VERSION:    'budget-version',
  BUDGET_ADJUSTMENT: 'budget-adjustment',
  PO_SEND:           'po-send',
  TENDER_AWARD:      'tender-award',
}

const ACTION_WORDS = {
  [APPROVAL_ACTION.BUDGET_VERSION]:    { noun: 'budget draft',      verb: 'approve' },
  [APPROVAL_ACTION.BUDGET_ADJUSTMENT]: { noun: 'budget adjustment', verb: 'approve' },
  [APPROVAL_ACTION.PO_SEND]:           { noun: 'purchase order',    verb: 'send' },
  [APPROVAL_ACTION.TENDER_AWARD]:      { noun: 'tender package',    verb: 'award' },
}
const GENERIC_WORDS = { noun: 'document', verb: 'approve' }
const wordsFor = (action) => ACTION_WORDS[action] ?? GENERIC_WORDS

export const APPROVAL_BLOCK = {
  CREATOR:     'creator',      // the viewer created the document
  LAST_EDITOR: 'last-editor',  // the viewer made its last material edit
  UNRECORDED:  'unrecorded',   // its preparer was never recorded (legacy)
}

export function segregationEnabled(policy) {
  return policy?.segregationEnabled === true
}

// null when nothing blocks the viewer, or { code, reason }.
//
// `requireStamp` — the PO-send and tender-award form: a document without a
// `lastMaterialEditBy` string is refused for everyone (fail closed, as the
// Rules do; an empty string is still a string to the Rules).
export function approvalBlock({ policy, uid, createdBy, lastMaterialEditBy, requireStamp = false, action } = {}) {
  if (!segregationEnabled(policy)) return null
  const { noun, verb } = wordsFor(action)
  const another = `Another authorised member must ${verb} it.`
  if (typeof uid === 'string' && uid && uid === createdBy) {
    return { code: APPROVAL_BLOCK.CREATOR, reason: `You prepared this ${noun}, so you cannot ${verb} it. ${SEGREGATION_EXPLANATION} ${another}` }
  }
  if (typeof uid === 'string' && uid && uid === lastMaterialEditBy) {
    return { code: APPROVAL_BLOCK.LAST_EDITOR, reason: `You made the last change to this ${noun}'s content, so you cannot ${verb} it. ${SEGREGATION_EXPLANATION} ${another}` }
  }
  if (requireStamp && typeof lastMaterialEditBy !== 'string') {
    return {
      code: APPROVAL_BLOCK.UNRECORDED,
      reason: `This ${noun}'s preparer was never recorded (it was written before preparers were tracked), so no one can ${verb} it yet. ${SEGREGATION_EXPLANATION} An authorised member must save a change to its content first, then another member can ${verb} it.`,
    }
  }
  return null
}

export const SEGREGATION_NOTE = {
  UNKNOWN:     'unknown',      // the policy is loading or unreadable — say nothing
  OFF:         'off',          // segregation is off (known)
  BLOCKED:     'blocked',      // segregation is on and the viewer may not act
  INDEPENDENT: 'independent',  // segregation is on and the viewer did not prepare it
}

// What a surface should say about segregation. `text` is null when the
// surface keeps its own wording (OFF) or says nothing (UNKNOWN).
export function segregationNote({ policy, policyKnown, ...rest } = {}) {
  if (!policyKnown) return { kind: SEGREGATION_NOTE.UNKNOWN, text: null, block: null }
  if (!segregationEnabled(policy)) return { kind: SEGREGATION_NOTE.OFF, text: null, block: null }
  const block = approvalBlock({ policy, ...rest })
  if (block) return { kind: SEGREGATION_NOTE.BLOCKED, text: block.reason, block }
  const { noun, verb } = wordsFor(rest.action)
  return { kind: SEGREGATION_NOTE.INDEPENDENT, text: `You did not prepare this ${noun}, so you can ${verb} it. ${SEGREGATION_EXPLANATION}`, block: null }
}

// A Firestore / domain-error permission refusal: `permission-denied` on the
// error or its cause, or a *Actions module's PERMISSION kind.
export function isPermissionRefusal(err) {
  for (const c of [err?.code, err?.cause?.code]) {
    if (typeof c === 'string' && c.replace(/^firestore\//, '') === 'permission-denied') return true
  }
  return err?.kind === 'permission'
}

// A permission refusal of one of the four actions, explained. When the policy
// is ON and the viewer is blocked by it, the refusal is CERTAIN and its reason
// is segregation — the specific explanation replaces the generic "You do not
// have permission" text. Otherwise null: the caller keeps its own message.
export function describeApprovalRefusal(err, context = {}) {
  if (!isPermissionRefusal(err)) return null
  const block = approvalBlock(context)
  if (!block) return null
  return { certain: true, kind: 'segregation', code: block.code, message: `Nothing was changed. ${block.reason}` }
}
