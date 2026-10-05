import { CdkDragDrop, DragDropModule } from '@angular/cdk/drag-drop';
import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTabsModule } from '@angular/material/tabs';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Store } from '@ngrx/store';
import { TranslocoModule } from '@jsverse/transloco';
import { Subscription } from 'rxjs';
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
} from './state/script.actions';
import { MergeConflict, OfflineOp, ReviewStatus, ScriptState, ScriptVersion, STORAGE_KEY } from './state/script.reducer';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, DragDropModule, FormsModule, MatToolbarModule, MatButtonModule, MatCardModule, MatTabsModule, MatChipsModule, MatIconModule, MatInputModule, TranslocoModule],
  template: `
    <mat-toolbar color="primary" class="topbar">
      <span>{{ 'title' | transloco }}</span>
      <span class="spacer"></span>
      <button mat-stroked-button (click)="toggleOnline()">
        {{ ((state$ | async)?.online ? 'online' : 'offline') | transloco }}
      </button>
      <button mat-flat-button color="accent" (click)="toggleRehearsal()">
        {{ ((state$ | async)?.rehearsalMode ? 'normalMode' : 'rehearsalMode') | transloco }}
      </button>
    </mat-toolbar>

    <main *ngIf="state$ | async as state" [class.rehearsal]="state.rehearsalMode">
      <ng-container *ngIf="!state.rehearsalMode">
        <section class="summary">
          <mat-card>
            <mat-card-title>版本控制</mat-card-title>
            <p>断网改动逐条带回，按改动前基线合并：编剧没碰过的直接生效，双方都改过的保留两版等待处置。</p>
            <div class="chips">
              <button mat-stroked-button *ngFor="let version of state.versions" [color]="version.id === state.activeVersionId ? 'primary' : ''" (click)="activate(version.id)">
                {{ version.label }} · {{ version.playwright }}
              </button>
              <button mat-flat-button color="primary" (click)="createDraft()">新增导演修订</button>
              <button mat-flat-button color="primary" (click)="receivePlaywright()">接收编剧新稿</button>
              <button mat-raised-button color="accent" [disabled]="!state.online || pendingOps(state) === 0" (click)="merge()">
                合并断网改动（{{ pendingOps(state) }} 条）
              </button>
            </div>
          </mat-card>
        </section>

        <section class="conflicts" *ngIf="state.conflicts.length">
          <mat-card>
            <mat-card-title>冲突待处置（{{ state.conflicts.length }}）</mat-card-title>
            <p>双方都改过，两版都保留；选定一版后仍需重新确认，才会进入排练提词。</p>
            <article class="conflict" *ngFor="let conflict of state.conflicts">
              <header>{{ conflict.kind === 'line' ? '台词' : '舞台提示' }} · {{ conflict.role || conflict.scene }}</header>
              <div class="sides">
                <div class="side">
                  <b>断网改动版</b>
                  <p>{{ conflict.ours }}</p>
                  <button mat-stroked-button color="primary" (click)="resolve(conflict.id, 'ours')">采用断网版</button>
                </div>
                <div class="side">
                  <b>编剧版</b>
                  <p>{{ conflict.theirs }}</p>
                  <button mat-stroked-button color="warn" (click)="resolve(conflict.id, 'theirs')">采用编剧版</button>
                </div>
              </div>
            </article>
          </mat-card>
        </section>

        <section *ngIf="activeVersion$ | async as activeVersion" class="workspace">
          <mat-card class="script">
            <mat-card-title>{{ activeVersion.label }}</mat-card-title>
            <mat-card-subtitle>{{ activeVersion.note }}</mat-card-subtitle>
            <mat-tab-group>
              <mat-tab label="角色台词">
                <div cdkDropList (cdkDropListDropped)="dropLine($event)">
                  <article class="line" cdkDrag *ngFor="let line of activeVersion.lines">
                    <div class="body">
                      <b>{{ line.role }}</b>
                      <p *ngIf="editingId !== line.id">{{ line.text }}</p>
                      <div class="editor" *ngIf="editingId === line.id">
                        <input matInput [(ngModel)]="editBuffer" placeholder="修改后的台词" />
                        <button mat-button color="primary" (click)="saveLine(line.id)">保存</button>
                        <button mat-button (click)="editingId = null">取消</button>
                      </div>
                      <span class="status" [class.ok]="line.status === 'accepted'">{{ statusLabel(line.status) }}</span>
                      <span class="flag" *ngIf="hasConflict(state, 'line', line.id)">冲突待处置</span>
                    </div>
                    <div class="ops">
                      <button mat-button (click)="startEdit(line.id, line.text)">修改</button>
                      <button mat-button color="primary" (click)="reviewLine(line.id, 'accepted')">采纳</button>
                      <button mat-button color="warn" (click)="reviewLine(line.id, 'returned')">退回</button>
                    </div>
                  </article>
                </div>
                <div class="adder">
                  <input matInput placeholder="角色" [(ngModel)]="newLineRole" />
                  <input matInput placeholder="新台词" [(ngModel)]="newLineText" />
                  <button mat-stroked-button (click)="addLine()">添加台词</button>
                </div>
              </mat-tab>
              <mat-tab label="舞台提示">
                <article class="line" *ngFor="let cue of activeVersion.cues">
                  <div class="body">
                    <b>{{ cue.scene }}</b>
                    <p *ngIf="editingId !== cue.id">{{ cue.text }}</p>
                    <div class="editor" *ngIf="editingId === cue.id">
                      <input matInput [(ngModel)]="editBuffer" placeholder="修改后的提示" />
                      <button mat-button color="primary" (click)="saveCue(cue.id)">保存</button>
                      <button mat-button (click)="editingId = null">取消</button>
                    </div>
                    <span class="status" [class.ok]="cue.status === 'accepted'">{{ statusLabel(cue.status) }}</span>
                    <span class="flag" *ngIf="hasConflict(state, 'cue', cue.id)">冲突待处置</span>
                  </div>
                  <div class="ops">
                    <button mat-button (click)="startEdit(cue.id, cue.text)">修改</button>
                    <button mat-button color="primary" (click)="reviewCue(cue.id, 'accepted')">采纳</button>
                    <button mat-button color="warn" (click)="reviewCue(cue.id, 'returned')">退回</button>
                  </div>
                </article>
                <div class="adder">
                  <input matInput placeholder="场次" [(ngModel)]="newCueScene" />
                  <input matInput placeholder="新提示" [(ngModel)]="newCueText" />
                  <button mat-stroked-button (click)="addCue()">添加提示</button>
                </div>
              </mat-tab>
            </mat-tab-group>
          </mat-card>

          <mat-card class="compare">
            <mat-card-title>版本对比</mat-card-title>
            <p class="version-name">基准 v12 → {{ activeVersion.label }}</p>
            <div class="diff"><b>条目</b><span>{{ activeVersion.lines.length }} 条台词 / {{ activeVersion.cues.length }} 条提示</span></div>
            <div class="diff"><b>待确认</b><span>{{ pendingCount(activeVersion) }} 项</span></div>
            <div class="diff"><b>断网改动</b><span>待合并 {{ countOps(state, 'pending') }} · 冲突 {{ countOps(state, 'conflict') }} · 已生效 {{ countOps(state, 'applied') }}</span></div>
            <div class="diff warn"><b>规则</b><span>合并按改动 id 去重，失败后重试不会多出重复条目</span></div>
          </mat-card>
        </section>
      </ng-container>

      <section class="prompter" *ngIf="state.rehearsalMode && (activeVersion$ | async) as activeVersion">
        <h2>{{ activeVersion.label }} · 排练提词</h2>
        <p class="hint">仅显示已处置（已采纳）的台词与舞台提示，待确认和冲突内容不会出现</p>
        <article class="prompt-line" *ngFor="let line of prompterLines(activeVersion, state)">
          <b>{{ line.role }}</b>
          <p>{{ line.text }}</p>
        </article>
        <article class="prompt-cue" *ngFor="let cue of prompterCues(activeVersion, state)">【{{ cue.scene }}】{{ cue.text }}</article>
      </section>

      <aside class="offline" *ngIf="!state.online">网络不可用，修改已逐条写入本地缓存（{{ pendingOps(state) }} 条待带回）。</aside>
      <aside class="sync" *ngIf="state.online && pendingOps(state) > 0">已恢复联网：{{ pendingOps(state) }} 条断网改动待合并，点击“合并断网改动”逐条带回。</aside>
    </main>
  `,
  styles: [`
    .topbar { position: sticky; top: 0; z-index: 4; }
    .spacer { flex: 1; }
    main { max-width: 1180px; margin: 24px auto; padding: 0 18px 48px; }
    main.rehearsal { max-width: 860px; background: #111827; color: #f9fafb; margin-top: 0; min-height: calc(100vh - 64px); }
    .summary, .conflicts { margin-bottom: 18px; }
    .chips { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; align-items: center; }
    .workspace { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 18px; }
    .line { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 16px 0; border-bottom: 1px solid #e5e7eb; }
    .line .body { flex: 1; }
    .line p { margin: 8px 0; font-size: 17px; line-height: 1.6; }
    .line .ops { white-space: nowrap; }
    .status { font-size: 12px; color: #b45309; margin-right: 8px; }
    .status.ok { color: #15803d; }
    .flag { font-size: 12px; color: #b91c1c; border: 1px solid #b91c1c; border-radius: 4px; padding: 1px 6px; }
    .editor, .adder { display: flex; gap: 8px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
    .editor input, .adder input { flex: 1; min-width: 140px; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 15px; }
    .adder { border-top: 1px dashed #d1d5db; padding-top: 14px; margin-top: 10px; }
    .conflict { border-top: 1px solid #e5e7eb; padding: 14px 0; }
    .conflict header { font-weight: 600; margin-bottom: 10px; }
    .sides { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .side { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; }
    .side p { font-size: 16px; line-height: 1.6; }
    .version-name { padding: 12px; background: #f3f4f6; border-radius: 8px; }
    .diff { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid #e5e7eb; padding: 14px 0; }
    .diff.warn b { color: #b45309; }
    .prompter { padding: 28px 18px; }
    .prompter .hint { color: #9ca3af; }
    .prompt-line b { font-size: 22px; color: #fbbf24; }
    .prompt-line p { font-size: 34px; line-height: 1.5; margin: 6px 0 24px; }
    .prompt-cue { font-size: 24px; color: #93c5fd; margin: 16px 0; }
    .offline, .sync { position: fixed; right: 18px; bottom: 18px; padding: 14px 18px; color: #fff; border-radius: 10px; box-shadow: 0 8px 30px #0003; }
    .offline { background: #b45309; }
    .sync { background: #1d4ed8; }
    @media (max-width: 820px) { .workspace { grid-template-columns: 1fr; } .line { align-items: flex-start; } .sides { grid-template-columns: 1fr; } }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  readonly state$ = this.store.select('script');
  readonly activeVersion$ = this.store.select((state) => {
    const script = state.script as ScriptState;
    return script.versions.find((item) => item.id === script.activeVersionId) ?? script.versions[0];
  });
  editingId: string | null = null;
  editBuffer = '';
  newLineRole = '';
  newLineText = '';
  newCueScene = '';
  newCueText = '';
  private subscription?: Subscription;
  private onlineHandler = () => this.store.dispatch(setOnline({ online: navigator.onLine }));
  private offlineHandler = () => this.store.dispatch(setOnline({ online: false }));

  constructor(private readonly store: Store<{ script: ScriptState }>) {}

  ngOnInit() {
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    this.subscription = this.state$.subscribe((state) => localStorage.setItem(STORAGE_KEY, JSON.stringify(state)));
  }

  ngOnDestroy() {
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
    this.subscription?.unsubscribe();
  }

  activate(id: string) { this.store.dispatch(activateVersion({ id })); }
  toggleRehearsal() { this.store.dispatch(toggleRehearsal()); }
  toggleOnline() { this.state$.subscribe((state) => this.store.dispatch(setOnline({ online: !state.online }))).unsubscribe(); }
  reviewLine(id: string, decision: 'accepted' | 'returned') { this.store.dispatch(reviewLine({ id, decision })); }
  reviewCue(id: string, decision: 'accepted' | 'returned') { this.store.dispatch(reviewCue({ id, decision })); }
  dropLine(event: CdkDragDrop<unknown>) { if (event.previousIndex !== event.currentIndex) this.store.dispatch(reorderLines({ from: event.previousIndex, to: event.currentIndex })); }

  startEdit(id: string, text: string) { this.editingId = id; this.editBuffer = text; }
  saveLine(id: string) {
    const text = this.editBuffer.trim();
    if (text) this.store.dispatch(editLineText({ id, text }));
    this.editingId = null;
  }
  saveCue(id: string) {
    const text = this.editBuffer.trim();
    if (text) this.store.dispatch(editCueText({ id, text }));
    this.editingId = null;
  }
  addLine() {
    const role = this.newLineRole.trim();
    const text = this.newLineText.trim();
    if (!role || !text) return;
    this.store.dispatch(addLineItem({ id: `l-${Date.now()}`, role, text }));
    this.newLineRole = '';
    this.newLineText = '';
  }
  addCue() {
    const scene = this.newCueScene.trim();
    const text = this.newCueText.trim();
    if (!scene || !text) return;
    this.store.dispatch(addCueItem({ id: `c-${Date.now()}`, scene, text }));
    this.newCueScene = '';
    this.newCueText = '';
  }

  merge() { this.store.dispatch(mergeOfflineQueue()); }
  resolve(conflictId: string, choice: 'ours' | 'theirs') { this.store.dispatch(resolveConflict({ conflictId, choice })); }

  receivePlaywright() {
    const id = `v14-${Date.now().toString().slice(-4)}`;
    const version: ScriptVersion = {
      id,
      label: `编剧新稿 ${id}`,
      playwright: '林编剧',
      note: '回城后提交：重写周岚开场，调整雨声与灯光提示。',
      lines: [
        { id: 'l1', role: '周岚', text: '你总说明天，可明天的舞台不属于我们。', status: 'pending' },
        { id: 'l2', role: '周野', text: '那就让灯灭吧，我早已背熟黑暗。', status: 'pending' },
        { id: 'l4', role: '周野', text: '如果灯再亮一次，我想看清你说话的样子。', status: 'pending' }
      ],
      cues: [
        { id: 'c1', scene: '第三场', text: '侧灯收至20%，雨声提前四拍渐入', status: 'pending' },
        { id: 'c2', scene: '第三场', text: '周野坐到舞台左前区，保留两拍静默', status: 'pending' }
      ]
    };
    this.store.dispatch(addVersion({ version }));
    this.store.dispatch(activateVersion({ id }));
  }

  createDraft() {
    const id = `v${Date.now().toString().slice(-4)}`;
    const version: ScriptVersion = {
      id,
      label: `导演修订 ${id}`,
      playwright: '本地草稿',
      note: '断网期间创建的修订，等待与编剧版本合并。',
      lines: [{ id: `${id}-l1`, role: '周岚', text: '这次换你告诉我，灯亮之后准备去哪里。', status: 'pending' }],
      cues: [{ id: `${id}-c1`, scene: '第三场', text: '追光保持到台词结束，再执行全场收光', status: 'pending' }]
    };
    this.store.dispatch(addVersion({ version }));
    this.store.dispatch(activateVersion({ id }));
  }

  statusLabel(status: ReviewStatus) {
    return status === 'accepted' ? '已采纳' : status === 'returned' ? '已退回' : '待确认';
  }
  pendingCount(version: ScriptVersion) {
    return version.lines.filter((item) => item.status === 'pending').length + version.cues.filter((item) => item.status === 'pending').length;
  }
  pendingOps(state: ScriptState) { return state.offlineQueue.filter((op) => op.status !== 'applied').length; }
  countOps(state: ScriptState, status: OfflineOp['status']) { return state.offlineQueue.filter((op) => op.status === status).length; }
  hasConflict(state: ScriptState, kind: MergeConflict['kind'], itemId: string) {
    return state.conflicts.some((conflict) => conflict.kind === kind && conflict.itemId === itemId);
  }
  prompterLines(version: ScriptVersion, state: ScriptState) {
    return version.lines.filter((line) => line.status === 'accepted' && !this.hasConflict(state, 'line', line.id));
  }
  prompterCues(version: ScriptVersion, state: ScriptState) {
    return version.cues.filter((cue) => cue.status === 'accepted' && !this.hasConflict(state, 'cue', cue.id));
  }
}
