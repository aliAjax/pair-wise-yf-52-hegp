/**
 * 剧本版本与断网合并的领域模型。
 * 本文件不依赖 Angular / NgRx，全部为纯函数，便于独立验证合并幂等性。
 */

export type ReviewStatus = 'pending' | 'accepted' | 'returned';
/** 兼容旧引用 */
export type CueDecision = ReviewStatus;

export interface LineItem {
  id: string;
  role: string;
  text: string;
  status: ReviewStatus;
  /** 改动前基线：用于判断编剧是否碰过该条目 */
  baseText?: string;
}

export interface CueItem {
  id: string;
  scene: string;
  text: string;
  status: ReviewStatus;
  baseText?: string;
}

export interface ScriptVersion {
  id: string;
  label: string;
  playwright: string;
  note: string;
  lines: LineItem[];
  cues: CueItem[];
}

/** 断网期间逐条记录的改动，回城联网后按基线逐条带回合并 */
export interface OfflineOp {
  /** 稳定 id：同一条目未合并前重复编辑只更新同一条记录，保证重试不重复 */
  id: string;
  kind: 'line' | 'cue';
  itemId: string;
  role?: string;
  scene?: string;
  /** 改动前基线文本 */
  baseText: string;
  /** 断网改动后的文本 */
  text: string;
  status: 'pending' | 'applied' | 'conflict';
}

/** 双方都改过的条目：两版都保留，等待人工处置 */
export interface MergeConflict {
  /** 与产生它的 OfflineOp.id 相同，重试合并不会登记出重复冲突 */
  id: string;
  kind: 'line' | 'cue';
  itemId: string;
  role?: string;
  scene?: string;
  /** 断网改动版 */
  ours: string;
  /** 编剧版 */
  theirs: string;
}

export interface ScriptState {
  schemaVersion: number;
  versions: ScriptVersion[];
  activeVersionId: string;
  rehearsalMode: boolean;
  online: boolean;
  offlineQueue: OfflineOp[];
  conflicts: MergeConflict[];
}

export const SCHEMA_VERSION = 2;
export const STORAGE_KEY = 'yf52-script-state';

const initialVersions: ScriptVersion[] = [
  {
    id: 'v12',
    label: '排练稿 v12',
    playwright: '林编剧',
    note: '重写第三场父女冲突，舞台灯光提示延后2拍。',
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
    id: 'v13',
    label: '导演修订 v13',
    playwright: '林编剧',
    note: '调整周岚结论，加入一次性追光变化。',
    lines: [
      { id: 'l1', role: '周岚', text: '你总说明天，但今晚我们必须把话说完。', status: 'pending' },
      { id: 'l3', role: '周岚', text: '看着灯，再说一次你为什么回来。', status: 'pending' }
    ],
    cues: [{ id: 'c3', scene: '第三场', text: '追光由冷白切换至琥珀，等待雨声下落', status: 'pending' }]
  }
];

/** 为条目补齐基线（历史数据没有 baseText 字段，以当前文本为基线） */
function stampVersion(version: ScriptVersion): ScriptVersion {
  return {
    ...version,
    lines: (version.lines ?? []).map((line) => ({ ...line, baseText: line.baseText ?? line.text })),
    cues: (version.cues ?? []).map((cue) => ({ ...cue, baseText: cue.baseText ?? cue.text }))
  };
}

/**
 * 历史数据升级：旧缓存没有 schemaVersion / offlineQueue / conflicts / baseText。
 * 升级只补字段，原有版本、条目和已做的采纳/退回改动全部保留。
 */
export function migrateState(saved?: unknown): ScriptState {
  const data = (saved && typeof saved === 'object' ? saved : {}) as Partial<ScriptState>;
  const versions = (Array.isArray(data.versions) && data.versions.length ? data.versions : initialVersions).map(stampVersion);
  const activeVersionId = versions.some((v) => v.id === data.activeVersionId) ? (data.activeVersionId as string) : versions[0].id;
  return {
    schemaVersion: SCHEMA_VERSION,
    versions,
    activeVersionId,
    rehearsalMode: data.rehearsalMode === true,
    online: data.online !== false,
    offlineQueue: Array.isArray(data.offlineQueue) ? data.offlineQueue : [],
    conflicts: Array.isArray(data.conflicts) ? data.conflicts : []
  };
}

/**
 * 登记编剧新稿：以当前活动版本为共同祖先继承基线与确认状态。
 * - 编剧没改动的条目沿用原确认状态；
 * - 编剧改动过且之前已采纳的条目，重新置为待确认。
 */
