"""
DuckDB 桥（**可选**的成熟引擎侧）：把 tables/*.csv 当表、跑 SQL、结果同时给 CSV 与 JSON。

由 `tools/query-sql.mjs` 调用，用途只有一个：**和自研引擎逐格交叉验证**。
它不是页面与交付的依赖 —— 网页是纯静态的（见 `npm run test:browser` 第 21 节），
这里没装 DuckDB 也只是"跳过交叉验证"，不影响任何交付物。

用法：python tools/duck-run.py job.json [结果.json]

⚠️ 结果**写文件**而不是打到 stdout：Windows 上 Python 的 stdout 默认是 cp936，
把中文 `print` 出去会被另一端按 UTF-8 解码成乱码（`冬小麦` → `��С��`）——
这个坑真的踩到了：只含 ASCII 键的查询全部通过，一切换到中文列名就整片不匹配。
所以：**跨进程传中文一律走显式 UTF-8 文件**，stdout 只留 ASCII 摘要。
"""
import csv
import json
import pathlib
import sys

import duckdb


def main():
    job = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
    con = duckdb.connect()
    for v in job['views']:
        # ⚠️ all_varchar=true 是**故意的**：键列必须留文本。
        # 若让 DuckDB 自动推断类型，`09186162` 会变成整数、`09186-P-000001` 会变字符串，
        # 于是"行政区划码"在 SQL 侧悄悄换了形态（前导零没了，这个坑在导出侧踩过一次）。
        # 需要在 SQL 里算数的地方一律显式 CAST(... AS DOUBLE)。
        con.execute(
            f"CREATE VIEW {v['name']} AS "
            f"SELECT * FROM read_csv_auto('{v['file']}', header=true, all_varchar=true)"
        )
    results = []
    for q in job['queries']:
        rel = con.sql(q['sql'])
        cols = [d[0] for d in rel.description]
        rows = rel.fetchall()
        out = pathlib.Path(q['out'])
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open('w', newline='', encoding='utf-8') as f:
            w = csv.writer(f)
            w.writerow(cols)
            w.writerows(rows)
        results.append({'id': q['id'], 'cols': cols, 'rows': [[None if x is None else x for x in r] for r in rows]})
    payload = {'ok': True, 'duckdb': duckdb.__version__, 'results': results}
    if len(sys.argv) > 2:
        # 显式 UTF-8 写文件（不用 print 传中文，见文件头说明）
        pathlib.Path(sys.argv[2]).write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
        print(json.dumps({'ok': True, 'duckdb': duckdb.__version__}))
    else:
        print(json.dumps(payload, ensure_ascii=False))


if __name__ == '__main__':
    main()
