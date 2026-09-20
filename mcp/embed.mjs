#!/usr/bin/env node
/**
 * embed.mjs — эмбеддинг-проход: считает bge-m3 вектора для всех чанков и кладёт в index.db (таблица vecs).
 * Требует запущенный llama-server с моделью bge-m3 на :8095:
 *   llama-server -m models/bge-m3-q8_0.gguf --embedding --port 8095 -c 8192
 * Запуск: node embed.mjs
 */
import { DatabaseSync } from "node:sqlite";

import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // корень репо opencode-env
const DB_PATH = process.env.RAG_DB ?? path.join(ROOT, "rag", "index.db");
const EMBED_URL = "http://127.0.0.1:8095/v1/embeddings";
const BATCH = 24;

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

async function main() {
  const db = new DatabaseSync(DB_PATH);
  db.exec("CREATE TABLE IF NOT EXISTS vecs(id INTEGER PRIMARY KEY, vec BLOB)");
  const rows = db.prepare("SELECT id,text FROM chunks WHERE id NOT IN (SELECT id FROM vecs)").all();
  console.log(`Чанков без векторов: ${rows.length}`);
  if (!rows.length) { console.log("Всё уже эмбеддировано."); return; }
  const ins = db.prepare("INSERT OR REPLACE INTO vecs(id,vec) VALUES(?,?)");
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    let vecs;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { vecs = await embedBatch(batch.map((r) => r.text.slice(0, 4000))); break; }
      catch (e) { if (attempt === 4) throw e; await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
    }
    for (let k = 0; k < batch.length; k++) ins.run(batch[k].id, Buffer.from(vecs[k].buffer));
    done += batch.length;
    if (done % 240 === 0 || done === rows.length) console.log(`  ${done}/${rows.length}`);
  }
  console.log("OK: вектора записаны.");
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });