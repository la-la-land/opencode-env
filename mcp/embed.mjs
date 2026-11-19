#!/usr/bin/env node
/**
 * embed.mjs — эмбеддинги для RAG, хранение ВЕКТОРОВ В Qdrant.
 *
 * Для каждого проекта в rag/projects/<name>/index.db (sqlite) лежат чанки
 * и лексика (BM25). Вектора уходят в Qdrant :6333 — коллекция rag_<name>
 * (dim = размерность эмбеддинга, distance Cosine), payload: path/start_line/end_line/lang.
 * Уже залитые проекты (points_count == chunks) пропускаются.
 *
 * Размерность вектора (единый контракт):
 *   RAG_EMBED_DIM  →  EMBED_DIM из stack.config  →  384 (MiniLM по умолчанию)
 *   bge-m3 = 1024 (pooling cls), MiniLM = 384 (pooling mean)
 *
 * Требует запущенные embed-сервер (:8095) и Qdrant (:6333):
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
const BATCH = 64;

// ---------- stack.config (EMBED_DIM / EMBED_MODEL) ----------
function readStackConfig(file) {
  const out = {};
  let text;
  try {
    if (!file || !fs.existsSync(file)) return out;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (!/^["']/.test(val)) val = val.replace(/\s+#.*$/, "").trim();
    if (val.length >= 2 && /^["'].*["']$/.test(val)) val = val.slice(1, -1);
    if (key) out[key] = val;
  }
  return out;
}

const STACK = readStackConfig(process.env.STACK_CONFIG || path.join(ROOT, "stack.config"));

// Размерность: RAG_EMBED_DIM → EMBED_DIM (stack.config) → 384 (MiniLM)
const DECLARED_DIM = (() => {
  const raw = process.env.RAG_EMBED_DIM || STACK.EMBED_DIM || "384";
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 384;
})();
// Модель эмбеддингов: bge-m3 (1024, pooling cls) или minilm (384, pooling mean)
const EMBED_MODEL = (process.env.RAG_EMBED_MODEL || STACK.EMBED_MODEL || "").toLowerCase();
const IS_BGE = EMBED_MODEL.includes("bge");

// Длина текста на чанк: MiniLM-L12-v2 (384-dim, soft-limit ~512 токенов на вход) —
// слишком длинный единичный вход валит весь запрос (embed HTTP 500), поэтому режем символы.
// У bge-m3 (1024) лимит контекста большой (~8k токенов) — режем мягче.
const MAX_CHARS = parseInt(
  process.env.RAG_EMBED_MAX_CHARS || (IS_BGE ? "4000" : "600"),
  10,
);

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

// Размерность уже существующей коллекции (для контроля совпадения с embed-сервером)
function collectionDim(info) {
  const v = info?.config?.params?.vectors;
  if (typeof v?.size === "number") return v.size;
  if (typeof v?.size === "object" && typeof v.size.size === "number") return v.size.size;
  return null;
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

// Проба embed-сервера: узнаём фактическую размерность вектора.
// Если она отличается от объявленной (RAG_EMBED_DIM / EMBED_DIM) — коллекция должна
// быть создана с ФАКТИЧЕСКОЙ размерностью, иначе Qdrant отвергнет векторы.
async function probeDim() {
  try {
    const v = await embedBatch(["dim probe"]);
    return v[0]?.length ?? null;
  } catch {
    return null;
  }
}

async function embedProject(name, dim) {
  const dbPath = path.join(PROJECTS_DIR, name, "index.db");
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT id,path,start_line,end_line,lang,text FROM chunks").all();
  db.close();
  if (!rows.length) { console.log(`  ${name}: пустой индекс — пропуск`); return; }

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
      const vecs = await embedBatch(batch.map((r) => r.text ? r.text.slice(0, MAX_CHARS) : ""));
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

  // Фактическая размерность важнее объявленной: Qdrant отвергает векторы другой длины.
  const probed = await probeDim();
  let dim = DECLARED_DIM;
  if (probed && probed !== DECLARED_DIM) {
    console.warn(
      `⚠ embed-сервер отдаёт ${probed}-мерные векторы, а объявлено ${DECLARED_DIM} ` +
      `(RAG_EMBED_DIM / EMBED_DIM). Использую фактические ${probed} — поправь EMBED_DIM в stack.config.`,
    );
    dim = probed;
  }

  console.log(`Qdrant: ${QDRANT_URL}  |  embed: ${EMBED_URL}  |  dim: ${dim}${probed ? "" : " (не проверена)"}`);
  for (const name of names) {
    const info = await collectionInfo(name);
    const existingDim = collectionDim(info);
    if (existingDim && existingDim !== dim) {
      console.error(
        `  ${name}: коллекция rag_${name} имеет dim ${existingDim}, а embed-сервер даёт ${dim}. ` +
        `Пересоздайте коллекцию: node mcp/embed.mjs --project ${name} --reset`,
      );
      continue;
    }
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
    if (!info) console.log(`  ${name}: коллекции нет — создаю (dim ${dim}) и заливаю (${total} чанков)`);
    else if (info.points_count < total) console.log(`  ${name}: в Qdrant только ${info.points_count}/${total} — перезаливаю`);
    await embedProject(name, dim);
  }
  console.log("Готово.");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
