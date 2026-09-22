/**
 * stats-common.mjs — общий счётчик активности плагинов (для TUI-панели).
 *
 * Серверные плагины (rag-sync, honcho-sync) пишут сюда агрегированные счётчики
 * своей работы (индексации, поиски, суммаризации...). TUI-плагин
 * plugins-status читает этот файл и показывает статистику в сайдбаре/панели.
 *
 * Файл: ~/.local/share/opencode/plugins-stats.json
 */

import fs from "node:fs"
import path from "node:path"

export const STATS_PATH = path.join(
  process.env.HOME ?? "/home/leonid",
  ".local",
  "share",
  "opencode",
  "plugins-stats.json",
)

const LOCK_MS = 50

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(STATS_PATH, "utf8"))
  } catch {
    return {}
  }
}

/**
 * Атомарно инкрементирует/обновляет поле плагина.
 * bump: { searches: 1 } — увеличит счётчик; { lastActivity: 123 } — установит.
 */
export function statsBump(pluginId, patch = {}, increment = 1) {
  try {
    fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true })
    const all = readRaw()
    const entry = (all[pluginId] ??= {})
    for (const [key, val] of Object.entries(patch)) {
      if (typeof val === "number" && !Number.isNaN(val)) {
        // last* — устанавливаем (timestamp/имя последнего события), остальное — суммируем
        entry[key] = key.startsWith("last") ? val : (Number(entry[key]) || 0) + val
      } else {
        entry[key] = val
      }
    }
    entry.updatedAt = Date.now()
    // пишем во временный файл и переименовываем — почти атомарно
    const tmp = STATS_PATH + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2))
    fs.renameSync(tmp, STATS_PATH)
  } catch (err) {
    // статистика не критична — молча
    console.error("[stats-common] bump error:", err?.message ?? err)
  }
}

export function statsSet(pluginId, patch) {
  try {
    fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true })
    const all = readRaw()
    const entry = (all[pluginId] ??= {})
    Object.assign(entry, patch)
    entry.updatedAt = Date.now()
    const tmp = STATS_PATH + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2))
    fs.renameSync(tmp, STATS_PATH)
  } catch (err) {
    console.error("[stats-common] set error:", err?.message ?? err)
  }
}

export function statsRead() {
  try {
    return readRaw()
  } catch {
    return {}
  }
}