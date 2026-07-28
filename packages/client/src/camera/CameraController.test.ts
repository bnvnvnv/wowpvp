/**
 * 镜头控制器测试。对应规格书 4.1–4.3 与验收 #1 / #2 / #3。
 *
 * three.js 的 PerspectiveCamera 与 Vector3 是纯数学，不需要 WebGL 上下文，
 * 所以镜头的这几条硬规则可以自动化验证，而不是只靠人眼看。
 */

import { describe, expect, it } from 'vitest';
import { GEOMETRY, type Aabb } from '@wowpvp/shared';
import { CAMERA, CameraController, type CameraInput } from './CameraController.js';

const DT = 1 / 60;
const noInput: CameraInput = { wheel: 0, leftDrag: null, rightDrag: null, reset: false };
const target = (x = 0, y = 0, z = 0, yaw = 0) => ({
  position: { x, y, z },
  yaw,
  grounded: true,
});

const settle = (c: CameraController, obstacles: readonly Aabb[], frames = 120, t = target()) => {
  for (let i = 0; i < frames; i++) c.update(DT, t, obstacles, false);
};

describe('4.2 / 验收 #2 — 左键环绕不改变角色朝向，右键联动', () => {
  it('★ 左键拖动只转镜头，角色朝向增量为 0', () => {
    const c = new CameraController(16 / 9);
    const before = c.yaw;
    const characterYawDelta = c.applyInput({ ...noInput, leftDrag: { dx: 100, dy: 0 } });

    expect(c.yaw).not.toBe(before); // 镜头转了
    expect(characterYawDelta).toBe(0); // ★ 角色没转
  });

  it('★ 右键拖动同时转镜头和角色，且转动量一致', () => {
    const c = new CameraController(16 / 9);
    const before = c.yaw;
    const characterYawDelta = c.applyInput({ ...noInput, rightDrag: { dx: 100, dy: 0 } });

    expect(characterYawDelta).not.toBe(0);
    expect(c.yaw - before).toBeCloseTo(characterYawDelta, 10);
  });

  it('6.5 —— 镜头可以转到角色背后，这正是「不能用镜头绕过朝向限制」要防的情形', () => {
    const c = new CameraController(16 / 9);
    // 左键拖到镜头看向角色身后
    for (let i = 0; i < 20; i++) c.applyInput({ ...noInput, leftDrag: { dx: 50, dy: 0 } });
    // 镜头 yaw 已经明显偏离 0，而角色 yaw 从未被本模块改动
    expect(Math.abs(c.yaw)).toBeGreaterThan(1);
  });

  it('一键复位把镜头转回角色正后方', () => {
    const c = new CameraController(16 / 9);
    c.applyInput({ ...noInput, leftDrag: { dx: 300, dy: 0 } });
    c.resetBehind(1.23);
    expect(c.yaw).toBe(1.23);
  });
});

describe('4.1 / 验收 #1 — 连续缩放', () => {
  it('滚轮改变目标距离，实际距离平滑趋近而不是突变', () => {
    const c = new CameraController(16 / 9);
    const start = c.distance;
    c.applyInput({ ...noInput, wheel: 100 });

    c.update(DT, target(), [], false);
    const afterOneFrame = c.distance;
    // 一帧内只走了一小部分，不是瞬间跳过去
    expect(afterOneFrame).toBeGreaterThan(start);
    expect(afterOneFrame).toBeLessThan(start + CAMERA.ZOOM_STEP);

    settle(c, []);
    expect(c.distance).toBeCloseTo(start + CAMERA.ZOOM_STEP, 2);
  });

  it('缩放有上下限：最近到 0（第一人称），最远到 MAX_DISTANCE', () => {
    const c = new CameraController(16 / 9);
    for (let i = 0; i < 60; i++) c.applyInput({ ...noInput, wheel: -100 });
    settle(c, []);
    expect(c.distance).toBeLessThan(CAMERA.FIRST_PERSON_THRESHOLD);
    expect(c.isFirstPerson).toBe(true);

    for (let i = 0; i < 200; i++) c.applyInput({ ...noInput, wheel: 100 });
    settle(c, [], 300);
    expect(c.distance).toBeCloseTo(CAMERA.MAX_DISTANCE, 1);
    expect(c.isFirstPerson).toBe(false);
  });

  it('4.1 最远距离仍围绕角色，不变成垂直俯视', () => {
    const c = new CameraController(16 / 9);
    // 一路往下拖，试图把镜头压成俯视
    for (let i = 0; i < 100; i++) c.applyInput({ ...noInput, leftDrag: { dx: 0, dy: 200 } });
    expect(c.pitch).toBeLessThanOrEqual((CAMERA.MAX_PITCH_DEG * Math.PI) / 180 + 1e-9);
    expect(CAMERA.MAX_PITCH_DEG).toBeLessThan(90);
  });
});

describe('4.3 / 验收 #3 — 镜头不穿墙，靠墙拉近并平滑恢复', () => {
  /** 角色站在原点，身后（+Z）5 米处有一堵墙 */
  const wallBehind: Aabb = {
    min: { x: -20, y: 0, z: 4 },
    max: { x: 20, y: 8, z: 5 },
  };

  it('★ 墙挡在镜头与角色之间时，镜头被拉到墙前', () => {
    const c = new CameraController(16 / 9);
    settle(c, []); // 先在无阻挡下稳定到默认 6.5 米
    const free = c.camera.position.z;

    settle(c, [wallBehind], 200);
    // 墙的近面在 z = 4，镜头必须停在它前面
    expect(c.camera.position.z).toBeLessThan(4);
    expect(c.camera.position.z).toBeLessThan(free);
  });

  it('★ 离开墙后平滑恢复原距离，而不是瞬间弹回', () => {
    const c = new CameraController(16 / 9);
    settle(c, [wallBehind], 200);
    const nearWall = c.distanceToAnchor();

    // 障碍移除后跑一帧
    c.update(DT, target(), [], false);
    const oneFrameLater = c.distanceToAnchor();
    expect(oneFrameLater).toBeGreaterThan(nearWall);
    expect(oneFrameLater).toBeLessThan(CAMERA.DEFAULT_DISTANCE); // 还没到位

    settle(c, [], 200);
    expect(c.distanceToAnchor()).toBeCloseTo(CAMERA.DEFAULT_DISTANCE, 1);
  });

  it('★ 收缩比恢复快 —— 慢一帧就会穿墙偷看', () => {
    expect(CAMERA.PULL_IN_LERP).toBeGreaterThan(CAMERA.RESTORE_LERP * 3);
  });

  it('无阻挡时镜头保持在完整距离上', () => {
    const c = new CameraController(16 / 9);
    settle(c, []);
    expect(c.distanceToAnchor()).toBeCloseTo(CAMERA.DEFAULT_DISTANCE, 1);
  });
});

describe('4.3 — 手动拖动期间停止自动跟随', () => {
  it('拖动后一段时间内，角色移动不会把镜头自动拽走', () => {
    const c = new CameraController(16 / 9);
    c.applyInput({ ...noInput, leftDrag: { dx: 200, dy: 0 } });
    const afterDrag = c.yaw;

    // 角色朝向 0 且在移动，若自动跟随生效镜头会转回 0
    for (let i = 0; i < 20; i++) c.update(DT, target(0, 0, 0, 0), [], true);
    expect(c.yaw).toBeCloseTo(afterDrag, 6);
  });

  it('延迟过后自动跟随恢复，镜头逐渐转到角色背后', () => {
    const c = new CameraController(16 / 9);
    c.applyInput({ ...noInput, leftDrag: { dx: 200, dy: 0 } });
    const afterDrag = c.yaw;

    // 先空跑过等待期
    for (let i = 0; i < Math.ceil(CAMERA.AUTO_FOLLOW_DELAY / DT) + 2; i++) {
      c.update(DT, target(0, 0, 0, 0), [], false);
    }
    for (let i = 0; i < 60; i++) c.update(DT, target(0, 0, 0, 0), [], true);

    expect(Math.abs(c.yaw)).toBeLessThan(Math.abs(afterDrag));
  });
});

describe('4.3 — 跳跃时垂直跟随柔于水平跟随', () => {
  it('垂直位置滞后于角色，水平位置不滞后', () => {
    const c = new CameraController(16 / 9);
    settle(c, []);

    // 角色瞬间上升 3 米
    c.update(DT, { position: { x: 0, y: 3, z: 0 }, yaw: 0, grounded: false }, [], false);

    const anchorY = 3 + GEOMETRY.CHEST_HEIGHT;
    // 一帧内没有完全跟上
    expect(c.camera.position.y).toBeLessThan(anchorY);
  });

  it('落地时垂直跟随更快，避免镜头拖在角色上方', () => {
    expect(CAMERA.VERTICAL_LERP_LANDING).toBeGreaterThan(CAMERA.VERTICAL_LERP);
  });
});
