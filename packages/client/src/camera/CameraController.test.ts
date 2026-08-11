/**
 * 镜头控制器测试。对应规格书 4.1–4.3 与验收 #1 / #2 / #3。
 *
 * three.js 的 PerspectiveCamera 与 Vector3 是纯数学，不需要 WebGL 上下文，
 * 所以镜头的这几条硬规则可以自动化验证，而不是只靠人眼看。
 */

import { describe, expect, it } from 'vitest';
import { GEOMETRY, type Aabb } from '@wowpvp/shared';
import { CAMERA, CameraController, type CameraInput } from './CameraController.js';
import { DEFAULT_ACCESSIBILITY } from '../settings/accessibility.js';

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

  /**
   * ★★ X15 指针锁定要成立，镜头这一侧必须没有「单次拖动上限」。
   *   锁定之后一次按住能累出远超窗口宽度的 `movementX`（光标不再有边界），
   *   若 yaw 通道对增量有夹取或按窗口宽度归一，锁定就白做了。
   */
  it('★★ X15 — 一次按住内的大额位移全额转成 yaw（转身量不被任何上限封顶）', () => {
    const c = new CameraController(16 / 9);
    const before = c.yaw;
    // 1366px 窗里拖满 1200px 只转出 149°（真机量化）；锁定后同一次按住可累出 4000px
    let charYaw = 0;
    for (let i = 0; i < 10; i++) {
      charYaw += c.applyInput({ ...noInput, rightDrag: { dx: 400, dy: 0 } });
    }
    expect(c.yaw - before).toBeCloseTo(-4000 * CAMERA.SENSITIVITY, 10);
    // 4000px × 0.0045 = 18 弧度 ≈ 2.86 圈：一次按住转过整圈是本条债的判据
    expect(Math.abs(c.yaw - before)).toBeGreaterThan(Math.PI * 2);
    // 角色朝向跟着走同样的量（4.2 右键联动，锁定与否是同一条路径）
    expect(charYaw).toBeCloseTo(c.yaw - before, 10);
  });

  it('★ X15 — 俯仰仍然被夹住（yaw 不封顶不等于 pitch 也放开，4.1 不许变垂直俯视）', () => {
    const c = new CameraController(16 / 9);
    for (let i = 0; i < 10; i++) c.applyInput({ ...noInput, rightDrag: { dx: 0, dy: 400 } });
    expect(c.pitch).toBeCloseTo((CAMERA.MAX_PITCH_DEG * Math.PI) / 180, 10);
    for (let i = 0; i < 20; i++) c.applyInput({ ...noInput, rightDrag: { dx: 0, dy: -400 } });
    expect(c.pitch).toBeCloseTo((CAMERA.MIN_PITCH_DEG * Math.PI) / 180, 10);
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

describe('镜头震动（打击感改造，docs/07 §1.7）—— 不穿墙、可归零、不翻第一人称', () => {
  const wallBehind: Aabb = {
    min: { x: -20, y: 0, z: 4 },
    max: { x: 20, y: 8, z: 5 },
  };

  const distToAnchor = (c: CameraController): number =>
    Math.hypot(
      c.camera.position.x,
      c.camera.position.y - GEOMETRY.CHEST_HEIGHT,
      c.camera.position.z,
    );

  it('★★ 满创伤连续 30 帧，镜头到锚点的距离恒 ≤ 无震动时的距离（只拉近，永不推远）', () => {
    const c = new CameraController(16 / 9);
    settle(c, [wallBehind], 200);
    const baseline = distToAnchor(c);

    c.addTrauma(1);
    for (let i = 0; i < 30; i++) {
      c.update(DT, target(), [wallBehind], false);
      // 位移通道是减法：任何一帧都不该比无震动时更远（更远 = 可能穿墙）
      expect(distToAnchor(c)).toBeLessThanOrEqual(baseline + 1e-6);
      // 墙的硬边界照样成立
      expect(c.camera.position.z).toBeLessThan(4);
    }
  });

  it('★ cameraShake=0 时有无 addTrauma 的相机位置与朝向逐帧完全相同', () => {
    const run = (shake: boolean) => {
      const c = new CameraController(16 / 9);
      c.setAccessibility({ ...DEFAULT_ACCESSIBILITY, cameraShake: 0 });
      settle(c, []);
      if (shake) c.addTrauma(1);
      const frames: [number, number, number, number][] = [];
      for (let i = 0; i < 20; i++) {
        c.update(DT, target(), [], false);
        frames.push([
          c.camera.position.x, c.camera.position.y, c.camera.position.z,
          c.camera.quaternion.w,
        ]);
      }
      return frames;
    };
    expect(run(true)).toEqual(run(false));
  });

  it('★ 满创伤不会把 isFirstPerson 从 false 翻成 true（pullIn 不改玩家设定的缩放）', () => {
    const c = new CameraController(16 / 9);
    settle(c, []);
    expect(c.isFirstPerson).toBe(false);
    c.addTrauma(1);
    for (let i = 0; i < 30; i++) {
      c.update(DT, target(), [], false);
      expect(c.isFirstPerson).toBe(false);
    }
  });
});
