/**
 * honcho-sync.ts — Автозеркалирование переписки в Honcho + инъекция памяти проекта в system prompt.
 *
 * Загружается автоматически из ~/.config/opencode/plugins/ (глобальный плагин,
 * opencode V2: default-экспорт { id, setup }). Внешних зависимостей нет.
 *
 * - Каждое сообщение (user/assistant) пишется в honcho в workspace
 *   "project-<имя>" (согласовано с MCP honcho-server.mjs → honcho_recall
 *   видит всю память проекта в одном месте). Проект определяется по директории
 *   сессии (кэш из session.created/updated, fallback ctx.session.get).
 * - ctx.session.hook("context") добавляет блок "## Honcho Memory" с последними
 *   сообщениями проекта в system prompt — каждая новая сессия уже знает о проекте.
 */
import fs from "node:fs"
import path from "node:path"

// ── конфиг ──────────────────────────────────────────────────────────
const HONCHO_BASE = "http://127.0.0.1:8000"
const RAG_PROJECTS_DIR =
  process.env.RAG_PROJECTS_DIR ??
  path.join(process.env.HOME ?? "~", "opencode-env", "rag", "projects")

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

async function getMemoryBlock(ws: string): Promise<string | null> {
  try {
    const page = await honchoApi(
      "POST",
      `/v3/workspaces/${encodeURIComponent(ws)}/sessions/list`,
      {},
    )
    const sessions: any[] = Array.isArray(page)
      ? page
      : page?.items || []
    if (!sessions.length) return null

    const lines: string[] = []
    for (const s of sessions.slice(0, 5)) {
      const sid = s.id || s.name
      const msgsPage = await honchoApi(
        "POST",
        `/v3/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(sid)}/messages/list?reverse=true&limit=8`,
        {},
      )
      const msgs: any[] = Array.isArray(msgsPage)
        ? msgsPage
        : msgsPage?.messages || []
      for (const m of msgs.reverse()) {
        const role =
          m.peer_id === "user"
            ? "User"
            : m.peer_id === "opencode"
              ? "AI"
              : m.peer_id || "System"
        const text = String(m.content || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 300)
        if (text) lines.push(`[${role}]: ${text}`)
      }
    }
    if (!lines.length) return null
    const proj = ws.replace(/^project-/, "")
    return (
      `## Honcho Memory (проект: ${proj})\n` +
      lines.join("\n").slice(0, 5000)
    )
  } catch {
    return null
  }
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
      if (!fullText) return

      const ws = await getWorkspace(m.sessionID)
      const peer = m.role === "user" ? "user" : "opencode"
      const honchoSid = "oc-" + m.sessionID
      try {
        await postMessages(ws, honchoSid, [
          { content: fullText.slice(0, 20_000), peer_id: peer },
        ])
      } catch (err) {
        console.error("[honcho-sync] post error:", err)
      }
    }

    const eventController = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: eventController.signal,
        })) {
          try {
            // --- сессии: запоминаем directory ---
            const se = event as any
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

            // --- text parts: копим ---
            let part: any, messageID: string, sessionID: string
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

    // ── memory injection в system prompt ──────────────────────────
    // кэш: sessionID -> { ts, block } (память проекта этой сессии)
    const memoryCache = new Map<string, { ts: number; block: string | null }>()

    async function memoryForSession(sessionID: string): Promise<string | null> {
      const now = Date.now()
      const cached = memoryCache.get(sessionID)
      if (cached && now - cached.ts < 60_000) return cached.block
      let block: string | null = null
      try {
        const ws = await getWorkspace(sessionID)
        block = await getMemoryBlock(ws)
      } catch {
        block = null
      }
      memoryCache.set(sessionID, { ts: now, block })
      return block
    }

    const hookReg = await ctx.session.hook("context", async (event: any) => {
      try {
        const block = await memoryForSession(event.sessionID || "")
        if (block) {
          event.system.push({ type: "text", text: block })
        }
      } catch {
        // не ломаем запрос из-за памяти
      }
    })

    // ── cleanup ───────────────────────────────────────────────────
    return () => {
      eventController.abort()
      hookReg.dispose().catch(() => {})
    }
  },
}