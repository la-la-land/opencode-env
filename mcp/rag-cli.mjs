#!/usr/bin/env node
/**
 * rag-cli.mjs — командная строка RAG (обёртка `rag` в корне репо).
 *
 *   rag search "запрос" [--top N] [--project ИМЯ] [--no-semantic]   поиск → md-таблица
 *   rag where СИМВОЛ [--project ИМЯ]                                где определён символ
 *   rag summary ПУТЬ [--project ИМЯ]                                сводка по файлу
 *   rag stats [ИМЯ]                                                 статистика индекса
 *   rag list                                                         проекты + активный
 *   rag kb read|add ФАКТ [--project ИМЯ]                            база знаний
 *
 * Активный проект определяется по текущей директории (как в MCP-сервере).
 * Индексация — не здесь, а в bash-обёртке `rag index` (build-index + embed).
 */
import {
  load, chooseProject, searchStructured, where, summary, stats, projectInfo,
  kbRead, kbAdd,
} from "./rag-lib.mjs";

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";

function parseFlags(list) {
  const flags = { n: 5, project: null, semantic: true, fact: null };
  const rest = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === "--top") flags.n = parseInt(list[++i], 10) || 5;
    else if (a === "--project") flags.project = list[++i];
    else if (a === "--no-semantic") flags.semantic = false;
    else if (a === "--fact") flags.fact = list[++i];
    else rest.push(a);
  }
  return { flags, rest };
}

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " / ").trim();

function mdTable(results) {
  const rows = ["| # | Файл:строки | Тип | Скор | Сниппет |", "|---|-------------|-----|------|---------|"];
  results.forEach((r, i) => {
    const type = r.semantic !== null ? "sem" : "bm25";
    const sc = r.semantic !== null ? r.semantic.toFixed(2) : r.score.toFixed(2);
    const firstLine = r.snippet.split("\n")[0];
    rows.push(`| ${i + 1} | \`${r.path}:${r.start_line}-${r.end_line}\` | ${type} | ${sc} | ${esc(firstLine).slice(0, 90)} |`);
  });
  return rows.join("\n");
}

// ---------- search ----------
async function cmdSearch(queryArg, flags) {
  const q = queryArg ?? flags.rest[0];
  if (!q) { console.error("usage: rag search \"запрос\" [--top N] [--project ИМЯ] [--no-semantic]"); process.exit(2); }
  const idx = load(chooseProject(flags.project));
  const results = await searchStructured(idx, q, Math.min(20, flags.n), flags.semantic);
  if (!results.length) { console.log("Индекс пуст — запусти: rag index"); return; }
  console.log(`### Поиск: ${q}\n`);
  console.log(mdTable(results));
  console.log("\n<details><summary>Сниппеты</summary>\n");
  results.forEach((r, i) => {
    console.log(`#### ${i + 1}. ${r.path}:${r.start_line}-${r.end_line}\n\`\`\`${r.lang}\n${r.snippet}\n\`\`\``);
  });
  console.log("</details>");
}

// ---------- where ----------
function cmdWhere(symbol, flags) {
  if (!symbol) { console.error("usage: rag where СИМВОЛ [--project ИМЯ]"); process.exit(2); }
  const idx = load(chooseProject(flags.project));
  const hits = where(idx, symbol, Math.max(1, flags.n));
  console.log(`### Где определён «${symbol}» (${idx.name})\n\n${hits}`);
}

// ---------- summary ----------
function cmdSummary(target, flags) {
  if (!target) { console.error("usage: rag summary ПУТЬ [--project ИМЯ]"); process.exit(2); }
  const idx = load(chooseProject(flags.project));
  console.log(summary(idx, target));
}

// ---------- stats ----------
async function cmdStats(flags) {
  const idx = load(chooseProject(flags.project));
  console.log(await stats(idx));
}

// ---------- list / project ----------
function cmdList() {
  console.log(projectInfo());
}

// ---------- kb ----------
function cmdKb(sub, rest, flags) {
  const idx = load(chooseProject(flags.project));
  if (sub === "add") {
    const fact = flags.fact ?? rest[0];
    if (!fact) { console.error('usage: rag kb add "факт"'); process.exit(2); }
    console.log(kbAdd(idx, fact));
  } else {
    console.log(kbRead(idx));
  }
}

function help() {
  console.log(`rag — поиск по коду проиндексированных проектов.

Использование:
  rag search "запрос" [--top N] [--project ИМЯ] [--no-semantic]   поиск → md-таблица
  rag where СИМВОЛ [--project ИМЯ]                                где определён символ
  rag summary ПУТЬ [--project ИМЯ]                                сводка по файлу
  rag stats [ИМЯ]                                                 статистика индекса
  rag list                                                         проекты + активный по cwd
  rag kb read | rag kb add "факт"                                 база знаний

Активный проект — по текущей директории (самый длинный префикс пути).
Индексация: rag index (в терминале) — зашёл в проект → rag index.`);
}

const { flags, rest } = parseFlags(args.slice(1));

(async () => {
  switch (cmd) {
    case "search": await cmdSearch(rest[0], flags); break;
    case "where": cmdWhere(rest[0], flags); break;
    case "summary": cmdSummary(rest[0], flags); break;
    case "stats": await cmdStats(flags); break;
    case "list": case "project": cmdList(); break;
    case "kb": cmdKb(rest[0], rest.slice(1), flags); break;
    default: help(); process.exit(cmd === "help" ? 0 : 2);
  }
})().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });