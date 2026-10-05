import { createAction, props } from '@ngrx/store';
import { CueDecision, ItemKind, ScriptVersion } from './script.reducer';

export const addVersion = createAction('[Script] Add Version', props<{ version: ScriptVersion }>());
export const activateVersion = createAction('[Script] Activate Version', props<{ id: string }>());
export const reviewLine = createAction('[Script] Review Line', props<{ id: string; decision: 'accepted' | 'returned' }>());
export const reorderLines = createAction('[Script] Reorder Lines', props<{ from: number; to: number }>());
export const reviewCue = createAction('[Script] Review Cue', props<{ id: string; decision: CueDecision }>());
export const toggleRehearsal = createAction('[Script] Toggle Rehearsal');
export const setOnline = createAction('[Script] Set Online', props<{ online: boolean }>());

/** 断网/在线期间编辑台词或舞台提示。断网时改动进入离线改动队列。 */
export const editItem = createAction(
  '[Script] Edit Item',
  props<{ kind: ItemKind; itemId: string; field: 'text' | 'role' | 'scene'; value: string }>()
);

/** 接收编剧新稿并按基线合并断网改动。 */
export const mergeWriterDraft = createAction('[Script] Merge Writer Draft', props<{ draft: ScriptVersion }>());

/** 处置冲突：选择本地方案或编剧方案，处置后排练提词可见。 */
export const resolveConflict = createAction(
  '[Script] Resolve Conflict',
  props<{ conflictId: string; choice: 'local' | 'remote' }>()
);
