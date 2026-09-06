import { CastFailure } from '@wowpvp/shared';
import type { HudSkillSlot } from './CombatView.js';
import { BLOCKER_GLYPH, blockerCategory, blockerText, pickBlocker, skillAriaLabel } from './skillTooltip.js';
import { remoteIconsReady } from './skillIcon.js';

type LateFlash = { phase: 'hot' | 'fade'; text: string } | undefined;
const text = (el: HTMLElement, value: string): void => {
  if (el.textContent !== value) el.textContent = value;
};
const display = (el: HTMLElement, shown: boolean): void => {
  const value = shown ? '' : 'none';
  if (el.style.display !== value) el.style.display = value;
};

/** Retain the actual skill controls through cooldown, focus and press animations. */
export class SkillBarView {
  private readonly ids: string[];
  private readonly nodes;
  private readonly iconsReady = remoteIconsReady();

  constructor(private readonly root: HTMLElement, slots: readonly HudSkillSlot[]) {
    this.ids = slots.map((s) => String(s.skill.id));
    this.nodes = Array.from(root.children, (node) => {
      const el = node as HTMLElement;
      const head = el.querySelector<HTMLElement>('.sk-head')!;
      const ensure = (selector: string, parent: HTMLElement): HTMLElement => {
        const existing = el.querySelector<HTMLElement>(selector);
        if (existing) return existing;
        const child = document.createElement('div');
        child.className = selector.slice(1);
        parent.appendChild(child);
        return child;
      };
      return {
        el, key: el.querySelector<HTMLElement>('kbd')!,
        reason: ensure('.sk-block', el), late: ensure('.sk-late', el),
        cooldown: ensure('.sk-cd', head), gcd: ensure('.sk-gcd', head),
      };
    });
  }

  matches(slots: readonly HudSkillSlot[]): boolean {
    return this.iconsReady === remoteIconsReady()
      && this.root.children.length === this.nodes.length && slots.length === this.ids.length
      && slots.every((s, i) => String(s.skill.id) === this.ids[i]);
  }

  update(slots: readonly HudSkillSlot[], keyOf: (i: number) => string, lateOf: (id: string) => LateFlash): void {
    slots.forEach((s, i) => {
      const n = this.nodes[i]!;
      const blocker = s.blockers?.length ? pickBlocker(s.blockers) : s.blocker;
      const ownCd = s.cooldownRemaining > 0;
      const usable = blocker === CastFailure.Ok && !ownCd;
      const category = ownCd ? 'cooldown' : blocker === CastFailure.Ok ? undefined : blockerCategory(blocker);
      const reason = ownCd ? `${s.cooldownRemaining.toFixed(1)}s`
        : blocker === CastFailure.Ok ? '' : blockerText(blocker,
          blocker === CastFailure.OnGlobalCooldown ? s.gcdRemaining : undefined);
      const late = lateOf(String(s.skill.id));
      n.el.classList.toggle('usable', usable);
      n.el.classList.toggle('blocked', !usable);
      n.el.classList.toggle('late', !!late);
      if (late) n.el.dataset.late = late.phase;
      else delete n.el.dataset.late;
      text(n.key, keyOf(i));
      text(n.reason, reason ? `${category ? BLOCKER_GLYPH[category] : ''} ${reason}` : '');
      if (n.reason.dataset.blk !== (category ?? '')) n.reason.dataset.blk = category ?? '';
      display(n.reason, !!reason);
      text(n.late, late ? `\u231b ${late.text}` : '');
      display(n.late, !!late);
      display(n.cooldown, ownCd && s.skill.cooldown > 0);
      if (ownCd && s.skill.cooldown > 0) {
        n.cooldown.style.setProperty('--cd-deg', `${Math.min(360, s.cooldownRemaining / s.skill.cooldown * 360).toFixed(1)}deg`);
      }
      const gcd = (s.gcdRemaining ?? 0) > 0 && (s.gcdTotal ?? 0) > 0;
      display(n.gcd, gcd);
      if (gcd) n.gcd.style.setProperty('--gcd-deg', `${Math.min(360, s.gcdRemaining! / s.gcdTotal! * 360).toFixed(1)}deg`);
      const aria = skillAriaLabel(s.skill, keyOf(i), reason);
      const label = late ? `${aria}\uff08${late.text}\uff09` : aria;
      if (n.el.getAttribute('aria-label') !== label) n.el.setAttribute('aria-label', label);
    });
  }
}
