/**
 * 确定性随机（mulberry32）。
 *
 * ## 为什么不用 `Math.random()`
 *
 * 世界生成必须**同种子同世界**：判据（`tools/smoke.mjs`）靠它复现，
 * 玩家也靠它分享"种子 20261012 那张图"。Kotlin 那边用 `kotlin.random.Random(seed)`，
 * 本版用 mulberry32 —— **两者不会给出同一个世界**（算法不同），
 * 这是记录在 README 里的**有意偏离**：端口要的是"同种子可复现"，不是"与 Kotlin 逐格同图"。
 */
export class Rng {
  constructor(seed) {
    // 0 是 mulberry32 的退化种，换成黄金比例常数
    this.state = (Math.abs(Math.trunc(seed)) >>> 0) || 0x9e3779b9;
  }

  /** [0, 1) */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 与 Kotlin `Random.nextFloat()` 同一个语义：[0, 1) */
  nextFloat() {
    return this.next();
  }

  /** 与 Kotlin `Random.nextInt(n)` 同一个语义：[0, n) —— n ≤ 0 时 fail-loud */
  nextInt(n) {
    if (!(n > 0)) throw new Error(`nextInt 需要正上界，收到 ${n}`);
    return Math.floor(this.next() * n);
  }

  /** 闭区间 [lo, hi]（Kotlin 里是 `lo + nextInt(hi - lo + 1)`） */
  range(lo, hi) {
    return lo + this.nextInt(hi - lo + 1);
  }

  pick(arr) {
    if (arr.length === 0) throw new Error('pick 需要非空数组');
    return arr[this.nextInt(arr.length)];
  }
}

/** 字符串种子 → 32 位整数（FNV-1a），支持 `#seed=mygame` 这种可读种子 */
export function seedFromString(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
