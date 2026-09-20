#!/usr/bin/env node
/**
 * honcho-server.mjs — MCP-сервер памяти (Honcho v3) с пер-проектными сессиями.
 *
 * Каждому проекту — отдельный workspace honcho (project-<имя>):
 * память и сессии изолированы по проектам. Активный проект определяется
 * по рабочей директории (cwd) процесса opencode — тот же механизм,
 * что у RAG: проект = путь с самым длинным префиксом среди RAG-индексов,
 * либо ближайший git-репозиторий, либо имя текущего каталога.
 * Явный выбор: env HONCHO_WORKSPACE=<имя-workspace>.
 *
 * Требует запущенный honcho API (honcho/README.md, порт :8000).
 * Auth не нужен при AUTH_USE_AUTH=false (шаблон репо).
 *
 * Инструменты:
 *   honcho_sessions(project?)   — сессии проекта
 *   honcho_memories(project?)   — сколько сообщений в каждой сессии проекта
 *   honcho_recall(query, limit?, project?) — семантический поиск по памяти проекта
 *   honcho_save(fact, project?) — сохранить факт/заметку в память проекта
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // корень репо opencode-env
const BASE = (process.env.HONCHO_BASE_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
const PROJECTS_DIR = process.env.RAG_PROJECTS_DIR ?? path.join(ROOT, "rag", "projects");
const MAIN_SESSION = process.env.HONCHO_SESSION ?? "main-memory";

// ---------- имя проекта (из cwd) ----------
function sanitize(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 200) || "workspace";
}

function findGitRoot(dir) {
  let d = dir;
  for (let i = 0; i < 20; i++) {
    try { if (fs.statSync(path.join(d, ".git")).isDirectory()) return d; } catch { /* дальше */ }
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
  return null;
}

function projectNameFromCwd(cwd) {
  // 1) RAG-индексы: самый длинный префикс пути
  let best = null, bestLen = -1;
  try {
    const real = fs.realpathSync(cwd);
    for (const p of fs.readdirSync(PROJECTS_DIR)) {
      const pp = path.join(PROJECTS_DIR, p, "project.path");
      if (!fs.existsSync(pp)) continue;
      const src = fs.readFileSync(pp, "utf8").trim();
      if (real === src || real.startsWith(src + path.sep)) {
        if (src.length > bestLen) { bestLen = src.length; best = p; }
      }
    }
  } catch { /* нет индексов */ }
  if (best) return best;
  // 2) git-репозиторий
  const git = findGitRoot(cwd);
  if (git) return path.basename(git);
  // 3) имя каталога
  return path.basename(cwd);
}

function workspaceFor(cwd) {
  const envWs = process.env.HONCHO_WORKSPACE;
  if (envWs) return sanitize(envWs);
  return "project-" + sanitize(projectNameFromCwd(cwd));
}

// ---------- REST-хелперы (honcho v3, без auth при AUTH_USE_AUTH=false) ----------
async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
  if (!res.ok) {
    const detail = json?.detail ? (Array.isArray(json.detail) ? json.detail.map((d) => d.msg || JSON.stringify(d)).join("; ") : String(json.detail)) : text;
    throw new Error(`honcho ${res.status} ${method} ${p}: ${detail || ""}`.trim());
  }
  return json;
}

async function ensureWorkspace(ws) {
  return api("POST", "/v3/workspaces", { name: ws });
}

async function listSessions(ws) {
  const page = await api("POST", `/v3/workspaces/${encodeURIComponent(ws)}/sessions/list`, {});
  return page?.items || page || [];
}

async function sessionMessageCount(ws, sess) {
  const page = await api("POST", `/v3/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(sess)}/messages/list`, { filters: {} });
  return page?.total ?? (Array.isArray(page) ? page.length : 0);
}

// ---------- инструменты ----------
async function sessionsInfo(project) {
  const ws = workspaceFor(process.cwd());
  const list = await listSessions(ws);
  const source = project ? ` (явно: ${project})` : "";
  if (!list.length) return `Проект «${ws.replace(/^project-/, "")}» — сессий пока нет${source}. Сохрани первую: honcho_save.`;
  const lines = [`Workspace: ${ws}${source}`, "Сессии:", ...list.map((s) => `  - ${s.name ?? s.id}${s.created_at ? "  (" + String(s.created_at).slice(0, 16).replace("T", " ") + ")" : ""}`)];
  return lines.join("\n");
}