export function registerPlaywrightVersion(state: ScriptState, version: ScriptVersion): ScriptState {
  const ancestor = state.versions.find((v) => v.id === state.activeVersionId);
  const inherit = <T extends LineItem | CueItem>(items: T[], ancestorItems: T[] | undefined, kind: OfflineOp['kind']): T[] =>
    items.map((item) => {
      const prev = ancestorItems?.find((a) => a.id === item.id);
      const pendingOp = state.offlineQueue.find((o) => o.kind === kind && o.itemId === item.id && o.status !== 'applied');
      // 基线 = 双方共同的改动前版本；若该条目有未合并的断网改动，以改动记录里的原值为准
      const baseText = pendingOp?.baseText ?? prev?.baseText ?? prev?.text ?? item.text;
      let status: ReviewStatus = prev?.status ?? item.status;
      if (status === 'accepted' && item.text !== baseText) status = 'pending';
      return { ...item, status, baseText };
    });
  const stamped: ScriptVersion = {
    ...version,
    lines: inherit(version.lines, ancestor?.lines, 'line'),
    cues: inherit(version.cues, ancestor?.cues, 'cue')
  };
  return { ...state, versions: [...state.versions, stamped] };
}

/** 修改台词/提示文本；断网时逐条记录改动，等待带回合并 */
export function applyItemEdit(state: ScriptState, kind: OfflineOp['kind'], itemId: string, text: string): ScriptState {
  const version = state.versions.find((v) => v.id === state.activeVersionId);
  if (!version) return state;
  const list = kind === 'line' ? version.lines : version.cues;
  const item = list.find((i) => i.id === itemId);
  if (!item || item.text === text) return state;
  const key = kind === 'line' ? 'lines' : 'cues';
  const versions = state.versions.map((v) =>
    v.id !== version.id
      ? v
      : { ...v, [key]: (kind === 'line' ? v.lines : v.cues).map((i) => (i.id === itemId ? { ...i, text, status: 'pending' as const } : i)) }
  );
  if (state.online) return { ...state, versions };
  const existing = state.offlineQueue.find((o) => o.kind === kind && o.itemId === itemId && o.status !== 'applied');
  const op: OfflineOp = existing
    ? { ...existing, text }
    : {
        id: nextOpId(state, kind, itemId),
        kind,
        itemId,
        role: kind === 'line' ? (item as LineItem).role : undefined,
        scene: kind === 'cue' ? (item as CueItem).scene : undefined,
        baseText: item.baseText ?? item.text,
        text,
        status: 'pending'
      };
  const offlineQueue = existing ? state.offlineQueue.map((o) => (o.id === existing.id ? op : o)) : [...state.offlineQueue, op];
  return { ...state, versions, offlineQueue };
}

function nextOpId(state: ScriptState, kind: OfflineOp['kind'], itemId: string): string {
  const base = `op-${kind}-${itemId}`;
  if (!state.offlineQueue.some((o) => o.id === base)) return base;
  return `${base}-${state.offlineQueue.filter((o) => o.kind === kind && o.itemId === itemId).length}`;
}

/** 断网期间新增的条目：本地生效，同时记录改动以便合并时带回 */
export function applyNewItem(state: ScriptState, kind: OfflineOp['kind'], item: LineItem | CueItem): ScriptState {
  const version = state.versions.find((v) => v.id === state.activeVersionId);
  if (!version) return state;
  const list = kind === 'line' ? version.lines : version.cues;
  if (list.some((i) => i.id === item.id)) return state;
  const stamped = { ...item, status: 'pending' as const, baseText: item.text };
  const key = kind === 'line' ? 'lines' : 'cues';
  const versions = state.versions.map((v) =>
    v.id !== version.id ? v : { ...v, [key]: [...(kind === 'line' ? v.lines : v.cues), stamped] }
  );
  if (state.online) return { ...state, versions };
  const op: OfflineOp = {
    id: nextOpId(state, kind, item.id),
    kind,
    itemId: item.id,
    role: (item as LineItem).role,
    scene: (item as CueItem).scene,
    baseText: item.text,
    text: item.text,
    status: 'pending'
  };
  return { ...state, versions, offlineQueue: [...state.offlineQueue, op] };
}

