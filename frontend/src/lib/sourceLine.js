// ── Source-line identity (M3-B2, ADR-63) ─────────────────────────────────────
//
// A progress-claim line or a supplier-invoice line recognises cost against
// exactly ONE source line:
//
//   · a PO LINE          — identity `poId` (the document's) + `poLineIndex`
//   · a VARIATION LINE   — identity `variationId` + `variationLineIndex`
//                          (a positive NEW_SCOPE line of an approved,
//                          scope-committed supplier variation, ADR-63)
//
// The two identities are kept apart on the line itself: a variation-origin
// line carries `variationId` + `variationLineIndex` and `poLineIndex: null`;
// a PO-origin line carries an integer `poLineIndex` and NO variation keys
// (every document written before M3-B2 has this shape — absent variation
// keys read as PO-origin, and nothing is backfilled).
//
// ⚠️ A NULL `poLineIndex` IS NEVER COERCED TO 0. Before M3-B2 the two line
// builders ran every index through `Number(v) || 0`, which would have silently
// attributed a variation-origin line to PO LINE 0 — moving its recognition onto
// the wrong commitment line. Every builder and every selector now reads the
// index through `indexOrNull` and refuses a line whose identity is malformed
// (`sourceLineIdentityError`) rather than reinterpreting it.
//
// Pure, dependency-free; shared by lib/progressClaims.js, lib/supplierInvoices.js,
// lib/variations.js, lib/commitment.js and lib/shield.js so the one notion of
// "which line is this" cannot drift between them.

export const SOURCE_LINE_KIND = {
  PO_LINE:        'po_line',
  VARIATION_LINE: 'variation_line',
  INVALID:        'invalid',
}

// A non-negative integer index, or null. Strings, floats, negatives, NaN,
// null and undefined all read as null — never as 0.
export function indexOrNull(v) {
  return Number.isInteger(v) && v >= 0 ? v : null
}

export const isVariationOriginLine = (li) =>
  typeof li?.variationId === 'string' && li.variationId.length > 0

// Classifies one stored or built line by its identity fields alone (no
// register lookup). INVALID covers: a variation id with a bad line index or a
// non-null PO index; a PO-origin line without a valid integer PO index.
export function sourceLineKind(li) {
  if (!li || typeof li !== 'object') return SOURCE_LINE_KIND.INVALID
  if (isVariationOriginLine(li)) {
    return indexOrNull(li.variationLineIndex) !== null && (li.poLineIndex === null || li.poLineIndex === undefined)
      ? SOURCE_LINE_KIND.VARIATION_LINE
      : SOURCE_LINE_KIND.INVALID
  }
  if (li.variationId !== undefined && li.variationId !== null) return SOURCE_LINE_KIND.INVALID // a non-string, non-null id
  return indexOrNull(li.poLineIndex) !== null ? SOURCE_LINE_KIND.PO_LINE : SOURCE_LINE_KIND.INVALID
}

export const poLineKey        = (poId, idx)        => `po:${poId}:${idx}`
export const variationLineKey = (variationId, idx) => `var:${variationId}:${idx}`

// The collision-safe stable key of a line, or null when its identity is
// malformed. `poId` is the owning document's PO (claim.poId / invoice.poId).
export function sourceLineKey(li, { poId } = {}) {
  switch (sourceLineKind(li)) {
    case SOURCE_LINE_KIND.PO_LINE:        return poLineKey(poId ?? '', li.poLineIndex)
    case SOURCE_LINE_KIND.VARIATION_LINE: return variationLineKey(li.variationId, li.variationLineIndex)
    default:                              return null
  }
}

// Human label for messages: "PO line 3" / "SV-0002 line 1".
export function sourceLineLabel(li) {
  if (sourceLineKind(li) === SOURCE_LINE_KIND.VARIATION_LINE) {
    return `${li.variationNumber || li.variationId} line ${li.variationLineIndex + 1}`
  }
  if (sourceLineKind(li) === SOURCE_LINE_KIND.PO_LINE) return `PO line ${li.poLineIndex + 1}`
  return 'line with no valid source'
}

// Number of variation-origin lines in a line set — the value the claim and
// invoice headers carry as `variationLineCount` (rules pin the line count to
// PO lines + this number; the contents stay client-only, DC40).
export function variationLineCountOf(lineItems) {
  return (Array.isArray(lineItems) ? lineItems : []).filter(li => sourceLineKind(li) === SOURCE_LINE_KIND.VARIATION_LINE).length
}

// The first identity defect in a line set, or null. A set is valid when every
// line has exactly one well-formed identity and no two lines share a key —
// one claim or invoice may recognise a source line once only. Fail-closed:
// used by validateClaimDraft (create, draft edit, approve) and by the invoice
// builders, so a malformed stored line blocks the write instead of being
// silently repaired or re-attributed.
export function sourceLineIdentityError(lineItems, { poId } = {}) {
  const lines = Array.isArray(lineItems) ? lineItems : []
  const seen = new Set()
  for (let i = 0; i < lines.length; i++) {
    const li = lines[i]
    const kind = sourceLineKind(li)
    if (kind === SOURCE_LINE_KIND.INVALID) {
      return `Line ${i + 1}: the source line identity is missing or malformed (it names neither a PO line nor a variation line)`
    }
    const key = sourceLineKey(li, { poId })
    if (seen.has(key)) return `Line ${i + 1}: ${sourceLineLabel(li)} appears more than once — a source line may be claimed once per document`
    seen.add(key)
  }
  return null
}
