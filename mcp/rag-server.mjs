#!/usr/bin/env node
/**
 * rag-server.mjs — MCP-сервер RAG по коду (мульти-проектный).
 *
 * Индексы хранятся по проектам: rag/projects/<name>/ (см. build-index.mjs).
 * Чанки и лексика (BM25) — в sqlite index.db; ВЕКТОРА — в Qdrant :6333,
 * коллекция rag_<name> (dim 1024, cosine), заливаются mcp/embed.mjs.
 * Активный проект определяется по рабочей директории (cwd) процесса opencode:
 * выбирается проект, чей путь — самый длинный префикс текущего каталога.
 * Можно явно указать проект в любом инструменте (параметр project).
 *
 * Инструменты:
 *   rag_project()          — активный проект + список всех
 *   rag_search(query,n,semantic,project?)   — гибридный поиск (лексика + BM25 + семантика bge-m3)
 *   rag_where(symbol,n,project?)            — где определён класс/функция/символ
 *   rag_summary(path,project?)              — сводка по файлу/модулю
 *   rag_stats(project?)                     — статистика индекса
 *   kb_read(project?)                       — PROJECT_KNOWLEDGE.md активного проекта
 *   kb_add(fact,project?)                   — дописать факт в базу знаний
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // корень репо opencode-env
const PROJECTS_DIR = process.env.RAG_PROJECTS_DIR ?? path.join(ROOT, "rag", "projects");
const EMBED_URL = process.env.RAG_EMBED_URL ?? "http://127.0.0.1:8095/v1/embeddings";
const QDRANT_URL = (process.env.QDRANT_URL ?? "http://127.0.0.1:6333").replace(/\/+$/, "");

function collectionName(name) { return "rag_" + name; }

// ---------- список проектов ----------
function scanProjects() {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(PROJECTS_DIR); } catch { return out; }
  for (const name of names) {
    const dir = path.join(PROJECTS_DIR, name);
    const pp = path.join(dir, "project.path");
    if (!fs.existsSync(pp)) continue;
    const src = fs.readFileSync(pp, "utf8").trim();
    out.set(name, {
      name,
      src,
      dbPath: path.join(dir, "index.db"),
      kbPath: path.join(dir, "PROJECT_KNOWLEDGE.md"),
    });
  }
  return out;
}

// активный проект по cwd (самый длинный префикс), либо RAG_PROJECT из env
function detectActive(cwd) {
  const projects = scanProjects();
  const envPick = process.env.RAG_PROJECT;
  if (envPick && projects.has(envPick)) return envPick;
  let real;
  try { real = fs.realpathSync(cwd); } catch { real = cwd; }
  let best = null, bestLen = -1;
  for (const [name, p] of projects) {
    let src;
    try { src = fs.realpathSync(p.src); } catch { src = p.src; }
    if (real === src || real.startsWith(src + path.sep)) {
      if (src.length > bestLen) { bestLen = src.length; best = name; }
    }
  }
  return best;
}

// ---------- загрузка индекса проекта в память (кэш) ----------
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const projects = scanProjects();
  const p = projects.get(name);
  if (!p) throw new Error(`Нет проекта «${name}». Проиндексируй: node mcp/build-index.mjs --project /path/to/project`);
  if (!fs.existsSync(p.dbPath)) throw new Error(`Индекс «${name}» не создан — запустите: node mcp/build-index.mjs --project ${p.src}`);
  const db = new DatabaseSync(p.dbPath);
  const rows = db.prepare("SELECT id,path,lang,start_line,end_line,text,tokens FROM chunks").all();
  const idx = {
    name,
    src: p.src,
    kbPath: p.kbPath,
    chunks: rows.map((r) => ({
      id: r.id, path: r.path, lang: r.lang,
      start_line: r.start_line, end_line: r.end_line, text: r.text,
      tokens: (r.tokens || "").split(" ").filter(Boolean),
    })),
    df: new Map(),
  };
  idx.N = idx.chunks.length;
  idx.byId = new Map(idx.chunks.map((c, i) => [c.id, i]));
  for (const c of idx.chunks) {
    const seen = new Set(c.tokens);
    for (const t of seen) idx.df.set(t, (idx.df.get(t) || 0) + 1);
  }
  cache.set(name, idx);
  return idx;
}

// выбрать проект: явный параметр, иначе активный по cwd
function chooseProject(asked) {
  if (asked && typeof asked === "string" && asked.trim()) return asked.trim();
  const active = detectActive(process.cwd());
  if (!active) {
    const names = [...scanProjects().keys()];
    throw new Error(
      "Не удалось определить проект по рабочей директории.\n" +
      (names.length ? `Доступные индексы: ${names.join(", ")}\n` : "Индексов нет. Проиндексируй: node mcp/build-index.mjs --project /path/to/project\n") +
      "Указать явно: передай project в инструменте или задай RAG_PROJECT=<имя>."
    );
  }
  return active;
}

// ---------- поисковая логика ----------
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

function bm25(idx, queryTokens) {
  const { chunks, df, N } = idx;
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

function scoreQuery(idx, query) {
  const qTokens = uniqTokens(query);
  const bm = bm25(idx, qTokens);
  const qSet = new Set(qTokens);
  const out = [];
  for (let i = 0; i < idx.N; i++) {
    const c = idx.chunks[i];
    let score = bm[i];
    const toks = new Set(c.tokens);
    const exact = qTokens.filter((t) => toks.has(t)).length;
    if (exact >= 2) score *= 1 + 0.8 * exact;
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

async function qdrantGet(collection) {
  try {
    const res = await fetch(`${QDRANT_URL}/collections/${collection}`, { method: "GET", signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.result ?? null;
  } catch { return null; }
}

async function qdrantSearch(collection, vector, limit) {
  try {
    const res = await fetch(`${QDRANT_URL}/collections/${collection}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ vector: Array.from(vector), limit, with_payload: false }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.result ?? null;
  } catch { return null; }
}

function snippet(idx, chunk, queryTokens) {
  const lines = chunk.text.split("\n");
  let best = 0, bestHits = -1;
  for (let i = 0; i < lines.length; i++) {
    const hits = uniqTokens(lines[i]).filter((t) => queryTokens.includes(t)).length;
    if (hits > bestHits) { bestHits = hits; best = i; }
  }
  const from = Math.max(0, best - 4), to = Math.min(lines.length, best + 6);
  return lines.slice(from, to).join("\n");
}

// ---------- инструменты ----------
async function search(idx, query, n = 5, withSemantic = true) {
  const { chunks, N } = idx;
  if (!N) return "Индекс пуст — запустите: node mcp/build-index.mjs --project <путь>";
  let ranked = scoreQuery(idx, query);
  ranked.sort((a, b) => b.score - a.score);
  let top = ranked.slice(0, Math.max(20, n * 4));
  if (withSemantic) {
    const qv = await embedQuery(query);
    if (qv) {
      const hits = await qdrantSearch(collectionName(idx.name), qv, Math.max(10, n * 4));
      if (hits) {
        const seed = new Set(top.slice(0, n).map((r) => r.idx));
        for (const h of hits) {
          const i = idx.byId.get(h.id);
          if (i === undefined || seed.has(i)) continue;
          const sim = h.score ?? 0;
          if (sim > 0.5) top.push({ idx: i, score: sim * 3, exact: 0, semantic: sim });
        }
        top.sort((a, b) => b.score - a.score);
      }
    }
  }
  const qTokens = uniqTokens(query);
  const out = [];
  for (const r of top.slice(0, n)) {
    const c = chunks[r.idx];
    out.push(`[${c.path}:${c.start_line}-${c.end_line}]${r.semantic ? ` (sem=${r.semantic.toFixed(2)})` : ""}\n\`\`\`${c.lang}\n${snippet(idx, c, qTokens)}\n\`\`\``);
  }
  return out.join("\n---\n");
}

function where(idx, symbol, n = 5) {
  const toks = tokenize(symbol).map((t) => t.replace(/s$/, ""));
  const hits = [];
  for (const c of idx.chunks) {
    const ct = new Set(c.tokens);
    if (toks.every((t) => ct.has(t))) hits.push(c);
  }
  hits.sort((a, b) => a.path.localeCompare(b.path));
  return hits.slice(0, n).map((c) => `- ${c.path}:${c.start_line}-${c.end_line}`).join("\n") || `Символ "${symbol}" не найден в индексе.`;
}

function summary(idx, targetPath) {
  const rel = targetPath.replace(new RegExp("^" + idx.src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/"), "");
  const hits = idx.chunks.filter((c) => c.path.includes(rel));
  if (!hits.length) return `Нет чанков по пути ${targetPath}.`;
  const total = hits.reduce((s, c) => s + (c.end_line - c.start_line + 1), 0);
  const head = hits[0].text.split("\n").slice(0, 25).join("\n");
  return `Файл: ${hits[0].path}\nСтрок в индексе: ${total} (${hits.length} чанков)\nНачало файла:\n\`\`\`${hits[0].lang}\n${head}\n\`\`\``;
}

async function stats(idx) {
  const langs = {};
  for (const c of idx.chunks) langs[c.lang] = (langs[c.lang] || 0) + 1;
  const info = await qdrantGet(collectionName(idx.name));
  const vecs = info?.points_count ?? info?.vectors_count ?? null;
  const vecLine = vecs === null
    ? "Эмбеддинги: 0 (коллекция не создана — запусти node mcp/embed.mjs; нужны bge-m3 :8095 и Qdrant :6333)"
    : `Эмбеддинги: ${vecs}/${idx.N} чанков (Qdrant: rag_${idx.name})`;
  return `Проект: ${idx.name} (${idx.src})\nИндекс: ${idx.N} чанков (${Object.keys(langs).length} языков)\nЯзыки: ${Object.entries(langs).map(([k, v]) => `${k}=${v}`).join(", ")}\n${vecLine}\nБаза знаний: ${fs.existsSync(idx.kbPath) ? idx.kbPath : "нет"}`;
}

function projectInfo() {
  const projects = scanProjects();
  const active = detectActive(process.cwd());
  const lines = [`Рабочая директория: ${process.cwd()}`];
  lines.push(active ? `Активный проект: ${active} (${projects.get(active)?.src})` : "Активный проект: НЕ ОПРЕДЕЛЁН (нет индекса, покрывающего cwd)");
  if (projects.size) {
    lines.push("Доступные индексы:");
    for (const [name, p] of projects) lines.push(`  - ${name}  (${p.src})`);
  } else {
    lines.push("Индексов нет. Проиндексируй: node mcp/build-index.mjs --project /path/to/project");
  }
  return lines.join("\n");
}

function kbRead(idx) {
  if (!fs.existsSync(idx.kbPath)) return "База знаний ещё не создана — запустите build-index.mjs";
  const t = fs.readFileSync(idx.kbPath, "utf8");
  return t.length > 12000 ? t.slice(0, 12000) + "\n...[обрезано, всего " + t.length + " симв]" : t;
}

function kbAdd(idx, fact) {
  fs.mkdirSync(path.dirname(idx.kbPath), { recursive: true });
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const line = `- [${stamp}] ${String(fact).trim()}`;
  if (fs.existsSync(idx.kbPath)) fs.appendFileSync(idx.kbPath, line + "\n");
  else fs.writeFileSync(idx.kbPath, `# PROJECT_KNOWLEDGE.md\n\n## Факты и решения\n${line}\n`);
  return `Факт добавлен в базу знаний (${idx.name}):\n${line}`;
}

// ---------- MCP (JSON-RPC over stdio) ----------
function jsonrpc(id, result) { return JSON.stringify({ jsonrpc: "2.0", id, result }); }
function jsonrpcError(id, code, message) { return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }); }

const tools = [
  {
    name: "rag_search",
    description: "Семантико-лексический поиск по коду проекта (активного — по рабочей директории, либо указанному project). " +
      "Запрос — фраза как к пользователю («биллинг», «как делается рассылка в Telegram»). Возвращает top-N мест " +
      "с путём, строками и сниппетом. Используй ПЕРВЫМ перед чтением крупных файлов.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Что ищем (рус/англ/идентификаторы)" },
        n: { type: "integer", description: "Сколько результатов, default 5" },
        semantic: { type: "boolean", description: "Включать семантический слой (нужен bge-m3 на :8095), default true" },
        project: { type: "string", description: "Имя проекта (см. rag_project). По умолчанию — активный по cwd" },
      },
      required: ["query"],
    },
  },
  {
    name: "rag_where",
    description: "Точно найти, где определён класс/функция/символ (например OrderController, applyDiscount).",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Имя символа (camelCase/snake_case)" },
        n: { type: "integer", description: "Сколько результатов, default 5" },
        project: { type: "string", description: "Имя проекта (см. rag_project)" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "rag_summary",
    description: "Сводка по конкретному файлу/модулю: первые 25 строк + статистика. Путь — относительный или абсолютный.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Путь к файлу" },
        project: { type: "string", description: "Имя проекта (см. rag_project)" },
      },
      required: ["path"],
    },
  },
  {
    name: "rag_stats",
    description: "Статистика индекса проекта: чанки, языки, эмбеддинги, путь базы знаний.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Имя проекта (см. rag_project)" } },
    },
  },
  {
    name: "rag_project",
    description: "Какой проект активен (по рабочей директории) и какие проекты проиндексированы.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kb_read",
    description: "Прочитать накопительную базу знаний проекта (PROJECT_KNOWLEDGE.md): архитектурные факты, решения, ссылки. " +
      "Вызывай при старте работы и перед незнакомыми задачами.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Имя проекта (см. rag_project)" } },
    },
  },
  {
    name: "kb_add",
    description: "Добавить факт в базу знаний проекта (PROJECT_KNOWLEDGE.md): где что лежит, как устроено, конвенции.",
    inputSchema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "Текст факта" },
        project: { type: "string", description: "Имя проекта (см. rag_project)" },
      },
      required: ["fact"],
    },
  },
];

async function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return jsonrpc(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "rag-server", version: "2.0.0" } });
    case "notifications/initialized":
      return null;
    case "tools/list":
      return jsonrpc(id, { tools });
    case "tools/call": {
      const { name, arguments: args } = params;
      try {
        const a = args || {};
        let text;
        if (name === "rag_project") {
          text = projectInfo();
        } else if (name === "rag_search") {
          const idx = load(chooseProject(a.project));
          text = await search(idx, String(a.query || ""), Math.min(20, a.n || 5), a.semantic !== false);
        } else if (name === "rag_where") {
          const idx = load(chooseProject(a.project));
          text = where(idx, String(a.symbol || ""), a.n || 5);
        } else if (name === "rag_summary") {
          const idx = load(chooseProject(a.project));
          text = summary(idx, String(a.path || ""));
        } else if (name === "rag_stats") {
          const idx = load(chooseProject(a.project));
          text = await stats(idx);
        } else if (name === "kb_read") {
          const idx = load(chooseProject(a.project));
          text = kbRead(idx);
        } else if (name === "kb_add") {
          const idx = load(chooseProject(a.project));
          text = kbAdd(idx, String(a.fact || ""));
        } else {
          return jsonrpcError(id, -32602, `Unknown tool: ${name}`);
        }
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