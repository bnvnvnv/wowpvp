import { describe, expect, it } from 'vitest';
import { SurfaceNavigator, type NavigationMap } from './index.js';
import { createEntity } from '../sim/entity.js';
import { createMovementState, stepMovement } from '../sim/movement.js';
import { warrior } from '../data/index.js';
import { activeForbidden, arena3v3, ctfMap } from '../data/maps/index.js';
import { hasLineOfSight, type Aabb } from '../math/geometry.js';
import { distance2D, type Vec3 } from '../math/vec3.js';
import { asEntityId, TEAM_RED } from '../types/ids.js';
import { GameMode } from '../types/enums.js';

const floor: Aabb = { min: { x: -20, y: -1, z: -20 }, max: { x: 20, y: 0, z: 20 }, blocksSight: false };
const wall: Aabb = { min: { x: -3, y: 0, z: -0.5 }, max: { x: 3, y: 3, z: 0.5 } };
const simpleMap = (extra: readonly Aabb[] = [wall]): NavigationMap => ({ geometry: [floor, ...extra],
  bounds: { min: { x: -20, y: -5, z: -20 }, max: { x: 20, y: 20, z: 20 } } });

function walk(map: NavigationMap, from: Vec3, goal: Vec3, frames = 800) {
  const navigator = new SurfaceNavigator(map);
  const entity = createEntity(asEntityId(1), warrior, TEAM_RED, { ...from });
  let movement = createMovementState(from);
  const visited: Vec3[] = [];
  for (let i = 0; i < frames; i++) {
    const input = navigator.move(entity, goal, i * 0.05);
    movement = stepMovement(movement, input, 0.05, map.geometry).state;
    entity.position = movement.position;
    entity.yaw = input.yaw;
    visited.push({ ...entity.position });
    if (distance2D(entity.position, goal) < 0.3 && Math.abs(entity.position.y - goal.y) < 0.3) break;
  }
  const plans = navigator.plans;
  navigator.dispose();
  return { entity, visited, plans };
}

describe('navigation through the actual movement solver', () => {
  it('walks around a wall with body clearance instead of getting caught on its corner', () => {
    const result = walk(simpleMap(), { x: 0, y: 0, z: 8 }, { x: 0, y: 0, z: -8 });
    expect(distance2D(result.entity.position, { x: 0, y: 0, z: -8 })).toBeLessThan(0.4);
    expect(Math.max(...result.visited.map(p => Math.abs(p.x)))).toBeGreaterThan(3.45);
    expect(result.plans).toBeLessThan(8);
  });

  it('routes a ranged actor that stopped at casting distance with its sight blocked', () => {
    const map = simpleMap();
    const navigator = new SurfaceNavigator(map);
    const self = createEntity(asEntityId(1), warrior, TEAM_RED, { x: 0, y: 0, z: 8 });
    const foe = createEntity(asEntityId(2), warrior, TEAM_RED, { x: 0, y: 0, z: -8 });
    let movement = createMovementState(self.position);
    for (let i = 0; i < 200 && !hasLineOfSight(self, foe, map.geometry); i++) {
      const input = navigator.combatMove(self, foe, { forward: 0, strafe: 0, jump: false, yaw: 0 }, i * 0.05);
      movement = stepMovement(movement, input, 0.05, map.geometry).state;
      self.position = movement.position;
    }
    expect(hasLineOfSight(self, foe, map.geometry)).toBe(true);
    navigator.dispose();
  });

  it('also routes around barriers that do not block sight', () => {
    const map = simpleMap([{ ...wall, max: { ...wall.max, y: 1 }, blocksSight: false }]);
    const navigator = new SurfaceNavigator(map);
    const self = createEntity(asEntityId(1), warrior, TEAM_RED, { x: 0, y: 0, z: 8 });
    const foe = createEntity(asEntityId(2), warrior, TEAM_RED, { x: 0, y: 0, z: -8 });
    expect(hasLineOfSight(self, foe, map.geometry)).toBe(true);
    const move = navigator.combatMove(self, foe, { forward: 1, strafe: 0, jump: false, yaw: 0 }, 0);
    expect(Math.abs(move.yaw)).toBeGreaterThan(0.1);
    navigator.dispose();
  });

  it.each([0.4, 0.5])('climbs real %s meter steps to a raised platform', rise => {
    const stairs: Aabb[] = Array.from({ length: 5 }, (_, i) => ({
      min: { x: -3, y: 0, z: 4 - i * 1.2 }, max: { x: 3, y: rise * (i + 1), z: 5.2 - i * 1.2 }, blocksSight: false,
    }));
    stairs.push({ min: { x: -3, y: 0, z: -8 }, max: { x: 3, y: rise * 5, z: -0.8 }, blocksSight: false });
    const result = walk(simpleMap(stairs), { x: 0, y: 0, z: 8 }, { x: 0, y: rise * 5, z: -5 }, 1200);
    expect(distance2D(result.entity.position, { x: 0, y: 0, z: -5 })).toBeLessThan(0.5);
    expect(result.entity.position.y).toBeCloseTo(rise * 5);
  });

  it('can leave a real arena spawn and reach the other side of its central cover', () => {
    const start = arena3v3.prepRooms![0]!.spawns[0]!.position;
    const result = walk(arena3v3, start, { x: 0, y: 0, z: -10 }, 1000);
    expect(distance2D(result.entity.position, { x: 0, y: 0, z: -10 })).toBeLessThan(0.5);
  });

  it('plans on the underground level and can return to the surface', () => {
    const map = { ...ctfMap, forbidden: activeForbidden(ctfMap, GameMode.Ctf8v8) };
    const result = walk(map, { x: 0, y: -6, z: 0 }, { x: 0, y: 0, z: 100 }, 2200);
    expect(distance2D(result.entity.position, { x: 0, y: 0, z: 100 })).toBeLessThan(0.6);
    expect(result.entity.position.y).toBeCloseTo(0);
  });

  it('updates a nearby moving goal instead of keeping the old five-meter dead zone', () => {
    const navigator = new SurfaceNavigator(simpleMap([]));
    const self = createEntity(asEntityId(1), warrior, TEAM_RED, { x: 0, y: 0, z: 0 });
    navigator.move(self, { x: 0, y: 0, z: 0 }, 0);
    const move = navigator.move(self, { x: 2, y: 0, z: 0 }, 0.5);
    expect(move.forward).toBeGreaterThan(0);
    expect(move.yaw).toBeCloseTo(-Math.PI / 2);
    navigator.dispose();
  });
});
