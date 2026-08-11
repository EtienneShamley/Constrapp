import { describe, it, expect } from 'vitest'
import {
  ALLOWED_CONTENT_TYPES, ALLOWED_EXTENSIONS,
  DRAWING_MAX_BYTES, DOCUMENT_MAX_BYTES,
  fileExtension, storageExtension, objectName,
  drawingStoragePath, documentStoragePath,
  validateFile, formatFileSize, originalFileName,
  isImageContentType, isPdfContentType, uploadErrorMessage,
} from '../../src/lib/files.js'

// ── lib/files.js — file types, size ceilings, and storage paths ──────────────
//
// The storage-path tests are the important ones: those exact strings are what
// Firestore rules and Storage Rules independently recompute, so a change here
// that is not mirrored in both rules files breaks every upload.

const file = (name, type, size) => ({ name, type, size })

describe('allowed types', () => {
  it('accepts exactly PDF, PNG and JPEG as content types', () => {
    expect(ALLOWED_CONTENT_TYPES).toEqual(['application/pdf', 'image/png', 'image/jpeg'])
  })

  it('accepts jpg and jpeg as filename extensions for the same picture', () => {
    expect(ALLOWED_EXTENSIONS).toEqual(['pdf', 'png', 'jpg', 'jpeg'])
  })

  it('uses 50 MB for drawings and 25 MB for documents', () => {
    expect(DRAWING_MAX_BYTES).toBe(52428800)
    expect(DOCUMENT_MAX_BYTES).toBe(26214400)
  })
})

describe('fileExtension', () => {
  it('lowercases the extension', () => {
    expect(fileExtension('Ground Floor.PDF')).toBe('pdf')
  })

  it('takes the LAST extension of a multi-dotted name', () => {
    expect(fileExtension('A-101.rev.b.pdf')).toBe('pdf')
  })

  it('returns empty for a name with no extension', () => {
    expect(fileExtension('drawing')).toBe('')
  })

  it('returns empty for a dotfile with no extension', () => {
    expect(fileExtension('.gitignore')).toBe('')
  })

  it('returns empty for a trailing dot', () => {
    expect(fileExtension('plan.')).toBe('')
  })

  it('returns empty for null and undefined', () => {
    expect(fileExtension(null)).toBe('')
    expect(fileExtension(undefined)).toBe('')
  })
})

describe('storageExtension / objectName', () => {
  it('maps every allowed content type to one stored extension', () => {
    expect(storageExtension('application/pdf')).toBe('pdf')
    expect(storageExtension('image/png')).toBe('png')
    expect(storageExtension('image/jpeg')).toBe('jpg')
  })

  it('is case-insensitive about the content type', () => {
    expect(storageExtension('Application/PDF')).toBe('pdf')
  })

  it('returns empty for an unsupported content type', () => {
    expect(storageExtension('application/acad')).toBe('')
    expect(storageExtension('')).toBe('')
  })

  it('names every object original.{ext}, never the user filename', () => {
    expect(objectName('application/pdf')).toBe('original.pdf')
    expect(objectName('image/png')).toBe('original.png')
    expect(objectName('image/jpeg')).toBe('original.jpg')
    expect(objectName('application/zip')).toBe('')
  })
})

describe('drawingStoragePath', () => {
  it('builds the exact company-namespaced revision path', () => {
    expect(drawingStoragePath('c1', 'p1', 'd1', 'r1', 'application/pdf'))
      .toBe('companies/c1/projects/p1/drawings/d1/r1/original.pdf')
  })

  it('stores a JPEG as .jpg regardless of what the file was called', () => {
    expect(drawingStoragePath('c1', 'p1', 'd1', 'r1', 'image/jpeg'))
      .toBe('companies/c1/projects/p1/drawings/d1/r1/original.jpg')
  })

  it('returns empty when any identity segment is missing', () => {
    expect(drawingStoragePath('', 'p1', 'd1', 'r1', 'application/pdf')).toBe('')
    expect(drawingStoragePath('c1', '', 'd1', 'r1', 'application/pdf')).toBe('')
    expect(drawingStoragePath('c1', 'p1', '', 'r1', 'application/pdf')).toBe('')
    expect(drawingStoragePath('c1', 'p1', 'd1', '', 'application/pdf')).toBe('')
  })

  it('returns empty for an unsupported content type', () => {
    expect(drawingStoragePath('c1', 'p1', 'd1', 'r1', 'image/gif')).toBe('')
  })
})

describe('documentStoragePath', () => {
  it('builds the exact company-namespaced document path', () => {
    expect(documentStoragePath('c1', 'p1', 'doc1', 'image/png'))
      .toBe('companies/c1/projects/p1/documents/doc1/original.png')
  })

  it('returns empty when a segment or the content type is missing', () => {
    expect(documentStoragePath('c1', 'p1', '', 'image/png')).toBe('')
    expect(documentStoragePath('c1', 'p1', 'doc1', 'text/plain')).toBe('')
  })
})

