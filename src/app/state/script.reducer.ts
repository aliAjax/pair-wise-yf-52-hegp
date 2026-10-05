import { createReducer, on } from '@ngrx/store';
import {
  activateVersion,
  addCueItem,
  addLineItem,
  addVersion,
  editCueText,
  editLineText,
  mergeOfflineQueue,
  reorderLines,
  resolveConflict,
  reviewCue,
  reviewLine,
  setOnline,
  toggleRehearsal
} from './script.actions';
import {
  applyItemEdit,
  applyNewItem,
  mergeOfflineOps,
  migrateState,
  registerPlaywrightVersion,
  resolveConflictOp,
  reviewItem,
  ScriptState,
  STORAGE_KEY
} from './script.model';

export type { CueDecision, LineItem, CueItem, MergeConflict, OfflineOp, ReviewStatus, ScriptState, ScriptVersion } from './script.model';
export { STORAGE_KEY } from './script.model';

function getInitialState(): ScriptState {
  if (typeof localStorage === 'undefined') return migrateState();
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    // 历史数据升级在 migrateState 内完成，原有改动保留
    return saved ? migrateState(JSON.parse(saved)) : migrateState();
  } catch {
    return migrateState();
  }
}

export const scriptReducer = createReducer(
  getInitialState(),
  on(addVersion, (state, { version }) => registerPlaywrightVersion(state, version)),
  on(activateVersion, (state, { id }) => ({ ...state, activeVersionId: id })),
  on(reviewLine, (state, { id, decision }) => reviewItem(state, 'line', id, decision)),
  on(reviewCue, (state, { id, decision }) => reviewItem(state, 'cue', id, decision)),
  on(editLineText, (state, { id, text }) => applyItemEdit(state, 'line', id, text)),
  on(editCueText, (state, { id, text }) => applyItemEdit(state, 'cue', id, text)),
  on(addLineItem, (state, { id, role, text }) => applyNewItem(state, 'line', { id, role, text, status: 'pending' })),
  on(addCueItem, (state, { id, scene, text }) => applyNewItem(state, 'cue', { id, scene, text, status: 'pending' })),
  on(mergeOfflineQueue, (state) => mergeOfflineOps(state)),
  on(resolveConflict, (state, { conflictId, choice }) => resolveConflictOp(state, conflictId, choice)),
  on(reorderLines, (state, { from, to }) => ({
    ...state,
    versions: state.versions.map((version) => {
      if (version.id !== state.activeVersionId || from === to) return version;
      const lines = [...version.lines];
      const [moved] = lines.splice(from, 1);
      lines.splice(to, 0, moved);
      return { ...version, lines };
    })
  })),
  on(toggleRehearsal, (state) => ({ ...state, rehearsalMode: !state.rehearsalMode })),
  on(setOnline, (state, { online }) => ({ ...state, online }))
);
