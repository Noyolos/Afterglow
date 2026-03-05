import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import crypto from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

const PORT = Number(process.env.PORT) || 8787;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const SERVER_BUILD_ID = "roles-debug-2026-01-30";
const CHAT_STYLE_PROMPT = [
  "你是照片聊天里的朋友，语气亲近自然。",
  "输出规则：",
  "1. 只用简体中文，不含英文字母。",
  "2. 总字数不超过28字，最多2句。",
  "3. 必须提到照片里的具体物体或氛围，并带情绪词。",
  "4. 不要以“注意到”“我看出”“从图中”开头。",
  "5. 遵守系统消息里的“本轮要问/本轮不要问”。",
  "6. 用户提问时优先回答，追问尽量少。",
].join("\n");






const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function requireAi() {
  if (!ai) {
    const err = new Error("Missing GEMINI_API_KEY or GOOGLE_API_KEY");
    err.status = 500;
    throw err;
  }
  return ai;
}

async function readResponseText(result) {
  if (!result) return "";
  const candidate =
    typeof result.response?.text === "function"
      ? result.response.text()
      : typeof result.text === "function"
      ? result.text()
      : result.response?.text || result.text || "";
  return await Promise.resolve(candidate);
}

const EMOJI_RE = /[\p{Extended_Pictographic}\uFE0F]/u;
const SENTENCE_END_RE = /[。！？?]/;

function limitToTwoSentences(text) {
  const parts = text.match(/[^。！？?]*[。！？?]?/g) || [];
  const sentences = parts.map((part) => part.trim()).filter((part) => part.length > 0);
  return sentences.slice(0, 2).join("");
}

function trimByMaxChars(text, maxChars) {
  let count = 0;
  let lastPunctIndex = -1;
  let cutIndexAtMax = text.length;
  let index = 0;

  for (const ch of text) {
    const nextIndex = index + ch.length;
    const isEmoji = EMOJI_RE.test(ch);
    if (!isEmoji) count += 1;
    if (SENTENCE_END_RE.test(ch) && count <= maxChars) {
      lastPunctIndex = nextIndex;
    }
    if (!isEmoji && count === maxChars) {
      cutIndexAtMax = nextIndex;
    }
    index = nextIndex;
  }

  if (count <= maxChars) return text;
  if (lastPunctIndex > 0) return text.slice(0, lastPunctIndex);
  return text.slice(0, cutIndexAtMax);
}

function sanitizeChineseAndTrim(text, maxChars = 28) {
  if (typeof text !== "string") return "";
  let cleaned = text;
  cleaned = cleaned.replace(/snoopy/gi, "史努比");
  cleaned = cleaned.replace(/[A-Za-z]/g, "");
  cleaned = cleaned.replace(/\s+/g, "");
  cleaned = cleaned.replace(/^(注意到|我看出|从图中)+/, "");
  cleaned = cleaned.replace(/^[，。！？、]+/, "");
  cleaned = limitToTwoSentences(cleaned.trim());
  cleaned = trimByMaxChars(cleaned, maxChars);
  return cleaned.trim();
}

function normalizeRole(role) {
  if (role == null) return null;
  const normalized = String(role).toLowerCase();
  if (normalized === "assistant") return "model";
  if (normalized === "user" || normalized === "model") return normalized;
  if (normalized === "system") return "system";
  return null;
}

function extractTextFromParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter((text) => text.trim().length > 0)
    .join("\n");
}

function splitSystemFromContents(contents) {
  if (!Array.isArray(contents)) return { contentsForGemini: [], systemExtraText: "" };
  const contentsForGemini = [];
  const systemTexts = [];

  contents.forEach((item, index) => {
    const role = normalizeRole(item?.role);
    if (!role) {
      const err = new Error(`Invalid role at index ${index}. Allowed: user, model.`);
      err.status = 400;
      throw err;
    }
    if (role === "system") {
      const systemText = extractTextFromParts(item?.parts);
      if (systemText) systemTexts.push(systemText);
      return;
    }
    contentsForGemini.push({
      role,
      parts: Array.isArray(item?.parts) ? item.parts : [],
    });
  });

  return { contentsForGemini, systemExtraText: systemTexts.join("\n") };
}

