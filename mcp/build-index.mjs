#!/usr/bin/env node
/**
 * build-index.mjs — строит RAG-индекс кода любого проекта (openai-нейтральный).
 * Чанки кода -> sqlite (rag/index.db) + генерация PROJECT_KNOWLEDGE.md (каркас базы знаний).
 * Эмбеддинги добавляются отдельным проходом: embed.mjs (после запуска bge-m3 :8095).
 *
 * Запуск:
 *   node mcp/build-index.mjs                      # индексировать текущий каталог
 *   RAG_ROOT=/path/to/project node mcp/build-index.mjs
 *   RAG_DB=/x/idx.db RAG_KB=/x/KB.md node mcp/build-index.mjs
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // корень репо opencode-env
const RAG_ROOT = process.env.RAG_ROOT || ".";
const DB_PATH = process.env.RAG_DB ?? path.join(ROOT, "rag", "index.db");
const KB_PATH = process.env.RAG_KB ?? path.join(ROOT, "rag", "PROJECT_KNOWLEDGE.md");

const EXCLUDE_DIRS = new Set([
  "node_modules", "vendor", "dist", "build", ".git", ".idea", "storage",
  ".opencode", ".dsh", "backups", "screenshots", "diag-screens",
  "downloads", "fonts", "images", "img", "assets", "files", "logs",
  "tmp", ".cache", "coverage", ".gpg-keys", "k8s", "docker",
]);
const INCLUDE_EXT = new Set([".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".vue", ".php", ".go", ".rs", ".java", ".rb", ".dart", ".sql", ".sh", ".md"]);
const EXCLUDE_FILES = new Set([
  "composer.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "pubspec.lock", "go.sum", "Cargo.lock",
]);

/** Токенизация для поиска: snake_case + camelCase -> токены, нижний регистр */
export function tokenize(text) {
  const t = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  const tokens = t.split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const seen = new Set();
  const uniq = [];
  for (const w of tokens) {
    const n = w.replace(/s$/, ""); // лёгкий стемминг только для индекса совпадений
    if (!seen.has(n)) { seen.add(n); uniq.push(n); }
  }
  return uniq;
}

function* walkFiles(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      yield* walkFiles(p);
    } else {
      const ext = path.extname(e.name).toLowerCase();
      if (!INCLUDE_EXT.has(ext)) continue;
      if (EXCLUDE_FILES.has(e.name)) continue;
      if (e.name.endsWith(".min.js") || e.name.endsWith(".min.css")) continue;
      yield p;
    }
  }
}

function chunkFile(filePath, relPath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n");
  const lang = path.extname(filePath).toLowerCase().replace(".", "") || "txt";
  const chunkSize = 150, overlap = 15;
  const chunks = [];
  if (lines.length <= chunkSize) {
    chunks.push({ start: 1, end: lines.length, text: lines.join("\n") });
  } else {
    for (let i = 0; i < lines.length; i += chunkSize - overlap) {
      const end = Math.min(lines.length, i + chunkSize);
      chunks.push({ start: i + 1, end, text: lines.slice(i, end).join("\n") });
    }
  }
  return chunks.map((c) => ({
    path: relPath, lang,
    start_line: c.start, end_line: c.end,
    text: c.text,
    tokens: tokenize(c.text + " " + path.basename(relPath)),
  }));
}

/** Каркас базы знаний: AGENTS.md (глубина 2) + дерево каталогов */
function generateKBBase() {
  const lines = [`# PROJECT_KNOWLEDGE.md — накопительная база знаний (${path.basename(path.resolve(RAG_ROOT))})`, ""];
  lines.push("> Авто-часть (структура, статистика) перегенерируется build-index.mjs.");
  lines.push("> Раздел «Факты и решения» пополняется агентом через MCP-инструмент kb_add — не удалять произвольно.", "");
  // AGENTS.md на глубине <= 2
  const found = [];
  const q = [[RAG_ROOT, 0]];
  while (q.length && found.length < 5) {
    const [d, depth] = q.shift();
    if (depth > 2) continue;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!EXCLUDE_DIRS.has(e.name)) q.push([path.join(d, e.name), depth + 1]);
      } else if (e.name === "AGENTS.md") {
        found.push(path.join(d, e.name));
      }
    }
  }
  for (const ag of found.slice(0, 5)) {
    const txt = fs.readFileSync(ag, "utf8").split("\n").slice(0, 40).join("\n");
    lines.push(`## ${path.relative(RAG_ROOT, ag)} (выдержка)`, "```", txt, "```", "");
  }
  // дерево каталогов (2 уровня)
  lines.push("## Структура каталогов", "");
  for (const d of fs.readdirSync(RAG_ROOT, { withFileTypes: true })) {
    if (!d.isDirectory() || EXCLUDE_DIRS.has(d.name)) continue;
    const sub = fs.readdirSync(path.join(RAG_ROOT, d.name), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !EXCLUDE_DIRS.has(e.name))
      .map((e) => e.name);
    lines.push(`- \`${d.name}/\`${sub.length ? " — " + sub.slice(0, 8).join(", ") + (sub.length > 8 ? "…" : "") : ""}`);
  }
  lines.push("", "## Статистика RAG (обновляется индексатором)", "");
  return lines.join("\n");
}

function main() {
  console.log(`Индексирую: ${path.resolve(RAG_ROOT)}`);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS chunks(
    id INTEGER PRIMARY KEY, path TEXT NOT NULL, lang TEXT,
    start_line INT, end_line INT, text TEXT NOT NULL, tokens TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)`);
  db.exec("DELETE FROM chunks");

  const ins = db.prepare("INSERT INTO chunks(path,lang,start_line,end_line,text,tokens) VALUES(?,?,?,?,?,?)");
  let n = 0, files = 0, skipped = 0;
  const byLang = {};
  for (const filePath of walkFiles(RAG_ROOT)) {
    const relPath = path.relative(RAG_ROOT, filePath);
    try {
      const chunks = chunkFile(filePath, relPath);
      for (const c of chunks) {
        ins.run(c.path, c.lang, c.start_line, c.end_line, c.text, c.tokens.join(" "));
        n++;
      }
      files++;
      byLang[chunks[0]?.lang] = (byLang[chunks[0]?.lang] || 0) + 1;
    } catch { skipped++; }
  }
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('chunks',?)").run(String(n));
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('files',?)").run(String(files));
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('built_at',?)").run(new Date().toISOString());

  // база знаний
  const kb = generateKBBase();
  const head = `## Сгенерировано (${new Date().toISOString().slice(0, 16)})\n- Файлов: **${files}** (пропущено: ${skipped})\n- Чанков: **${n}**\n${Object.entries(byLang).filter(([k]) => k).map(([k, v]) => `- ${k}: ${v} файлов`).join("\n")}\n\n## Факты и решения (пополняется агентом через kb_add)\n`;
  let final;
  if (fs.existsSync(KB_PATH)) {
    const cur = fs.readFileSync(KB_PATH, "utf8");
    final = cur.includes("## Сгенерировано") ? cur.replace(/\n## Сгенерировано[\s\S]*?\n## Факты/, "\n" + head + "\n## Факты") : cur + "\n\n" + head;
  } else {
    final = kb + "\n" + head;
  }
  fs.writeFileSync(KB_PATH, final);
  console.log(`OK: проиндексировано ${files} файлов, ${n} чанков. Пропущено ${skipped}. Языки:`, byLang);
  console.log(`DB: ${DB_PATH}\nKB: ${KB_PATH}`);
}

main();