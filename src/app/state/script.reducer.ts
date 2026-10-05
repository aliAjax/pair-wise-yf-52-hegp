import { createReducer, on } from '@ngrx/store';
import { activateVersion, addVersion, editItem, mergeWriterDraft, resolveConflict, reorderLines, reviewCue, reviewLine, setOnline, toggleRehearsal } from './script.actions';
import { mergeDraft, snapshotVersion } from './merge';

export type CueDecision = 'pending' | 'accepted' | 'returned';
export type ItemKind = 'line' | 'cue';

export interface ScriptVersion {
  id: string;
  label: string;
  playwright: string;
  note: string;
  lines: Array<{ id: string; role: string; text: string; status: 'pending' | 'accepted' | 'returned' }>;
  cues: Array<{ id: string; scene: string; text: string; status: CueDecision }>;
}

/** 断网期间排队的单条改动，before 为断网基线值，用于三方合并。 */
export interface OfflineChange {
  id: string;
  kind: ItemKind;
  itemId: string;
  field: 'text' | 'role' | 'scene';
  before: string | null;
  after: string;
  at: number;
  applied: boolean;
}

/** 双方都改过的条目保留两版，status=open 表示待处置。 */
export interface MergeConflict {
  id: string;
  kind: ItemKind;
  itemId: string;
  baseline: string | null;
  local: string;
  remote: string;
  status: 'open' | 'local' | 'remote';
  at: number;
}

export interface BaselineSnapshot {
  lines: Array<{ id: string; role: string; text: string }>;
  cues: Array<{ id: string; scene: string; text: string }>;
}

export interface ScriptState {
  schemaVersion: number;
  versions: ScriptVersion[];
  activeVersionId: string;
  rehearsalMode: boolean;
  online: boolean;
  /** 断网前最后一次同步的基线快照。 */
  baseline: BaselineSnapshot | null;
  offlineChanges: OfflineChange[];
  conflicts: MergeConflict[];
  /** 已合并的编剧稿 id，保证重试不重复合并。 */
  mergedDraftIds: string[];
  mergeError: string | null;
}

const CURRENT_SCHEMA = 2;
const STORAGE_KEY = 'yf52-script-state';

const initialVersions: ScriptVersion[] = [
  {
    id: 'v12', label: '排练稿 v12', playwright: '林编剧', note: '重写第三场父女冲突，舞台灯光提示延后2拍。',
    lines: [
      { id: 'l1', role: '周岚', text: '你每次都说等明天，可舞台不会等我们。', status: 'pending' },
      { id: 'l2', role: '周野', text: '那就让灯灭吧，我早已背熟黑暗。', status: 'pending' }
    ],
    cues: [
      { id: 'c1', scene: '第三场', text: '侧灯收至30%，雨声渐入', status: 'pending' },
      { id: 'c2', scene: '第三场', text: '周野坐到舞台左前区，保留两拍静默', status: 'accepted' }
    ]
  },
  {
    id: 'v13', label: '导演修订 v13', playwright: '林编剧', note: '调整周岚结论，加入一次性追光变化。',
    lines: [
      { id: 'l1', role: '周岚', text: '你总说明天，但今晚我们必须把话说完。', status: 'pending' },
      { id: 'l3', role: '周岚', text: '看着灯，再说一次你为什么回来。', status: 'pending' }
    ],
    cues: [{ id: 'c3', scene: '第三场', text: '追光由冷白切换至琥珀，等待雨声下落', status: 'pending' }]
  }
];

function fallbackState(): ScriptState {
  return {
    schemaVersion: CURRENT_SCHEMA,
    versions: initialVersions,
    activeVersionId: 'v12',
    rehearsalMode: false,
    online: true,
    baseline: null,
    offlineChanges: [],
    conflicts: [],
    mergedDraftIds: [],
    mergeError: null
  };
}

/**
 * 历史数据升级：旧版本地数据没有基线/改动队列，
 * 升级后保留原有台词、提示与采纳状态，并依据当前版本建立合并基线。
 */
function migrate(raw: unknown): ScriptState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallbackState();
  const source = raw as Record<string, unknown>;
  const state: ScriptState = {
    schemaVersion: typeof source.schemaVersion === 'number' ? source.schemaVersion : 1,
    versions: Array.isArray(source.versions) && (source.versions as unknown[]).length ? (source.versions as ScriptVersion[]) : initialVersions,
    activeVersionId: typeof source.activeVersionId === 'string' ? source.activeVersionId : 'v12',
    rehearsalMode: source.rehearsalMode === true,
    online: source.online !== false,
    baseline: (source.baseline as BaselineSnapshot) ?? null,
    offlineChanges: Array.isArray(source.offlineChanges) ? (source.offlineChanges as OfflineChange[]) : [],
    conflicts: Array.isArray(source.conflicts) ? (source.conflicts as MergeConflict[]) : [],
    mergedDraftIds: Array.isArray(source.mergedDraftIds) ? (source.mergedDraftIds as string[]) : [],
    mergeError: typeof source.mergeError === 'string' ? source.mergeError : null
  };
  if (state.schemaVersion < CURRENT_SCHEMA) {
    const active = state.versions.find((v) => v.id === state.activeVersionId) ?? state.versions[0];
    state.baseline = state.baseline ?? snapshotVersion(active);
    state.schemaVersion = CURRENT_SCHEMA;
  }
  return state;
}

function getInitialState(): ScriptState {
  if (typeof localStorage === 'undefined') return fallbackState();
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return fallbackState();
  try {
    return migrate(JSON.parse(saved));
  } catch {
    return fallbackState();
  }
}