/**
 * 断网改动逐条带回，按改动前基线三方合并到当前活动版本：
 * - 编剧没碰过的条目：断网改动直接生效（已采纳）；
 * - 双方都改过的条目：保留两版并登记冲突，等待人工处置；
 * - 编剧稿里没有的条目（断网新增）：按 id 带入。
 * 已合并/已登记的记录按 id 去重，合并失败后重试不会多出重复条目。
 */
export function mergeOfflineOps(state: ScriptState): ScriptState {
  const target = state.versions.find((v) => v.id === state.activeVersionId);
  if (!target) return state;
  if (!state.offlineQueue.some((o) => o.status !== 'applied')) return state;

  const queue = state.offlineQueue.map((op) => ({ ...op }));
  let conflicts = state.conflicts;

  const mergeInto = <T extends LineItem | CueItem>(items: T[], kind: OfflineOp['kind']): T[] => {
    const list = items.map((item) => ({ ...item }));
    for (const op of queue) {
      if (op.kind !== kind || op.status === 'applied') continue;
      if (op.status === 'conflict' && conflicts.some((c) => c.id === op.id)) continue;
      const index = list.findIndex((item) => item.id === op.itemId);
      if (index === -1) {
        const inserted = (
          kind === 'line'
            ? { id: op.itemId, role: op.role ?? '', text: op.text, status: 'accepted', baseText: op.text }
            : { id: op.itemId, scene: op.scene ?? '', text: op.text, status: 'accepted', baseText: op.text }
        ) as T;
        list.push(inserted);
        op.status = 'applied';
        continue;
      }
      const item = list[index];
      const playwrightUntouched = item.text === op.baseText || (item.baseText !== undefined && item.text === item.baseText);
      if (item.text === op.text) {
        // 已生效（含合并失败后重试）：只刷新基线，不产生重复条目
        list[index] = { ...item, baseText: op.text };
        op.status = 'applied';
      } else if (playwrightUntouched) {
        // 编剧没碰过：直接生效
        list[index] = { ...item, text: op.text, status: 'accepted', baseText: op.text };
        op.status = 'applied';
      } else {
        // 双方都改过：保留两版并标出冲突，等待处置
        if (!conflicts.some((c) => c.id === op.id)) {
          conflicts = [
            ...conflicts,
            { id: op.id, kind: op.kind, itemId: op.itemId, role: op.role, scene: op.scene, ours: op.text, theirs: item.text }
          ];
        }
        op.status = 'conflict';
      }
    }
    return list;
  };

  const lines = mergeInto(target.lines, 'line');
  const cues = mergeInto(target.cues, 'cue');
  return {
    ...state,
    offlineQueue: queue,
    conflicts,
    versions: state.versions.map((v) => (v.id === target.id ? { ...v, lines, cues } : v))
  };
}

/** 处置冲突：选定一版写入；编剧改动过的条目需重新确认，状态回到待确认 */
export function resolveConflictOp(state: ScriptState, conflictId: string, choice: 'ours' | 'theirs'): ScriptState {
  const conflict = state.conflicts.find((c) => c.id === conflictId);
  if (!conflict) return state;
  const text = choice === 'ours' ? conflict.ours : conflict.theirs;
  const versions = state.versions.map((v) => {
    if (v.id !== state.activeVersionId) return v;
    if (conflict.kind === 'line') {
      return { ...v, lines: v.lines.map((l) => (l.id === conflict.itemId ? { ...l, text, status: 'pending' as const, baseText: text } : l)) };
    }
    return { ...v, cues: v.cues.map((c) => (c.id === conflict.itemId ? { ...c, text, status: 'pending' as const, baseText: text } : c)) };
  });
  return {
    ...state,
    versions,
    conflicts: state.conflicts.filter((c) => c.id !== conflictId),
    offlineQueue: state.offlineQueue.map((op) => (op.id === conflict.id ? { ...op, status: 'applied' as const } : op))
  };
}

/** 采纳/退回：采纳即确认为新基线 */
export function reviewItem(state: ScriptState, kind: OfflineOp['kind'], itemId: string, decision: 'accepted' | 'returned'): ScriptState {
  return {
    ...state,
    versions: state.versions.map((v) => {
      if (v.id !== state.activeVersionId) return v;
      const review = <T extends LineItem | CueItem>(items: T[]): T[] =>
        items.map((item) => {
          if (item.id !== itemId) return item;
          return decision === 'accepted' ? { ...item, status: decision, baseText: item.text } : { ...item, status: decision };
        });
      return kind === 'line' ? { ...v, lines: review(v.lines) } : { ...v, cues: review(v.cues) };
    })
  };
}
