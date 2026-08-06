<!-- 本文件由 scripts/gen-docs.ts 自动生成，请勿手工编辑。
     数据来源：packages/shared/src/data/classes/*.ts、packages/shared/src/data/armors.ts
     重新生成：pnpm docs -->

# 武器、护甲与装备映射表

> 规格书附录A#4：每件武器和护甲必须标注所属职业、攻击间隔、距离、优势、代价和改变的技能。
> 本文件由 `scripts/gen-docs.ts` 自动生成。装备系统的**规则**（拾取、换装、军械箱、职业锁定）
> 见规格书第 10 章与 [01-development-plan.md](01-development-plan.md) 的 M6。

## 设计约束（规格书 17.1 / 验收 #32）

- 临时装备必须**横向取舍**，不能同时提高伤害、攻速、防御、移动和控制
- 每件装备都必须同时有明确的优势与代价，不存在全面上位装备
- 武器和护甲带职业归属，**不允许跨职业使用**（10.2 / 验收 #29）
- 每个职业始终保留 1 套不可删除的默认武器和默认护甲，默认装备永不掉落（10.6）
- 最多携带 2 套临时武器、2 套临时护甲、2 个主动增益道具（10.6）

## 武器方案

### 战士

| 方案 | 类型 | 单击 | 攻击间隔 | 距离 | 优势 | 代价 | 改变的技能 |
|---|---|---|---|---|---|---|---|
| **单手剑 + 盾牌**（默认） | 单手 | 90% | 1.7s | 2.8m | 正面格挡 20%，防御 +15% | 爆发低 | 获得 warrior.shield_slam；禁用 warrior.cleave, warrior.combo_storm |
| 双手巨剑 | 双手 | 155% | 2.4s | 3.4m | 单击和横扫伤害最高，暴击更重（倍率 ×1.15） | 防御 -10%，攻速慢 | 获得 warrior.cleave；禁用 warrior.shield_slam, warrior.combo_storm |
| 双持单手剑 | 双持 | 42% | 0.75s | 2.8m | 攻速快，怒气获取 +20% | 单击低，防御 -8% | 获得 warrior.combo_storm；禁用 warrior.shield_slam, warrior.cleave；warrior.mortal_strike: damageMultiplier=0.85 |

### 圣骑士

| 方案 | 类型 | 单击 | 攻击间隔 | 距离 | 优势 | 代价 | 改变的技能 |
|---|---|---|---|---|---|---|---|
| **单手剑 + 盾牌**（默认） | 单手 | 68% | 1.8s | 2.8m | 防御 +12%，可格挡 | 持续伤害较低 | 获得 paladin.shield_of_the_righteous；禁用 paladin.templar_strike, paladin.holy_bolt |
| 双手战锤 | 双手 | 150% | 2.5s | 3.4m | 神圣爆发和范围压力高 | 防御 -10%，无格挡 | 获得 paladin.templar_strike；禁用 paladin.shield_of_the_righteous, paladin.holy_bolt |
| 权杖 + 圣典 | 远程 | 50% | 1.6s | 25m | 治疗 +10%，读条时间 -15% | 物理防御 -12%，近战输出低 | 获得 paladin.holy_bolt；禁用 paladin.crusader_strike, paladin.shield_of_the_righteous, paladin.templar_strike |

### 死亡骑士

| 方案 | 类型 | 单击 | 攻击间隔 | 距离 | 优势 | 代价 | 改变的技能 |
|---|---|---|---|---|---|---|---|
| **双手符文剑**（默认） | 双手 | 140% | 2.3s | 3.3m | 重击和爆发高 | 攻速慢 | 禁用 deathknight.frost_strike_fast, deathknight.rune_ward；deathknight.obliterate: damageMultiplier=1.15 |
| 双持符文刃 | 双持 | 48% | 0.8s | 2.8m | 符文能量获取 +20%，持续压制 | 单击低，防御 -5% | 获得 deathknight.frost_strike_fast；禁用 deathknight.rune_ward |
| 符文剑 + 骨盾 | 单手 | 85% | 1.8s | 2.8m | 防御 +15%，法术抗性提高 | 移动 -5%，输出低 | 获得 deathknight.rune_ward；禁用 deathknight.frost_strike_fast；deathknight.obliterate: damageMultiplier=0.85 |

### 盗贼

| 方案 | 类型 | 单击 | 攻击间隔 | 距离 | 优势 | 代价 | 改变的技能 |
|---|---|---|---|---|---|---|---|
| **双匕首**（默认） | 双持 | 45% | 0.7s | 2.4m | 背后爆发最高，能量循环快，暴击 +10% | 距离最短，正面弱 | 禁用 rogue.blade_flurry, rogue.riposte；rogue.backstab: damageMultiplier=1.15；rogue.poisoned_blade: damageMultiplier=1.15 |
| 双剑 | 双持 | 56% | 0.9s | 2.8m | 正面持续伤害稳定 | 背后加成降低，攻速慢 | 获得 rogue.blade_flurry；禁用 rogue.riposte；rogue.backstab: damageMultiplier=0.85 |
| 匕首 + 格挡短刃 | 单手 | 29% | 0.85s | 2.5m | 招架 +15%，反击稳定 | 爆发 -15% | 获得 rogue.riposte；禁用 rogue.blade_flurry；rogue.kidney_shot: damageMultiplier=0.7；rogue.eviscerate: damageMultiplier=0.85；rogue.backstab: damageMultiplier=0.85 |

### 猎人

| 方案 | 类型 | 单击 | 攻击间隔 | 距离 | 优势 | 代价 | 改变的技能 |
|---|---|---|---|---|---|---|---|
| **短弓**（默认） | 远程 | 95% | 1.35s | 28m | 射速快，可全速移动射击 | 单发低，射程短 | 禁用 hunter.piercing_bolt；hunter.arcane_shot: cooldownMultiplier=0.75 |
| 长弓 | 远程 | 160% | 2.2s | 35m | 射程和单发最高，暴击更重（倍率 ×1.2） | 攻速慢；重型射击需站定 | 禁用 hunter.piercing_bolt；hunter.aimed_shot: damageMultiplier=1.15 |
| 重弩 | 远程 | 165% | 2.6s | 32m | 穿甲和冲击高 | 每发前有 1 秒装填；移动会中断 | 获得 hunter.piercing_bolt |

### 法师

| 方案 | 类型 | 单击 | 攻击间隔 | 距离 | 优势 | 代价 | 改变的技能 |
|---|---|---|---|---|---|---|---|
| **双手法杖**（默认） | 法杖 | 50% | 2s | 32m | 法术伤害 +12%，范围能力强 | 读条时间 +10%，物理防御低 | 禁用 mage.elemental_slash；mage.blizzard: damageMultiplier=1.15；mage.meteor: damageMultiplier=1.15 |
| 魔杖 + 法球 | 远程 | 45% | 1.2s | 28m | 读条时间 -12%，资源循环快 | 伤害 -8%，范围较小 | 禁用 mage.elemental_slash；mage.fire_blast: cooldownMultiplier=0.7 |
| 法刃 + 元素焦点 | 单手 | 85% | 1.5s | 2.8m | 瞬发技能 +15%，自保提高 | 远程技能最大距离 -20% | 获得 mage.elemental_slash；mage.fire_blast: damageMultiplier=1.15；mage.frost_nova: damageMultiplier=1.15；mage.elemental_slash: damageMultiplier=1.15 |

### 牧师

| 方案 | 类型 | 单击 | 攻击间隔 | 距离 | 优势 | 代价 | 改变的技能 |
|---|---|---|---|---|---|---|---|
| **双手法杖**（默认） | 法杖 | 50% | 2s | 30m | 群体治疗 +12% | 读条时间 +8%，自保一般 | 禁用 priest.mind_spike |
| 权杖 + 圣典 | 单手 | 45% | 1.5s | 25m | 单体治疗读条 -15%，驱散效率高 | 范围治疗 -10% | 禁用 priest.mind_spike；priest.dispel_magic: cooldownMultiplier=0.75；priest.mass_dispel: cooldownMultiplier=0.85 |
| 魔杖 + 圣物 | 远程 | 45% | 1.2s | 28m | 攻击和控制 +12% | 治疗与护盾 -10% | 获得 priest.mind_spike |

### 德鲁伊

| 方案 | 类型 | 单击 | 攻击间隔 | 距离 | 优势 | 代价 | 改变的技能 |
|---|---|---|---|---|---|---|---|
| **自然法杖**（默认） | 法杖 | 60% | 1.8s | 28m | 治疗和控制 +10% | 动物形态伤害 -10% | druid.healing_touch: damageMultiplier=1.1；druid.entangling_roots: cooldownMultiplier=0.9 |
| 长柄战刃 | 双手 | 120% | 2.1s | 3.6m | 动物形态伤害 +15%，近战范围较长 | 治疗 -12%，攻速慢 | druid.bear_form: damageMultiplier=1.15；druid.cat_form: damageMultiplier=1.15 |
| 单手锤 + 自然图腾 | 单手 | 85% | 1.6s | 2.8m | 控制与团队辅助更强 | 没有高爆发，防御一般 | druid.stampeding_roar: cooldownMultiplier=0.9；druid.barkskin: cooldownMultiplier=0.9 |

## 护甲方案（10.8 五种横向原型）

所有职业共用同一组原型结构，由 `packages/shared/src/data/armors.ts` 的 `makeArmorSet` 工厂生成，
保证不会出现某个职业的某件护甲意外变成全面上位。

### 战士

| 方案 | 原型 | 优势 | 代价 | 数值修正 |
|---|---|---|---|---|
| **板甲**（默认） | baseline | 标准化基线，无任何倾向 | 没有专精优势 | — |
| 板甲·进攻型护甲 | offense | 攻击、法术、资源效率与暴击几率提高 | 防御下降，受到的治疗降低 | damageDealt=1.12 resourceGain=1.15 critChance=0.05 damageTaken=1.08 healingTaken=0.92 |
| 板甲·守护型护甲 | guardian | 物理防御与爆发承受能力提高 | 移动、攻速与施法速度降低 | damageTaken=0.85 block=0.1 moveSpeed=0.93 attackSpeed=1.08 castSpeed=1.08 |
| 板甲·机动型护甲 | mobility | 移动与追击能力提高 | 基础防御与击退抵抗降低 | moveSpeed=1.12 damageTaken=1.1 knockbackTaken=1.25 |
| 板甲·抗法型护甲 | spellWard | 法术伤害与魔法控制时长降低 | 物理防御明显降低 | damageTaken=1.12 damageTakenBySchool={"holy":0.82,"fire":0.82,"frost":0.82,"arcane":0.82,"shadow":0.82,"nature":0.82} ccDurationTakenBySchool={"holy":0.8,"fire":0.8,"frost":0.8,"arcane":0.8,"shadow":0.8,"nature":0.8} |
| 板甲·抗控型护甲 | tenacity | 控制持续时间与击退距离降低 | 输出、治疗与资源效率降低 | ccDurationTaken=0.75 knockbackTaken=0.6 damageDealt=0.9 healingDone=0.9 resourceGain=0.9 |

### 圣骑士

| 方案 | 原型 | 优势 | 代价 | 数值修正 |
|---|---|---|---|---|
| **板甲**（默认） | baseline | 标准化基线，无任何倾向 | 没有专精优势 | — |
| 板甲·进攻型护甲 | offense | 攻击、法术、资源效率与暴击几率提高 | 防御下降，受到的治疗降低 | damageDealt=1.12 resourceGain=1.15 critChance=0.05 damageTaken=1.08 healingTaken=0.92 |
| 板甲·守护型护甲 | guardian | 物理防御与爆发承受能力提高 | 移动、攻速与施法速度降低 | damageTaken=0.85 block=0.1 moveSpeed=0.93 attackSpeed=1.08 castSpeed=1.08 |
| 板甲·机动型护甲 | mobility | 移动与追击能力提高 | 基础防御与击退抵抗降低 | moveSpeed=1.12 damageTaken=1.1 knockbackTaken=1.25 |
| 板甲·抗法型护甲 | spellWard | 法术伤害与魔法控制时长降低 | 物理防御明显降低 | damageTaken=1.12 damageTakenBySchool={"holy":0.82,"fire":0.82,"frost":0.82,"arcane":0.82,"shadow":0.82,"nature":0.82} ccDurationTakenBySchool={"holy":0.8,"fire":0.8,"frost":0.8,"arcane":0.8,"shadow":0.8,"nature":0.8} |
| 板甲·抗控型护甲 | tenacity | 控制持续时间与击退距离降低 | 输出、治疗与资源效率降低 | ccDurationTaken=0.75 knockbackTaken=0.6 damageDealt=0.9 healingDone=0.9 resourceGain=0.9 |

### 死亡骑士

| 方案 | 原型 | 优势 | 代价 | 数值修正 |
|---|---|---|---|---|
| **符文板甲**（默认） | baseline | 标准化基线，无任何倾向 | 没有专精优势 | — |
| 符文板甲·进攻型护甲 | offense | 攻击、法术、资源效率与暴击几率提高 | 防御下降，受到的治疗降低 | damageDealt=1.12 resourceGain=1.15 critChance=0.05 damageTaken=1.08 healingTaken=0.92 |
| 符文板甲·守护型护甲 | guardian | 物理防御与爆发承受能力提高 | 移动、攻速与施法速度降低 | damageTaken=0.85 block=0.1 moveSpeed=0.93 attackSpeed=1.08 castSpeed=1.08 |
| 符文板甲·机动型护甲 | mobility | 移动与追击能力提高 | 基础防御与击退抵抗降低 | moveSpeed=1.12 damageTaken=1.1 knockbackTaken=1.25 |
| 符文板甲·抗法型护甲 | spellWard | 法术伤害与魔法控制时长降低 | 物理防御明显降低 | damageTaken=1.12 damageTakenBySchool={"holy":0.82,"fire":0.82,"frost":0.82,"arcane":0.82,"shadow":0.82,"nature":0.82} ccDurationTakenBySchool={"holy":0.8,"fire":0.8,"frost":0.8,"arcane":0.8,"shadow":0.8,"nature":0.8} |
| 符文板甲·抗控型护甲 | tenacity | 控制持续时间与击退距离降低 | 输出、治疗与资源效率降低 | ccDurationTaken=0.75 knockbackTaken=0.6 damageDealt=0.9 healingDone=0.9 resourceGain=0.9 |

### 盗贼

| 方案 | 原型 | 优势 | 代价 | 数值修正 |
|---|---|---|---|---|
| **皮甲**（默认） | baseline | 标准化基线，无任何倾向 | 没有专精优势 | — |
| 皮甲·进攻型护甲 | offense | 攻击、法术、资源效率与暴击几率提高 | 防御下降，受到的治疗降低 | damageDealt=1.12 resourceGain=1.15 critChance=0.05 damageTaken=1.08 healingTaken=0.92 |
| 皮甲·守护型护甲 | guardian | 物理防御与爆发承受能力提高 | 移动、攻速与施法速度降低 | damageTaken=0.85 block=0.1 moveSpeed=0.93 attackSpeed=1.08 castSpeed=1.08 |
| 皮甲·机动型护甲 | mobility | 移动与追击能力提高 | 基础防御与击退抵抗降低 | moveSpeed=1.12 damageTaken=1.1 knockbackTaken=1.25 |
| 皮甲·抗法型护甲 | spellWard | 法术伤害与魔法控制时长降低 | 物理防御明显降低 | damageTaken=1.12 damageTakenBySchool={"holy":0.82,"fire":0.82,"frost":0.82,"arcane":0.82,"shadow":0.82,"nature":0.82} ccDurationTakenBySchool={"holy":0.8,"fire":0.8,"frost":0.8,"arcane":0.8,"shadow":0.8,"nature":0.8} |
| 皮甲·抗控型护甲 | tenacity | 控制持续时间与击退距离降低 | 输出、治疗与资源效率降低 | ccDurationTaken=0.75 knockbackTaken=0.6 damageDealt=0.9 healingDone=0.9 resourceGain=0.9 |

### 猎人

| 方案 | 原型 | 优势 | 代价 | 数值修正 |
|---|---|---|---|---|
| **锁甲**（默认） | baseline | 标准化基线，无任何倾向 | 没有专精优势 | — |
| 锁甲·进攻型护甲 | offense | 攻击、法术、资源效率与暴击几率提高 | 防御下降，受到的治疗降低 | damageDealt=1.12 resourceGain=1.15 critChance=0.05 damageTaken=1.08 healingTaken=0.92 |
| 锁甲·守护型护甲 | guardian | 物理防御与爆发承受能力提高 | 移动、攻速与施法速度降低 | damageTaken=0.85 block=0.1 moveSpeed=0.93 attackSpeed=1.08 castSpeed=1.08 |
| 锁甲·机动型护甲 | mobility | 移动与追击能力提高 | 基础防御与击退抵抗降低 | moveSpeed=1.12 damageTaken=1.1 knockbackTaken=1.25 |
| 锁甲·抗法型护甲 | spellWard | 法术伤害与魔法控制时长降低 | 物理防御明显降低 | damageTaken=1.12 damageTakenBySchool={"holy":0.82,"fire":0.82,"frost":0.82,"arcane":0.82,"shadow":0.82,"nature":0.82} ccDurationTakenBySchool={"holy":0.8,"fire":0.8,"frost":0.8,"arcane":0.8,"shadow":0.8,"nature":0.8} |
| 锁甲·抗控型护甲 | tenacity | 控制持续时间与击退距离降低 | 输出、治疗与资源效率降低 | ccDurationTaken=0.75 knockbackTaken=0.6 damageDealt=0.9 healingDone=0.9 resourceGain=0.9 |

### 法师

| 方案 | 原型 | 优势 | 代价 | 数值修正 |
|---|---|---|---|---|
| **布甲**（默认） | baseline | 标准化基线，无任何倾向 | 没有专精优势 | — |
| 布甲·进攻型护甲 | offense | 攻击、法术、资源效率与暴击几率提高 | 防御下降，受到的治疗降低 | damageDealt=1.12 resourceGain=1.15 critChance=0.05 damageTaken=1.08 healingTaken=0.92 |
| 布甲·守护型护甲 | guardian | 物理防御与爆发承受能力提高 | 移动、攻速与施法速度降低 | damageTaken=0.85 block=0.1 moveSpeed=0.93 attackSpeed=1.08 castSpeed=1.08 |
| 布甲·机动型护甲 | mobility | 移动与追击能力提高 | 基础防御与击退抵抗降低 | moveSpeed=1.12 damageTaken=1.1 knockbackTaken=1.25 |
| 布甲·抗法型护甲 | spellWard | 法术伤害与魔法控制时长降低 | 物理防御明显降低 | damageTaken=1.12 damageTakenBySchool={"holy":0.82,"fire":0.82,"frost":0.82,"arcane":0.82,"shadow":0.82,"nature":0.82} ccDurationTakenBySchool={"holy":0.8,"fire":0.8,"frost":0.8,"arcane":0.8,"shadow":0.8,"nature":0.8} |
| 布甲·抗控型护甲 | tenacity | 控制持续时间与击退距离降低 | 输出、治疗与资源效率降低 | ccDurationTaken=0.75 knockbackTaken=0.6 damageDealt=0.9 healingDone=0.9 resourceGain=0.9 |

### 牧师

| 方案 | 原型 | 优势 | 代价 | 数值修正 |
|---|---|---|---|---|
| **布甲**（默认） | baseline | 标准化基线，无任何倾向 | 没有专精优势 | — |
| 布甲·进攻型护甲 | offense | 攻击、法术、资源效率与暴击几率提高 | 防御下降，受到的治疗降低 | damageDealt=1.12 resourceGain=1.15 critChance=0.05 damageTaken=1.08 healingTaken=0.92 |
| 布甲·守护型护甲 | guardian | 物理防御与爆发承受能力提高 | 移动、攻速与施法速度降低 | damageTaken=0.85 block=0.1 moveSpeed=0.93 attackSpeed=1.08 castSpeed=1.08 |
| 布甲·机动型护甲 | mobility | 移动与追击能力提高 | 基础防御与击退抵抗降低 | moveSpeed=1.12 damageTaken=1.1 knockbackTaken=1.25 |
| 布甲·抗法型护甲 | spellWard | 法术伤害与魔法控制时长降低 | 物理防御明显降低 | damageTaken=1.12 damageTakenBySchool={"holy":0.82,"fire":0.82,"frost":0.82,"arcane":0.82,"shadow":0.82,"nature":0.82} ccDurationTakenBySchool={"holy":0.8,"fire":0.8,"frost":0.8,"arcane":0.8,"shadow":0.8,"nature":0.8} |
| 布甲·抗控型护甲 | tenacity | 控制持续时间与击退距离降低 | 输出、治疗与资源效率降低 | ccDurationTaken=0.75 knockbackTaken=0.6 damageDealt=0.9 healingDone=0.9 resourceGain=0.9 |

### 德鲁伊

| 方案 | 原型 | 优势 | 代价 | 数值修正 |
|---|---|---|---|---|
| **皮甲**（默认） | baseline | 标准化基线，无任何倾向 | 没有专精优势 | — |
| 皮甲·进攻型护甲 | offense | 攻击、法术、资源效率与暴击几率提高 | 防御下降，受到的治疗降低 | damageDealt=1.12 resourceGain=1.15 critChance=0.05 damageTaken=1.08 healingTaken=0.92 |
| 皮甲·守护型护甲 | guardian | 物理防御与爆发承受能力提高 | 移动、攻速与施法速度降低 | damageTaken=0.85 block=0.1 moveSpeed=0.93 attackSpeed=1.08 castSpeed=1.08 |
| 皮甲·机动型护甲 | mobility | 移动与追击能力提高 | 基础防御与击退抵抗降低 | moveSpeed=1.12 damageTaken=1.1 knockbackTaken=1.25 |
| 皮甲·抗法型护甲 | spellWard | 法术伤害与魔法控制时长降低 | 物理防御明显降低 | damageTaken=1.12 damageTakenBySchool={"holy":0.82,"fire":0.82,"frost":0.82,"arcane":0.82,"shadow":0.82,"nature":0.82} ccDurationTakenBySchool={"holy":0.8,"fire":0.8,"frost":0.8,"arcane":0.8,"shadow":0.8,"nature":0.8} |
| 皮甲·抗控型护甲 | tenacity | 控制持续时间与击退距离降低 | 输出、治疗与资源效率降低 | ccDurationTaken=0.75 knockbackTaken=0.6 damageDealt=0.9 healingDone=0.9 resourceGain=0.9 |
