/**
 * rag-sync.ts — RAG-плагин opencode V2: поиск + индексация + автоконтекст.
 *
 * Что делает:
 * 1. ИНСТРУМЕНТЫ для агента (namespace "rag"): rag_search, rag_where,
 *    rag_index (обязательная переиндексация после изменений кода), rag_stats,
 *    rag_project, rag_summary, kb_read, kb_add. Проект определяется по
 *    директории сессии, из которой вызван инструмент.
 * 2. АВТО-КОНТЕКСТ. context-хук делает семантический поиск по индексу проекта
 *    сессии с query = первый user-запрос сессии (fallback — общий запрос по
 *    проекту) и вставляет блок "## RAG Context" в system prompt.
 * 3. АВТО-ПЕРЕИНДЕКСАЦИЯ. На session.idle / session.deleted переиндексирует
 *    проект сессии в фоне (build-index.mjs → embed.mjs), с локом (не более
 *    одной индексации на проект одновременно).
 *
 * Индексация = два шага (как `rag index`):
 *   node mcp/build-index.mjs --project <путь> --name <имя>  — чанки в sqlite
 *   node mcp/embed.mjs --project <имя> [--reset]            — вектора в Qdrant
 */
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"

// Абсолютные пути: плагин лежит в ~/.config/opencode/plugins/, а ядро RAG — в репо.
import * as ragLib from "/home/leonid/opencode-env/mcp/rag-lib.mjs"
import { statsBump } from "./stats-common.mjs"

const {
  scanProjects,
  detectActive,
  load,
  searchStructured,
  where,
  summary,
  stats,
  projectInfo,
  kbRead,
  kbAdd,
} = ragLib

const OPENCODE_ENV = "/home/leonid/opencode-env"
const AUTO_CTX_LIMIT = 5000

// ── helpers ─────────────────────────────────────────────────────────
function sanitize(name: string) {
  return (
    String(name)
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 200) || "workspace"
  )
}

function truncate(s: string, n: number) {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n) + "…" : t
}

function tail(s: string, n: number) {
  const t = String(s || "").trim()
  return t.length > n ? "…" + t.slice(-n) : t
}

// Запуск node-скрипта из репо opencode-env, сбор stdout+stderr.
function runNode(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn("node", args, { cwd: OPENCODE_ENV })
    let out = ""
    p.stdout.on("data", (d: Buffer) => (out += String(d)))
    p.stderr.on("data", (d: Buffer) => (out += String(d)))
    p.on("close", (code) => resolve({ code: code ?? -1, out }))
    p.on("error", (e: Error) => resolve({ code: -1, out: String(e) }))
  })
}

// Полная переиндексация проекта: чанки (sqlite) + вектора (Qdrant).
// reset=true — пересоздать коллекцию Qdrant (честная перезаливка векторов,
// нужно, когда изменилось содержимое, но не число чанков).
async function reindexProject(
  project: { name: string; src: string },
  reset: boolean,
): Promise<string> {
  const r1 = await runNode(["mcp/build-index.mjs", "--project", project.src, "--name", project.name])
  if (r1.code !== 0) {
    return `Ошибка индексации чанков (${project.name}):\n${tail(r1.out, 2000)}`
  }
  const embedArgs = ["mcp/embed.mjs", "--project", project.name]
  if (reset) embedArgs.push("--reset")
  const r2 = await runNode(embedArgs)
  if (r2.code !== 0) {
    return `Чанки готовы, но вектора не залиты (${project.name}):\n${tail(r2.out, 2000)}`
  }
  statsBump("rag-sync", { reindexes: 1, lastReindex: project.name, lastProject: project.src })
  const last = tail(r1.out.split("\n").pop() || "", 200) + "\n" + tail(r2.out, 1500)
  return `✅ Переиндексировано: ${project.name} (${project.src})\n${last}`
}

