/**
 * 断网合并引擎验证脚本（不依赖 Angular，直接用 tsc 编译后 node 运行）。
 * 覆盖：
 *  1. 断网改动逐条带回，按改动前基线合并；
 *  2. 编剧没碰过的条目直接生效；
 *  3. 双方都改过的台词/提示保留两版并标出冲突；
 *  4. 合并失败后重试不会多出重复条目（幂等）；
 *  5. 历史数据升级后原有改动保留；
 *  6. 编剧改动过的已采纳条目重新置为待确认；
 *  7. 冲突处置后需重新确认，确认后成为新基线。
 */
import {
  applyItemEdit,
  applyNewItem,
  mergeOfflineOps,
  migrateState,
  registerPlaywrightVersion,
  resolveConflictOp,
  reviewItem,
  ScriptState,
  ScriptVersion
} from '../src/app/state/script.model';

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`ok   - ${message}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${message}`);
  }
}

const playwrightV14: ScriptVersion = {
  id: 'v14',
  label: '编剧新稿 v14',
  playwright: '林编剧',
  note: '回城后提交',
  lines: [
    { id: 'l1', role: '周岚', text: '你总说明天，可明天的舞台不属于我们。', status: 'pending' },
    { id: 'l2', role: '周野', text: '那就让灯灭吧，我早已背熟黑暗。', status: 'pending' }
  ],
  cues: [
    { id: 'c1', scene: '第三场', text: '侧灯收至20%，雨声提前四拍渐入', status: 'pending' },
    { id: 'c2', scene: '第三场', text: '周野坐到舞台左前区，保留两拍静默', status: 'pending' }
  ]
};

function active(state: ScriptState): ScriptVersion {
  return state.versions.find((v) => v.id === state.activeVersionId) as ScriptVersion;
}

// ---------- 场景一：断网改动逐条带回 + 三方合并 ----------
let state = migrateState();
assert(state.schemaVersion === 2 && state.activeVersionId === 'v12', '初始状态：schemaVersion=2，活动版本 v12');

// 联网时先采纳 c1（之后编剧会改它，用来验证“重新确认”）
state = reviewItem(state, 'cue', 'c1', 'accepted');
assert(active(state).cues.find((c) => c.id === 'c1')?.status === 'accepted', '联网时采纳 c1 生效');

// 进山断网：演员改台词 l1（编剧也改了 → 冲突），舞台监督改提示 c2（编剧没碰 → 直接生效），新增一条提示
state = { ...state, online: false };
state = applyItemEdit(state, 'line', 'l1', '你每次都说等明天，可今晚必须说完。');
state = applyItemEdit(state, 'cue', 'c2', '周野坐到舞台左前区，保留四拍静默。');
state = applyNewItem(state, 'cue', { id: 'c-off', scene: '第三场', text: '断电时启用应急脚灯', status: 'pending' });
// 同一条目断网期间重复修改，只记一条
state = applyItemEdit(state, 'line', 'l1', '你总说明天，可今晚我们必须把话说完。');
assert(state.offlineQueue.filter((o) => o.status !== 'applied').length === 3, '断网改动逐条记录，重复修改同一条目不新增记录');
const opL1 = state.offlineQueue.find((o) => o.itemId === 'l1');
assert(opL1?.baseText === '你每次都说等明天，可舞台不会等我们。' && opL1.text === '你总说明天，可今晚我们必须把话说完。', '改动记录保留改动前基线与最终文本');

// 回城联网，接收编剧新稿
state = { ...state, online: true };
state = registerPlaywrightVersion(state, playwrightV14);
state = { ...state, activeVersionId: 'v14' };
const v14 = active(state);
assert(v14.cues.find((c) => c.id === 'c1')?.status === 'pending', '编剧改动过的已采纳条目 c1 重新置为待确认');
assert(v14.cues.find((c) => c.id === 'c2')?.status === 'pending', 'c2 有未合并的断网改动，合并前保持待确认');
assert(v14.lines.find((l) => l.id === 'l2')?.status === 'pending', '编剧没碰也没断网改动的 l2 沿用原确认状态');
assert(v14.lines.find((l) => l.id === 'l1')?.baseText === '你每次都说等明天，可舞台不会等我们。', '编剧新稿继承改动前基线');

