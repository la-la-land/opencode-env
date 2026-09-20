#!/usr/bin/env node
/**
 * build-index.mjs — строит RAG-индекс кода проекта (мульти-проект).
 *
 * Каждый проект индексируется в свой каталог:
 *   rag/projects/<name>/index.db             — чанки кода (sqlite)
 *   rag/projects/<name>/PROJECT_KNOWLEDGE.md — база знаний проекта
 *   rag/projects/<name>/project.path         — абсолютный путь к исходникам
 *
 * Имя проекта: --name, либо (по умолчанию) имя каталога источников.
 * Актуальный проект MCP-сервер определяет по рабочей директории (cwd) —
 * там, где запущен opencode.
 *
 * Запуск:
 *   node mcp/build-index.mjs --project /path/to/project [--name alias]
 *   RAG_ROOT=/path RAG_NAME=alias node mcp/build-index.mjs
 *   node mcp/build-index.mjs --list            # показать проиндексированные проекты
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // корень репо opencode-env
const PROJECTS_DIR = process.env.RAG_PROJECTS_DIR ?? path.join(ROOT, "rag", "projects");

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

// ---------- аргументы ----------
function parseArgs(argv) {
  const args = { project: null, name: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") args.list = true;
    else if (a === "--project") args.project = argv[++i];
    else if (a === "--name") args.name = argv[++i];
    else if (a.startsWith("--project=")) args.project = a.split("=")[1];
    else if (a.startsWith("--name=")) args.name = a.split("=")[1];
  }
  args.project = args.project ?? process.env.RAG_ROOT ?? null;
  args.name = args.name ?? process.env.RAG_NAME ?? null;
  return args;
}

// ---------- утилиты ----------
function listProjects() {
  let names = [];
  try { names = fs.readdirSync(PROJECTS_DIR).filter((n) => fs.existsSync(path.join(PROJECTS_DIR, n, "project.path"))); }
  catch { /* нет каталога */ }
  return names.sort();
}

function tokenize(text) {
  const t = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  const tokens = t.split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const seen = new Set();
  const uniq = [];
  for (const w of tokens) {
    const n = w.replace(/s$/, "");
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

function generateKBBase(srcRoot, name) {
  const lines = [`# PROJECT_KNOWLEDGE.md — накопительная база знаний (${name})`, ""];
  lines.push("> Авто-часть (структура, статистика) перегенерируется build-index.mjs.");
  lines.push("> Раздел «Факты и решения» пополняется агентом через MCP-инструмент kb_add — не удалять произвольно.", "");
  const found = [];
  const q = [[srcRoot, 0]];
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
    lines.push(`## ${path.relative(srcRoot, ag)} (выдержка)`, "```", txt, "```", "");
  }
  lines.push("## Структура каталогов", "");
  for (const d of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    if (!d.isDirectory() || EXCLUDE_DIRS.has(d.name)) continue;
    const sub = fs.readdirSync(path.join(srcRoot, d.name), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !EXCLUDE_DIRS.has(e.name))
      .map((e) => e.name);
    lines.push(`- \`${d.name}/\`${sub.length ? " — " + sub.slice(0, 8).join(", ") + (sub.length > 8 ? "…" : "") : ""}`);
  }
  lines.push("", "## Статистика RAG (обновляется индексатором)", "");
  return lines.join("\n");
}

// ---------- main ----------
function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    const names = listProjects();
    if (!names.length) { console.log("Индексов нет. Создай: node mcp/build-index.mjs --project /path/to/project"); return; }
    console.log("Проиндексированные проекты:");
    for (const n of names) {
      const p = fs.readFileSync(path.join(PROJECTS_DIR, n, "project.path"), "utf8").trim();
      console.log(`  - ${n}  (${p})`);
    }
    return;
  }

  if (!args.project) {
    console.error("Укажи проект: node mcp/build-index.mjs --project /path/to/project [--name alias]");
    console.error("  или RAG_ROOT=/path node mcp/build-index.mjs");
    process.exit(1);
  }
  const srcRoot = path.resolve(args.project);
  if (!fs.existsSync(srcRoot) || !fs.statSync(srcRoot).isDirectory()) {
    console.error(`Нет такого каталога: ${srcRoot}`);
    process.exit(1);
  }

  const name = args.name || path.basename(srcRoot);
  const projDir = path.join(PROJECTS_DIR, name);
  // конфликт имён: другой путь с тем же именем
  const pp = path.join(projDir, "project.path");
  if (fs.existsSync(pp)) {
    const prev = fs.readFileSync(pp, "utf8").trim();
    if (prev !== srcRoot) {
      console.error(`Имя «${name}» уже занято проектом: ${prev}\n  Укажи другое: --name alias`);
      process.exit(1);
    }
  }
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(pp, srcRoot + "\n");

  const DB_PATH = path.join(projDir, "index.db");
  const KB_PATH = path.join(projDir, "PROJECT_KNOWLEDGE.md");
  console.log(`Индексирую: ${srcRoot}  →  ${name}`);

  const db = new DatabaseSync(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS chunks(
    id INTEGER PRIMARY KEY, path TEXT NOT NULL, lang TEXT,
    start_line INT, end_line INT, text TEXT NOT NULL, tokens TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)`);
  db.exec("DELETE FROM chunks");

  const ins = db.prepare("INSERT INTO chunks(path,lang,start_line,end_line,text,tokens) VALUES(?,?,?,?,?,?)");
  let n = 0, files = 0, skipped = 0;
  const byLang = {};
  for (const filePath of walkFiles(srcRoot)) {
    const relPath = path.relative(srcRoot, filePath);
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

  const kb = generateKBBase(srcRoot, name);
  const head = `## Сгенерировано (${new Date().toISOString().slice(0, 16)})\n- Файлов: **${files}** (пропущено: ${skipped})\n- Чанков: **${n}**\n${Object.entries(byLang).filter(([k]) => k).map(([k, v]) => `- ${k}: ${v} файлов`).join("\n")}\n\n## Факты и решения (пополняется агентом через kb_add)\n`;
  let final;
  if (fs.existsSync(KB_PATH)) {
    const cur = fs.readFileSync(KB_PATH, "utf8");
    final = cur.includes("## Сгенерировано") ? cur.replace(/\n## Сгенерировано[\s\S]*?\n## Факты/, "\n" + head + "\n## Факты") : cur + "\n\n" + head;
  } else {
    final = kb + "\n" + head;
  }
  fs.writeFileSync(KB_PATH, final);
  console.log(`OK: ${files} файлов, ${n} чанков (пропущено ${skipped}). Языки:`, byLang);
  console.log(`  ${DB_PATH}\n  ${KB_PATH}`);
}

main();