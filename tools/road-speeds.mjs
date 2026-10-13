/**
 * 路网通行参数：**唯一来源**。
 *
 * ## 为什么要单独一个文件
 * `build-access.mjs`（算现状可达性）与 `scenario.mjs`（算"新建一个收储点会怎样"）必须用**同一套**
 * 速度与接驳参数 —— 否则两者算出来的时间差不是"新建带来的改善"，而是"两套算法的差"。
 * 我第一版就是在 scenario 里**手抄了一份速度表**（还抄错了：motorway 写成 100 而非 80），
 * 复算现状时与 `access.json` 差了 **2.33 分钟**。参数一旦有两个副本，这种错迟早会发生，
 * 所以抽成一个模块 import 两边用。
 */

/** 通行速度（km/h）。田间道给得很低：这是"农机下道"的真实处境 */
export const SPEED = {
  motorway: 80, trunk: 70, primary: 60, secondary: 50, tertiary: 40,
  unclassified: 25, residential: 25, track: 12,
};

/** 地块质心 → 路网节点的接驳速度（km/h，机耕） */
export const OFFROAD = 10;

/** 哪些设施算"收储点"（可达性的目的地） */
export const SOURCE_KINDS = new Set(['silo', 'barn', 'agrarian', 'marketplace']);

/** 路网建图参数：节点吸附容差（m）与哈希格边长（度） */
export const SNAP_M = 15;
export const CELL = 0.0002;
