import { FlagState, distance2D, dropViewFor, type CombatEntity, type InteractTarget, type Match, type Vec3 } from '@wowpvp/shared';

export interface BattleObjective { point: Vec3; priority: boolean; interact?: InteractTarget }

/** Flags are public objectives; this never resolves the position of a hidden player. */
export const battleObjective = (match: Match, self: CombatEntity): BattleObjective | undefined => {
  const ctf = match.ctf?.state;
  if (!ctf) return undefined;
  const home = ctf.flags[String(self.team)];
  const enemy = Object.values(ctf.flags).find(f => f.team !== self.team);
  if (!home || !enemy) return undefined;
  if (enemy.carrierId === self.id) return { point: home.basePosition, priority: true,
    ...(home.state === FlagState.AtBase ? { interact: { kind: 'flag' } as const } : {}) };
  const interacting = Object.values(ctf.flags).find(f => f.interactorId === self.id);
  if (interacting) return { point: interacting.position, priority: true, interact: { kind: 'flag' } };
  if (home.state === FlagState.Dropped || home.state === FlagState.BeingReturned) {
    return { point: home.position, priority: true, interact: { kind: 'flag' } };
  }
  const defender = self.id % 3 === 0;
  if (home.carrierId !== undefined && defender) return { point: home.position, priority: false };
  if (enemy.carrierId !== undefined) return { point: enemy.position, priority: false };
  const loadout = match.loadouts.get(self.id);
  if (loadout) {
    const pending = match.pickups.get(self.id);
    const drop = match.arsenal.drops.filter(d => distance2D(d.position, self.position) < 9
      && dropViewFor(d, self, loadout).pickableByViewer)
      .sort((a, b) => distance2D(a.position, self.position) - distance2D(b.position, self.position))[0];
    const chosen = pending ? match.arsenal.drops.find(d => d.id === pending.dropId) : drop;
    if (chosen) return { point: chosen.position, priority: true, interact: { kind: 'drop', dropId: chosen.id } };
  }
  const boss = match.boss?.activeId === undefined ? undefined : match.world.entities.get(match.boss.activeId);
  if (defender && boss?.alive && distance2D(boss.position, self.position) < 50) return { point: boss.position, priority: false };
  return { point: enemy.position, priority: !defender, interact: { kind: 'flag' } };
};
