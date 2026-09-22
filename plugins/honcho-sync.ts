/**
 * honcho-sync.ts — Память проекта в Honcho: LLM-суммаризации сессий + инструменты
 * recall/save + инъекция релевантной памяти в system prompt.
 *
 * opencode V2, глобальный плагин (~/.config/opencode/plugins/). Внешних зависимостей нет.
 *
 * Что делает:
 * 1. ЗЕРКАЛО-СУММАРИЗАЦИЯ. Весь поток рассуждений в honcho НЕ пишется.
 *    Сессия копится в памяти плагина; когда сессия уходит в idle (или удаляется),
 *    плагин вызывает LLM (ТУ ЖЕ модель, что в сессии — динамически, из последнего
 *    user-сообщения; fallback: MiniMax-M3 из конфига) с промптом «суммаризируй
 *    сессию» и пишет в honcho ОДНО компактное сообщение [Summary].
 * 2. ИНЪЕКЦИЯ ПАМЯТИ. context-хук делает СЕМАНТИЧЕСКИЙ ПОИСК по всему workspace
 *    honcho (POST /search) с query = первый user-запрос текущей сессии →
 *    релевантные куски всей истории (не «хвост» последних сообщений).
 * 3. ИНСТРУМЕНТЫ для агента (вместо MCP-сервера honcho): honcho_recall,
 *    honcho_save, honcho_sessions, honcho_memories — регистрируются через
 *    ctx.tool.transform, workspace определяется по директории сессии.
 */
import fs from "node:fs"
import path from "node:path"
import { statsBump } from "./stats-common.mjs"

// ── конфиг ──────────────────────────────────────────────────────────
const HONCHO_BASE = "http://127.0.0.1:8000"
const RAG_PROJECTS_DIR =
  process.env.RAG_PROJECTS_DIR ??
  path.join(process.env.HOME ?? "~", "opencode-env", "rag", "projects")
// Модель на случай, если у сессии не удалось узнать модель (или она недоступна).
const FALLBACK_MODEL = { providerID: "MiniMax", id: "MiniMax-M3" }
// Порог простоя сессии (мс) перед суммаризацией.
const IDLE_SUMMARIZE_DELAY = Number(process.env.HONCHO_IDLE_SUMMARIZE_DELAY ?? 45_000)
// Лимит входа суммаризатора (символов): начало + конец сессии.
const SUMMARY_INPUT_LIMIT = 150_000
const SUMMARY_KEEP_HEAD = 25_000

// ── helpers ─────────────────────────────────────────────────────────
function sanitize(name: string) {
  return String(name)
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 200) || "workspace"
}

function projectNameFromDir(dir: string): string {
  // 1) RAG-индексы: самый длинный префикс пути
  try {
    const real = fs.realpathSync(dir)
    let best: string | null = null
    let bestLen = -1
    for (const p of fs.readdirSync(RAG_PROJECTS_DIR)) {
      const pp = path.join(RAG_PROJECTS_DIR, p, "project.path")
      try {
        const src = fs.readFileSync(pp, "utf8").trim()
        if (real === src || real.startsWith(src + path.sep)) {
          if (src.length > bestLen) {
            bestLen = src.length
            best = p
          }
        }
      } catch { /* нет project.path */ }
    }
    if (best) return best
  } catch { /* нет индексов */ }

  // 2) git root
  try {
    let d = dir
    for (let i = 0; i < 20; i++) {
      try {
        if (fs.statSync(path.join(d, ".git")).isDirectory()) return path.basename(d)
      } catch { /* идём выше */ }
      const parent = path.dirname(d)
      if (parent === d) break
      d = parent
    }
  } catch { /* не git */ }

  // 3) basename
  return path.basename(dir)
}

async function honchoApi(method: string, p: string, body?: unknown) {
  const res = await fetch(HONCHO_BASE + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch { /* не JSON */ }
  if (!res.ok) {
    const detail = json?.detail
      ? Array.isArray(json.detail)
        ? json.detail.map((d: any) => d.msg || JSON.stringify(d)).join("; ")
        : String(json.detail)
      : text
    throw new Error(`honcho ${res.status} ${method} ${p}: ${detail || ""}`.trim())
  }
  return json
}

async function ensureWorkspace(ws: string) {
  return honchoApi("POST", "/v3/workspaces", { name: ws })
}

async function postMessages(
  ws: string,
  sid: string,
  messages: Array<{ content: string; peer_id: string }>,
) {
  await ensureWorkspace(ws)
  return honchoApi(
    "POST",
    `/v3/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(sid)}/messages`,
    { messages },
  )
}

async function searchWorkspace(ws: string, query: string, limit = 6): Promise<any[]> {
  const hits = await honchoApi(
    "POST",
    `/v3/workspaces/${encodeURIComponent(ws)}/search`,
    { query: String(query).slice(0, 2000), limit },
  )
  return Array.isArray(hits) ? hits : []
}

function truncate(s: string, n: number) {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n) + "…" : t
}

