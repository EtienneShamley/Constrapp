// Test fixture (scripts.test.js): preloaded into an operator-script child via
// NODE_OPTIONS=--import, it makes Node print a process warning on stderr —
// the same shape as the MetadataLookupWarning google-auth-library emits on a
// CI agent with no Application Default Credentials (Azure builds #136/#137).
process.emitWarning('simulated diagnostic from the runtime environment', 'CiDiagnosticWarning')
