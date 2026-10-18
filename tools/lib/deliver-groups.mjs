/**
 * 交付分组的**唯一一处**规则：必带 / 按需 / 说明。
 *
 * 为什么要抽出来：`deliver`（写清单）和 `pack`（打交付包）必须用**同一套**分组，
 * 否则会出现"清单里说必带、包里却没有"这种自相矛盾的交付物。规则只写在这里。
 */
import fs from 'node:fs';
import path from 'node:path';

/** `.gitignore` 里显式忽略的 `tables/*.csv` —— "按需"表的判定依据（如 `fact_parcel_daily`） */
export function ignoredTables(root) {
  return new Set(
    fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.trim())
      .filter((l) => l.startsWith('tables/') && l.endsWith('.csv'))
      .map((l) => path.basename(l, '.csv')),
  );
}

/**
 * 三组：
 *   必带 = 被查询读到（运行时追踪）且不是按需表
 *   按需 = `.gitignore` 忽略（可由模型重算/按需导出）
 *   说明 = 其余（词典、元数据、日期维）
 */
export function classify(deps) {
  const ignored = ignoredTables(process.cwd());
  const all = Object.keys(deps.tables);
  const must = all.filter((n) => (deps.tables[n].readBy ?? []).length && !ignored.has(n));
  const optional = all.filter((n) => ignored.has(n));
  const docs = all.filter((n) => !must.includes(n) && !optional.includes(n));
  return { must, optional, docs, all, ignored };
}
