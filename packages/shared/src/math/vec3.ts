/**
 * 极简向量库。坐标系与 three.js 一致：Y 轴向上，右手系。
 * 全部为纯函数，不依赖 three.js —— shared 层要能在 Node 服务器上跑。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const set = (out: Vec3, x: number, y: number, z: number): Vec3 => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};
export const copy = (out: Vec3, a: Vec3): Vec3 => set(out, a.x, a.y, a.z);

export const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 => vec3(a.x * s, a.y * s, a.z * s);
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 =>
  vec3(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const lengthSq = (a: Vec3): number => dot(a, a);
export const length = (a: Vec3): number => Math.sqrt(lengthSq(a));

export const distanceSq = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};
export const distance = (a: Vec3, b: Vec3): number => Math.sqrt(distanceSq(a, b));

/** 水平距离（忽略高度）。近战距离判定用它，避免站台阶上就打不到 */
export const distanceSq2D = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
};
export const distance2D = (a: Vec3, b: Vec3): number => Math.sqrt(distanceSq2D(a, b));

export const normalize = (a: Vec3): Vec3 => {
  const len = length(a);
  return len > 1e-9 ? scale(a, 1 / len) : vec3(0, 0, 0);
};

/** 水平面上的单位方向（Y 归零后归一化）*/
export const normalize2D = (a: Vec3): Vec3 => {
  const len = Math.hypot(a.x, a.z);
  return len > 1e-9 ? vec3(a.x / len, 0, a.z / len) : vec3(0, 0, 0);
};

export const cross = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 =>
  vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/**
 * 把偏航角（弧度）转成水平朝向向量。
 * 约定：yaw = 0 面向 -Z（与 three.js 默认相机前方一致），逆时针为正。
 */
export const yawToDir = (yaw: number): Vec3 => vec3(-Math.sin(yaw), 0, -Math.cos(yaw));

/** 水平方向向量转偏航角 */
export const dirToYaw = (d: Vec3): number => Math.atan2(-d.x, -d.z);

/** 把角度差归一化到 (-PI, PI] */
export const wrapAngle = (a: number): number => {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  if (r <= -Math.PI) r += TAU;
  return r;
};

/** 两个偏航角之间的最短角差（绝对值，弧度）*/
export const angleDelta = (a: number, b: number): number => Math.abs(wrapAngle(a - b));
