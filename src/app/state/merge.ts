import { ScriptState, ScriptVersion, OfflineChange, MergeConflict, BaselineSnapshot, ItemKind } from './script.reducer';

/**
 * 把某个版本当前的台词/提示快照为合并基线。
 * 基线是断网前最后一次同步的状态，三方合并以它为共同祖先。
 */
export function snapshotVersion(version: { lines: Array<{ id: string; role: string; text: string }>; cues: Array<{ id: string; scene: string; text: string }> }): BaselineSnapshot {
  return {
    lines: version.lines.map((line) => ({ id: line.id, role: line.role, text: line.text })),
    cues: version.cues.map((cue) => ({ id: cue.id, scene: cue.scene, text: cue.text }))
  };
}

export function hasOpenConflict(conflicts: MergeConflict[], kind: ItemKind, itemId: string): boolean {
  return conflicts.some((c) => c.kind === kind && c.itemId === itemId && c.status === 'open');
}

/**
 * 按 (kind, itemId) 幂等地写入一条冲突：
 * 已存在未处置冲突则更新两版文案，否则新建。重试合并不会产生重复条目。
 */
function upsertConflict(conflicts: MergeConflict[], incoming: { kind: ItemKind; itemId: string; baseline: string | null; local: string; remote: string }): MergeConflict[] {
  const idx = conflicts.findIndex((c) => c.kind === incoming.kind && c.itemId === incoming.itemId && c.status === 'open');
  if (idx >= 0) {
    const existing = conflicts[idx];
    const updated: MergeConflict = { ...existing, baseline: incoming.baseline, local: incoming.local, remote: incoming.remote };
    return [...conflicts.slice(0, idx), updated, ...conflicts.slice(idx + 1)];
  }
  const conflict: MergeConflict = {
    id: `cf-${incoming.kind}-${incoming.itemId}`,
    kind: incoming.kind,
    itemId: incoming.itemId,
    baseline: incoming.baseline,
    local: incoming.local,
    remote: incoming.remote,
    status: 'open',
    at: Date.now()
  };
  return [...conflicts, conflict];
}

interface MergeItem {
  id: string;
  text: string;
  role?: string;
  scene?: string;
  status?: 'pending' | 'accepted' | 'returned';
}

interface MergeMaps {
  local: Map<string, MergeItem>;
  remote: Map<string, MergeItem>;
  base: Map<string, Omit<MergeItem, 'status'>>;
}

/**
 * 三方合并一条条目：
 * - 编剧没碰（remote 与基线一致）→ 断网改动直接生效；
 * - 仅编剧改过 → 采用编剧稿并标记待重新确认；
 * - 双方都改过且文案不一致 → 保留两版、标记冲突，等人处置。
 */
function mergeItem(
  maps: MergeMaps,
  kind: ItemKind,
  id: string,
  conflicts: MergeConflict[]
): { item: MergeItem; conflicts: MergeConflict[] } {
  const local = maps.local.get(id);
  const remote = maps.remote.get(id);
  const base = maps.base.get(id);
  const localChanged = local ? base === undefined || local.text !== base.text : false;
  const remoteChanged = remote ? base === undefined || remote.text !== base.text : false;

  if (local && remote) {
    if (localChanged && remoteChanged && local.text !== remote.text) {
      const next = upsertConflict(conflicts, { kind, itemId: id, baseline: base?.text ?? null, local: local.text, remote: remote.text });
      return { item: { ...local, status: 'pending' }, conflicts: next };
    }
    if (!localChanged && remoteChanged) {
      return { item: { ...remote, status: 'pending' }, conflicts };
    }
    return { item: { ...local }, conflicts };
  }
  if (local) return { item: { ...local }, conflicts };
  if (remote) return { item: { ...remote, status: 'pending' }, conflicts };
  return { item: { id, text: '', status: 'pending' }, conflicts };
}

/**
 * 把编剧新稿与断网期间的本地改动按基线逐条合并。
 * 幂等：同一编剧稿只合并一次；合并失败后重试不会新增重复条目或重复冲突。
 */
