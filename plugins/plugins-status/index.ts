/**
 * plugins-status/index.ts — серверная часть TUI-плагина «статистика плагинов».
 *
 * Сам UI делает tui.tsx (слот sidebar.content + панель plugins.status + /plugins).
 * Этот entry нужен, чтобы плагин был в общем списке плагинов (plugin.list)
 * и CLI подхватил TUI-компоненту из того же каталога.
 */
export default {
  id: "plugins-status",
  setup: async () => {
    // вся работа — в tui.tsx
  },
}