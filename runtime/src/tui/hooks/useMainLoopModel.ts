// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { useEffect, useReducer } from 'react'
import { type AppState, useAppStateMaybeOutsideOfProvider } from '../state/AppState.js'
import {
  getDefaultMainLoopModelSetting,
  type ModelName,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js' // upstream-import: keep target is owned by another Z-PURGE item

// The value of the selector is a full model name that can be used directly in
// API calls. Use this over getMainLoopModel() when the component needs to
// update upon a model config change.
export function useMainLoopModel(): ModelName {
  const mainLoopModel = useAppStateMaybeOutsideOfProvider(
    (s: AppState) => s.mainLoopModel,
  )
  const mainLoopModelForSession = useAppStateMaybeOutsideOfProvider(
    (s: AppState) => s.mainLoopModelForSession,
  )

  // parseUserSpecifiedModel resolves aliases from config that can refresh
  // after startup. AppState doesn't change when that refresh finishes, so we
  // subscribe to the refresh signal and force a re-render to re-resolve.
  // Without this, the alias resolution is frozen until something else
  // happens to re-render the component — the API would sample one model
  // while /model (which also re-resolves) displays another.
  // forceRerender is currently unused: the effect below is a no-op placeholder
  // for the refresh-signal subscription described above. Keep the useReducer
  // call to preserve the hook order/render behavior until that wiring lands.
  useReducer(x => x + 1, 0)
  useEffect(() => () => {}, [])

  const model = parseUserSpecifiedModel(
    mainLoopModelForSession ??
      mainLoopModel ??
      getDefaultMainLoopModelSetting(),
  )
  return model
}
