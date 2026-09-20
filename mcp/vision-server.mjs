#!/usr/bin/env node
// Vision MCP — локальное чтение картинок: метаданные, OCR, опционально vision через OpenAI-compatible API.
//
// Инструменты:
//   image_info     — метаданные + топ-цветов + dominant
//   ocr_image      — извлечь текст (offline, tesseract.js)
//   describe_image — собрать summary: размеры, EXIF, OCR, и если есть OPENAI_BASE_URL — vision LLM
//
// ENV:
//   OPENAI_BASE_URL   если задан, используется для vision-запроса
//   OPENAI_API_KEY    bearer token
//   VISION_MODEL      имя модели (default qwen3-vl-flash или из провайдера)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";

async function imageInfo({ input_path }) {
  if (!input_path || !fs.existsSync(input_path)) {
    return { isError: true, content: [{ type: "text", text: `not found: ${input_path}` }] };
  }
  try {
    const sharpMod = await import("sharp");
    const sharp = sharpMod.default;
    const meta = await sharp(input_path).metadata();
    const buf = fs.readFileSync(input_path);
    // доминирующие цвета через кроп 64x64 thumbnail и квантование
    const small = await sharp(buf).resize(64, 64, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
    const { data, info } = small;
    const channels = info.channels;
    const buckets = new Map();
    for (let i = 0; i < data.length; i += channels) {
      const r = data[i] >> 4, g = data[i + 1] >> 4, b = data[i + 2] >> 4;
      const key = (r << 8) | (g << 4) | b;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    const top = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => {
      const r = ((k >> 8) & 0xf) << 4, g = ((k >> 4) & 0xf) << 4, b = (k & 0xf) << 4;
      const hex = "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
      return `${hex} (${Math.round(100 * n / (64 * 64))}%)`;
    });
    const lines = [
      `Path: ${input_path}`,
      `Size: ${fs.statSync(input_path).size} bytes`,
      `Format: ${meta.format}`,
      `Dimensions: ${meta.width}x${meta.height}`,
      `Channels: ${meta.channels}`,
      meta.density ? `Density: ${meta.density} dpi` : null,
      `Dominant colors: ${top.join(", ")}`,
      meta.exif ? `EXIF: ${Object.keys(meta.exif).length} keys (cam: ${meta.exif.Make || "?"} ${meta.exif.Model || ""})` : "EXIF: none",
    ].filter(Boolean);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `info error: ${e.message}` }] };
  }
}

async function ocrImage({ input_path, lang = "rus+eng" }) {
  if (!input_path || !fs.existsSync(input_path)) {
    return { isError: true, content: [{ type: "text", text: `not found: ${input_path}` }] };
  }
  try {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker(lang.split("+"));
    const buf = fs.readFileSync(input_path);
    const { data } = await worker.recognize(buf);
    await worker.terminate();
    const text = (data?.text || "").trim();
    return {
      content: [{
        type: "text",
        text: text ? `OCR (${lang}):\n${text}` : `OCR (${lang}): no text detected`,
      }],
    };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `ocr error: ${e.message}` }] };
  }
}

async function describeImage({ input_path, compare_with, prompt = "Опиши что на изображении: объекты, текст, цвета, настроение." }) {
  if (!input_path || !fs.existsSync(input_path)) {
    return { isError: true, content: [{ type: "text", text: `not found: ${input_path}` }] };
  }
  const baseUrl = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.VISION_MODEL || "qwen3-vl-flash";
  const metaText = await imageInfo({ input_path }).then(r => r.content?.[0]?.text || "");
  if (!baseUrl || !apiKey) {
    // fallback: без vision — отдаём OCR + метаданные
    const ocr = await ocrImage({ input_path });
    return {
      content: [{
        type: "text",
        text:
          "⚠ VISION API не настроен (env OPENAI_BASE_URL/OPENAI_API_KEY). Возвращаю OCR+метаданные как proxy-description.\n\n" +
          `--- meta ---\n${metaText}\n\n` +
          `--- ocr ---\n${ocr.content?.[0]?.text || "(none)"}`,
      }],
    };
  }
  try {
    const toPart = async (p) => {
      let b = fs.readFileSync(p);
      let m = "image/jpeg";
      try {
        const sharpMod = await import("sharp");
        b = await sharpMod.default(b).resize({ width: 1400, height: 1400, fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
      } catch {
        const e = (path.extname(p).slice(1) || "jpeg").toLowerCase();
        m = ["jpg", "jpeg"].includes(e) ? "image/jpeg" : `image/${e}`;
      }
      return { type: "image_url", image_url: { url: `data:${m};base64,${b.toString("base64")}` } };
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
    const outText = j?.choices?.[0]?.message?.content || "(empty)";
    return { content: [{ type: "text", text: String(outText) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `vision error: ${e.message}` }] };
  }
}

const server = new Server({ name: "vision-mcp", version: "0.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "image_info",
      description: "Image metadata: format, dimensions, dominant colors, EXIF (camera).",
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
        "Describe an image. Uses OPENAI_BASE_URL/vision API if configured, else falls back to OCR + metadata.",
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
