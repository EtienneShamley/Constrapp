import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createWriteController, writeFlags } from '../lib/writeOutcome'

// React binding for lib/writeOutcome.js (L3 Stage 2). One controller per
// dialog instance; every rule lives in the controller, not here.
//
//   const write = useWriteAction('Client receipt')
//   write.run(() => onSave(fields), { onConfirmed: onClose })
//   <WriteFeedback write={write} />
//   <Btn disabled={write.locked || !valid}>{write.busy ? 'Saving…' : 'Save'}</Btn>
//
// This hook performs no Firestore access. The write itself stays in the data
// hook that owns it, with its transaction and guards unchanged.
export function useWriteAction(label) {
  const [controller] = useState(() => createWriteController({ label }))
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)

  // attach/detach as a pair so React's development double-mount leaves the
  // controller attached; a real unmount hands an unanswered write to the
  // page-level notice.
  useEffect(() => {
    controller.attach()
    return () => controller.detach()
  }, [controller])

  return useMemo(() => ({
    ...state,
    ...writeFlags(state),
    run: controller.run,
    acknowledge: controller.acknowledge,
    clearFailure: controller.clearFailure,
  }), [state, controller])
}
