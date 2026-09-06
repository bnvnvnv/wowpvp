import { init, NavMeshQuery, type NavMesh } from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';
import { GEOMETRY, MOVE } from '../constants/combat.js';
import type { ForbiddenVolume, PrepRoom } from '../data/maps/schema.js';
import { hasLineOfSight, segmentIntersectsAabb, type Aabb } from '../math/geometry.js';
import { dirToYaw, distance2D, yawToDir, type Vec3 } from '../math/vec3.js';
import type { CombatEntity } from '../sim/entity.js';
import type { MovementInput } from '../sim/movement.js';
import type { TeamId } from '../types/ids.js';

// Loaded separately from shared combat logic so the lobby does not initialize WASM.
await init();

export interface NavigationMap {
  geometry: readonly Aabb[];
  bounds: Aabb;
  forbidden?: readonly ForbiddenVolume[];
  prepRooms?: readonly PrepRoom[];
}

interface MeshResource { mesh: NavMesh; query: NavMeshQuery }
interface CachedResource extends MeshResource { geometry: readonly Aabb[]; key: string; users: number; usedAt: number }
const meshCache: CachedResource[] = [];
let cacheClock = 0;
interface Route {
  goal: Vec3;
  points: Vec3[];
  plannedAt: number;
  progressAt: number;
  last: Vec3;
  lastJumpAt: number;
}

const CS = 0.2;
const CH = 0.1;
const STOP_DISTANCE = 0.12;
const REPLAN_SECONDS = 0.35;

/** Recast consumes the same solid boxes as movement, including their stacked surfaces. */
function appendBox(vertices: number[], indices: number[], box: Aabb): void {
  const b = vertices.length / 3;
  const { min: a, max: z } = box;
  vertices.push(a.x, a.y, a.z, z.x, a.y, a.z, z.x, a.y, z.z, a.x, a.y, z.z,
    a.x, z.y, a.z, z.x, z.y, a.z, z.x, z.y, z.z, a.x, z.y, z.z);
  const faces = [0, 1, 2, 0, 2, 3, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0];
  faces.push(...(box.standable === false ? [4, 6, 7, 4, 5, 6] : [4, 7, 6, 4, 6, 5]));
  for (const index of faces) indices.push(b + index);
}

export class SurfaceNavigator {
  private readonly resources = new Map<string, CachedResource>();
  private readonly teamResources = new Map<TeamId, MeshResource>();
  private readonly routes = new Map<number, Route>();
  private readonly solids: readonly Aabb[];
  private readonly expandedSolids: readonly Aabb[];
  plans = 0;

  constructor(private readonly map: NavigationMap) {
    this.solids = map.geometry.filter(box => box.blocksMovement !== false);
    const pad = GEOMETRY.HITBOX_RADIUS + 0.06;
    this.expandedSolids = this.solids.map(box => ({
      min: { x: box.min.x - pad, y: box.min.y, z: box.min.z - pad },
      max: { x: box.max.x + pad, y: box.max.y, z: box.max.z + pad },
    }));
  }

  prepare(teams: readonly TeamId[]): void { for (const team of teams) this.resource(team); }

  private resource(team: TeamId): MeshResource {
    const cached = this.teamResources.get(team);
    if (cached) return cached;
    const forbidden = (this.map.forbidden ?? []).filter(f => {
      // Actors must be able to leave their initial prep room when combat opens.
      if (this.map.prepRooms?.some(room => room.volume === f.volume)) return false;
      return f.scope === 'all' || f.scope.forTeam === team;
    });
    const key = JSON.stringify(forbidden.map(f => f.volume));
    let resource = this.resources.get(key);
    if (!resource) resource = meshCache.find(entry => entry.geometry === this.map.geometry && entry.key === key);
    if (!resource) {
      const vertices: number[] = [];
      const indices: number[] = [];
      for (const box of this.solids) appendBox(vertices, indices, box);
      for (const f of forbidden) appendBox(vertices, indices, { ...f.volume, standable: false });
      const result = generateSoloNavMesh(vertices, indices, {
        cs: CS, ch: CH, walkableSlopeAngle: GEOMETRY.MAX_WALKABLE_SLOPE_DEG,
        walkableHeight: Math.ceil(GEOMETRY.HITBOX_HEIGHT / CH),
        walkableRadius: Math.ceil((GEOMETRY.HITBOX_RADIUS + 0.06) / CS),
        walkableClimb: Math.ceil((GEOMETRY.STEP_HEIGHT + 0.1) / CH),
        minRegionArea: 0, mergeRegionArea: 0, maxEdgeLen: 24,
        maxSimplificationError: 0.8, detailSampleDist: 3, detailSampleMaxError: 0.5,
      });
      if (!result.success) throw new Error(`Navigation mesh: ${result.error}`);
      resource = { mesh: result.navMesh, query: new NavMeshQuery(result.navMesh), geometry: this.map.geometry,
        key, users: 0, usedAt: ++cacheClock };
      meshCache.push(resource);
    }
    if (!this.resources.has(key)) {
      resource.users++;
      resource.usedAt = ++cacheClock;
      this.resources.set(key, resource);
      while (meshCache.length > 16) {
        const oldest = meshCache.filter(entry => entry.users === 0).sort((a, b) => a.usedAt - b.usedAt)[0];
        if (!oldest) break;
        oldest.query.destroy(); oldest.mesh.destroy();
        meshCache.splice(meshCache.indexOf(oldest), 1);
      }
    }
    this.teamResources.set(team, resource);
    return resource;
  }