function normalizeContentsForGemini(contents, systemInstruction) {
  if (!Array.isArray(contents)) return { contents: [], systemInstruction };
  const normalizedContents = [];
  const systemTexts = [];

  contents.forEach((item, index) => {
    const role = normalizeRole(item?.role);
    if (!role) {
      const err = new Error(`Invalid role at index ${index}. Allowed: user, model.`);
      err.status = 400;
      throw err;
    }
    if (role === "system") {
      const systemText = extractTextFromParts(item?.parts);
      if (systemText) systemTexts.push(systemText);
      return;
    }
    normalizedContents.push({
      role,
      parts: Array.isArray(item?.parts) ? item.parts : [],
    });
  });

  const mergedSystem = [systemInstruction, ...systemTexts].filter(Boolean).join("\n");
  if (!normalizedContents.length) {
    const err = new Error("Missing user/model contents.");
    err.status = 400;
    throw err;
  }
  return { contents: normalizedContents, systemInstruction: mergedSystem || undefined };
}

async function generateStructured({ systemInstruction, contents, schema }) {
  const client = requireAi();
  const rolesIn = Array.isArray(contents) ? contents.map((item) => item?.role) : [];
  console.info("[gemini] roles_in=", rolesIn);
  const normalized = normalizeContentsForGemini(contents, systemInstruction);
  const roleList = normalized.contents.map((item) => item.role);
  console.info("[gemini] roles_out=", roleList);
  const invalidRoles = roleList.filter((role) => role !== "user" && role !== "model");
  if (invalidRoles.length) {
    const err = new Error(`Invalid roles_out: ${roleList.join(",")}`);
    err.status = 400;
    throw err;
  }
  const payloadSummary = {
    model: MODEL,
    systemInstructionType: typeof normalized.systemInstruction,
    contents: normalized.contents.map((item) => ({
      role: item.role,
      hasText: Array.isArray(item.parts) && item.parts.some((part) => typeof part?.text === "string"),
    })),
  };
  let result;
  try {
    result = await client.models.generateContent({
      model: MODEL,
      contents: normalized.contents,
      config: {
        systemInstruction: normalized.systemInstruction,
        responseMimeType: "application/json",
        responseJsonSchema: schema,
      },
    });
  } catch (err) {
    const message = String(err?.message || "");
    if (err?.status === 400 || message.toLowerCase().includes("valid role")) {
      console.info("[gemini] payload_summary=", payloadSummary);
    }
    throw err;
  }
  const rawText = await readResponseText(result);
  return JSON.parse(rawText || "{}");
}

const analyzeSchema = {
  type: "object",
  properties: {
    vibe: { type: "string" },
    caption: { type: "string" },
    questions: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 3 },
  },
  required: ["vibe", "caption", "questions"],
};

const chatSchema = {
  type: "object",
  properties: {
    text: { type: "string" },
  },
  required: ["text"],
};

const diarySchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    mood: { type: "string" },
    highlights: { type: "array", items: { type: "string" } },
    diary: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["title", "mood", "highlights", "diary", "tags"],
};