// ── plugin ──────────────────────────────────────────────────────────
export default {
  id: "rag-sync",
  setup: async (ctx: any) => {
    const fallbackDir: string = ctx.location?.directory || ""
    // sessionID -> directory (для определения проекта по сессии)
    const sessionDir = new Map<string, string>()
    // первый user-запрос сессии (для query автопоиска)
    const firstUserText = new Map<string, string>()

    async function sessionDirOf(sessionID: string): Promise<string> {
      let dir = sessionDir.get(sessionID)
      if (!dir && ctx.session?.get) {
        try {
          const info = await ctx.session.get({ sessionID })
          if (info?.directory) {
            dir = info.directory
            sessionDir.set(sessionID, dir)
          }
        } catch {
          /* сессия могла уже завершиться */
        }
      }
      return dir || fallbackDir
    }

    // Проект по сессии: имя индекса (самый длинный префикс project.path) + исходник.
    // Если индекса нет — возвращаем заготовку {name: basename, src: dir}
    // (нужна для rag_index; поисковые инструменты дадут понятную ошибку).
    async function resolveProject(
      sessionID: string,
    ): Promise<{ name: string; src: string } | null> {
      const dir = await sessionDirOf(sessionID)
      if (!dir) return null
      const projects = scanProjects()
      const active = detectActive(dir)
      if (active && projects.has(active)) {
        return { name: active, src: projects.get(active)!.src }
      }
      return { name: sanitize(path.basename(dir)), src: dir }
    }

    // Проект из аргумента инструмента (имя индекса ИЛИ путь), иначе по сессии.
    async function projectFrom(input: any, context: any): Promise<{ name: string; src: string }> {
      const asked = String(input?.project ?? "").trim()
      if (asked) {
        const projects = scanProjects()
        if (projects.has(asked)) return { name: asked, src: projects.get(asked)!.src }
        if (asked.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(asked)) {
          return { name: sanitize(path.basename(asked)), src: asked }
        }
        return { name: sanitize(asked), src: asked }
      }
      const proj = await resolveProject(context?.sessionID || "")
      if (!proj) throw new Error("Не удалось определить проект (нет директории сессии)")
      return proj
    }

    // ── сбор первого user-сообщения сессии ──────────────────────────
    interface PartState { text: string; synthetic: boolean; ignored: boolean }
    interface MsgState { order: string[]; parts: Map<string, PartState> }
    const msgCache = new Map<string, MsgState>()

    function finalizeMessage(m: any) {
      if (!m || m.error) return
      const s = msgCache.get(m.id)
      if (!s) return
      const fullText = s.order
        .map((id) => s.parts.get(id))
        .filter((p) => p && !p.synthetic && !p.ignored)
        .map((p) => p!.text)
        .join("\n")
        .trim()
      msgCache.delete(m.id)
      if (m.role === "user" && fullText && !firstUserText.has(m.sessionID)) {
        firstUserText.set(m.sessionID, truncate(fullText, 500))
      }
    }

    // ── событийный цикл ─────────────────────────────────────────────
    const eventController = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
          try {
            const se = event as any

            // сессии: запоминаем directory
            if (se.type === "session.created" || se.type === "session.updated") {
              const info = se.properties?.info
              if (info?.directory && info?.id) sessionDir.set(info.id, info.directory)
              continue
            }
            if (se.type === "sync" && se.name && se.name.startsWith("session.")) {
              const info = se.data?.info
              if (info?.directory && se.data?.sessionID) {
                sessionDir.set(se.data.sessionID, info.directory)
              }
              continue
            }

            // text parts: копим для сборки первого сообщения
            let part: any
            if (se.type === "message.part.updated") {
              part = se.properties?.info
            } else if (se.type === "sync" && se.name === "message.part.updated.1") {
              part = se.data?.part
            }
            if (part && part.type === "text" && part.messageID) {
              let ms = msgCache.get(part.messageID)
              if (!ms) {
                ms = { order: [], parts: new Map() }
                msgCache.set(part.messageID, ms)
              }
              ms.parts.set(part.id, {
                text: part.text ?? "",
                synthetic: !!part.synthetic,
                ignored: !!part.ignored,
              })
              if (!ms.order.includes(part.id)) ms.order.push(part.id)
            }

            // готовое сообщение
            let msg: any
            if (se.type === "message.updated") {
              msg = se.properties?.info
            } else if (se.type === "sync" && se.name === "message.updated.1") {
              msg = se.data?.info
            }
            if (msg) finalizeMessage(msg)

            // --- session.idle / session.deleted → авто-переиндексация ---
            if (se.type === "session.idle" && se.properties?.sessionID) {
              triggerIndex(se.properties.sessionID)
              continue
            }
            if (se.type === "sync" && se.name === "session.idle.1" && se.data?.sessionID) {
              triggerIndex(se.data.sessionID)
              continue
            }
            if (se.type === "session.deleted" && se.properties?.sessionID) {
              triggerIndex(se.properties.sessionID)
              continue
            }
            if (se.type === "sync" && se.name === "session.deleted.1" && se.data?.sessionID) {
              triggerIndex(se.data.sessionID)
              continue
            }
          } catch (err) {
            console.error("[rag-sync] event error:", err)
          }
        }
      } catch {
        /* stream aborted/ended */
      }
    })()

    // ── авто-переиндексация на session.idle / session.deleted ───────
    const indexingLocks = new Set<string>()

    async function triggerIndex(sessionID: string) {
      try {
        const proj = await resolveProject(sessionID)
        if (!proj) return
        // Авто-индексируем только уже известные индексы; для нового проекта
        // агент явно вызывает rag_index (иначе под каждый каталог сессий
        // создавался бы мусорный индекс).
        const projects = scanProjects()
        if (!projects.has(proj.name)) {
          console.log(`[rag-sync] ${proj.name}: индекса нет — автоиндексация пропущена (вызови rag_index)`)
          return
        }
        if (indexingLocks.has(proj.name)) return
        indexingLocks.add(proj.name)
        console.log(`[rag-sync] авто-переиндексация ${proj.name} (session.idle)…`)
        void (async () => {
          try {
            const out = await reindexProject(proj, false)
            statsBump("rag-sync", { autoReindexes: 1, lastActivity: Date.now() })
            console.log(`[rag-sync] ${tail(out, 1200)}`)
          } catch (e: any) {
            console.error(`[rag-sync] авто-переиндексация ${proj.name} упала:`, e?.message ?? e)
          } finally {
            indexingLocks.delete(proj.name)
          }
        })()
      } catch (e) {
        console.error("[rag-sync] triggerIndex:", e)
      }
    }

    // ── авто-контекст (семантический поиск по проекту сессии) ───────
    const contextCache = new Map<string, { ts: number; block: string | null }>()

    async function getContextBlock(sessionID: string): Promise<string | null> {
      try {
        const now = Date.now()
        const cached = contextCache.get(sessionID)
        if (cached && now - cached.ts < 60_000) return cached.block

        const proj = await resolveProject(sessionID)
        if (!proj) return null
        let idx: any
        try {
          idx = load(proj.name)
        } catch {
          return null // нет индекса — молча (агент может вызвать rag_index)
        }

        const query =
          firstUserText.get(sessionID) ||
          `Проект ${proj.name}: структура, ключевые решения, файлы и готовый код`
        const hits = await searchStructured(idx, query, 3)
        let block: string | null = null
        if (hits.length) {
          statsBump("rag-sync", { contextBlocks: 1, lastActivity: Date.now() })
          const lines = [`## RAG Context (проект: ${proj.name})`]
          for (const h of hits) {
            const score =
              h.semantic != null ? ` (sem=${h.semantic.toFixed(2)})` : ` (bm25=${h.score.toFixed(1)})`
            lines.push(`- \`${h.path}:${h.start_line}-${h.end_line}\`${score}`)
            lines.push("```" + (h.lang || "txt"))
            lines.push(truncate(h.snippet, 1200))
            lines.push("```")
          }
          block = lines.join("\n").slice(0, AUTO_CTX_LIMIT)
        }
        contextCache.set(sessionID, { ts: now, block })
        return block
      } catch (err) {
        console.error("[rag-sync] context block error:", err)
        return null
      }
    }

    const hookReg = await ctx.session.hook("context", async (event: any) => {
      try {
        const block = await getContextBlock(event.sessionID || "")
        if (block) {
          event.system.push({ type: "text", text: block })
        }
      } catch {
        /* не ломаем запрос из-за RAG */
      }
    })

    // ── инструменты для агента (вместо MCP rag) ──────────────────────
    await ctx.tool.transform((editor: any) => {
      editor.namespace({ name: "rag", description: "RAG: поиск, индексация и база знаний" })

      const register = (name: string, desc: string, input: any, exec: (i: any, c: any) => Promise<any>) => {
        editor.add({
          name,
          description: desc,
          input,
          options: { namespace: "rag" },
          execute: async (i: any, c: any) => exec(i, c),
        })
      }

      register(
        "rag_search",
        "Семантический поиск по проекту (session-проект или project=<имя индекса>)",
        {
          type: "object",
          properties: {
            query: { type: "string", description: "Поисковый запрос" },
            project: { type: "string", description: "Имя индекса (по умолчанию — проект сессии)" },
          },
          required: ["query"],
        },
        async (i: any, c: any) => {
          const p = await projectFrom(i, c)
          const idx = load(p.name)
          const hits = await searchStructured(idx, i.query, 5)
          statsBump("rag-sync", { searches: 1, lastActivity: Date.now() })
          if (!hits.length) return { content: "Ничего не найдено. Индекс пуст или запрос нерелевантен." }
          return {
            content: hits
              .map(
                (h) =>
                  `[${h.path}:${h.start_line}-${h.end_line}]${h.semantic != null ? ` (sem=${h.semantic.toFixed(2)})` : ""}\n\`\`\`${h.lang}\n${h.snippet}\n\`\`\``,
              )
              .join("\n---\n"),
          }
        },
      )

      register(
        "rag_where",
        "Где встречается символ/фраза (лексика по индексу)",
        {
          type: "object",
          properties: {
            phrase: { type: "string", description: "Символ или фраза" },
            project: { type: "string" },
          },
          required: ["phrase"],
        },
        async (i: any, c: any) => {
          const p = await projectFrom(i, c)
          const idx = load(p.name)
          statsBump("rag-sync", { wheres: 1, lastActivity: Date.now() })
          return { content: where(idx, i.phrase, 8) }
        },
      )

      register(
        "rag_index",
        "Переиндексация проекта (ОБЯЗАТЕЛЬНО вызывай после изменения кода/файлов). reset=true — пересоздать вектора в Qdrant (нужно, если менялось содержимое без изменения числа чанков)",
        {
          type: "object",
          properties: {
            project: { type: "string", description: "Имя индекса или путь (по умолчанию — проект сессии)" },
            reset: { type: "boolean", description: "Полная перезаливка векторов (медленнее)" },
          },
          required: [],
        },
        async (i: any, c: any) => {
          const p = await projectFrom(i, c)
          return { content: await reindexProject(p, !!i.reset) }
        },
      )

      register(
        "rag_stats",
        "Статистика индекса проекта",
        {
          type: "object",
          properties: { project: { type: "string" } },
          required: [],
        },
        async (i: any, c: any) => {
          const p = await projectFrom(i, c)
          const idx = load(p.name)
          return { content: await stats(idx) }
        },
      )

      register(
        "rag_project",
        "Информация о проекте и активных индексах",
        {
          type: "object",
          properties: { project: { type: "string" } },
          required: [],
        },
        async (i: any, c: any) => {
          const dir = await sessionDirOf(c?.sessionID || "")
          return { content: projectInfo(dir) }
        },
      )

      register(
        "rag_summary",
        "Конспект файла по пути (из индекса)",
        {
          type: "object",
          properties: {
            targetPath: { type: "string", description: "Путь к файлу (относительно проекта)" },
            project: { type: "string" },
          },
          required: ["targetPath"],
        },
        async (i: any, c: any) => {
          const p = await projectFrom(i, c)
          const idx = load(p.name)
          return { content: summary(idx, i.targetPath) }
        },
      )

      register(
        "kb_read",
        "Прочитать базу знаний проекта (PROJECT_KNOWLEDGE.md)",
        {
          type: "object",
          properties: { project: { type: "string" } },
          required: [],
        },
        async (i: any, c: any) => {
          const p = await projectFrom(i, c)
          const idx = load(p.name)
          return { content: kbRead(idx) }
        },
      )

      register(
        "kb_add",
        "Добавить факт в базу знаний проекта",
        {
          type: "object",
          properties: {
            fact: { type: "string", description: "Факт/решение" },
            project: { type: "string" },
          },
          required: ["fact"],
        },
        async (i: any, c: any) => {
          const p = await projectFrom(i, c)
          const idx = load(p.name)
          return { content: kbAdd(idx, i.fact) }
        },
      )
    })

    return () => {
      eventController.abort()
      hookReg?.dispose?.()
    }
  },
}