// 合并断网改动
state = mergeOfflineOps(state);
let merged = active(state);
assert(merged.cues.find((c) => c.id === 'c2')?.text === '周野坐到舞台左前区，保留四拍静默。', '编剧没碰过的 c2：断网改动直接生效');
assert(merged.cues.find((c) => c.id === 'c2')?.status === 'accepted', '直接生效的条目标记为已采纳');
assert(merged.cues.some((c) => c.id === 'c-off'), '断网新增的提示被带入编剧新稿');
assert(merged.lines.find((l) => l.id === 'l1')?.text === '你总说明天，可明天的舞台不属于我们。', '冲突条目在版本中保留编剧版文本');
assert(state.conflicts.length === 1, '双方都改过的 l1 标出冲突');
const conflict = state.conflicts[0];
assert(conflict.ours === '你总说明天，可今晚我们必须把话说完。' && conflict.theirs === '你总说明天，可明天的舞台不属于我们。', '冲突同时保留断网版与编剧版两版文本');

// ---------- 场景二：合并失败后重试不产生重复 ----------
const beforeRetry = JSON.stringify({ versions: state.versions, conflicts: state.conflicts, offlineQueue: state.offlineQueue });
state = mergeOfflineOps(state);
state = mergeOfflineOps(state);
const afterRetry = JSON.stringify({ versions: state.versions, conflicts: state.conflicts, offlineQueue: state.offlineQueue });
assert(beforeRetry === afterRetry, '合并重复执行结果完全一致（幂等）');
merged = active(state);
assert(merged.cues.filter((c) => c.id === 'c-off').length === 1, '重试后断网新增条目没有重复');
assert(state.conflicts.filter((c) => c.itemId === 'l1').length === 1, '重试后冲突记录没有重复');

// ---------- 场景三：冲突处置 → 重新确认 → 成为新基线 ----------
state = resolveConflictOp(state, conflict.id, 'ours');
merged = active(state);
assert(state.conflicts.length === 0, '处置后冲突从待办中移除');
assert(merged.lines.find((l) => l.id === 'l1')?.text === '你总说明天，可今晚我们必须把话说完。', '采用断网版后文本写入版本');
assert(merged.lines.find((l) => l.id === 'l1')?.status === 'pending', '处置后的条目需重新确认（待确认）');
assert(state.offlineQueue.every((o) => o.status === 'applied'), '全部断网改动均已合并');
state = reviewItem(state, 'line', 'l1', 'accepted');
const confirmed = active(state).lines.find((l) => l.id === 'l1');
assert(confirmed?.status === 'accepted' && confirmed.baseText === confirmed.text, '重新确认后成为新基线，可进入排练提词');

// ---------- 场景四：历史数据升级，原有改动保留 ----------
const legacySaved = {
  versions: [
    {
      id: 'v9',
      label: '旧版排练稿 v9',
      playwright: '林编剧',
      note: '历史数据',
      lines: [{ id: 'l1', role: '周岚', text: '旧版改过的台词', status: 'accepted' }],
      cues: [{ id: 'c1', scene: '第一场', text: '旧版改过的提示', status: 'returned' }]
    }
  ],
  activeVersionId: 'v9',
  rehearsalMode: true,
  online: false
};
const migrated = migrateState(JSON.parse(JSON.stringify(legacySaved)));
assert(migrated.schemaVersion === 2, '历史数据升级到当前 schema');
assert(migrated.versions[0].lines[0].text === '旧版改过的台词' && migrated.versions[0].lines[0].status === 'accepted', '升级后原有台词改动与采纳状态保留');
assert(migrated.versions[0].cues[0].status === 'returned', '升级后原有退回状态保留');
assert(migrated.versions[0].lines[0].baseText === '旧版改过的台词', '升级时以现有文本补齐基线');
assert(migrated.rehearsalMode === true && migrated.online === false, '升级后排练模式与联网状态保留');
assert(Array.isArray(migrated.offlineQueue) && Array.isArray(migrated.conflicts), '升级后补齐离线队列与冲突记录');

if (failures > 0) {
  console.error(`\n${failures} 项验证失败`);
  process.exit(1);
}
console.log('\n全部验证通过');