  path(from: Vec3, to: Vec3, team: TeamId): Vec3[] {
    this.plans++;
    const { query } = this.resource(team);
    const result = query.computePath(from, to, { halfExtents: { x: 2, y: 1.5, z: 2 }, maxPathPolys: 1024 });
    return result.success ? result.path.map(p => ({ x: p.x, y: p.y, z: p.z })) : [];
  }

  private blocked(from: Vec3, to: Vec3): boolean {
    const lowFrom = { x: from.x, y: from.y + GEOMETRY.STEP_HEIGHT + 0.05, z: from.z };
    const lowTo = { x: to.x, y: to.y + GEOMETRY.STEP_HEIGHT + 0.05, z: to.z };
    const highFrom = { x: from.x, y: from.y + GEOMETRY.HITBOX_HEIGHT - 0.05, z: from.z };
    const highTo = { x: to.x, y: to.y + GEOMETRY.HITBOX_HEIGHT - 0.05, z: to.z };
    return this.expandedSolids.some(box => segmentIntersectsAabb(lowFrom, lowTo, box) || segmentIntersectsAabb(highFrom, highTo, box));
  }

  private jumpAhead(self: CombatEntity, next: Vec3, now: number, route: Route): boolean {
    if (now - route.lastJumpAt < 0.8) return false;
    const length = distance2D(self.position, next);
    if (length < 0.001) return false;
    const distance = Math.min(0.85, length);
    const x = self.position.x + (next.x - self.position.x) / length * distance;
    const z = self.position.z + (next.z - self.position.z) / length * distance;
    const step = this.solids.some(b => b.standable !== false && b.max.y > self.position.y + GEOMETRY.STEP_HEIGHT
      && b.max.y <= self.position.y + 0.7 && x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z);
    if (step) route.lastJumpAt = now;
    return step;
  }

  move(self: CombatEntity, goal: Vec3, now: number): MovementInput {
    let route = this.routes.get(self.id);
    const stuck = route && now - route.progressAt > 1.4 && distance2D(self.position, route.last) < 0.25;
    const shifted = route && distance2D(goal, route.goal) > (distance2D(self.position, goal) < 5 ? 0.35 : 1);
    const teleported = route && distance2D(self.position, route.points[0] ?? self.position) > 12
      && distance2D(self.position, route.last) > 12;
    if (!route || ((shifted || stuck || teleported || route.points.length === 0) && now - route.plannedAt >= REPLAN_SECONDS)) {
      const points = this.path(self.position, goal, self.team);
      route = { goal: { ...goal }, points, plannedAt: now, progressAt: now, last: { ...self.position }, lastJumpAt: route?.lastJumpAt ?? -Infinity };
      this.routes.set(self.id, route);
    }
    if (now - route.progressAt > 1.4) { route.progressAt = now; route.last = { ...self.position }; }
    while (route.points.length && distance2D(self.position, route.points[0]!) <= STOP_DISTANCE
      && Math.abs(self.position.y - route.points[0]!.y) < 0.75) route.points.shift();
    const next = route.points[0];
    if (!next) return { forward: 0, strafe: 0, jump: false, yaw: self.yaw };
    return { forward: Math.min(1, distance2D(self.position, next) / (MOVE.BASE_SPEED * 0.05)), strafe: 0,
      jump: this.jumpAhead(self, next, now, route), yaw: dirToYaw({ x: next.x - self.position.x, y: 0, z: next.z - self.position.z }) };
  }

  /** Keep the combat AI's spacing and dodge decisions, routing only obstructed movement. */
  combatMove(self: CombatEntity, foe: CombatEntity, desired: MovementInput, now: number): MovementInput {
    if (self.flags.stunned || self.flags.rooted || self.flags.feared) return desired;
    const forward = yawToDir(desired.yaw);
    const dx = forward.x * desired.forward - forward.z * desired.strafe;
    const dz = forward.z * desired.forward + forward.x * desired.strafe;
    const length = Math.hypot(dx, dz);
    const toward = (foe.position.x - self.position.x) * dx + (foe.position.z - self.position.z) * dz;
    if (length > 0.01 && toward <= 0) {
      const goal = { x: self.position.x + dx / length * 5, y: self.position.y, z: self.position.z + dz / length * 5 };
      return this.blocked(self.position, goal) ? this.move(self, goal, now) : desired;
    }
    if (!hasLineOfSight(self, foe, this.map.geometry) || (length > 0.01 && this.blocked(self.position, foe.position))) {
      return this.move(self, foe.position, now);
    }
    this.routes.delete(self.id);
    return desired;
  }

  forget(id: number): void { this.routes.delete(id); }

  dispose(): void {
    for (const resource of this.resources.values()) resource.users--;
    this.resources.clear(); this.teamResources.clear(); this.routes.clear();
  }
}
