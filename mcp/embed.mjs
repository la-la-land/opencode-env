#!/usr/bin/env node
/**
 * embed.mjs — эмбеддинги bge-m3 для RAG-индексов проектов.
 * Для каждого проекта в rag/projects/<name>/index.db заполняет таблицу vecs.
 * Уже обработанные проекты (все чанки с векторами) пропускаются.
 *
 * Требует запущенный llama-server с bge-m3 на :8095:
 *   llama-server -m models/bge-m3-q8_0.gguf --embedding --port 8095 -c 8192
 * (поднимается командой: ./start.sh embed  |  make start)
 *
 * Запуск:
 *   node mcp/embed.mjs                     # все проекты без векторов
 *   node mcp/embed.mjs --project <name>    # только указанный проект
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PROJECTS_DIR = process.env.RAG_PROJECTS_DIR ?? path.join(ROOT, "rag", "projects");
const EMBED_URL = process.env.RAG_EMBED_URL ?? "http://127.0.0.1:8095/v1/embeddings";
const BATCH = 24;

const args = process.argv.slice(2);
let only = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--project") only = args[++i];
  else if (args[i].startsWith("--project=")) only = args[i].split("=")[1];
}

async function embedBatch(inputs) {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: inputs }),
  });
  if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
  const j = await res.json();
  return j.data.map((d) => Float32Array.from(d.embedding));
}

async function embedProject(name, pathToDb) {
  const db = new DatabaseSync(pathToDb);
  const rows = db.prepare("SELECT id,text FROM chunks").all();
  const total = rows.length;
  db.exec("DROP TABLE IF EXISTS vecs");
  db.exec("CREATE TABLE IF NOT EXISTS vecs(id INTEGER PRIMARY KEY, vec BLOB)");
  const ins = db.prepare("INSERT OR REPLACE INTO vecs(id, vec) VALUES(?, ?)");
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    try {
      const vecs = await embedBatch(batch.map((r) => r.text.slice(0, 4000)));
      for (let k = 0; k < batch.length; k++) {
        const buf = Buffer.from(vecs[k].buffer);
        ins.run(batch[k].id, buf);
      }
      done += batch.length;
      console.log(`  ${name}: ${done}/${total}`);
    } catch (e) {
      console.error(`  ${name}: ошибка батча ${i}: ${e.message}`);
      break;
    }
  }
  db.close();
  return done;
}

async function main() {
  let names = [];
  try { names = fs.readdirSync(PROJECTS_DIR).filter((n) => fs.existsSync(path.join(PROJECTS_DIR, n, "index.db"))); }
  catch { /* ничего */ }
  if (only) {
    if (!names.includes(only)) { console.error(`Нет проекта «${only}». Доступны: ${names.join(", ") || "—"}`); process.exit(1); }
    names = [only];
  }
  if (!names.length) { console.error("Индексов нет — сначала: node mcp/build-index.mjs --project /path/to/project"); process.exit(1); }

  for (const name of names) {
    const dbPath = path.join(PROJECTS_DIR, name, "index.db");
    const db = new DatabaseSync(dbPath);
    const total = db.prepare("SELECT COUNT(*) c FROM chunks").get().c;
    let hasVec = 0;
    try { hasVec = db.prepare("SELECT COUNT(*) c FROM vecs").get().c; } catch { /* нет vecs */ }
    db.close();
    if (total > 0 && hasVec >= total) {
      console.log(`  ${name}: уже с эмбеддингами (${hasVec}/${total}) — пропуск`);
      continue;
    }
    console.log(`  ${name}: считаю вектора (${total} чанков)...`);
    await embedProject(name, dbPath);
  }
  console.log("Готово.");
}

main();