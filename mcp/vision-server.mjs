#!/usr/bin/env node
// Vision MCP — локальное чтение картинок: метаданные, OCR, опционально vision через OpenAI-compatible API.
//
// Инструменты:
//   image_info     — метаданные + топ-цветов + dominant (работает и без sharp — частично)
//   ocr_image      — извлечь текст (offline, tesseract.js)
//   describe_image — собрать summary: размеры, EXIF, OCR, и если есть vision-API — описание моделью
//
// ENV (в порядке приоритета):
//   VISION_BASE_URL / OPENAI_BASE_URL   — OpenAI-совместимый endpoint (https://.../v1)
//   VISION_API_KEY  / OPENAI_API_KEY    — bearer token
//   VISION_MODEL                        — имя модели (по умолчанию MiniMax-M3)
//   TESSERACT_CACHE_PATH                — каталог кэша языковых данных tesseract
//   STACK_CONFIG                        — путь к stack.config (по умолчанию <repo>/stack.config)
//
// Если VISION_*/OPENAI_* не заданы в окружении — берутся из stack.config репозитория.
// Пакеты sharp и tesseract.js подключаются ДИНАМИЧЕСКИ: если их нет, инструменты
// не падают с «Cannot find package», а дают внятную диагностику.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---------- конфиг из stack.config (fallback для VISION_* переменных) ----------
function loadStackConfig() {
  const file = process.env.STACK_CONFIG || path.join(ROOT, "stack.config");
  const out = {};
  let text;
  try {
    if (!fs.existsSync(file)) return out;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // убираем хвостовой комментарий, если значение не в кавычках
    if (!/^["']/.test(val)) val = val.replace(/\s+#.*$/, "").trim();
    if (val.length >= 2 && /^["'].*["']$/.test(val)) val = val.slice(1, -1);
    if (key) out[key] = val;
  }
  return out;
}

const STACK = loadStackConfig();
const pickEnv = (...names) => {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== "") return v;
  }
  return "";
};

// ---------- динамический импорт опциональных пакетов ----------
const IMPORT_HINTS = {
  sharp: "не хватает пакета sharp (метаданные/цвета). Установите: cd <repo>/mcp && npm install sharp",
  "tesseract.js": "не хватает пакета tesseract.js (OCR). Установите: cd <repo>/mcp && npm install tesseract.js",
};

async function importOptional(spec) {
  try {
    const mod = await import(spec);
    return { ok: true, mod: mod?.default ?? mod, error: null };
  } catch (e) {
    return { ok: false, mod: null, error: e?.message || String(e) };
  }
}

function sharpErrorText(name, err) {
  return `⚠ ${name}: ${IMPORT_HINTS[name] || ""} (${err})`;
}

// ---------- определение формата/разрешения без sharp ----------
const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  avif: "image/avif", svg: "image/svg+xml", heic: "image/heic", jfif: "image/jpeg",
};

function extOf(file) {
  const e = (path.extname(file || "").slice(1) || "").toLowerCase();
  return e;
}

function mimeOf(file) {
  return MIME_BY_EXT[extOf(file)] || "image/jpeg";
}

// Разрешение из заголовка файла (PNG/JPEG/GIF/BMP/WEBP) — без внешних зависимостей.
function dimensionsFromHeader(buf) {
  try {
    if (!buf || buf.length < 16) return null;
    // PNG
    if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF
    if (buf.slice(0, 3).toString("latin1") === "GIF") {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // BMP
    if (buf.slice(0, 2).toString("latin1") === "BM" && buf.length >= 26) {
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
    }
    // WEBP (RIFF....WEBP)
    if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") {
      const fourcc = buf.slice(12, 16).toString("latin1");
      if (fourcc === "VP8 " && buf.length >= 30) {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (fourcc === "VP8L" && buf.length >= 25) {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (fourcc === "VP8X" && buf.length >= 30) {
        const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { width: w, height: h };
      }
      return null;
    }
    // JPEG: ищем сегмент SOF0..SOF15 (кроме DHT/JPG/DAC)
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSOF) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Минимальный разбор EXIF-тегов (Make/Model) из сырого буфера sharp.
function exifTags(buf) {
  if (!buf || !buf.length) return null;
  try {
    const s = buf.toString("latin1");
    const pick = (tag) => {
      const m = s.match(new RegExp(tag + "[\\x00-\\x20]{0,4}([^\\x00]{1,40})"));
      return m ? m[1].trim() : null;
    };
    const make = pick("Make");
    const model = pick("Model");
    if (!make && !model) return null;
    return { make, model };
  } catch {
    return null;
  }
}

// ---------- image_info ----------
async function imageInfo({ input_path }) {
  if (!input_path || !fs.existsSync(input_path)) {
    return { isError: true, content: [{ type: "text", text: `not found: ${input_path}` }] };
  }
  let stat;
  try {
    stat = fs.statSync(input_path);
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `info error: ${e.message}` }] };
  }

  const ext = extOf(input_path) || "?";
  let head = Buffer.alloc(0);
  try {
    const fd = fs.openSync(input_path, "r");
    try {
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // заголовок не прочитали — разрешение будет unknown
  }
  const dims = dimensionsFromHeader(head);

  // Базовые метаданные: расширение + размер файла (+ разрешение, если разобрали заголовок)
  const baseLines = [
    `Path: ${input_path}`,
    `Size: ${stat.size} bytes`,
    `Format: ${ext}`,
    dims ? `Dimensions: ${dims.width}x${dims.height}` : `Dimensions: unknown`,
  ];

  const sharpRes = await importOptional("sharp");
  if (!sharpRes.ok) {
    return {
      content: [{
        type: "text",
        text: [
          ...baseLines,
          `Channels: unknown`,
          `Dominant colors: unavailable`,
          `EXIF: unknown`,
          "",
          sharpErrorText("sharp", sharpRes.error),
          "Метаданные частичные: продолжите без sharp (или поставьте его — npm ci в mcp/).",
        ].join("\n"),
      }],
    };
  }

  const sharp = sharpRes.mod;
  try {
    const meta = await sharp(input_path).metadata();
    const buf = fs.readFileSync(input_path);
    // доминирующие цвета через кроп 64x64 thumbnail и квантование
    const small = await sharp(buf).resize(64, 64, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
    const { data, info } = small;
    const channels = info.channels || 3;
    const buckets = new Map();
    for (let i = 0; i + channels - 1 < data.length; i += channels) {
      const r = data[i] >> 4, g = data[i + 1] >> 4, b = data[i + 2] >> 4;
      const key = (r << 8) | (g << 4) | b;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    const total = Math.max(1, buckets.size ? [...buckets.values()].reduce((a, b) => a + b, 0) : 1);
    const top = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => {
      const r = ((k >> 8) & 0xf) << 4, g = ((k >> 4) & 0xf) << 4, b = (k & 0xf) << 4;
      const hex = "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
      return `${hex} (${Math.round(100 * n / total)}%)`;
    });
    const tags = exifTags(meta.exif);
    const lines = [
      `Path: ${input_path}`,
      `Size: ${stat.size} bytes`,
      `Format: ${meta.format || ext}`,
      `Dimensions: ${meta.width}x${meta.height}`,
      `Channels: ${meta.channels}`,
      meta.density ? `Density: ${meta.density} dpi` : null,
      `Dominant colors: ${top.join(", ") || "n/a"}`,
      tags
        ? `EXIF: Make=${tags.make || "?"} Model=${tags.model || "?"}`
        : "EXIF: none",
    ].filter(Boolean);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (e) {
    // sharp есть, но файл не прочитался — отдаём базовые метаданные + причину
    return {
      content: [{
        type: "text",
        text: [
          ...baseLines,
          "",
          `⚠ sharp не смог разобрать файл: ${e.message}`,
        ].join("\n"),
      }],
    };
  }
}

// ---------- ocr_image ----------
async function ocrImage({ input_path, lang = "rus+eng" }) {
  if (!input_path || !fs.existsSync(input_path)) {
    return { isError: true, content: [{ type: "text", text: `not found: ${input_path}` }] };
  }
  const tessRes = await importOptional("tesseract.js");
  if (!tessRes.ok) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `ocr error: ${IMPORT_HINTS["tesseract.js"]} (${tessRes.error})`,
      }],
    };
  }
  const { createWorker } = tessRes.mod;
  // кэш языковых данных: по умолчанию ~/.cache/tesseract (иначе tesseract.js пишет в cwd)
  const cachePath = process.env.TESSERACT_CACHE_PATH || path.join(os.homedir(), ".cache", "tesseract");
  let worker = null;
  try {
    fs.mkdirSync(cachePath, { recursive: true });
    worker = await createWorker(String(lang).split("+").map(s => s.trim()).filter(Boolean), 1, { cachePath });
    const buf = fs.readFileSync(input_path);
    const { data } = await worker.recognize(buf);
    const text = (data?.text || "").trim();
    return {
      content: [{
        type: "text",
        text: text ? `OCR (${lang}):\n${text}` : `OCR (${lang}): no text detected`,
      }],
    };
  } catch (e) {
    const msg = e?.message || String(e);
    const netHint = /fetch|network|ENOTFOUND|ECONNREFUSED|timeout/i.test(msg)
      ? "\nНе удалось скачать языковые данные tesseract — нужен доступ к tessdata.projectnaptha.com (или положите <lang>.traineddata в кэш вручную)."
      : "";
    return { isError: true, content: [{ type: "text", text: `ocr error: ${msg}${netHint}` }] };
  } finally {
    try { if (worker) await worker.terminate(); } catch { /* игнорируем */ }
  }
}

