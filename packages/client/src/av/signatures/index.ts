/**
 * P3 技能签名的**唯一注册入口**。
 *
 * ★★ 导入这一个模块 = 全部手写签名进注册表。调用方（AudioManager 的
 *   `playCastFor`/`playImpactFor`、SpellVfx 的形态层）永远只认
 *   `skillSignature.ts` 的 `resolveSignature`，不认识任何一张具体的表 ——
 *   加一个职业表只改本文件一行，调用点零改动。
 *
 * ★ 依赖方向是单向的：`signatures/*` → `skillSignature.ts`，反过来不成立
 *   （地基不 import 任何表，见那边 :137 的注释）。本文件是这条单向边的汇合点。
 *
 * ★ 注册是**副作用** —— 生效前提是启动路径真的 import 到本模块
 *   （`main.ts` 顶部那一行）。漏掉的话 `resolveSignature` 会静默退回
 *   推导层：没有报错、没有日志，音画只是「差一点」——正是本仓库最怕的
 *   那种失败。`integrity.test.ts` 因此有一条「main.ts 必须 import 本模块」
 *   的源码锁。
 */

import { registerSignatures } from '../skillSignature.js';
import { commonSignatures } from './common.js';
import { signatures as warriorSignatures } from './warrior.js';
import { signatures as paladinSignatures } from './paladin.js';
import { signatures as deathknightSignatures } from './deathknight.js';
import { signatures as rogueSignatures } from './rogue.js';
import { signatures as hunterSignatures } from './hunter.js';
import { signatures as mageSignatures } from './mage.js';
import { signatures as priestSignatures } from './priest.js';
import { signatures as druidSignatures } from './druid.js';

registerSignatures(commonSignatures);
registerSignatures(warriorSignatures);
registerSignatures(paladinSignatures);
registerSignatures(deathknightSignatures);
registerSignatures(rogueSignatures);
registerSignatures(hunterSignatures);
registerSignatures(mageSignatures);
registerSignatures(priestSignatures);
registerSignatures(druidSignatures);