describe('validateFile', () => {
  it('accepts a PDF within the ceiling', () => {
    expect(validateFile(file('A-101.pdf', 'application/pdf', 2048), DRAWING_MAX_BYTES)).toBeNull()
  })

  it('accepts a .jpeg carrying image/jpeg', () => {
    expect(validateFile(file('site.jpeg', 'image/jpeg', 2048), DRAWING_MAX_BYTES)).toBeNull()
  })

  it('accepts a .jpg carrying image/jpeg', () => {
    expect(validateFile(file('site.jpg', 'image/jpeg', 2048), DRAWING_MAX_BYTES)).toBeNull()
  })

  it('rejects nothing selected', () => {
    expect(validateFile(null, DRAWING_MAX_BYTES)).toBe('Choose a file to upload')
  })

  it('rejects a file with no extension', () => {
    expect(validateFile(file('drawing', 'application/pdf', 10), DRAWING_MAX_BYTES)).toMatch(/Unsupported file/)
  })

  it('rejects an unsupported extension', () => {
    expect(validateFile(file('plan.dwg', 'application/acad', 10), DRAWING_MAX_BYTES)).toMatch(/\.dwg files are not supported/)
  })

  it('rejects an unsupported MIME type even with an allowed extension', () => {
    expect(validateFile(file('plan.pdf', 'application/octet-stream', 10), DRAWING_MAX_BYTES))
      .toMatch(/Unsupported file type/)
  })

  it('rejects an extension that disagrees with the MIME type', () => {
    expect(validateFile(file('plan.pdf', 'image/png', 10), DRAWING_MAX_BYTES))
      .toBe('The file extension (.pdf) does not match its file type')
  })

  it('rejects a zero-byte file', () => {
    expect(validateFile(file('plan.pdf', 'application/pdf', 0), DRAWING_MAX_BYTES))
      .toBe('This file is empty (0 bytes)')
  })

  it('rejects a file whose size is not a number', () => {
    expect(validateFile(file('plan.pdf', 'application/pdf', NaN), DRAWING_MAX_BYTES))
      .toBe('This file is empty (0 bytes)')
  })

  it('accepts a file EXACTLY at the ceiling', () => {
    expect(validateFile(file('plan.pdf', 'application/pdf', DRAWING_MAX_BYTES), DRAWING_MAX_BYTES)).toBeNull()
  })

  it('rejects a file one byte over the ceiling', () => {
    expect(validateFile(file('plan.pdf', 'application/pdf', DRAWING_MAX_BYTES + 1), DRAWING_MAX_BYTES))
      .toBe('File is too large — maximum 50.0 MB')
  })

  it('applies the smaller document ceiling independently', () => {
    const size = DOCUMENT_MAX_BYTES + 1
    expect(validateFile(file('spec.pdf', 'application/pdf', size), DOCUMENT_MAX_BYTES))
      .toBe('File is too large — maximum 25.0 MB')
    // The same file is fine as a drawing.
    expect(validateFile(file('spec.pdf', 'application/pdf', size), DRAWING_MAX_BYTES)).toBeNull()
  })
})

describe('formatFileSize', () => {
  it('formats bytes, whole KB and one-decimal MB', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1024)).toBe('1 KB')
    expect(formatFileSize(1536)).toBe('2 KB')
    expect(formatFileSize(1048576)).toBe('1.0 MB')
    expect(formatFileSize(52428800)).toBe('50.0 MB')
  })

  it('returns an em dash for missing or negative values', () => {
    expect(formatFileSize(null)).toBe('—')
    expect(formatFileSize(undefined)).toBe('—')
    expect(formatFileSize(-1)).toBe('—')
  })
})

describe('originalFileName', () => {
  it('trims the name kept as metadata', () => {
    expect(originalFileName({ name: '  A-101 Rev B.pdf  ' })).toBe('A-101 Rev B.pdf')
  })

  it('caps a pathological name at 255 characters', () => {
    expect(originalFileName({ name: 'x'.repeat(400) })).toHaveLength(255)
  })

  it('returns empty for a missing file', () => {
    expect(originalFileName(null)).toBe('')
  })
})

describe('content type predicates', () => {
  it('treats PNG and JPEG as renderable inline', () => {
    expect(isImageContentType('image/png')).toBe(true)
    expect(isImageContentType('image/jpeg')).toBe(true)
    expect(isImageContentType('application/pdf')).toBe(false)
  })

  it('identifies PDFs, which are handed to the browser viewer', () => {
    expect(isPdfContentType('application/pdf')).toBe(true)
    expect(isPdfContentType('image/png')).toBe(false)
  })
})

describe('uploadErrorMessage', () => {
  it('reports a rules rejection as a permission problem, not a fault', () => {
    expect(uploadErrorMessage({ code: 'storage/unauthorized' }))
      .toBe('You do not have permission to upload this file.')
  })

  it('reports a cancellation as a cancellation', () => {
    expect(uploadErrorMessage({ code: 'storage/canceled' })).toBe('Upload cancelled.')
  })

  it('names a missing bucket rather than blaming the connection', () => {
    expect(uploadErrorMessage({ code: 'storage/bucket-not-found' }))
      .toBe('File storage is not set up for this Firebase project yet.')
  })

  it('falls back to a generic message for unknown codes', () => {
    expect(uploadErrorMessage({ code: 'storage/unknown' }))
      .toBe('Upload failed. Check your connection and try again.')
    expect(uploadErrorMessage(null)).toBe('Upload failed. Check your connection and try again.')
  })
})
