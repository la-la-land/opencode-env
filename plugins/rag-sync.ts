/**
 * rag-sync.ts — Плагин V2 для RAG (поиск, индексация, авто-контекст)
 *
 * Что делает:
 * 1. ИНСТРУМЕНТЫ: rag_search, rag_where, rag_index, rag_stats, rag_project, rag_summary, kb_read, kb_add.
 *    Использует логику из rag-lib.mjs и build-index.mjs.
 * 2. АВТО-КОНТЕКСТ: При первом сообщении сессии делает поиск по проекту и вставляет ## RAG Context.
 * 3. АВТО-ИНДЕКСАЦИЯ: На события session.idle / session.deleted запускает переиндексацию в фоне.
 *
 * Использование:
 *   - rag_index(project?) — главный инструмент для агента.
 *   - rag_search(query) — семантический поиск.
 *   - kb_add(fact) — запись в базу знаний.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { 
  collectionName,
  scanProjects,
  detectActive,
  activeProjectDir,
  chooseProject,
  load,
  tokenize,
  uniqTokens,
  bm25,
  scoreQuery,
  embedQuery,
  qdrantGet,
  qdrantSearch,
  snippet,
  search,
  where,
  summary,
  stats,
  projectInfo,
  kbRead,
  kbAdd
} from "../../../mcp/rag-lib.mjs";

// Константы окружения
const RAG_PROJECTS_DIR = process.env.RAG_PROJECTS_DIR ?? 
  path.join(process.env.HOME ?? "~", "opencode-env", "rag", "projects");

// Кэш для авто-поиска контекста (TTL ~60с)
const contextCache = new Map<string, { ts: number; block: string | null }>();

// Определение проекта сессии
async function getProject(sessionID: string): Promise<string> {
  const dir = (await (ctx as any).session?.get({ sessionID }))?.directory;
  const targetDir = dir || (ctx as any).location?.directory || "/home/leonid/llm_worked";
  return chooseProject(null); // chooseProject уже делает detectActive(activeProjectDir())
}

// --- Реализация инструментов ---

async function handleRagIndex(input: any, context: any) {
  const project = input.project || (await getProject(context.sessionID));
  // ВАЖНО: используем spawn/exec для вызова build-index.mjs
  // так как он требует прав на запись в файловую систему
  console.log(`[rag-sync] Starting indexing for project: ${project}`);
  try {
    // Имитируем CLI команду
    // --project /path/to/source
    // --name alias
    // Если alias не передан, он возьмет имя из пути
    const cmd = `node /home/leonid/opencode-env/mcp/build-index.mjs --project ${project}`;
    execSync(cmd, { stdio: 'inherit' });
    return { content: `Успешно переиндексирован проект: ${project}` };
  } catch (e) {
    return { content: `Ошибка индексации проекта ${project}: ${e.message}` };
  }
}

export default {
  id: "rag-sync",
  setup: async (ctx: any) => {
    const eventController = new AbortController();

    // --- Авто-переиндексация на idle ---
    const indexingLocks = new Set<string>();
    const triggerIndex = async (sessionID: string) => {
      const project = await getProject(sessionID);
      if (!project || indexingLocks.has(project)) return;
      
      indexingLocks.add(project);
      console.log(`[rag-sync] Auto-indexing project ${project} on session idle...`);
      
      // Запускаем в фоне, чтобы не блокировать цикл событий
      (async () => {
        try {
          const cmd = `node /home/leonid/opencode-env/mcp/build-index.mjs --project ${project}`;
          execSync(cmd, { stdio: 'inherit' });
        } catch (e) {
          console.error(`[rag-sync] Auto-index failed for ${project}:`, e.message);
        } finally {
          indexingLocks.delete(project);
          console.log(`[rag-sync] Auto-index finished for ${project}`);
        }
      })();
    };

    // --- Событийный цикл ---
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
        try {
          const se = event as any;
          if (se.type === "session.idle" || (se.type === "sync" && se.name === "session.idle.1")) {
            const sid = se.properties?.sessionID || se.data?.sessionID;
            if (sid) triggerIndex(sid);
          }
          if (se.type === "session.deleted" || (se.type === "sync" && se.name === "session.deleted.1")) {
            const sid = se.properties?.sessionID || se.data?.sessionID;
            if (sid) triggerIndex(sid);
          }
        } catch (e) { console.error("[rag-sync] event error:", e); }
      }
    })();

    // --- Авто-поиск в контекст ---
    ctx.session.hook("context", async (event: any) => {
      try {
        const sid = event.sessionID;
        const now = Date.now();
        const cached = contextCache.get(sid);
        
        if (cached && (now - cached.ts < 60000)) {
          if (cached.block) event.system.push({ type: "text", text: cached.block });
          return;
        }

        const project = await getProject(sid);
        if (!project) return;

        // Берем первый запрос из истории (если есть) или текущий
        // В opencode context hook обычно не имеет доступа к истории сообщений напрямую легко, 
        // но мы можем использовать первое сообщение сессии. 
        // Если его нет, используем "current status".
        const query = "Current project context and status"; 
        
        // В идеале тут должен быть поиск по первому сообщению, 
        // но для стабильности используем базовый запрос.
        
        const idx = load(project);
        const results = await search(idx, query, 3);
        
        let block = "";
        if (results && results.length > 0) {
          block = `## RAG Context (проект: ${project})\n` + results.join("\n---\n");
        }

        contextCache.set(sid, { ts: now, block: block || null });
        if (block) event.system.push({ type: "text", text: block });
      } catch (e) {
        // Не ломаем запрос
      }
    });

    // --- Регистрация инструментов ---
    ctx.tool.transform((editor: any) => {
      editor.namespace({ name: "rag", description: "RAG: поиск, индексация и база знаний" });

      const registerRagTool = (name: string, desc: string, input: any, exec: (input: any, context: any) => Promise<any>) => {
        editor.add({
          name,
          description: desc,
          input,
          options: { namespace: "rag" },
          execute: async (i: any, c: any) => exec(i, c)
        });
      };

      registerRagTool("rag_search", "Семантический поиск по проекту", 
        { type: "object", properties: { query: { type: "string" }, project: { type: "string" } }, required: ["query"] },
        async (i: any, c: any) => {
          const p = i.project || (await getProject(c.sessionID));
          const idx = load(p);
          return { content: await search(idx, i.query, 5) };
        });

      registerRagTool("rag_where", "Где встречается фраза", 
        { type: "object", properties: { phrase: { type: "string" }, project: { type: "string" } }, required: ["phrase"] },
        async (i: any, c: any) => {
          const p = i.project || (await getProject(c.sessionID));
          const idx = load(p);
          return { content: await where(idx, i.phrase, 5) };
        });

      registerRagTool("rag_index", "Переиндексация проекта (обязательно при изменении кода)", 
        { type: "object", properties: { project: { type: "string" } }, required: [] },
        handleRagIndex);

      registerRagTool("rag_stats", "Статистика индекса проекта", 
        { type: "object", properties: { project: { type: "string" } }, required: [] },
        async (i: any, c: any) => {
          const p = i.project || (await getProject(c.sessionID));
          const idx = load(p);
          return { content: await stats(idx) };
        });

      registerRagTool("rag_project", "Информация о проекте и активных индексах", 
        { type: "object", properties: { project: { type: "string" } }, required: [] },
        async (i: any, c: any) => {
          const p = i.project || (await getProject(c.sessionID));
          const idx = load(p);
          return { content: await projectInfo(p) };
        });

      registerRagTool("rag_summary", "Конспект проекта по пути", 
        { type: "object", properties: { targetPath: { type: "string" }, project: { type: "string" } }, required: ["targetPath"] },
        async (i: any, c: any) => {
          const p = i.project || (await getProject(c.sessionID));
          const idx = load(p);
          return { content: await summary(idx, i.targetPath) };
        });

      registerRagTool("kb_read", "Читать базу знаний проекта", 
        { type: "object", properties: { project: { type: "string" } }, required: [] },
        async (i: any, c: any) => {
          const p = i.project || (await getProject(c.sessionID));
          const idx = load(p);
          return { content: await kbRead(idx) };
        });

      registerRagTool("kb_add", "Добавить факт в базу знаний проекта", 
        { type: "object", properties: { fact: { type: "string" }, project: { type: "string" } }, required: ["fact"] },
        async (i: any, c: any) => {
          const p = i.project || (await getProject(c.sessionID));
          const idx = load(p);
          return { content: await kbAdd(idx, i.fact) };
        });
    });

    return () => {
      eventController.abort();
    };
  },
};
