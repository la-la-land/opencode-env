#!/usr/bin/env node
/**
 * notix-rag.mjs — MCP-сервер RAG по коду notix (stdio, JSON-RPC, стиль qwen-image.mjs).
 * Инструменты:
 *   notix_search(query, n)        — гибридный поиск (лексика + точные символы + семантика если embed доступен)
 *   notix_where(symbol, n)        — где определён класс/функция/символ
 *   notix_summary(path)           — сводка по файлу/модулю
 *   notix_stats()                 — статистика индекса
 *   notix_kb_read()               — содержимое PROJECT_KNOWLEDGE.md
 *   notix_kb_add(fact)            — дописать факт в PROJECT_KNOWLEDGE.md
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // корень репо opencode-env
const DB_PATH = process.env.RAG_DB ?? path.join(ROOT, "rag", "notix.db");
const KB_PATH = process.env.RAG_KB ?? path.join(ROOT, "rag", "PROJECT_KNOWLEDGE.md");
const PROJECT_ROOT = process.env.RAG_ROOT ?? ".";
const EMBED_URL = process.env.RAG_EMBED_URL ?? "http://127.0.0.1:8095/v1/embeddings";
const EMBED_DIM = 1024; // bge-m3 dense

let db = null;
let chunks = [];      // {id,path,lang,start_line,end_line,text,tokens[],vec<Float32Array|null>}
let df = new Map();   // token -> документная частота (для BM25)
let N = 0;

function tokenize(text) {
  const t = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  return t.split(/[^a-z0-9]+/).filter((w) => w.length > 1);
}
function uniqTokens(text) {
  const seen = new Set();
  for (const w of tokenize(text)) if (!seen.has(w)) seen.add(w);
  return [...seen];
}

function load() {
  if (db) return;
  try {
    db = new DatabaseSync(DB_PATH);
    const rows = db.prepare("SELECT id,path,lang,start_line,end_line,text,tokens FROM chunks").all();
    chunks = rows.map((r) => ({
      id: r.id, path: r.path, lang: r.lang,
      start_line: r.start_line, end_line: r.end_line, text: r.text,
      tokens: (r.tokens || "").split(" ").filter(Boolean),
      vec: null,
    }));
    N = chunks.length;
    try {
      const vrows = db.prepare("SELECT id,vec FROM vecs").all();
      const vmap = new Map(vrows.map((v) => [v.id, new Float32Array(v.vec.buffer.slice(v.vec.byteOffset, v.vec.byteOffset + v.vec.byteLength))]));
      for (const c of chunks) c.vec = vmap.get(c.id) || null;
    } catch { /* vecs ещё нет — лексика */ }
    // документные частоты
    df = new Map();
    for (const c of chunks) {
      const seen = new Set(c.tokens);
      for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }
  } catch (e) {
    throw new Error(`DB not ready (${DB_PATH}): ${e.message}. Запустите: node build-index.mjs`);
  }
}

function bm25(queryTokens) {
  const k1 = 1.5, b = 0.75;
  const avgdl = N > 0 ? chunks.reduce((s, c) => s + c.tokens.length, 0) / N : 1;
  const scores = new Float32Array(N);
  for (const qt of new Set(queryTokens)) {
    const idf = Math.log(1 + (N - (df.get(qt) || 0) + 0.5) / ((df.get(qt) || 0) + 0.5));
    for (let i = 0; i < N; i++) {
      const c = chunks[i];
      let tf = 0;
      for (const t of c.tokens) if (t === qt) tf++;
      if (tf === 0) continue;
      const dl = c.tokens.length;
      scores[i] += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl));
    }
  }
  return scores;
}

function scoreQuery(query) {
  const qTokens = uniqTokens(query);
  const bm = bm25(qTokens);
  const qSet = new Set(qTokens);
  const out = [];
  for (let i = 0; i < N; i++) {
    const c = chunks[i];
    let score = bm[i];
    // точное совпадение символов — сильный буст
    const toks = new Set(c.tokens);
    const exact = qTokens.filter((t) => toks.has(t)).length;
    if (exact >= 2) score *= 1 + 0.8 * exact;
    // совпадение в имени файла
    const fname = tokenize(path.basename(c.path));
    const fnHit = fname.filter((t) => qSet.has(t)).length;
    if (fnHit > 0) score *= 1 + 0.5 * fnHit;
    out.push({ idx: i, score, exact });
  }
  return out;
}

