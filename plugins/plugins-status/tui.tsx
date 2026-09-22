/**
 * plugins-status/tui.tsx — TUI-часть плагина «статистика плагинов».
 *
 * Что показывает в TUI opencode:
 * 1. sidebar.content — блок «Plugins» в сайдбаре справа (там же, где MCP):
 *    список активных плагинов со статусом и краткой активностью.
 * 2. session.panel "plugins.status" — развёрнутая панель по /plugins:
 *    статус каждого плагина + счётчики из stats-файла (индексации, поиски,
 *    суммаризации...) + сводка сессии (сколько сообщений).
 * 3. home.footer.status — индикатор числа активных плагинов.
 * 4. Слэш-команда /plugins открывает панель.
 *
 * Статистику пишут серверные плагины (rag-sync, honcho-sync) в общий файл
 * через stats-common.mjs; мы читаем его реактивно (раз в 5 c и по событиям).
 */
import { Plugin } from "@opencode/plugin/tui"
import { Show, For, createSignal, onCleanup } from "solid-js"
import { statsRead } from "../stats-common.mjs"

export default Plugin.define({
  id: "plugins-status",
  async setup(context) {
    // ── данные ───────────────────────────────────────────────────
    const [stats, setStats] = createSignal<Record<string, any>>({})
    const [plugins, setPlugins] = createSignal<any[]>([])
    const [sessionMsgCount, setSessionMsgCount] = createSignal<number>(0)

    async function listPlugins(): Promise<any[]> {
      // в новых версиях — client.plugin.list({location}), fallback — context.plugins?.list
      try {
        const location = context.location ?? context.data.location.default()
        const res: any = await context.client?.plugin?.list?.({ location })
        if (Array.isArray(res)) return res
        if (res?.data) return res.data
      } catch { /* пробуем ниже */ }
      try {
        const local: any = (context as any)?.plugins?.list?.()
        if (Array.isArray(local)) return local
      } catch { /* нет доступа */ }
      return []
    }

    async function refresh(sessionID?: string) {
      try {
        setStats(statsRead())
      } catch { /* нет файла — пусто */ }
      try {
        setPlugins(await listPlugins())
      } catch { /* нет доступа — пусто */ }
      if (sessionID) {
        try {
          const msgs = context.data.session.message.list(sessionID) ?? []
          setSessionMsgCount(msgs.length)
        } catch { /* не критично */ }
      }
    }

    // первичная загрузка + периодическое обновление + реакция на события
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    const stopEvt = context.data?.on?.("session.execution.succeeded", () => {
      void refresh(context.data.session.current?.())
    })
    onCleanup(() => {
      clearInterval(timer)
      stopEvt?.()
    })

    // ── helpers для рендера ───────────────────────────────────────
    // Показываем только плагины инфраструктуры (RAG + память Honcho).
    const KNOWN_IDS = new Set(["rag-sync", "honcho-sync"])

    const activePlugins = () => {
      const list = plugins().filter((p) => KNOWN_IDS.has(String(p?.id)))
      if (list.length) return list
      // плагины не видны — падаем на те, что уже писали статистику
      const ids = Object.keys(stats()).filter((k) => KNOWN_IDS.has(k))
      return ids.map((id) => ({ id, active: true }))
    }

    const fmt = (v: unknown) => {
      const n = Number(v ?? 0)
      return Number.isFinite(n) && n > 0 ? String(n) : ""
    }

    // ── слот: блок в сайдбаре (справа, где MCP) ────────────────────
    const slotSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const st = stats()
        const pls = activePlugins()
        return (
          <box>
            <text bold>Plugins</text>
            <For each={pls}>
              {(p: any) => {
                const id: string = String(p?.id || "?")
                const entry = st[id] || {}
                const busy = entry.indexes || entry.reindexes || entry.searches || entry.summaries
                return (
                  <box>
                    <text fg={context.theme.text.base}>
                      {p?.active === false ? "○" : "✓"} {id}
                    </text>
                    <Show when={fmt(busy)}>
                      <text fg={context.theme.textMuted}> · {fmt(busy)}</text>
                    </Show>
                  </box>
                )
              }}
            </For>
          </box>
        )
      },
    })

    // ── панель: развёрнутая статистика по /plugins ─────────────────
    const slotPanel = context.ui.slot({
      append: "session.panel",
      render: (panel: any) => (
        <Show when={panel.name === "plugins.status"}>
          <box>
            <text bold>Плагины и статистика</text>
            <text fg={context.theme.textMuted}>
              Сессия: {(panel.sessionID || "?").slice(0, 10)} · сообщений: {sessionMsgCount()}
            </text>

            <For each={activePlugins()}>
              {(p: any) => {
                const id = String(p?.id || "?")
                const e = stats()[id] || {}
                const rows: string[] = []
                for (const [k, v] of Object.entries(e)) {
                  if (k === "updatedAt") continue
                  if (k === "lastActivity" || k === "lastReindex" || k === "lastProject") {
                    rows.push(`${k}=${String(v).slice(0, 40)}`)
                  } else if (typeof v === "number") {
                    rows.push(`${k}=${v}`)
                  }
                }
                const when = e.updatedAt
                  ? new Date(Number(e.updatedAt)).toLocaleString("ru-RU")
                  : "—"
                return (
                  <box>
                    <text fg={context.theme.text.base}>
                      {p?.active === false ? "○" : "✓"} {id}
                    </text>
                    <Show when={rows.length}>
                      <text fg={context.theme.textMuted}>{rows.join("  ")}</text>
                    </Show>
                    <text fg={context.theme.textMuted}>обновлено: {when}</text>
                  </box>
                )
              }}
            </For>
          </box>
        </Show>
      ),
    })

    // ── команда /plugins + индикатор в футере ──────────────────────
    const slotApp = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global" as const,
          commands: [
            {
              id: "plugins.status",
              title: "Плагины: статистика",
              group: "Plugins",
              slash: { name: "plugins", aliases: ["pl"] },
              run: () => {
                context.ui.panel.open("plugins.status")
              },
            },
          ],
        }))
        return null
      },
    })

    const slotFooter = context.ui.slot({
      append: "home.footer.status",
      render: () => <text>⚡{activePlugins().length}</text>,
    })

    // cleanup
    return () => {
      ;[slotSidebar, slotPanel, slotApp, slotFooter].forEach((d) => {
        try {
          d?.()
        } catch { /* уже отключено */ }
      })
    }
  },
})