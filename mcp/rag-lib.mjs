#!/usr/bin/env node
/**
 * rag-lib.mjs — общее ядро RAG (используют rag-server.mjs и rag-cli.mjs).
 * Чанки и лексика (BM25) — sqlite rag/projects/<name>/index.db;
 * вектора — Qdrant :6333 (коллекция rag_<name>, dim 1024, cosine).
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, ".."); // корень репо opencode-env
export const PROJECTS_DIR = process.env.RAG_PROJECTS_DIR ?? path.join(ROOT, "rag", "projects");
export const EMBED_URL = process.env.RAG_EMBED_URL ?? "http://127.0.0.1:8095/v1/embeddings";
export const QDRANT_URL = (process.env.QDRANT_URL ?? "http://127.0.0.1:6333").replace(/\/+$/, "");

export function collectionName(name) { return "rag_" + name; }

// ---------- список проектов ----------
export function scanProjects() {
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
export function detectActive(cwd) {
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
export function load(name) {
  if (cache.has(name)) return cache.get(name);
  const projects = scanProjects();
  const p = projects.get(name);
  if (!p) throw new Error(`Нет проекта «${name}». Проиндексируй: rag index (или node mcp/build-index.mjs --project /path/to/project)`);
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

// выбор проекта: явный параметр, иначе активный по каталогу вызова
// (CLI передаёт RAG_CWD; MCP-сервер — cwd процесса opencode)
export function activeProjectDir(cwd) {
  return cwd ?? process.env.RAG_CWD ?? process.cwd();
}

export function chooseProject(asked) {
  if (asked && typeof asked === "string" && asked.trim()) return asked.trim();
  const active = detectActive(activeProjectDir());
  if (!active) {
    const names = [...scanProjects().keys()];
    throw new Error(
      "Не удалось определить проект по рабочей директории.\n" +
      (names.length ? `Доступные индексы: ${names.join(", ")}\n` : "Индексов нет. Проиндексируй: rag index\n") +
      "Указать явно: передай project или задай RAG_PROJECT=<имя>."
    );
  }
  return active;
}

// ---------- поисковая логика ----------
export function tokenize(text) {
  const t = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  return t.split(/[^a-z0-9]+/).filter((w) => w.length > 1);
}
export function uniqTokens(text) {
  const seen = new Set();
  for (const w of tokenize(text)) if (!seen.has(w)) seen.add(w);
  return [...seen];
}

export function bm25(idx, queryTokens) {
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

export function scoreQuery(idx, query) {
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

export async function embedQuery(query) {
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

export async function qdrantGet(collection) {
  try {
    const res = await fetch(`${QDRANT_URL}/collections/${collection}`, { method: "GET", signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.result ?? null;
  } catch { return null; }
}

export async function qdrantSearch(collection, vector, limit) {
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

export function snippet(idx, chunk, queryTokens) {
  const lines = chunk.text.split("\n");
  let best = 0, bestHits = -1;
  for (let i = 0; i < lines.length; i++) {
    const hits = uniqTokens(lines[i]).filter((t) => queryTokens.includes(t)).length;
    if (hits > bestHits) { bestHits = hits; best = i; }
  }
  const from = Math.max(0, best - 4), to = Math.min(lines.length, best + 6);
  return lines.slice(from, to).join("\n");
}

// ---------- поиск: структурированные результаты ----------
export async function searchStructured(idx, query, n = 5, withSemantic = true) {
  const { chunks, N } = idx;
  if (!N) return [];
  let ranked = scoreQuery(idx, query);
  ranked.sort((a, b) => b.score - a.score);
  // Лексика: только реально релевантное (score > 0). При русскоязычном
  // запросе BM25 часто даёт 0 всем (токенизация без стемминга) — тогда
  // топ строится целиком из семантики, иначе бесполезные 0-строки
  // вытесняли бы семантические попадания.
  const top = ranked.filter((r) => r.score > 0).slice(0, Math.max(20, n * 4));
  if (withSemantic) {
    const qv = await embedQuery(query);
    if (qv) {
      const hits = await qdrantSearch(collectionName(idx.name), qv, Math.max(10, n * 4));
      if (hits) {
        const inTop = new Set(top.map((r) => r.idx));
        for (const h of hits) {
          const i = idx.byId.get(h.id);
          if (i === undefined || inTop.has(i)) continue;
          const sim = h.score ?? 0;
          if (sim > 0.5) top.push({ idx: i, score: sim * 3, exact: 0, semantic: sim });
        }
        top.sort((a, b) => b.score - a.score);
      }
    }
  }
  const qTokens = uniqTokens(query);
  return top.slice(0, n).map((r) => {
    const c = chunks[r.idx];
    return {
      path: c.path, start_line: c.start_line, end_line: c.end_line, lang: c.lang,
      score: r.score, semantic: r.semantic ?? null, snippet: snippet(idx, c, qTokens),
    };
  });
}

// формат для MCP-сервера (текст со сниппетами)
export async function search(idx, query, n = 5, withSemantic = true) {
  const results = await searchStructured(idx, query, n, withSemantic);
  if (!results.length) return "Индекс пуст — запустите: rag index (node mcp/build-index.mjs --project <путь>)";
  return results.map((r) =>
    `[${r.path}:${r.start_line}-${r.end_line}]${r.semantic ? ` (sem=${r.semantic.toFixed(2)})` : ""}\n\`\`\`${r.lang}\n${r.snippet}\n\`\`\``
  ).join("\n---\n");
}

// ---------- остальные инструменты ----------
export function where(idx, symbol, n = 5) {
  const toks = tokenize(symbol).map((t) => t.replace(/s$/, ""));
  const hits = [];
  for (const c of idx.chunks) {
    const ct = new Set(c.tokens);
    if (toks.every((t) => ct.has(t))) hits.push(c);
  }
  hits.sort((a, b) => a.path.localeCompare(b.path));
  return hits.slice(0, n).map((c) => `- ${c.path}:${c.start_line}-${c.end_line}`).join("\n") || `Символ "${symbol}" не найден в индексе.`;
}

export function summary(idx, targetPath) {
  const rel = targetPath.replace(new RegExp("^" + idx.src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/"), "");
  const hits = idx.chunks.filter((c) => c.path.includes(rel));
  if (!hits.length) return `Нет чанков по пути ${targetPath}.`;
  const total = hits.reduce((s, c) => s + (c.end_line - c.start_line + 1), 0);
  const head = hits[0].text.split("\n").slice(0, 25).join("\n");
  return `Файл: ${hits[0].path}\nСтрок в индексе: ${total} (${hits.length} чанков)\nНачало файла:\n\`\`\`${hits[0].lang}\n${head}\n\`\`\``;
}

export async function stats(idx) {
  const langs = {};
  for (const c of idx.chunks) langs[c.lang] = (langs[c.lang] || 0) + 1;
  const info = await qdrantGet(collectionName(idx.name));
  const vecs = info?.points_count ?? info?.vectors_count ?? null;
  const vecLine = vecs === null
    ? "Эмбеддинги: 0 (коллекция не создана — запусти rag index; нужны bge-m3 :8095 и Qdrant :6333)"
    : `Эмбеддинги: ${vecs}/${idx.N} чанков (Qdrant: rag_${idx.name})`;
  return `Проект: ${idx.name} (${idx.src})\nИндекс: ${idx.N} чанков (${Object.keys(langs).length} языков)\nЯзыки: ${Object.entries(langs).map(([k, v]) => `${k}=${v}`).join(", ")}\n${vecLine}\nБаза знаний: ${fs.existsSync(idx.kbPath) ? idx.kbPath : "нет"}`;
}

export function projectInfo(cwd) {
  const activeDir = cwd ?? process.env.RAG_CWD ?? process.cwd();
  const projects = scanProjects();
  const active = detectActive(activeDir);
  const lines = [`Рабочая директория: ${activeDir}`];
  lines.push(active ? `Активный проект: ${active} (${projects.get(active)?.src})` : "Активный проект: НЕ ОПРЕДЕЛЁН (нет индекса, покрывающего cwd)");
  if (projects.size) {
    lines.push("Доступные индексы:");
    for (const [name, p] of projects) lines.push(`  - ${name}  (${p.src})`);
  } else {
    lines.push("Индексов нет. Проиндексируй: rag index");
  }
  return lines.join("\n");
}

export function kbRead(idx) {
  if (!fs.existsSync(idx.kbPath)) return "База знаний ещё не создана — запустите build-index.mjs";
  const t = fs.readFileSync(idx.kbPath, "utf8");
  return t.length > 12000 ? t.slice(0, 12000) + "\n...[обрезано, всего " + t.length + " симв]" : t;
}

export function kbAdd(idx, fact) {
  fs.mkdirSync(path.dirname(idx.kbPath), { recursive: true });
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const line = `- [${stamp}] ${String(fact).trim()}`;
  if (fs.existsSync(idx.kbPath)) fs.appendFileSync(idx.kbPath, line + "\n");
  else fs.writeFileSync(idx.kbPath, `# PROJECT_KNOWLEDGE.md\n\n## Факты и решения\n${line}\n`);
  return `Факт добавлен в базу знаний (${idx.name}):\n${line}`;
}