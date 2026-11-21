import { WRITE_PHASE } from '../lib/writeOutcome'

// The message under a dialog's form for a write started with useWriteAction.
// A definite failure is red; an unanswered or uncertain write is amber, because
// it is not known to have failed. Only a SETTLED uncertain outcome offers the
// acknowledgement that re-enables the submit button.
export default function WriteFeedback({ write }) {
  if (!write?.message) return null
  const failed = write.phase === WRITE_PHASE.FAILED
  return (
    <div role="alert" data-write-phase={write.phase}>
      <p className={`text-[12px] m-0 ${failed ? 'text-brand-red' : 'text-brand-amber'}`}>{write.message}</p>
      {write.canAcknowledge && (
        <button
          type="button"
          onClick={write.acknowledge}
          className="mt-1.5 text-[11.5px] font-semibold text-brand-text underline cursor-pointer bg-transparent border-0 p-0"
        >
          I have checked the list — it was not saved. Let me try again.
        </button>
      )}
    </div>
  )
}