async function embedQuery(query) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: query }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json();
    const v = j?.data?.[0]?.embedding;
    return v ? Float32Array.from(v) : null;
  } catch { return null; }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function snippet(chunk, queryTokens) {
  const lines = chunk.text.split("\n");
  let best = 0, bestHits = -1;
  for (let i = 0; i < lines.length; i++) {
    const hits = uniqTokens(lines[i]).filter((t) => queryTokens.includes(t)).length;
    if (hits > bestHits) { bestHits = hits; best = i; }
  }
  const from = Math.max(0, best - 4), to = Math.min(lines.length, best + 6);
  return lines.slice(from, to).join("\n");
}

async function search(query, n = 5, withSemantic = true) {
  load();
  if (!N) return "Индекс пуст — запустите node build-index.mjs";
  let ranked = scoreQuery(query);
  ranked.sort((a, b) => b.score - a.score);
  let top = ranked.slice(0, Math.max(20, n * 4));
  if (withSemantic) {
    const qv = await embedQuery(query);
    if (qv) {
      const seed = new Set(top.slice(0, n).map((r) => r.idx));
      for (let i = 0; i < N; i++) {
        const c = chunks[i];
        if (c.vec && !seed.has(i)) {
          const sim = cosine(qv, c.vec);
          if (sim > 0.5) top.push({ idx: i, score: sim * 3, exact: 0, semantic: sim });
        }
      }
      top.sort((a, b) => b.score - a.score);
    }
  }
  const qTokens = uniqTokens(query);
  const out = [];
  for (const r of top.slice(0, n)) {
    const c = chunks[r.idx];
    out.push(`[${c.path}:${c.start_line}-${c.end_line}]${r.semantic ? ` (sem=${r.semantic.toFixed(2)})` : ""}\n\`\`\`${c.lang}\n${snippet(c, qTokens)}\n\`\`\``);
  }
  return out.join("\n---\n");
}

async function where(symbol, n = 5) {
  load();
  const toks = tokenize(symbol).map((t) => t.replace(/s$/, ""));
  const hits = [];
  for (let i = 0; i < N; i++) {
    const c = chunks[i];
    const ct = new Set(c.tokens);
    if (toks.every((t) => ct.has(t))) hits.push(c);
  }
  hits.sort((a, b) => a.path.localeCompare(b.path));
  return hits.slice(0, n).map((c) => `- ${c.path}:${c.start_line}-${c.end_line}`).join("\n") || `Символ "${symbol}" не найден в индексе.`;
}

function summary(targetPath) {
  load();
  const rel = targetPath.replace(new RegExp("^" + PROJECT_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/"), "");
  const hits = chunks.filter((c) => c.path.includes(rel));
  if (!hits.length) return `Нет чанков по пути ${targetPath}.`;
  const total = hits.reduce((s, c) => s + (c.end_line - c.start_line + 1), 0);
  const head = hits[0].text.split("\n").slice(0, 25).join("\n");
  return `Файл: ${hits[0].path}\nСтрок в индексе: ${total} (${hits.length} чанков)\nНачало файла:\n\`\`\`${hits[0].lang}\n${head}\n\`\`\``;
}

function stats() {
  load();
  const langs = {};
  for (const c of chunks) langs[c.lang] = (langs[c.lang] || 0) + 1;
  const hasVec = chunks.filter((c) => c.vec).length;
  return `Индекс RAG: ${N} чанков (${Object.keys(langs).length} языков)\nЯзыки: ${Object.entries(langs).map(([k, v]) => `${k}=${v}`).join(", ")}\nЭмбеддинги: ${hasVec}/${N} чанков\nБаза знаний: ${fs.existsSync(KB_PATH) ? KB_PATH : "нет"}`;
}

function kbRead() {
  load();
  if (!fs.existsSync(KB_PATH)) return "База знаний ещё не создана — запустите build-index.mjs";
  const t = fs.readFileSync(KB_PATH, "utf8");
  return t.length > 12000 ? t.slice(0, 12000) + "\n...[обрезано, всего " + t.length + " симв]" : t;
}

function kbAdd(fact) {
  load();
  fs.mkdirSync(path.dirname(KB_PATH), { recursive: true });
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const line = `- [${stamp}] ${String(fact).trim()}`;
  if (fs.existsSync(KB_PATH)) fs.appendFileSync(KB_PATH, line + "\n");
  else fs.writeFileSync(KB_PATH, `# PROJECT_KNOWLEDGE.md\n\n## Факты и решения\n${line}\n`);
  return `Факт добавлен в базу знаний (${KB_PATH}):\n${line}`;
}

// ---------- MCP (JSON-RPC over stdio) ----------
function jsonrpc(id, result) { return JSON.stringify({ jsonrpc: "2.0", id, result }); }
function jsonrpcError(id, code, message) { return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }); }