async function memories(project) {
  const ws = workspaceFor(process.cwd());
  const list = await listSessions(ws);
  const out = [`Workspace: ${ws}`, "Сообщений по сессиям:"];
  let total = 0;
  for (const s of list) {
    const n = await sessionMessageCount(ws, s.name ?? s.id);
    total += n;
    out.push(`  - ${s.name ?? s.id}: ${n}`);
  }
  out.push(`Итого: ${total}`);
  return out.join("\n");
}

async function recall(query, limit = 5) {
  const ws = workspaceFor(process.cwd());
  const hits = await api("POST", `/v3/workspaces/${encodeURIComponent(ws)}/search`, { query: String(query).slice(0, 2000), limit: Math.max(1, Math.min(20, limit)) });
  if (!Array.isArray(hits) || !hits.length) return `По запросу «${query}» в памяти «${ws}» ничего нет.`;
  const out = hits.map((m) => {
    const who = m.peer_id ?? m.peer_name;
    const sess = m.session_id ?? m.session_name;
    const when = (m.created_at || "").slice(0, 16).replace("T", " ") || "?";
    let text = String(m.content || "").replace(/\s+/g, " ").trim();
    if (text.length > 400) text = text.slice(0, 400) + "…";
    return `[${sess} | ${who} | ${when}]\n${text}`;
  });
  return `Память «${ws}»:\n\n` + out.join("\n\n");
}

async function save(fact, project) {
  const ws = workspaceFor(process.cwd());
  await ensureWorkspace(ws);
  const body = { messages: [{ content: String(fact).slice(0, 20000), peer_id: "opencode" }] };
  const created = await api("POST", `/v3/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(MAIN_SESSION)}/messages`, body);
  return `Сохранено в память «${ws}» (сессия ${MAIN_SESSION})${project ? ` [${project}]` : ""}:\n${String(fact).slice(0, 400)}`;
}

// ---------- MCP (JSON-RPC over stdio) ----------
function jsonrpc(id, result) { return JSON.stringify({ jsonrpc: "2.0", id, result }); }
function jsonrpcError(id, code, message) { return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }); }

const tools = [
  {
    name: "honcho_sessions",
    description: "Сессии памяти проекта (активного по рабочей директории). Показывает workspace и список сессий.",
    inputSchema: { type: "object", properties: { project: { type: "string", description: "Имя проекта (необязательно)" } } },
  },
  {
    name: "honcho_memories",
    description: "Сколько сообщений накоплено в памяти проекта (по сессиям).",
    inputSchema: { type: "object", properties: { project: { type: "string" } } },
  },
  {
    name: "honcho_recall",
    description: "Семантический поиск по памяти проекта: фразой ищи ранее сохранённые факты, решения, контекст. " +
      "Используй перед незнакомыми задачами, чтобы не перечитывать проект заново.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Что вспомнить" },
        limit: { type: "integer", description: "Сколько результатов, default 5" },
        project: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "honcho_save",
    description: "Сохранить факт/заметку в память проекта (важные решения, найденные закономерности — чтобы следующая сессия их знала).",
    inputSchema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "Что запомнить" },
        project: { type: "string" },
      },
      required: ["fact"],
    },
  },
];

async function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return jsonrpc(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "honcho-server", version: "1.0.0" } });
    case "notifications/initialized":
      return null;
    case "tools/list":
      return jsonrpc(id, { tools });
    case "tools/call": {
      const { name, arguments: args } = params;
      try {
        const a = args || {};
        let text;
        if (name === "honcho_sessions") text = await sessionsInfo(a.project);
        else if (name === "honcho_memories") text = await memories(a.project);
        else if (name === "honcho_recall") text = await recall(String(a.query || ""), a.limit || 5);
        else if (name === "honcho_save") text = await save(String(a.fact || ""), a.project);
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
  let i;
  while ((i = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      handleRequest(m).then((r) => { if (r) process.stdout.write(r + "\n"); });
    } catch { /* skip */ }
  }
});