// ---------- describe_image ----------
function stripThink(text) {
  return String(text).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

async function describeImage({ input_path, compare_with, prompt = "Опиши что на изображении: объекты, текст, цвета, настроение." }) {
  if (!input_path || !fs.existsSync(input_path)) {
    return { isError: true, content: [{ type: "text", text: `not found: ${input_path}` }] };
  }
  const baseUrl = pickEnv("VISION_BASE_URL", "OPENAI_BASE_URL") || STACK.VISION_BASE_URL || "";
  const apiKey = pickEnv("VISION_API_KEY", "OPENAI_API_KEY") || STACK.VISION_API_KEY || "";
  const model = pickEnv("VISION_MODEL") || STACK.VISION_MODEL || "MiniMax-M3";

  const metaText = await imageInfo({ input_path }).then(r => r.content?.[0]?.text || "");
  if (!baseUrl || !apiKey) {
    // fallback: без vision-API — отдаём OCR + метаданные
    const ocr = await ocrImage({ input_path });
    return {
      content: [{
        type: "text",
        text:
          "⚠ VISION API не настроен (нужны VISION_BASE_URL/VISION_API_KEY или OPENAI_BASE_URL/OPENAI_API_KEY). " +
          "Возвращаю OCR+метаданные как proxy-description.\n\n" +
          `--- meta ---\n${metaText}\n\n` +
          `--- ocr ---\n${ocr.content?.[0]?.text || "(none)"}`,
      }],
    };
  }

  try {
    // Если sharp доступен — ужимаем картинку (экономит токены). Если нет — шлём исходный файл как есть.
    const sharpRes = await importOptional("sharp");
    const toPart = async (p) => {
      const raw = fs.readFileSync(p);
      if (sharpRes.ok) {
        try {
          const jpeg = await sharpRes.mod(raw).resize({ width: 1400, height: 1400, fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
          return { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } };
        } catch {
          // не смогли пережать — отдаём исходник
        }
      }
      const mime = mimeOf(p);
      return { type: "image_url", image_url: { url: `data:${mime};base64,${raw.toString("base64")}` } };
    };

    const content = [{ type: "text", text: prompt }];
    const extras = Array.isArray(compare_with) ? compare_with.filter((p) => p && fs.existsSync(p)) : [];
    for (const p of extras) content.push({ type: "text", text: `--- изображение для сравнения: ${path.basename(p)} ---` });
    content.push(await toPart(input_path));
    for (const p of extras) content.push(await toPart(p));

    const r = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
    });
    if (!r.ok) {
      const t = await r.text();
      return { isError: true, content: [{ type: "text", text: `vision api ${r.status}: ${t.slice(0, 300)}` }] };
    }
    const j = await r.json();
    const raw = j?.choices?.[0]?.message?.content || "(empty)";
    const outText = stripThink(raw) || "(empty)";
    const note = sharpRes.ok ? "" : `\n\n[sharp недоступен — отправлен исходный файл без сжатия]`;
    return { content: [{ type: "text", text: String(outText) + note }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `vision error: ${e.message}` }] };
  }
}

