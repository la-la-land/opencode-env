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
 * Общая логика (поиск, индексы, детект проекта) — в rag-lib.mjs.
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
import {
  load, chooseProject, search, where, summary, stats, projectInfo,
  kbRead, kbAdd,
} from "./rag-lib.mjs";

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
      return jsonrpc(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "rag-server", version: "2.1.0" } });
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