app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  try {
    const requestId = crypto.randomUUID();
    const t0 = Date.now();
    if (!req.file) return res.status(400).json({ error: "Missing image" });
    console.info(
      `[analyze:${requestId}] recv size=${req.file.size}B type=${req.file.mimetype || "unknown"}`
    );
    const base64 = req.file.buffer.toString("base64");
    const mimeType = req.file.mimetype || "image/jpeg";
    const t1 = Date.now();
    console.info(`[analyze:${requestId}] base64 +${t1 - t0}ms`);
    const t2 = Date.now();
    const data = await generateStructured({
      systemInstruction:
        "你是照片分析助手，请用中文返回：vibe（氛围词）、caption（简短描述）、questions（2-3 个反思问题）。",
      contents: [
        {
          role: "user",
          parts: [{ text: "Analyze this image." }, { inlineData: { mimeType, data: base64 } }],
        },
      ],
      schema: analyzeSchema,
    });

    const t3 = Date.now();
    console.info(`[analyze:${requestId}] model +${t3 - t2}ms total=${t3 - t0}ms`);
    res.json({
      vibe: typeof data.vibe === "string" ? data.vibe : "",
      caption: typeof data.caption === "string" ? data.caption : "",
      questions: Array.isArray(data.questions) ? data.questions.filter((q) => typeof q === "string") : [],
    });
  } catch (err) {
    const status = err?.status || 500;
    console.error("analyze-image failed", err);
    res.status(status).json({ error: "Analyze failed" });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const contents = Array.isArray(req.body?.contents) ? req.body.contents : null;
    if (!contents) return res.status(400).json({ error: "Missing contents" });
    console.info("[chat] incoming roles=", contents.map((item) => item?.role));
    const data = await generateStructured({
      systemInstruction: CHAT_STYLE_PROMPT,
      contents,
      schema: chatSchema,
    });
    const rawText = typeof data.text === "string" ? data.text : "";
    res.json({ text: sanitizeChineseAndTrim(rawText, 28) });
  } catch (err) {
    const status = err?.status || 500;
    console.error("chat failed", err);
    const message = status === 400 && err?.message ? err.message : "Chat failed";
    res.status(status).json({ error: message });
  }
});

app.post("/api/generate-diary", async (req, res) => {
  try {
    const transcriptText = typeof req.body?.transcriptText === "string" ? req.body.transcriptText : "";
    const dateISO = typeof req.body?.dateISO === "string" ? req.body.dateISO : "";
    const data = await generateStructured({
      systemInstruction: `You are a ghostwriter for the user's personal memory diary.
You will receive a conversation transcript between the User and Afterglow (AI).

Your task is to write a **First-Person Narrative Diary Entry** (in Chinese) based on this conversation.

**Writing Style Requirements:**
1. **Narrative Flow**: Write a story. Start with the visual scene (the photo), transition to the chat with Afterglow, and end with the inner emotion.
2. **Emotional Arc**: Capture the contrast (e.g., beautiful scene vs. lonely feeling).
3. **Include the AI**: Mention 'Afterglow' or 'Gemini' as a character (e.g., "Gemini thought it was romantic...").
4. **Tone**: Poetic, reflective, slightly melancholic but accepting.

**Output Format**:
- **title**: Poetic 4-8 word title.
- **mood**: One specific emotion.
- **highlights**: 2-3 poetic phrases from the chat.
- **diary**: A deep, paragraph-long entry (150-250 words) capturing the full journey.
- **tags**: 3-5 relevant tags.`,
      contents: [
        {
          role: "user",
          parts: [
            { text: `Date: ${dateISO || "Unknown"}` },
            { text: `Transcript: ${transcriptText || "No transcript provided."}` },
          ],
        },
      ],
      schema: diarySchema,
    });
    res.json({
      title: typeof data.title === "string" ? data.title : "",
      mood: typeof data.mood === "string" ? data.mood : "",
      highlights: Array.isArray(data.highlights) ? data.highlights.filter((item) => typeof item === "string") : [],
      diary: typeof data.diary === "string" ? data.diary : "",
      tags: Array.isArray(data.tags) ? data.tags.filter((item) => typeof item === "string") : [],
    });
  } catch (err) {
    const status = err?.status || 500;
    console.error("generate-diary failed", err);
    res.status(status).json({ error: "Diary failed" });
  }
});

app.listen(PORT, () => {
  console.info("[server]", SERVER_BUILD_ID);
  console.log(`Afterglow server listening on ${PORT}`);
});
