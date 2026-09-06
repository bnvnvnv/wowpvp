import { describe, expect, it } from 'vitest';
import { TEAM_BLUE, TEAM_RED, ctfMap } from '@wowpvp/shared';
import { BattleNavigator } from './BattleNavigator.js';

describe('battleground routes', () => {
  it('connects each base to the opposite flag through walkable doors', () => {
    const nav = new BattleNavigator(ctfMap);
    for (const team of [TEAM_RED, TEAM_BLUE]) {
      const from = ctfMap.graveyards!.find(g => g.team === team)!.spawns[0]!.position;
      const goal = ctfMap.flags!.find(f => f.team !== team)!.position;
      const path = nav.path(from, goal, team);
      expect(path.length).toBeGreaterThan(2);
      expect(path.at(-1)!.x).toBeCloseTo(goal.x);
      expect(path.at(-1)!.z).toBeCloseTo(goal.z);
      for (const p of path) expect(ctfMap.geometry.some(v => v.blocksMovement !== false && v.max.y > 0.1
        && v.min.y < 2 && p.x >= v.min.x && p.x <= v.max.x && p.z >= v.min.z && p.z <= v.max.z)).toBe(false);
    }
    nav.dispose();
  });
});
