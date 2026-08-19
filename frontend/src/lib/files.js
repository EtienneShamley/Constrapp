// ── File handling for Documents & Drawings ───────────────────────────────────
//
// Pure helpers shared by drawings and general documents: the allowed file types,
// the size ceilings, and — most importantly — the DETERMINISTIC storage paths.
//
// ⚠️ THE UPLOADED FILENAME IS NEVER OBJECT IDENTITY. Every stored object is
// named `original.{ext}` inside a folder whose path is built from Firestore
// document IDs. The user's filename is kept in Firestore metadata only. This is
// what makes an object path immutable, unguessable-by-name, and safe to enforce
// in Storage Rules (the path is the authority — never customMetadata).
//
// ⚠️ CLIENT VALIDATION IS CONVENIENCE ONLY. Everything here mirrors what
// Storage Rules enforce; the rules are the boundary. A direct SDK caller does
// not run this file. See docs/SECURITY.md.

// contentType → the ONE extension used to build the storage path. Deriving the
// extension from the content type (never from the filename) is what guarantees
// the object name and the content type can never disagree — which is exactly
// the pair Storage Rules check.
export const EXTENSION_BY_CONTENT_TYPE = {
  'application/pdf': 'pdf',
  'image/png':       'png',
  'image/jpeg':      'jpg',
}

export const ALLOWED_CONTENT_TYPES = Object.keys(EXTENSION_BY_CONTENT_TYPE)

// Filename extension → the content type it must carry. `jpeg` and `jpg` are the
// same picture; both are accepted from the user and both store as `.jpg`.
export const CONTENT_TYPE_BY_EXTENSION = {
  pdf:  'application/pdf',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
}

export const ALLOWED_EXTENSIONS = Object.keys(CONTENT_TYPE_BY_EXTENSION)

// Human label for the accepted set, and the `accept` attribute for file inputs.
export const ALLOWED_FILE_LABEL = 'PDF, PNG or JPEG'
export const FILE_INPUT_ACCEPT  = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg'

// Size ceilings. Drawings are larger because a multi-sheet PDF issue routinely
// runs to tens of megabytes; a specification or certificate does not.
export const DRAWING_MAX_BYTES  = 50 * 1024 * 1024
export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024

// Every stored object is this basename. Never the user's filename.
export const STORAGE_OBJECT_BASENAME = 'original'

// Lowercase extension of a filename, without the dot. '' when there is none.
export function fileExtension(fileName) {
  const name = String(fileName ?? '').trim()
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

// The extension a given content type stores as. '' for anything unsupported.
export function storageExtension(contentType) {
  return EXTENSION_BY_CONTENT_TYPE[String(contentType ?? '').toLowerCase()] ?? ''
}

// The object name Storage Rules expect for this content type, e.g. 'original.pdf'.
export function objectName(contentType) {
  const ext = storageExtension(contentType)
  return ext ? `${STORAGE_OBJECT_BASENAME}.${ext}` : ''
}

// ── Storage paths ────────────────────────────────────────────────────────────
//
// Drawing revision:
//   companies/{companyId}/projects/{projectId}/drawings/{drawingId}/{revisionId}/original.{ext}
// General document:
//   companies/{companyId}/projects/{projectId}/documents/{documentId}/original.{ext}
//
// Both are company-namespaced, so Storage Rules can enforce tenant isolation
// from the path alone. Both return '' if any segment is missing or the content
// type is unsupported — a caller must never upload to a half-built path.

export function drawingStoragePath(companyId, projectId, drawingId, revisionId, contentType) {
  const name = objectName(contentType)
  if (!companyId || !projectId || !drawingId || !revisionId || !name) return ''
  return `companies/${companyId}/projects/${projectId}/drawings/${drawingId}/${revisionId}/${name}`
}

export function documentStoragePath(companyId, projectId, documentId, contentType) {
  const name = objectName(contentType)
  if (!companyId || !projectId || !documentId || !name) return ''
  return `companies/${companyId}/projects/${projectId}/documents/${documentId}/${name}`
}

// ── Validation ───────────────────────────────────────────────────────────────

// Returns an error string, or null when the file is acceptable.
//
// Rejects: nothing selected, unsupported extension, unsupported MIME type, an
// extension that disagrees with the MIME type, a zero-byte file, and anything
// over the ceiling. Mirrors Storage Rules — it does not replace them.
export function validateFile(file, maxBytes) {
  if (!file) return 'Choose a file to upload'

  const ext  = fileExtension(file.name)
  const type = String(file.type ?? '').toLowerCase()

  if (!ext) return `Unsupported file — ${ALLOWED_FILE_LABEL} only`
  if (!CONTENT_TYPE_BY_EXTENSION[ext]) {
    return `.${ext} files are not supported — ${ALLOWED_FILE_LABEL} only`
  }
  if (!EXTENSION_BY_CONTENT_TYPE[type]) {
    return `Unsupported file type — ${ALLOWED_FILE_LABEL} only`
  }
  // A .pdf carrying image/png (or vice versa) is rejected: the storage path is
  // built from the content type, so a mismatch would store a file under a name
  // that lies about it.
  if (CONTENT_TYPE_BY_EXTENSION[ext] !== type) {
    return `The file extension (.${ext}) does not match its file type`
  }

  const size = Number(file.size)
  if (!Number.isFinite(size) || size <= 0) return 'This file is empty (0 bytes)'
  if (size > maxBytes) return `File is too large — maximum ${formatFileSize(maxBytes)}`

  return null
}

// ── Display ──────────────────────────────────────────────────────────────────

// Compact human size. Whole KB (a 1.4 KB / 1.6 KB distinction is noise) and one
// decimal for MB, which is the range that actually matters for drawings.
export function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined) return '—'
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// The user's filename, kept as METADATA only (never as identity). Trimmed, and
// capped so a pathological name cannot bloat the Firestore document.
export function originalFileName(file) {
  const name = String(file?.name ?? '').trim()
  return name.slice(0, 255)
}

// True when this content type can be rendered inline in an <img>. PDFs are
// deliberately excluded — they open in the browser's own viewer.
export function isImageContentType(contentType) {
  const type = String(contentType ?? '').toLowerCase()
  return type === 'image/png' || type === 'image/jpeg'
}

export const isPdfContentType = (contentType) =>
  String(contentType ?? '').toLowerCase() === 'application/pdf'

// ── Upload failures ──────────────────────────────────────────────────────────

// A human sentence for a Firebase Storage error code. Kept pure (and here
// rather than in the hook) so every upload surface reports the same thing, and
// so the mapping is testable without an emulator.
//
// `storage/unauthorized` is the interesting one: it is what Storage Rules
// return, so it means the caller's role or company genuinely does not permit
// this write — not that something went wrong.
export function uploadErrorMessage(error) {
  switch (error?.code) {
    case 'storage/canceled':
      return 'Upload cancelled.'
    case 'storage/unauthorized':
      return 'You do not have permission to upload this file.'
    case 'storage/retry-limit-exceeded':
      return 'Upload timed out. Check your connection and try again.'
    case 'storage/quota-exceeded':
      return 'Storage quota exceeded. Contact your administrator.'
    case 'storage/unauthenticated':
      return 'Your session has expired. Sign in and try again.'
    // Raised when the bucket does not exist — the state of a Firebase project
    // where Cloud Storage has never been enabled.
    case 'storage/bucket-not-found':
    case 'storage/project-not-found':
      return 'File storage is not set up for this Firebase project yet.'
    default:
      return 'Upload failed. Check your connection and try again.'
  }
}
