#!/usr/bin/env node
/**
 * embed.mjs — эмбеддинги bge-m3 для RAG, хранение ВЕКТОРОВ В Qdrant.
 *
 * Для каждого проекта в rag/projects/<name>/index.db (sqlite) лежат чанки
 * и лексика (BM25). Вектора уходят в Qdrant :6333 — коллекция rag_<name>
 * (dim 1024, distance Cosine), payload: path/start_line/end_line/lang.
 * Уже залитые проекты (points_count == chunks) пропускаются.
 *
 * Требует запущенные bge-m3 (:8095) и Qdrant (:6333):
 *   make infra   (./start.sh infra — embed + qdrant)
 *
 * Запуск:
 *   node mcp/embed.mjs                   # все проекты без векторов
 *   node mcp/embed.mjs --project <name>  # только указанный проект
 *   node mcp/embed.mjs --project <name> --reset   # пересоздать коллекцию
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PROJECTS_DIR = process.env.RAG_PROJECTS_DIR ?? path.join(ROOT, "rag", "projects");
const EMBED_URL = process.env.RAG_EMBED_URL ?? "http://127.0.0.1:8095/v1/embeddings";
const QDRANT_URL = (process.env.QDRANT_URL ?? "http://127.0.0.1:6333").replace(/\/+$/, "");
const DEFAULT_DIM = parseInt(process.env.RAG_EMBED_DIM || "1024", 10);
const BATCH = 64;

const args = process.argv.slice(2);
let only = null, reset = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--project") only = args[++i];
  else if (args[i].startsWith("--project=")) only = args[i].split("=")[1];
  else if (args[i] === "--reset") reset = true;
}

function collectionName(name) { return "rag_" + name; }

// ---------- Qdrant REST ----------
async function qdrant(method, p, body) {
  const res = await fetch(QDRANT_URL + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404) return null;
  const j = await res.json().catch(() => ({}));
  if (!res.ok && !(j?.status?.error || "").includes("already exists")) {
    throw new Error(`qdrant ${res.status} ${method} ${p}: ${j?.status?.error ?? res.statusText}`);
  }
  return j;
}

async function ensureCollection(name, dim) {
  await qdrant("PUT", `/collections/${collectionName(name)}`, {
    vectors: { size: dim, distance: "Cosine" },
  });
}

async function collectionInfo(name) {
  const j = await qdrant("GET", `/collections/${collectionName(name)}`);
  return j?.result ?? null;
}

async function upsertPoints(name, points) {
  await qdrant("PUT", `/collections/${collectionName(name)}/points`, {
    points: points.map((p) => ({
      id: p.id,
      vector: Array.from(p.vector),
      payload: { path: p.path, start_line: p.start_line, end_line: p.end_line, lang: p.lang },
    })),
  });
}

async function deleteCollection(name) {
  const j = await qdrant("DELETE", `/collections/${collectionName(name)}`);
  return j !== null;
}

// ---------- эмбеддинги ----------
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

async function embedProject(name) {
  const dbPath = path.join(PROJECTS_DIR, name, "index.db");
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT id,path,start_line,end_line,lang,text FROM chunks").all();
  db.close();
  if (!rows.length) { console.log(`  ${name}: пустой индекс — пропуск`); return; }

  const dim = DEFAULT_DIM;
  if (reset) {
    const removed = await deleteCollection(name);
    console.log(`  ${name}: коллекция удалена (reset)${removed ? "" : " — её не было"}`);
  }
  await ensureCollection(name, dim);

  const total = rows.length;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    try {
      const vecs = await embedBatch(batch.map((r) => r.text ? r.text.slice(0, 4000) : ""));
      const points = batch.map((r, k) => ({ id: r.id, path: r.path, start_line: r.start_line, end_line: r.end_line, lang: r.lang, vector: vecs[k] }));
      await upsertPoints(name, points);
      done += batch.length;
      console.log(`  ${name}: ${done}/${total} в Qdrant`);
    } catch (e) {
      console.error(`  ${name}: ошибка батча ${i}: ${e.message}`);
      return done;
    }
  }
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

  console.log(`Qdrant: ${QDRANT_URL}  |  embed: ${EMBED_URL}`);
  for (const name of names) {
    const info = await collectionInfo(name);
    const total = (() => {
      const db = new DatabaseSync(path.join(PROJECTS_DIR, name, "index.db"));
      const n = db.prepare("SELECT COUNT(*) c FROM chunks").get().c;
      db.close();
      return n;
    })();
    if (!reset && info && info.points_count >= total) {
      console.log(`  ${name}: уже в Qdrant (${info.points_count}/${total}) — пропуск`);
      continue;
    }
    if (!info) console.log(`  ${name}: коллекции нет — создаю и заливаю (${total} чанков)`);
    else if (info.points_count < total) console.log(`  ${name}: в Qdrant только ${info.points_count}/${total} — перезаливаю`);
    await embedProject(name);
  }
  console.log("Готово.");
}

main().catch((e) => { console.error(e.message); process.exit(1); });