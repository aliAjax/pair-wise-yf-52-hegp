import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Store } from '@ngrx/store';
import { TranslocoModule } from '@jsverse/transloco';
import { Subscription } from 'rxjs';
import { activateVersion, addVersion, editItem, mergeWriterDraft, resolveConflict, reorderLines, reviewCue, reviewLine, setOnline, toggleRehearsal } from './state/script.actions';
import { ScriptState, ScriptVersion, CueDecision } from './state/script.reducer';
import { generateWriterDraft, hasOpenConflict, snapshotVersion } from './state/merge';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, DragDropModule, MatToolbarModule, MatButtonModule, MatCardModule, MatTabsModule, MatChipsModule, MatIconModule, TranslocoModule],
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

    <main [class.rehearsal]="(state$ | async)?.rehearsalMode">
      <section class="summary" *ngIf="!(state$ | async)?.rehearsalMode">
        <mat-card>
          <mat-card-title>版本控制</mat-card-title>
          <p>进山联排断网期间，演员改台词、舞台监督调提示，均按断网前基线逐条缓存；回城联网后接收编剧新稿并逐条合并，双方都改过的条目保留两版、标出冲突等人处置。</p>
          <div class="chips">
            <button mat-stroked-button *ngFor="let version of (state$ | async)?.versions" [color]="version.id === (state$ | async)?.activeVersionId ? 'primary' : ''" (click)="activate(version.id)">
              {{ version.label }} · {{ version.playwright }}
            </button>
            <button mat-flat-button color="primary" (click)="createDraft()">新增导演修订</button>
            <button mat-flat-button color="accent" [disabled]="!(state$ | async)?.online" (click)="receiveWriterDraft()">接收编剧新稿并合并</button>
          </div>
          <p class="merge-error" *ngIf="(state$ | async)?.mergeError">{{ (state$ | async)?.mergeError }}</p>
        </mat-card>
      </section>

      <!-- 排练提词：只显示已采纳且无未处置冲突的版本 -->
      <section *ngIf="(state$ | async)?.rehearsalMode as rehearsal" class="workspace rehearsal-stage">
        <mat-card class="script">
          <mat-card-title>排练提词</mat-card-title>
          <div class="prompter">
            <article class="cue-line" *ngFor="let line of rehearsalLines(activeVersion$ | async)">
              <b>{{ line.role }}</b>
              <p>{{ line.text }}</p>
            </article>
            <article class="cue-line" *ngFor="let cue of rehearsalCues(activeVersion$ | async)">
              <b>{{ cue.scene }}</b>
              <p>{{ cue.text }}</p>
            </article>
            <p class="empty" *ngIf="rehearsalLines(activeVersion$ | async).length === 0 && rehearsalCues(activeVersion$ | async).length === 0">暂无已处置完成的提词内容。</p>
          </div>
        </mat-card>
      </section>

      <ng-container *ngIf="!(state$ | async)?.rehearsalMode">
        <section *ngIf="activeVersion$ | async as activeVersion" class="workspace">
          <mat-card class="script">
            <mat-card-title>{{ activeVersion.label }}</mat-card-title>
            <mat-card-subtitle>{{ activeVersion.note }}</mat-card-subtitle>
            <mat-tab-group>
              <mat-tab label="角色台词">
                <div cdkDropList (cdkDropListDropped)="dropLine($event)">
                  <article class="line" cdkDrag *ngFor="let line of activeVersion.lines">
                    <div class="line-body">
                      <ng-container *ngIf="editingKey === ('line:' + line.id); else lineView">
                        <input matInput [(ngModel)]="editText" />
                        <div class="edit-actions">
                          <button mat-button color="primary" (click)="saveEdit('line', line.id)">保存</button>
                          <button mat-button (click)="cancelEdit()">取消</button>
                        </div>
                      </ng-container>
                      <ng-template #lineView>
                        <div>
                          <b>{{ line.role }}</b>
                          <p>{{ line.text }}</p>
                          <span class="status" [class.ok]="line.status === 'accepted'">{{ line.status }}</span>
                          <span class="conflict-tag" *ngIf="hasConflict('line', line.id)">冲突待处置</span>
                        </div>
                      </ng-template>
                    </div>
                    <div class="line-actions" *ngIf="editingKey !== ('line:' + line.id)">
                      <button mat-button (click)="startEdit('line', line.id, line.text)">编辑</button>
                      <button mat-button color="primary" (click)="reviewLine(line.id, 'accepted')">采纳</button>
                      <button mat-button color="warn" (click)="reviewLine(line.id, 'returned')">退回</button>
                    </div>
                  </article>
                </div>
              </mat-tab>
              <mat-tab label="舞台提示">
                <article class="line" *ngFor="let cue of activeVersion.cues">
                  <div class="line-body">
                    <ng-container *ngIf="editingKey === ('cue:' + cue.id); else cueView">
                      <input matInput [(ngModel)]="editText" />
                      <div class="edit-actions">
                        <button mat-button color="primary" (click)="saveEdit('cue', cue.id)">保存</button>
                        <button mat-button (click)="cancelEdit()">取消</button>
                      </div>
                    </ng-container>
                    <ng-template #cueView>
                      <div>
                        <b>{{ cue.scene }}</b>
                        <p>{{ cue.text }}</p>
                        <span class="status" [class.ok]="cue.status === 'accepted'">{{ cue.status }}</span>
                        <span class="conflict-tag" *ngIf="hasConflict('cue', cue.id)">冲突待处置</span>
                      </div>
                    </ng-template>
                  </div>
                  <div class="line-actions" *ngIf="editingKey !== ('cue:' + cue.id)">
                    <button mat-button (click)="startEdit('cue', cue.id, cue.text)">编辑</button>
                    <button mat-button color="primary" (click)="reviewCue(cue.id, 'accepted')">采纳</button>
                    <button mat-button color="warn" (click)="reviewCue(cue.id, 'returned')">退回</button>
                  </div>
                </article>
              </mat-tab>
            </mat-tab-group>
          </mat-card>

          <mat-card class="compare">
            <mat-card-title>版本对比</mat-card-title>
            <p class="version-name">基准 v12 → {{ activeVersion.label }}</p>
            <div class="diff"><b>新增</b><span>{{ activeVersion.lines.length }} 条台词 / {{ activeVersion.cues.length }} 条提示</span></div>
            <div class="diff"><b>待确认</b><span>{{ pendingCount(activeVersion) }} 项</span></div>
            <div class="diff"><b>离线改动</b><span>{{ (state$ | async)?.offlineChanges?.length ?? 0 }} 条（{{ appliedCount() }} 条已合并）</span></div>
            <div class="diff"><b>未处置冲突</b><span>{{ openConflictCount() }} 项</span></div>
            <div class="diff warn"><b>规则</b><span>冲突未处置前不进入排练提词；编剧改动过的条目需重新确认。</span></div>
          </mat-card>
        </section>

        <section class="conflicts" *ngIf="openConflicts().length > 0">
          <mat-card>
            <mat-card-title>冲突处置（{{ openConflicts().length }}）</mat-card-title>
            <p>以下条目双方都做了修改，请选择采用哪一版；处置后排练提词才会显示。</p>
            <article class="conflict" *ngFor="let conflict of openConflicts()">
              <div class="conflict-version">
                <b>本地方案（断网改动）</b>
                <p>{{ conflict.local }}</p>
                <button mat-stroked-button color="primary" (click)="resolve(conflict.id, 'local')">采用本地方案</button>
              </div>
              <div class="conflict-version remote">
                <b>编剧方案（回城新稿）</b>
                <p>{{ conflict.remote }}</p>
                <button mat-flat-button color="accent" (click)="resolve(conflict.id, 'remote')">采用编剧方案</button>
              </div>
            </article>
          </mat-card>
        </section>
      </ng-container>

      <aside class="offline" *ngIf="!(state$ | async)?.online">
        网络不可用，当前修改已逐条写入本地缓存（{{ (state$ | async)?.offlineChanges?.length ?? 0 }} 条）；恢复网络后点击「接收编剧新稿并合并」，按断网前基线逐条合并。
      </aside>
    </main>
  `,
  styles: [`
    .topbar { position: sticky; top: 0; z-index: 4; }
    .spacer { flex: 1; }
    main { max-width: 1180px; margin: 24px auto; padding: 0 18px 48px; }
    main.rehearsal { max-width: 860px; background: #111827; color: #f9fafb; margin-top: 0; }
    main.rehearsal .script, main.rehearsal .compare, main.rehearsal .summary { opacity: .92; }
    .summary { margin-bottom: 18px; }
    .chips { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
    .merge-error { color: #b45309; margin: 12px 0 0; }
    .workspace { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 18px; }
    .rehearsal-stage { grid-template-columns: 1fr; }
    .line { cursor: grab; display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 16px 0; border-bottom: 1px solid #e5e7eb; }
    .line-body { flex: 1; }
    .line-body input { width: 100%; padding: 8px; font-size: 16px; }
    .edit-actions { display: flex; gap: 8px; margin-top: 6px; }
    .line-actions { display: flex; gap: 4px; flex-shrink: 0; }
    .line p { margin: 8px 0; font-size: 17px; line-height: 1.6; }
    .status { font-size: 12px; color: #b45309; }
    .status.ok { color: #15803d; }
    .conflict-tag { margin-left: 8px; font-size: 12px; color: #b91c1c; background: #fee2e2; padding: 2px 8px; border-radius: 10px; }
    .version-name { padding: 12px; background: #f3f4f6; border-radius: 8px; }
    .diff { display: flex; justify-content: space-between; border-bottom: 1px solid #e5e7eb; padding: 14px 0; }
    .diff.warn b { color: #b45309; }
    .conflicts { margin-top: 18px; }
    .conflict { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 16px 0; border-bottom: 1px solid #e5e7eb; }
    .conflict-version { padding: 12px; background: #f9fafb; border-radius: 8px; }
    .conflict-version.remote { background: #fff7ed; }
    .conflict-version p { margin: 8px 0 12px; }
    .prompter .cue-line { padding: 18px 0; border-bottom: 1px solid #374151; }
    .prompter b { color: #fbbf24; font-size: 20px; }
    .prompter p { margin: 8px 0 0; font-size: 30px; line-height: 1.5; }
    .prompter .empty { color: #9ca3af; }
    .offline { position: fixed; right: 18px; bottom: 18px; padding: 14px 18px; color: #fff; background: #b45309; border-radius: 10px; box-shadow: 0 8px 30px #0003; max-width: 360px; }
    @media (max-width: 820px) { .workspace { grid-template-columns: 1fr; } .line { align-items: flex-start; } .conflict { grid-template-columns: 1fr; } }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  readonly state$ = this.store.select('script');
  readonly activeVersion$ = this.store.select((state) => {
    const script = state.script as ScriptState;
    return script.versions.find((item) => item.id === script.activeVersionId) ?? script.versions[0];
  });
  private subscription?: Subscription;
  private onlineHandler = () => this.store.dispatch(setOnline({ online: navigator.onLine }));
  private offlineHandler = () => this.store.dispatch(setOnline({ online: false }));

  editingKey: string | null = null;
  editText = '';

  constructor(private readonly store: Store<{ script: ScriptState }>) {}

  ngOnInit() {
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    this.subscription = this.state$.subscribe((state) => localStorage.setItem('yf52-script-state', JSON.stringify(state)));
  }

  ngOnDestroy() {
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
    this.subscription?.unsubscribe();
  }

  activate(id: string) { this.store.dispatch(activateVersion({ id })); }
  toggleRehearsal() { this.store.dispatch(toggleRehearsal()); }
  setOnline(online: boolean) { this.store.dispatch(setOnline({ online })); }
  toggleOnline() { this.state$.subscribe((state) => this.setOnline(!state.online)).unsubscribe(); }
  reviewLine(id: string, decision: 'accepted' | 'returned') { this.store.dispatch(reviewLine({ id, decision })); }
  reviewCue(id: string, decision: CueDecision) { this.store.dispatch(reviewCue({ id, decision })); }
  dropLine(event: CdkDragDrop<unknown>) { if (event.previousIndex !== event.currentIndex) this.store.dispatch(reorderLines({ from: event.previousIndex, to: event.currentIndex })); }

  startEdit(kind: 'line' | 'cue', itemId: string, text: string) {
    this.editingKey = `${kind}:${itemId}`;
    this.editText = text;
  }
  cancelEdit() { this.editingKey = null; this.editText = ''; }
  saveEdit(kind: 'line' | 'cue', itemId: string) {
    const value = this.editText.trim();
    if (value) this.store.dispatch(editItem({ kind, itemId, field: 'text', value }));
    this.cancelEdit();
  }

  receiveWriterDraft() {
    this.state$.subscribe((state) => {
      const active = state.versions.find((item) => item.id === state.activeVersionId) ?? state.versions[0];
      const baseline = state.baseline ?? snapshotVersion(active);
      const draft = generateWriterDraft(baseline, `编剧新稿 v${Date.now().toString(36).slice(-4)}`);
      this.store.dispatch(mergeWriterDraft({ draft }));
    }).unsubscribe();
  }

  resolve(conflictId: string, choice: 'local' | 'remote') {
    this.store.dispatch(resolveConflict({ conflictId, choice }));
  }

  hasConflict(kind: 'line' | 'cue', itemId: string): boolean {
    let result = false;
    this.state$.subscribe((state) => { result = hasOpenConflict(state.conflicts, kind, itemId); }).unsubscribe();
    return result;
  }

  openConflicts() {
    let conflicts: ScriptState['conflicts'] = [];
    this.state$.subscribe((state) => { conflicts = state.conflicts.filter((c) => c.status === 'open'); }).unsubscribe();
    return conflicts;
  }

  openConflictCount(): number { return this.openConflicts().length; }

  appliedCount(): number {
    let count = 0;
    this.state$.subscribe((state) => { count = state.offlineChanges.filter((c) => c.applied).length; }).unsubscribe();
    return count;
  }

  /** 排练提词只显示已采纳且无未处置冲突的条目。 */
  rehearsalLines(version: ScriptVersion | null): ScriptVersion['lines'] {
    if (!version) return [];
    let conflicts: ScriptState['conflicts'] = [];
    this.state$.subscribe((state) => { conflicts = state.conflicts; }).unsubscribe();
    return version.lines.filter((line) => line.status === 'accepted' && !hasOpenConflict(conflicts, 'line', line.id));
  }

  rehearsalCues(version: ScriptVersion | null): ScriptVersion['cues'] {
    if (!version) return [];
    let conflicts: ScriptState['conflicts'] = [];
    this.state$.subscribe((state) => { conflicts = state.conflicts; }).unsubscribe();
    return version.cues.filter((cue) => cue.status === 'accepted' && !hasOpenConflict(conflicts, 'cue', cue.id));
  }

  pendingCount(version: ScriptVersion) { return version.lines.filter((item) => item.status === 'pending').length + version.cues.filter((item) => item.status === 'pending').length; }

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
}