export function mergeDraft(state: ScriptState, draft: ScriptVersion): ScriptState {
  if (state.mergedDraftIds.includes(draft.id)) return state;
  if (!state.online) {
    return { ...state, mergeError: '离线状态下无法合并编剧稿，请恢复网络后重试。' };
  }

  const active = state.versions.find((v) => v.id === state.activeVersionId) ?? state.versions[0];
  const baseline = state.baseline ?? snapshotVersion(active);

  const lineMaps: MergeMaps = {
    local: new Map(active.lines.map((l) => [l.id, l])),
    remote: new Map(draft.lines.map((l) => [l.id, l])),
    base: new Map(baseline.lines.map((l) => [l.id, l]))
  };
  const cueMaps: MergeMaps = {
    local: new Map(active.cues.map((c) => [c.id, c])),
    remote: new Map(draft.cues.map((c) => [c.id, c])),
    base: new Map(baseline.cues.map((c) => [c.id, c]))
  };

  let conflicts = state.conflicts;

  const lineIds = new Set([...lineMaps.local.keys(), ...lineMaps.remote.keys(), ...lineMaps.base.keys()]);
  const mergedLines: ScriptVersion['lines'] = [];
  for (const id of lineIds) {
    const result = mergeItem(lineMaps, 'line', id, conflicts);
    conflicts = result.conflicts;
    mergedLines.push(result.item as ScriptVersion['lines'][number]);
  }

  const cueIds = new Set([...cueMaps.local.keys(), ...cueMaps.remote.keys(), ...cueMaps.base.keys()]);
  const mergedCues: ScriptVersion['cues'] = [];
  for (const id of cueIds) {
    const result = mergeItem(cueMaps, 'cue', id, conflicts);
    conflicts = result.conflicts;
    mergedCues.push(result.item as ScriptVersion['cues'][number]);
  }

  // 逐条把断网改动标记为已合并；已合并的跳过，重试不重复处理。
  const offlineChanges: OfflineChange[] = state.offlineChanges.map((change) =>
    change.applied ? change : { ...change, applied: true }
  );

  // 新基线 = 合并结果；未处置冲突的条目保留原基线，等处置后再同步。
  const nextBaseline: BaselineSnapshot = {
    lines: mergedLines.map((line) => {
      const base = baseline.lines.find((b) => b.id === line.id);
      return { id: line.id, role: line.role, text: hasOpenConflict(conflicts, 'line', line.id) && base ? base.text : line.text };
    }),
    cues: mergedCues.map((cue) => {
      const base = baseline.cues.find((b) => b.id === cue.id);
      return { id: cue.id, scene: cue.scene, text: hasOpenConflict(conflicts, 'cue', cue.id) && base ? base.text : cue.text };
    })
  };

  return {
    ...state,
    versions: state.versions.map((version) =>
      version.id === active.id ? { ...version, lines: mergedLines, cues: mergedCues } : version
    ),
    baseline: nextBaseline,
    offlineChanges,
    conflicts,
    mergedDraftIds: [...state.mergedDraftIds, draft.id],
    mergeError: null
  };
}

/**
 * 生成一版编剧新稿：以基线为基础，改写首条台词与首条舞台提示（用于演示冲突），并新增一条台词。
 */
export function generateWriterDraft(baseline: BaselineSnapshot, label: string): ScriptVersion {
  const lines: ScriptVersion['lines'] = baseline.lines.map((line) => ({ ...line, status: 'pending' }));
  if (lines[0]) lines[0] = { ...lines[0], text: `【编剧修订】${lines[0].text}` };
  lines.push({ id: `w-${Date.now().toString(36)}`, role: '周岚', text: '编剧新增：把灯关掉，让台词自己发光。', status: 'pending' });
  const cues: ScriptVersion['cues'] = baseline.cues.map((cue) => ({ ...cue, status: 'pending' }));
  if (cues[0]) cues[0] = { ...cues[0], text: `【编剧修订】${cues[0].text}` };
  return {
    id: `w-${Date.now().toString(36)}`,
    label,
    playwright: '林编剧',
    note: '回城后接收的编剧新稿，已按基线与断网改动逐条合并。',
    lines,
    cues
  };
}
