/**
 * 教学任务面板（DOM）。docs/14 §M15：「现有 HUD 提示升级为任务打勾」。
 *
 * ★ 纯展示层：读 TutorialDirector.status 重绘，唯二的交互是「跳过教学」
 *   与「重新开始」。面板本体 pointer-events:none，只有按钮恢复 auto ——
 *   不挡画布的鼠标（与大厅 #lobby 同一套姿势）。
 */

import { STEPS, STEP_BY_ID, type StepId } from './steps.js';
import type { TutorialDirector } from './TutorialDirector.js';

export class TutorialHud {
  private readonly root: HTMLElement;

  constructor(container: HTMLElement, private readonly director: TutorialDirector) {
    this.root = document.createElement('div');
    this.root.id = 'tutorial-hud';
    container.appendChild(this.root);

    // 教学激活时收起 M1 的静态键位表 —— 教学面板就是它的任务化升级形态
    // （docs/14 §M15 交付物 1「现有 HUD 提示升级为任务打勾」），两个都摆着会叠在一起
    const help = document.getElementById('help');
    if (help) help.style.display = 'none';

    this.root.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-tutorial-action]');
      if (!btn) return;
      if (btn.dataset['tutorialAction'] === 'skip') this.director.skip();
      if (btn.dataset['tutorialAction'] === 'restart') this.director.restart();
    });

    director.onChange = () => this.render();
    this.render();
  }

  private render(): void {
    const s = this.director.status;

    if (s.skipped) {
      this.root.innerHTML = `
        <div class="tut-collapsed">
          <button class="tut-btn" data-tutorial-action="restart">📖 重新开始教学</button>
        </div>`;
      return;
    }

    if (s.current === null) {
      this.root.innerHTML = `
        <div class="tut-panel">
          <div class="tut-title">🎓 教学完成！</div>
          <div class="tut-goal">反制链已入门：打断、假读条、走位 —— 去大厅找真人过招吧。</div>
          <div class="tut-actions">
            <button class="tut-btn" data-tutorial-action="restart">重新开始</button>
          </div>
        </div>`;
      return;
    }

    const rows = STEPS.map((step, i) => {
      const done = s.done.includes(step.id);
      const current = step.id === s.current;
      const cls = done ? 'done' : current ? 'current' : 'locked';
      const mark = done ? '✓' : current ? '▶' : `${i + 1}`;
      const subs = current ? this.subGoalsHtml(step.id) : '';
      const goal = current ? `<div class="tut-goal">${step.goal}</div>${subs}` : '';
      return `
        <li class="tut-step ${cls}" data-step="${step.id}">
          <span class="tut-mark">${mark}</span>
          <div class="tut-body"><b>${step.title}</b>${goal}</div>
        </li>`;
    }).join('');

    // 刚完成的上一环：把它的知识点亮一句（学到了什么要说出口）
    const lastDone = s.done[s.done.length - 1];
    const lesson = lastDone ? STEP_BY_ID.get(lastDone)?.lesson : undefined;

    this.root.innerHTML = `
      <div class="tut-panel">
        <div class="tut-title">新手教学 <i>${s.done.length}/${STEPS.length}</i></div>
        ${lesson ? `<div class="tut-lesson">💡 ${lesson}</div>` : ''}
        <ul class="tut-steps">${rows}</ul>
        <div class="tut-actions">
          <button class="tut-btn tut-ghost" data-tutorial-action="skip">跳过教学</button>
        </div>
      </div>`;
  }

  private subGoalsHtml(id: StepId): string {
    const s = this.director.status;
    const def = STEP_BY_ID.get(id);
    if (!def?.subGoals) return '';
    const state: Record<string, boolean> =
      id === 'move' ? s.moveGoals : id === 'camera' ? s.cameraGoals : {};
    return `<ul class="tut-subs">${def.subGoals
      .map((g) => `<li class="${state[g.key] ? 'done' : ''}">${state[g.key] ? '✓' : '·'} ${g.label}</li>`)
      .join('')}</ul>`;
  }
}