const tools = [
  {
    name: "notix_search",
    description: "Семантико-лексический поиск по коду проекта notix (Laravel/PHP, Flutter/Dart, JS/TS, SQL). " +
      "Запрос — фраза как к пользователю («биллинг», «как делается рассылка в Telegram»). Возвращает top-N " +
      "мест с путём, строками и сниппетом кода. Используй ПЕРВЫМ перед чтением крупных файлов.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Что ищем (рус/англ/идентификаторы)" },
        n: { type: "integer", description: "Сколько результатов, default 5" },
        semantic: { type: "boolean", description: "Включать семантический слой (нужен bge-m3 на :8095), default true" },
      },
      required: ["query"],
    },
  },
  {
    name: "notix_where",
    description: "Точно найти, где определён класс/функция/символ в notix (например OrderController, applyDiscount).",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Имя символа (camelCase/snake_case)" },
        n: { type: "integer", description: "Сколько результатов, default 5" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "notix_summary",
    description: "Сводка по конкретному файлу/модулю notix: первые 25 строк + статистика. Путь — относительный или абсолютный.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Путь к файлу в notix" } },
      required: ["path"],
    },
  },
  {
    name: "notix_stats",
    description: "Статистика индекса RAG: число чанков, языки, готовность эмбеддингов, путь базы знаний.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "notix_kb_read",
    description: "Прочитать накопительную базу знаний проекта (PROJECT_KNOWLEDGE.md): архитектурные факты, решения, ссылки. " +
      "Вызывай при старте работы в notix и перед незнакомыми задачами, чтобы не перечитывать проект заново.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "notix_kb_add",
    description: "Добавить факт в базу знаний проекта (PROJECT_KNOWLEDGE.md). Используй после изучения крупного модуля, " +
      "важного решения, найденной закономерности — чтобы следующая сессия не искала заново.",
    inputSchema: {
      type: "object",
      properties: { fact: { type: "string", description: "Текст факта: где что лежит, как устроено, какие конвенции" } },
      required: ["fact"],
    },
  },
];

async function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return jsonrpc(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "notix-rag", version: "1.0.0" } });
    case "notifications/initialized":
      return null;
    case "tools/list":
      return jsonrpc(id, { tools });
    case "tools/call": {
      const { name, arguments: args } = params;
      try {
        const a = args || {};
        let text;
        if (name === "notix_search") text = await search(String(a.query || ""), Math.min(20, a.n || 5), a.semantic !== false);
        else if (name === "notix_where") text = await where(String(a.symbol || ""), a.n || 5);
        else if (name === "notix_summary") text = summary(String(a.path || ""));
        else if (name === "notix_stats") text = stats();
        else if (name === "notix_kb_read") text = kbRead();
        else if (name === "notix_kb_add") text = kbAdd(String(a.fact || ""));
        else return jsonrpcError(id, -32602, `Unknown tool: ${name}`);
        return jsonrpc(id, { content: [{ type: "text", text }] });
      } catch (e) {
        return jsonrpc(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      if (id !== undefined) return jsonrpcError(id, -32601, `Method not found: ${method}`);
      return null;
  }
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      handleRequest(msg).then((response) => { if (response) process.stdout.write(response + "\n"); });
    } catch { /* skip */ }
  }
});