function mapActiveVersion(state: ScriptState, project: (version: ScriptVersion) => ScriptVersion): ScriptState {
  return {
    ...state,
    versions: state.versions.map((version) => (version.id === state.activeVersionId ? project(version) : version))
  };
}

export const scriptReducer = createReducer(
  getInitialState(),
  on(addVersion, (state, { version }) => ({ ...state, versions: [...state.versions, version] })),
  on(activateVersion, (state, { id }) => ({ ...state, activeVersionId: id })),
  on(reviewLine, (state, { id, decision }) =>
    mapActiveVersion(state, (version) => ({
      ...version,
      lines: version.lines.map((line) => (line.id === id ? { ...line, status: decision } : line))
    }))
  ),
  on(reorderLines, (state, { from, to }) =>
    mapActiveVersion(state, (version) => {
      if (from === to) return version;
      const lines = [...version.lines];
      const [moved] = lines.splice(from, 1);
      lines.splice(to, 0, moved);
      return { ...version, lines };
    })
  ),
  on(reviewCue, (state, { id, decision }) =>
    mapActiveVersion(state, (version) => ({
      ...version,
      cues: version.cues.map((cue) => (cue.id === id ? { ...cue, status: decision } : cue))
    }))
  ),
  on(toggleRehearsal, (state) => ({ ...state, rehearsalMode: !state.rehearsalMode })),
  on(setOnline, (state, { online }) => {
    if (online) return { ...state, online: true, mergeError: null };
    if (!state.online) return state; // 已处于离线，保留既有基线，避免重复快照丢失原始基线
    const active = state.versions.find((v) => v.id === state.activeVersionId) ?? state.versions[0];
    return { ...state, online: false, baseline: snapshotVersion(active), mergeError: null };
  }),
  on(editItem, (state, { kind, itemId, field, value }) => {
    const versions = state.versions.map((version) => {
      if (version.id !== state.activeVersionId) return version;
      if (kind === 'line') {
        return {
          ...version,
          lines: version.lines.map((line) => {
            if (line.id !== itemId) return line;
            return field === 'role' ? { ...line, role: value } : { ...line, text: value };
          })
        };
      }
      return {
        ...version,
        cues: version.cues.map((cue) => {
          if (cue.id !== itemId) return cue;
          return field === 'scene' ? { ...cue, scene: value } : { ...cue, text: value };
        })
      };
    });

    let baseline = state.baseline;
    let offlineChanges = state.offlineChanges;

    if (!state.online) {
      // 断网：改动进入队列，before 取基线值；同一条目的连续编辑合并为一条，重试不重复。
      const baseItem = kind === 'line'
        ? state.baseline?.lines.find((line) => line.id === itemId)
        : state.baseline?.cues.find((cue) => cue.id === itemId);
      const before = baseItem ? (baseItem as Record<string, string>)[field] ?? null : null;
      const idx = offlineChanges.findIndex((change) => change.kind === kind && change.itemId === itemId && change.field === field);
      if (idx >= 0) {
        offlineChanges = offlineChanges.map((change, i) => (i === idx ? { ...change, after: value, at: Date.now() } : change));
      } else {
        const change: OfflineChange = {
          id: `oc-${kind}-${itemId}-${field}-${Date.now().toString(36)}`,
          kind,
          itemId,
          field,
          before,
          after: value,
          at: Date.now(),
          applied: false
        };
        offlineChanges = [...offlineChanges, change];
      }
    } else if (baseline) {
      // 在线：改动即时同步，基线跟随更新。
      baseline = {
        lines: kind === 'line'
          ? baseline.lines.map((line) => (line.id === itemId ? { ...line, [field]: value } : line))
          : baseline.lines,
        cues: kind === 'cue'
          ? baseline.cues.map((cue) => (cue.id === itemId ? { ...cue, [field]: value } : cue))
          : baseline.cues
      };
    }

    return { ...state, versions, baseline, offlineChanges };
  }),
  on(mergeWriterDraft, (state, { draft }) => mergeDraft(state, draft)),
  on(resolveConflict, (state, { conflictId, choice }) => {
    const conflict = state.conflicts.find((item) => item.id === conflictId);
    if (!conflict || conflict.status !== 'open') return state;
    const chosen = choice === 'local' ? conflict.local : conflict.remote;
    const versions: ScriptVersion[] = state.versions.map((version) => {
      if (version.id !== state.activeVersionId) return version;
      if (conflict.kind === 'line') {
        return {
          ...version,
          lines: version.lines.map((line) =>
            line.id === conflict.itemId ? { ...line, text: chosen, status: 'accepted' as const } : line
          )
        };
      }
      return {
        ...version,
        cues: version.cues.map((cue) =>
          cue.id === conflict.itemId ? { ...cue, text: chosen, status: 'accepted' as const } : cue
        )
      };
    });
    const baseline = state.baseline
      ? {
          lines: conflict.kind === 'line'
            ? state.baseline.lines.map((line) => (line.id === conflict.itemId ? { ...line, text: chosen } : line))
            : state.baseline.lines,
          cues: conflict.kind === 'cue'
            ? state.baseline.cues.map((cue) => (cue.id === conflict.itemId ? { ...cue, text: chosen } : cue))
            : state.baseline.cues
        }
      : state.baseline;
    const conflicts = state.conflicts.map((item) => (item.id === conflictId ? { ...item, status: choice } : item));
    return { ...state, versions, baseline, conflicts, mergeError: null };
  })
);