const server = new Server({ name: "vision-mcp", version: "0.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "image_info",
      description: "Image metadata: format, dimensions, dominant colors, EXIF (camera). Works partially even without sharp.",
      inputSchema: {
        type: "object",
        properties: { input_path: { type: "string" } },
        required: ["input_path"],
      },
    },
    {
      name: "ocr_image",
      description: "Extract text from an image via tesseract.js (offline).",
      inputSchema: {
        type: "object",
        properties: {
          input_path: { type: "string" },
          lang: { type: "string", default: "rus+eng", description: "tesseract language codes, + for multi" },
        },
        required: ["input_path"],
      },
    },
    {
      name: "describe_image",
      description:
        "Describe an image. Uses the vision API (VISION_BASE_URL/VISION_API_KEY or OPENAI_BASE_URL/OPENAI_API_KEY) " +
        "if configured, else falls back to OCR + metadata.",
      inputSchema: {
        type: "object",
        properties: {
          input_path: { type: "string" },
          compare_with: { type: "array", items: { type: "string" }, description: "Optional extra image paths to compare against in the same request." },
          prompt: { type: "string", default: "Опиши что на изображении" },
        },
        required: ["input_path"],
      },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "image_info") return imageInfo(args || {});
  if (name === "ocr_image") return ocrImage(args || {});
  if (name === "describe_image") return describeImage(args || {});
  return { isError: true, content: [{ type: "text", text: `unknown tool: ${name}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
