/**
 * 数据集入口：comments.csv → { rows, stats }。
 *
 * 为什么自己写 CSV 解析：评论正文里引号、逗号、换行全都有（实测 545 条正文含换行），
 * 用 split(",") / split("\n") 会把一条评论劈成好几行，后面所有对比都失真。
 * Node 标准库没有 CSV 解析器，所以这里按 RFC4180 写了一个状态机：
 *  - 引号内的逗号、换行、\r 都原样保留；
 *  - "" 还原成一个引号；
 *  - 只有引号出现在字段开头才进入引用态，正文里偶发的裸引号不会带偏整行。
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** 需要转成数字的列。like_count 参与排序/展示，字符串比较会得到 "9" > "10" 这种笑话。 */
const NUMERIC_COLUMNS = new Set(["like_count"]);

/**
 * RFC4180 状态机。返回二维数组（含表头行）。
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; } // 转义引号
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }

    if (ch === '"') {
      if (field.length === 0) { inQuotes = true; i += 1; continue; }
      field += ch; i += 1; continue; // 字段中间出现的裸引号按字面值处理
    }
    if (ch === ",") { row.push(field); field = ""; i += 1; continue; }
    if (ch === "\r") { i += 1; continue; } // 统一按 LF 断行，CRLF 的 \r 丢掉
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i += 1; continue; }
    field += ch; i += 1;
  }

  if (inQuotes) throw new Error("CSV 引号未闭合");

  // 文件末尾没有换行时，最后一格/最后一行也要收进来
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** 统计每个平台各多少条 —— 报告里要说明这 1 万条不是单一平台的偏差样本。 */
function countPlatforms(rows) {
  const counts = new Map();
  for (const r of rows) {
    const key = String(r.platform || "unknown");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([platform, count]) => ({ platform, count }))
    .sort((a, b) => b.count - a.count || a.platform.localeCompare(b.platform));
}

/**
 * @param {string} csvPath
 * @returns {{rows: object[], stats: object}}
 */
export function loadDataset(csvPath) {
  return datasetFromCsv(readFileSync(csvPath, "utf8"), csvPath);
}

export function datasetFromCsv(raw, csvPath = "upload.csv") {
  // Excel 导出的 CSV 常带 BOM；不去掉的话第一列列名会变成 "\ufeffcomment_id"
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const table = parseCsv(text);
  if (table.length === 0) throw new Error(`CSV 为空: ${csvPath}`);

  const header = table[0].map((h) => h.trim());
  for (const required of ["comment_id", "content"]) {
    if (!header.includes(required)) throw new Error(`CSV 缺少必需列 "${required}": ${csvPath}`);
  }

  if (new Set(header).size !== header.length) throw new Error("列名重复");
  const ids = new Set();
  const rows = [];
  let skipped = 0;
  let chars = 0;
  let maxChars = 0;
  let withNewline = 0;

  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    if (cells.length === 1 && cells[0] === "") continue; // 文件末尾的空行

    const item = {};
    for (let c = 0; c < header.length; c++) {
      const column = header[c];
      let value = cells[c] ?? "";
      if (NUMERIC_COLUMNS.has(column)) {
        const num = Number(value);
        value = Number.isFinite(num) ? num : 0;
      }
      item[column] = value;
    }

    item.comment_id = String(item.comment_id ?? "");
    if (!item.comment_id.trim() || !String(item.content).trim()) throw new Error(`第 ${r + 1} 行 ID 或正文为空`);
    if (ids.has(item.comment_id)) throw new Error(`重复 comment_id：${item.comment_id}`);
    ids.add(item.comment_id);

    const content = String(item.content ?? "");
    const length = [...content].length; // 按码点算，emoji/日文不会把长度算爆
    chars += length;
    if (length > maxChars) maxChars = length;
    if (content.includes("\n")) withNewline++;

    rows.push(item);
  }

  if (!rows.length) throw new Error("没有可用评论");
  const platformList = countPlatforms(rows);
  const stats = {
    path: csvPath,
    total: rows.length,
    skipped,
    platforms: Object.fromEntries(platformList.map((p) => [p.platform, p.count])),
    platformList,
    contentChars: {
      avg: rows.length ? Number((chars / rows.length).toFixed(1)) : 0,
      max: maxChars,
    },
    withNewline,
    // 数据集指纹：报告里要能证明两条道跑的是同一批数据
    fingerprint: createHash("sha256").update(raw).digest("hex").slice(0, 16),
    loadedAt: new Date().toISOString(),
  };

  return { rows, stats };
}

export async function datasetFromFile(buffer, name) {
  if (/\.csv$/i.test(name)) return datasetFromCsv(buffer.toString('utf8'), name);
  if (!/\.xlsx$/i.test(name)) throw new Error('支持 .csv 和 .xlsx；旧版 .xls 请另存为 .xlsx');
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  const sheet = book.worksheets[0];
  if (!sheet) throw new Error('Excel 没有工作表');
  const table = [];
  sheet.eachRow(row => {
    table.push(Array.from({ length: Math.max(sheet.columnCount, 2) }, (_, i) => {
      const cell = row.getCell(i + 1);
      if (cell.formula) throw new Error('请把 Excel 公式转换成值后导入');
      return '"' + cell.text.replaceAll('"', '""') + '"';
    }).join(','));
  });
  return datasetFromCsv(table.join('\n'), name);
}