// ── plugin ──────────────────────────────────────────────────────────
export default {
  id: "honcho-sync",
  setup: async (ctx: any) => {
    const fallbackDir: string = ctx.location?.directory || ""

    // sessionID -> directory (для определения проекта по сессии)
    const sessionDir = new Map<string, string>()
    // sessionID -> workspace (кеш)
    const wsCache = new Map<string, string>()

    async function getWorkspace(sessionID: string): Promise<string> {
      const cached = wsCache.get(sessionID)
      if (cached) return cached
      let dir = sessionDir.get(sessionID)
      if (!dir && ctx.session?.get) {
        try {
          const info = await ctx.session.get({ sessionID })
          if (info?.directory) {
            dir = info.directory
            sessionDir.set(sessionID, dir)
          }
        } catch { /* сессия могла уже завершиться */ }
      }
      const ws = "project-" + sanitize(projectNameFromDir(dir || fallbackDir))
      wsCache.set(sessionID, ws)
      return ws
    }

    // ── text parts cache (для сборки текста сообщения) ────────────
    interface PartState {
      text: string
      synthetic: boolean
      ignored: boolean
    }
    interface MsgState {
      order: string[]
      parts: Map<string, PartState>
    }
    const msgCache = new Map<string, MsgState>()

    // ── transcript сессии (для суммаризации) ──────────────────────
    // sessionID -> [{ role, text }]
    interface TranscriptMsg {
      role: "user" | "assistant"
      text: string
    }
    const transcripts = new Map<string, TranscriptMsg[]>()
    // version — меняется при каждом новом сообщении (для отмены устаревшего таймера)
    const sessionVersion = new Map<string, number>()
    // какая version уже суммаризирована (чтобы не дублировать)
    const summarizedVersion = new Map<string, number>()
    // модель сессии (из последнего user-сообщения: info.model)
    const sessionModel = new Map<string, { providerID: string; modelID: string }>()
    // первый user-запрос сессии (для query поиска памяти)
    const firstUserText = new Map<string, string>()
    const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()

    function bumpVersion(sessionID: string) {
      sessionVersion.set(sessionID, (sessionVersion.get(sessionID) ?? 0) + 1)
      // новые сообщения — откладываем суммаризацию
      const t = idleTimers.get(sessionID)
      if (t) clearTimeout(t)
      idleTimers.delete(sessionID)
    }

    function appendToTranscript(sessionID: string, role: "user" | "assistant", text: string) {
      let tr = transcripts.get(sessionID)
      if (!tr) {
        tr = []
        transcripts.set(sessionID, tr)
      }
      tr.push({ role, text })
      // сжимаем очень длинные сессии: держим начало + хвост
      let total = 0
      for (const m of tr) total += m.text.length + m.role.length + 3
      if (total > SUMMARY_INPUT_LIMIT) {
        let head: TranscriptMsg[] = []
        let headLen = 0
        for (const m of tr) {
          headLen += m.text.length + m.role.length + 3
          if (headLen > SUMMARY_KEEP_HEAD) break
          head.push(m)
        }
        const tail = tr.slice(-Math.max(8, Math.floor(tr.length / 2)))
        tr.splice(0, tr.length, ...head, { role: "assistant", text: "[… середина сессии опущена …]" }, ...tail)
      }
    }

    async function finalizeMessage(m: any) {
      if (!m || m.error) return
      const s = msgCache.get(m.id)
      if (!s) return
      // assistant — только завершённые
      if (m.role === "assistant" && !m.time?.completed) return

      const fullText = s.order
        .map((id) => s!.parts.get(id))
        .filter((p) => p && !p.synthetic && !p.ignored)
        .map((p) => p!.text)
        .join("\n")
        .trim()
      msgCache.delete(m.id)

      if (fullText) {
        // модель сессии — из user-сообщения (info.model), ассистент тоже несёт modelID
        if (m.role === "user" && m.model?.providerID && m.model?.modelID && !m.model?.variant?.includes("hidden")) {
          sessionModel.set(m.sessionID, {
            providerID: m.model.providerID,
            modelID: m.model.modelID,
          })
        } else if (m.role === "assistant" && m.modelID && m.providerID) {
          sessionModel.set(m.sessionID, { providerID: m.providerID, modelID: m.modelID })
        }
        if (m.role === "user" && !firstUserText.has(m.sessionID)) {
          firstUserText.set(m.sessionID, truncate(fullText, 400))
        }
        appendToTranscript(m.sessionID, m.role === "user" ? "user" : "assistant", fullText)
        bumpVersion(m.sessionID)
      }
    }

    // ── суммаризация сессии через LLM ─────────────────────────────
    async function pickModel(sessionID: string): Promise<{ providerID: string; id: string } | null> {
      const known = sessionModel.get(sessionID)
      if (known?.providerID && known?.modelID) {
        return { providerID: known.providerID, id: known.modelID }
      }
      // try default model of the app (usually the session's model)
      try {
        const def = await ctx.model?.default?.()
        if (def?.providerID && def?.modelID) {
          return { providerID: def.providerID, id: def.modelID }
        }
      } catch { /* нет доступа */ }
      return FALLBACK_MODEL
    }

    async function llmSummarize(prompt: string, model: { providerID: string; id: string }): Promise<string> {
      // ctx.generate.text — генерация указанной моделью без создания сессии/инструментов
      const out: any = await ctx.generate.text({ model, prompt })
      const text = typeof out === "string" ? out : out?.text ?? out?.content ?? ""
      return String(text).trim()
    }

    const SUMMARY_PROMPT = (transcript: string) =>
      `Ты — архивариус проекта, ведёшь память команды. Суммаризируй сессию диалога с ИИ-ассистентом так, чтобы по суммаризации можно было продолжить работу без перечитывания сессии.

Диалог:
"""
${transcript}
"""

Формат ответа (компактно, факты без рассуждений):
Задача: <что решали>
Решения: <ключевые решения и найденные закономерности>
Файлы: <затронутые файлы/компоненты, если есть>
Итог: <что сделано>
Открыто: <что осталось/следующие шаги, если есть>

Не более 12 строк. Пиши на русском.`

    async function summarizeSession(sessionID: string) {
      const tr = transcripts.get(sessionID)
      const ver = sessionVersion.get(sessionID) ?? 0
      if (!tr || !tr.length) return
      if (summarizedVersion.get(sessionID) === ver) return

      const transcript = tr
        .map((m) => (m.role === "user" ? `Пользователь: ${truncate(m.text, 6000)}` : `Ассистент: ${truncate(m.text, 6000)}`))
        .join("\n\n")
        .slice(-SUMMARY_INPUT_LIMIT)

      const model = await pickModel(sessionID)
      if (!model) return
      let summary = ""
      try {
        summary = await llmSummarize(SUMMARY_PROMPT(transcript), model)
      } catch (err: any) {
        console.error(`[honcho-sync] summarize error (${model.providerID}/${model.id}):`, err?.message ?? err)
        // fallback другая модель — один раз
        if (model.id !== FALLBACK_MODEL.id) {
          try {
            summary = await llmSummarize(SUMMARY_PROMPT(transcript), FALLBACK_MODEL)
          } catch (err2: any) {
            console.error("[honcho-sync] summarize fallback error:", err2?.message ?? err2)
            return
          }
        } else {
          return
        }
      }
      if (!summary) return

      try {
        const ws = await getWorkspace(sessionID)
        const honchoSid = "oc-" + sessionID
        await postMessages(ws, honchoSid, [
          { content: `[Summary]\n${summary.slice(0, 6000)}`, peer_id: "opencode" },
        ])
        statsBump("honcho-sync", { summaries: 1, lastActivity: Date.now() })
        summarizedVersion.set(sessionID, ver)
        console.log(`[honcho-sync] summary saved: ${ws}/${honchoSid} (v${ver})`)
      } catch (err) {
        console.error("[honcho-sync] summary post error:", err)
      }
    }

    function scheduleSummarize(sessionID: string) {
      const existing = idleTimers.get(sessionID)
      if (existing) clearTimeout(existing)
      const t = setTimeout(() => {
        idleTimers.delete(sessionID)
        void summarizeSession(sessionID).catch((e) => console.error("[honcho-sync] summarize:", e))
      }, IDLE_SUMMARIZE_DELAY)
      idleTimers.set(sessionID, t)
    }

    // ── событийный цикл ────────────────────────────────────────────
    const eventController = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: eventController.signal,
        })) {
          try {
            const se = event as any

            // --- сессии: запоминаем directory ---
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

            // --- session.idle → планируем суммаризацию ---
            if (se.type === "session.idle" && se.properties?.sessionID) {
              scheduleSummarize(se.properties.sessionID)
              continue
            }
            if (se.type === "sync" && se.name === "session.idle.1" && se.data?.sessionID) {
              scheduleSummarize(se.data.sessionID)
              continue
            }
            // --- сессия удалена → немедленная суммаризация остатков ---
            if (se.type === "session.deleted" && se.properties?.sessionID) {
              const sid = se.properties.sessionID
              const t = idleTimers.get(sid)
              if (t) clearTimeout(t)
              void summarizeSession(sid).catch(() => {})
              continue
            }
            if (se.type === "sync" && se.name === "session.deleted.1" && se.data?.sessionID) {
              const sid = se.data.sessionID
              const t = idleTimers.get(sid)
              if (t) clearTimeout(t)
              void summarizeSession(sid).catch(() => {})
              continue
            }

            // --- text parts: копим ---
            let part: any, messageID: string
            if (se.type === "message.part.updated") {
              part = se.properties?.info
            } else if (se.type === "sync" && se.name === "message.part.updated.1") {
              part = se.data?.part
            } else {
              part = undefined
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

            // --- готовое сообщение ---
            let msg: any
            if (se.type === "message.updated") {
              msg = se.properties?.info
            } else if (se.type === "sync" && se.name === "message.updated.1") {
              msg = se.data?.info
            }
            if (msg) await finalizeMessage(msg)
          } catch (err) {
            console.error("[honcho-sync] event error:", err)
          }
        }
      } catch {
        // stream aborted/ended
      }
    })()

    // ── memory injection в system prompt (семантический поиск) ─────
    const memoryCache = new Map<string, { ts: number; block: string | null }>()

    async function getMemoryBlock(sessionID: string): Promise<string | null> {
      try {
        const now = Date.now()
        const cached = memoryCache.get(sessionID)
        if (cached && now - cached.ts < 60_000) return cached.block

        const ws = await getWorkspace(sessionID)
        const proj = ws.replace(/^project-/, "")
        const query =
          firstUserText.get(sessionID) ||
          `Последняя работа по проекту ${proj}: что решали, какие решения и файлы`
        const hits = await searchWorkspace(ws, query, 6)
        let block: string | null = null

        if (hits.length) {
          statsBump("honcho-sync", { memoryBlocks: 1, lastActivity: Date.now() })
          const lines: string[] = ["## Honcho Memory (проект: " + proj + ")"]
          for (const m of hits) {
            const who = m.peer_id === "user" ? "User" : m.peer_id === "opencode" ? "AI" : m.peer_id || "?"
            const sess = String(m.session_id ?? m.session_name ?? "?")
            const when = String(m.created_at ?? "").slice(0, 16).replace("T", " ")
            const text = truncate(String(m.content ?? ""), 400)
            if (text) lines.push(`- [${sess} | ${who} | ${when}] ${text}`)
          }
          block = lines.join("\n").slice(0, 5000)
        }
        memoryCache.set(sessionID, { ts: now, block })
        return block
      } catch (err) {
        console.error("[honcho-sync] memory block error:", err)
        return null
      }
    }

    const hookReg = await ctx.session.hook("context", async (event: any) => {
      try {
        const block = await getMemoryBlock(event.sessionID || "")
        if (block) {
          event.system.push({ type: "text", text: block })
        }
      } catch {
        // не ломаем запрос из-за памяти
      }
    })

    // ── инструменты для агента (вместо MCP honcho) ─────────────────
    // workspace: по sessionID из контекста инструмента, иначе по location плагина
    async function wsFromContext(context: any): Promise<string> {
      const sid = context?.sessionID
      if (sid) {
        try {
          return await getWorkspace(sid)
        } catch { /* fallback ниже */ }
      }
      const loc = ctx?.location?.project?.canonical || ctx?.location?.directory || fallbackDir
      return "project-" + sanitize(projectNameFromDir(loc))
    }

    async function listSessions(ws: string): Promise<any[]> {
      const page = await honchoApi(
        "POST",
        `/v3/workspaces/${encodeURIComponent(ws)}/sessions/list`,
        {},
      )
      return page?.items || page || []
    }

    const toolReg = await ctx.tool.transform((editor: any) => {
      editor.namespace({ name: "honcho", description: "Память проекта (Honcho): семантический поиск и сохранение фактов" })

      editor.add({
        name: "recall",
        description:
          "Семантический поиск по памяти проекта: фразой ищи ранее сохранённые факты, решения, суммаризации сессий. " +
          "Используй перед незнакомыми задачами, когда авто-блок памяти неполон.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Что вспомнить" },
            limit: { type: "integer", description: "Сколько результатов, default 5" },
            project: { type: "string", description: "Имя проекта (обычно не нужно — определяется по сессии)" },
          },
          required: ["query"],
          additionalProperties: false,
        },
        options: { namespace: "honcho" },
        execute: async (input: any, context: any) => {
          statsBump("honcho-sync", { recalls: 1, lastActivity: Date.now() })
          const ws = input?.project ? "project-" + sanitize(input.project) : await wsFromContext(context)
          const q = String(input?.query ?? "")
          const limit = Math.max(1, Math.min(20, Number(input?.limit) || 5))
          const hits = await searchWorkspace(ws, q, limit)
          if (!hits.length) return { content: `По запросу «${q}» в памяти «${ws.replace(/^project-/, "")}» ничего не найдено.` }
          const out = hits.map((m: any) => {
            const who = m.peer_id === "user" ? "User" : m.peer_id === "opencode" ? "AI" : m.peer_id || "?"
            const sess = String(m.session_id ?? m.session_name ?? "?")
            const when = String(m.created_at ?? "").slice(0, 16).replace("T", " ")
            return `[${sess} | ${who} | ${when}]\n${truncate(String(m.content ?? ""), 400)}`
          })
          return { content: `Память «${ws.replace(/^project-/, "")}»:\n\n` + out.join("\n\n") }
        },
      })

      editor.add({
        name: "save",
        description:
          "Сохранить факт/решение/закономерность в память проекта — чтобы следующая сессия это знала. " +
          "Пиши осознанно, коротко и фактами.",
        input: {
          type: "object",
          properties: {
            fact: { type: "string", description: "Что запомнить (факт, решение, договорённость)" },
            project: { type: "string", description: "Имя проекта (обычно не нужно — определяется по сессии)" },
          },
          required: ["fact"],
          additionalProperties: false,
        },
        options: { namespace: "honcho" },
        execute: async (input: any, context: any) => {
          statsBump("honcho-sync", { saves: 1, lastActivity: Date.now() })
          const ws = input?.project ? "project-" + sanitize(input.project) : await wsFromContext(context)
          const fact = String(input?.fact ?? "").slice(0, 20000)
          if (!fact) return { content: "Пустой факт — не сохранено." }
          await postMessages(ws, "main-memory", [{ content: fact, peer_id: "opencode" }])
          return { content: `Сохранено в память «${ws.replace(/^project-/, "")}»:\n${truncate(fact, 400)}` }
        },
      })

      editor.add({
        name: "sessions",
        description: "Список сессий памяти проекта.",
        input: {
          type: "object",
          properties: { project: { type: "string" } },
          additionalProperties: false,
        },
        options: { namespace: "honcho" },
        execute: async (input: any, context: any) => {
          const ws = input?.project ? "project-" + sanitize(input.project) : await wsFromContext(context)
          const list = await listSessions(ws)
          if (!list.length) return { content: `Проект «${ws.replace(/^project-/, "")}» — сессий пока нет.` }
          const lines = [
            `Workspace: ${ws}`,
            ...list.map((s: any) => `  - ${s.name ?? s.id}${s.created_at ? "  (" + String(s.created_at).slice(0, 16).replace("T", " ") + ")" : ""}`),
          ]
          return { content: lines.join("\n") }
        },
      })

      editor.add({
        name: "memories",
        description: "Сколько сообщений накоплено в памяти проекта (по сессиям).",
        input: {
          type: "object",
          properties: { project: { type: "string" } },
          additionalProperties: false,
        },
        options: { namespace: "honcho" },
        execute: async (input: any, context: any) => {
          const ws = input?.project ? "project-" + sanitize(input.project) : await wsFromContext(context)
          const list = await listSessions(ws)
          const out = [`Workspace: ${ws}`, "Сообщений по сессиям:"]
          let total = 0
          for (const s of list) {
            const sid = s.name ?? s.id
            let n = 0
            try {
              const page: any = await honchoApi(
                "POST",
                `/v3/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(sid)}/messages/list`,
                { filters: {} },
              )
              n = page?.total ?? (Array.isArray(page) ? page.length : 0)
            } catch { /* пропускаем */ }
            total += n
            out.push(`  - ${sid}: ${n}`)
          }
          out.push(`Итого: ${total}`)
          return { content: out.join("\n") }
        },
      })
    })

    // ── cleanup ───────────────────────────────────────────────────
    return () => {
      eventController.abort()
      for (const t of idleTimers.values()) clearTimeout(t)
      idleTimers.clear()
      hookReg.dispose().catch(() => {})
      toolReg.dispose().catch(() => {})
    }
  },
}