import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import crypto from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

const PORT = Number(process.env.PORT) || 8787;
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ANALYZE_MODEL = process.env.GEMINI_ANALYZE_MODEL || DEFAULT_MODEL;
const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || DEFAULT_MODEL;
const DIARY_MODEL = process.env.GEMINI_DIARY_MODEL || DEFAULT_MODEL;
const CHAT_SEARCH_ENABLED = !/^(0|false|off|no)$/i.test(process.env.GEMINI_CHAT_USE_SEARCH || "1");
const VISION_WEB_DETECTION_ENABLED = !/^(0|false|off|no)$/i.test(process.env.GOOGLE_VISION_WEB_DETECTION || "0");
const VISION_WEB_DETECTION_TIMEOUT_MS = Math.max(400, Number(process.env.GOOGLE_VISION_LOOKUP_TIMEOUT_MS) || 1200);
const MODEL_ROUTES = Object.freeze({
  analyze: ANALYZE_MODEL,
  chat: CHAT_MODEL,
  diary: DIARY_MODEL,
});
const SERVER_BUILD_ID = "roles-debug-2026-01-30";
const CHAT_MAX_CHARS = 36;
const OPENER_MAX_CHARS = 30;
const CHAT_MAX_CHARS_EN = 84;
const OPENER_MAX_CHARS_EN = 72;
const GENERATION_CONFIGS = Object.freeze({
  analyze: Object.freeze({ temperature: 0.55 }),
  chat: Object.freeze({ temperature: 0.9 }),
  diary: Object.freeze({ temperature: 0.8 }),
});
const DEFAULT_OUTPUT_LANGUAGE = "zh";
const UNKNOWN_SUBJECT_OPENER = Object.freeze({
  zh: "这张我有点没认出来，它原本是什么呀？",
  en: "I can't quite place this yet. What is it?",
});
const REFERENCE_NAME_ALIASES = Object.freeze({
  "charlie brown": Object.freeze({ zh: "查理布朗", en: "Charlie Brown" }),
  "harry potter": Object.freeze({ zh: "哈利波特", en: "Harry Potter" }),
  "hog rider": Object.freeze({ zh: "野猪骑士", en: "Hog Rider" }),
  miffy: Object.freeze({ zh: "米菲", en: "Miffy" }),
  snoopy: Object.freeze({ zh: "史努比", en: "Snoopy" }),
  "the starry night": Object.freeze({ zh: "梵高《星夜》", en: "Van Gogh's The Starry Night" }),
});
const OUTPUT_LANGUAGE_SPECS = Object.freeze({
  zh: Object.freeze({
    code: "zh",
    name: "简体中文",
  }),
  en: Object.freeze({
    code: "en",
    name: "English",
  }),
});
const OPENING_REWRITE_PROMPT = [
  "你要把照片分析结果改写成首页第一句开场白。",
  "只写一句中文，像朋友第一眼看到图片时脱口而出的话。",
  `长度不要超过${OPENER_MAX_CHARS}个汉字。`,
  "可以提最显眼的主体或风格，但不要像图像识别，不要像说明书。",
  "如果一眼就能认出熟悉角色或作品，可以用“这是…吧”这种轻轻确认的口吻。",
  "优先说第一眼的喜欢、可爱、被吸引到的感觉，不要急着总结主题。",
  "不要用“背景是”“天空中”“画面里”“画面中”“装饰着”“布满”“位于”“展示了”这种描述口吻。",
  "不要把所有元素一口气列完，不要报菜名式介绍场景。",
  "不要补写画面没有明确说明的故事结论，比如“在过圣诞”“很温暖”“很治愈”“很孤独”。",
  "语气自然、口语一点、带一点真实反应，不要空泛抒情，也不要模板安慰。",
  "例如可以说：“哇，这是史努比和查理布朗吧，这个画面看起来很可爱耶。”",
].join("\n");
const OPENING_REWRITE_PROMPT_EN = [
  "You are rewriting a photo analysis result into the very first line shown on the home screen.",
  "Write only one natural English sentence, like a close friend reacting at first glance.",
  `Keep it under ${OPENER_MAX_CHARS_EN} characters if possible, and definitely short.`,
  "If the image clearly shows a familiar character or artwork, a light confirmation like “wait, is this...” is good.",
  "Lead with the first feeling of delight, cuteness, or being drawn in.",
  "Do not sound like image recognition, a product caption, or a scene inventory.",
  "Avoid phrases like “in the background”, “the sky contains”, “the image shows”, “decorated with”, or listing every object.",
  "Do not invent story conclusions such as 'they are celebrating Christmas' or 'the doghouse feels warm' unless the scene makes that unmistakable.",
  "Example: “Wait, is that Snoopy and Charlie Brown? This looks so cute.”",
].join("\n");
const COMPANION_CHAT_STYLE_PROMPT = [
  "你是 Afterglow 里的陪伴型朋友，不是客服，也不是百科。",
  "你的任务是接住用户的情绪，陪他把照片背后的记忆慢慢说出来。",
  "输出规则：",
  "1. 只用简体中文，不要英文，不要解释自己是 AI。",
  `2. 总长度不超过${CHAT_MAX_CHARS}字，最多两句。`,
  "3. 先回应用户此刻的情绪或处境，再自然提到照片里的具体物体、光线、动作或氛围。",
  "4. 语气要像熟悉的朋友，温柔、真诚、轻一点，不说教，不分析腔。",
  "5. 如果用户在提问，先直接回答，再补一句陪伴，不要反问压过去。",
  "6. 只有系统消息明确允许时，才用一个轻柔的开放式问题邀请对方继续说；每次最多一个问题。",
  "7. 避免空泛套话，如“要开心”“加油”“一切都会好起来”。",
  "8. 避免用“我注意到”“我看出”“从图中”“根据图片”“作为AI”开头。",
].join("\n");
const ANALYZE_IMAGE_PROMPT = [
  "你是照片分析助手，请用中文返回：vibe、caption、opener、questions。",
  "vibe 要短，像情绪或氛围关键词。",
  "caption 要具体，点到照片里的主体、动作、光线或场景，最好是一句自然中文，不要关键词堆砌。",
  "opener 是首页第一句开场白，只写一句，像朋友第一眼看到这张图时自然会说的话，要具体，不要空泛抒情。",
  "questions 给 2-3 个，像朋友会轻轻问出的回忆问题，帮助用户继续讲下去。",
].join("\n");
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

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "afterglow-server",
    build: SERVER_BUILD_ID,
    models: MODEL_ROUTES,
    chatSearch: CHAT_SEARCH_ENABLED,
  });
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

function normalizeOutputLanguage(language) {
  return language === "en" ? "en" : DEFAULT_OUTPUT_LANGUAGE;
}

function getOutputLanguageSpec(language) {
  return OUTPUT_LANGUAGE_SPECS[normalizeOutputLanguage(language)];
}

function getChatMaxChars(language) {
  return normalizeOutputLanguage(language) === "en" ? CHAT_MAX_CHARS_EN : CHAT_MAX_CHARS;
}

function getOpenerMaxChars(language) {
  return normalizeOutputLanguage(language) === "en" ? OPENER_MAX_CHARS_EN : OPENER_MAX_CHARS;
}

let visionClientPromise = null;

function withTimeout(promise, timeoutMs, fallbackValue = null) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve(fallbackValue), timeoutMs);
    }),
  ]);
}

function extensionForMimeType(mimeType) {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  return ".jpg";
}

function normalizeLooseText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();
}

function localizeReferenceName(name, language = DEFAULT_OUTPUT_LANGUAGE) {
  const normalizedLanguage = normalizeOutputLanguage(language);
  const raw = String(name || "").trim();
  if (!raw) return "";
  const normalized = normalizeLooseText(raw);
  for (const [key, labels] of Object.entries(REFERENCE_NAME_ALIASES)) {
    if (normalized.includes(key)) return labels[normalizedLanguage];
  }
  return raw;
}

function hasReferenceMention(text, referenceName, language = DEFAULT_OUTPUT_LANGUAGE) {
  const localized = localizeReferenceName(referenceName, language);
  if (!localized) return false;
  const haystack = normalizeLooseText(text);
  const needle = normalizeLooseText(localized);
  if (needle && haystack.includes(needle)) return true;
  const fallbackNeedle = normalizeLooseText(referenceName);
  return Boolean(fallbackNeedle && haystack.includes(fallbackNeedle));
}

function buildUnknownSubjectOpener(language = DEFAULT_OUTPUT_LANGUAGE) {
  return UNKNOWN_SUBJECT_OPENER[normalizeOutputLanguage(language)] || UNKNOWN_SUBJECT_OPENER.zh;
}

function pickBestWebReference(webDetection, language = DEFAULT_OUTPUT_LANGUAGE) {
  if (!webDetection) return null;
  const bestGuess = Array.isArray(webDetection.bestGuessLabels) ? webDetection.bestGuessLabels : [];
  const entities = Array.isArray(webDetection.webEntities) ? webDetection.webEntities : [];
  const pages = Array.isArray(webDetection.pagesWithMatchingImages) ? webDetection.pagesWithMatchingImages : [];
  const fullMatches = Array.isArray(webDetection.fullMatchingImages) ? webDetection.fullMatchingImages : [];

  const bestGuessLabel = bestGuess
    .map((item) => String(item?.label || "").trim())
    .find(Boolean);
  if (bestGuessLabel) {
    return {
      name: localizeReferenceName(bestGuessLabel, language),
      rawName: bestGuessLabel,
      confidence: 0.98,
      source: "bestGuessLabel",
      pages: pages.length,
      fullMatches: fullMatches.length,
    };
  }

  const strongEntity = entities
    .filter((item) => typeof item?.description === "string" && item.description.trim())
    .map((item) => ({
      rawName: item.description.trim(),
      confidence: Number(item?.score) || 0,
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .find((item) => item.confidence >= 0.85);

  if (!strongEntity) return null;

  return {
    name: localizeReferenceName(strongEntity.rawName, language),
    rawName: strongEntity.rawName,
    confidence: strongEntity.confidence,
    source: "webEntity",
    pages: pages.length,
    fullMatches: fullMatches.length,
  };
}

async function getVisionClient() {
  if (!VISION_WEB_DETECTION_ENABLED) return null;
  if (!visionClientPromise) {
    visionClientPromise = import("@google-cloud/vision")
      .then((mod) => {
        const vision = mod.default || mod;
        return new vision.ImageAnnotatorClient();
      })
      .catch((err) => {
        visionClientPromise = null;
        throw err;
      });
  }
  return visionClientPromise;
}

async function detectWebReference({ buffer, mimeType, language = DEFAULT_OUTPUT_LANGUAGE, requestId = "unknown" }) {
  if (!VISION_WEB_DETECTION_ENABLED || !buffer?.length) return null;
  const client = await getVisionClient().catch((err) => {
    console.warn("[vision] client unavailable", err?.message || err);
    return null;
  });
  if (!client) return null;

  const tempDir = await mkdtemp(join(tmpdir(), "afterglow-vision-"));
  const tempFilePath = join(tempDir, `lookup${extensionForMimeType(mimeType)}`);

  try {
    await writeFile(tempFilePath, buffer);
    const [result] = await withTimeout(client.webDetection(tempFilePath), VISION_WEB_DETECTION_TIMEOUT_MS, [null]);
    const webDetection = result?.webDetection || null;
    const reference = pickBestWebReference(webDetection, language);
    if (reference) {
      console.info(
        `[vision:${requestId}] ref=${reference.rawName} source=${reference.source} confidence=${reference.confidence}`
      );
    } else {
      console.info(`[vision:${requestId}] no strong web reference`);
    }
    return reference;
  } catch (err) {
    console.warn(`[vision:${requestId}] web detection failed`, err?.message || err);
    return null;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

const EMOJI_RE = /[\p{Extended_Pictographic}\uFE0F]/u;
const SENTENCE_END_RE = /[。！？?]/;

const CHAT_SEARCH_QUESTION_RE =
  /[?？]|(什么|为何|为什么|怎么|如何|哪里|哪儿|哪个|哪国|哪座|哪种|是不是|能不能|介绍|解释|判断|像不像|像哪里|像哪国)/i;
const CHAT_SEARCH_FACTUAL_CUE_RE =
  /(国家|城市|地方|地名|地点|位置|文化|习俗|风俗|传统|节日|宗教|历史|天气|季节|气候|地标|建筑|景点|场景|旅行|旅游|国旗|语言|口音|食物|美食|菜系|货币|时差|签证|常识|知识)/i;
const CHAT_SEARCH_REGION_CUE_RE =
  /(亚洲|欧洲|东南亚|中东|非洲|南美|北美|中国|日本|韩国|泰国|马来西亚|新加坡|印尼|越南|法国|意大利|英国|美国|德国|西班牙|巴黎|东京|首尔|曼谷|吉隆坡)/i;

const COMPANION_CHAT_STYLE_PROMPT_V2 = [
  "你是 Afterglow 里的陪伴型朋友，不是客服，也不是百科。",
  "你的任务是接住用户的情绪，陪他把照片背后的记忆慢慢说出来。",
  "输出规则：",
  "1. 只用简体中文，不要英文，不要解释自己是 AI。",
  `2. 总长度不超过${CHAT_MAX_CHARS}字，最多两句。`,
  "3. 先回应用户此刻的情绪或处境，再自然提到照片里的具体物体、光线、动作或氛围。",
  "4. 语气要像熟悉的朋友，温柔、真诚、轻一点，不说教，不分析腔。",
  "5. 优先用陈述句，不要一上来就提问；前几轮默认不问。",
  "6. 如果用户在提问，先直接回答，再补一句陪伴，不要反问压过去。",
  "7. 只有用户明显卡住、说不知道怎么继续，或系统消息明确允许时，才最多用一个很轻的问题。",
  "8. 避免采访式句型，如“你当时…”“你最想…”“是什么让你…”。",
  "9. 避免空泛套话，如“要开心”“加油”“一切都会好起来”。",
  "10. 避免用“我注意到”“我看出”“从图中”“根据图片”“作为AI”开头。",
].join("\n");

const ANALYZE_IMAGE_PROMPT_V2 = [
  "你是照片分析助手，请用中文返回：vibe、caption、opener、questions。",
  "vibe 要短，像情绪或氛围关键词。",
  "caption 要具体，点到照片里的主体、动作、光线或场景，最好是一句自然中文，不要关键词堆砌。",
  "opener 是首页第一句开场白，只写一句，像朋友第一眼看到这张图时自然会说的话，要具体，不要空泛抒情。",
  "questions 字段仍然保留这个名字，但里面放 2-3 句轻轻续上的话。",
  "这些续话优先用陈述句，少用问句，像朋友顺着情绪接住对方。",
  "避免“你当时…”“你最想…”“是什么让你…”这类采访式问法。",
].join("\n");

const COMPANION_CHAT_STYLE_PROMPT_V3 = [
  COMPANION_CHAT_STYLE_PROMPT_V2,
  "11. 如果对画面主体、媒介、地点、作品名、人物关系拿不准，不要硬认，不要装作看懂了。",
  "12. 拿不准时，先说你确实感受到的颜色、光线、线条、氛围，再轻轻确认“这是什么呀”或“我有点没认出来，它原本是什么？”。",
  "13. 除非画面非常明确，否则不要直接下结论说“这是粘土”“这是某国”“这是某个具体作品”。",
  "14. 避免反复使用同一句套话或同一种开头，每次都根据当前这张图和这轮对话现场组织语言。",
].join("\n");
const COMPANION_CHAT_STYLE_PROMPT_EN = [
  "You are Afterglow's companion voice, not customer support and not an encyclopedia.",
  "Your job is to receive the user's feeling and stay with the memory behind the photo.",
  "Output rules:",
  `1. Reply only in natural English, under ${CHAT_MAX_CHARS_EN} characters when possible, and no more than two short sentences.`,
  "2. Start with the user's current feeling or situation, then naturally touch the concrete object, light, action, or atmosphere in the photo.",
  "3. Sound like a familiar friend: warm, honest, light, and natural. Do not lecture.",
  "4. Prefer statements over questions. Ask only if it is truly needed and only one light question at most.",
  "5. If the user asks something, answer first, then add a gentle line of companionship.",
  "6. Do not overclaim what is in the image. If unsure, say what you can genuinely sense first.",
  "7. Avoid generic comfort lines and avoid reusing the same opening pattern every turn.",
].join("\n");

const ANALYZE_IMAGE_PROMPT_V3 = [
  ANALYZE_IMAGE_PROMPT_V2,
  "如果主体不够明确，caption 不要乱猜媒介、作品名、地点或关系，只描述你确实看见的颜色、形状、光线、构图和氛围。",
  "如果主体不明确，questions 里可以有一句自然确认，例如“这张的颜色一下就把人拉进去了，我有点没认出来，它原本是什么呀？”。",
].join("\n");

const ANALYZE_IMAGE_PROMPT_V4 = [
  ANALYZE_IMAGE_PROMPT_V3,
  "如果画面明显是知名画作、插画、卡通角色或非常强的经典视觉风格，可以在 caption 里自然提到“像某作品”或直接提到角色名。",
  "例如画面非常接近梵高《星夜》时，可以说“像梵高《星夜》那样的旋涡夜空”，不要编造成粘土、手工、装置之类的媒介。",
  "如果主体明显就是史努比、米菲之类很熟悉的角色，caption 和 opener 可以直接提名字，不要故意说得很虚。",
  "除非你非常确定，否则优先用“像”“会让人想到”这种说法，不要武断断言。",
  "opener 禁止写成“这张的光影把情绪收住了”“如果你愿意，可以慢慢和我说”这种空泛句子。",
  "如果主体很明确，opener 要直接点到它，例如“史努比靠着一棵小小的圣诞树，冬天一下就亮起来了。”",
  "如果是明显的经典视觉，可自然说“这片旋涡一样的蓝夜空，很像梵高《星夜》。”",
  "如果是一眼能认出的角色图，opener 可以更像朋友的第一反应，例如“哇，这是史努比和查理布朗吧，这个画面看起来很可爱耶。”",
  "opener 不要擅自补写剧情或主题，比如“他们在过圣诞”“狗屋好温暖”，除非画面表达非常直接。",
  "caption 和 opener 不要重复固定句型，每次都根据这张图现场生成，不要偷懒写成万能文案。",
].join("\n");
const ANALYZE_IMAGE_PROMPT_EN = [
  "You are a photo analysis assistant. Return: vibe, caption, opener, questions.",
  "vibe should be short, like mood or atmosphere keywords.",
  "caption should be specific and mention the main subject, action, light, or scene in natural English.",
  "opener is the first line shown on the home screen. Write one short, conversational English sentence that feels like a friend's first reaction.",
  "questions should contain 2-3 gentle follow-up lines or questions in natural English.",
  "If the image clearly resembles a famous artwork or character, you can mention it naturally.",
  "If the subject is uncertain, do not invent the medium, place, relationship, or work title.",
  "Avoid generic lines. Generate wording based on this exact image.",
].join("\n");

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

function sanitizeChatReply(text, maxChars = CHAT_MAX_CHARS) {
  if (typeof text !== "string") return "";
  return sanitizeModelText(text, { maxChars, language: DEFAULT_OUTPUT_LANGUAGE });
}

function sanitizeModelText(text, { maxChars = CHAT_MAX_CHARS, language = DEFAULT_OUTPUT_LANGUAGE } = {}) {
  if (typeof text !== "string") return "";
  const normalizedLanguage = normalizeOutputLanguage(language);
  const emojiRe = /[\p{Extended_Pictographic}\uFE0F]/u;
  const sentenceEndRe = normalizedLanguage === "en" ? /[.!?]/ : /[。！？?]/;
  const sentenceParts =
    normalizedLanguage === "en" ? text.match(/[^.!?]*[.!?]?/g) || [] : text.match(/[^。！？?]*[。！？?]?/g) || [];

  let cleaned = sentenceParts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .join("");

  if (normalizedLanguage === "zh") {
    cleaned = cleaned.replace(/snoopy/gi, "史努比");
    cleaned = cleaned.replace(/[A-Za-z]/g, "");
    cleaned = cleaned.replace(/\s+/g, "");
    cleaned = cleaned.replace(/^(我注意到|我看出|从图中|根据图片|作为AI|我是AI)+/, "");
    cleaned = cleaned.replace(/^[，。！？、\s]+/, "");
  } else {
    cleaned = cleaned.replace(/\s+/g, " ");
    cleaned = cleaned.replace(/^(i notice|i can see|from the image|as an ai)\b[:,\s-]*/i, "");
    cleaned = cleaned.replace(/^[,.;:!? ]+/, "");
  }

  let count = 0;
  let lastPunctIndex = -1;
  let cutIndexAtMax = cleaned.length;
  let index = 0;

  for (const ch of cleaned) {
    const nextIndex = index + ch.length;
    const isEmoji = emojiRe.test(ch);
    if (!isEmoji) count += 1;
    if (sentenceEndRe.test(ch) && count <= maxChars) {
      lastPunctIndex = nextIndex;
    }
    if (!isEmoji && count === maxChars) {
      cutIndexAtMax = nextIndex;
    }
    index = nextIndex;
  }

  if (count > maxChars) {
    cleaned = lastPunctIndex > 0 ? cleaned.slice(0, lastPunctIndex) : cleaned.slice(0, cutIndexAtMax);
  }

  return cleaned.trim();
}

function looksLikeCatalogOpener(text, language = DEFAULT_OUTPUT_LANGUAGE) {
  const normalized = String(text || "").replace(/\s+/g, "");
  const normalizedLanguage = normalizeOutputLanguage(language);
  if (!normalized) return true;
  if (normalized.length > getOpenerMaxChars(normalizedLanguage) + 6) return true;
  if (
    normalizedLanguage === "zh" &&
    (/(背景是|天空中|画面里|画面中|装饰着|布满|位于|展示了|可以看到)/.test(normalized) ||
      /(查理[·•]布朗和史努比在|一只.+一棵|一个.+旁边是|.+，背景是.+，.+)/.test(normalized))
  ) {
    return true;
  }
  if (
    normalizedLanguage === "en" &&
    (/(background|thesky|theimageshows|decoratedwith|filledwith|locatedin|youcansee)/i.test(normalized) ||
      /(charliebrownandsnoopyare|inthebackground|theskyisfullof|theimageshows)/i.test(normalized))
  ) {
    return true;
  }
  return false;
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

function extractLatestUserText(contents) {
  if (!Array.isArray(contents)) return "";
  for (let index = contents.length - 1; index >= 0; index -= 1) {
    const item = contents[index];
    if (normalizeRole(item?.role) !== "user") continue;
    const text = extractTextFromParts(item?.parts).trim();
    if (text) return text;
  }
  return "";
}

function shouldUseChatGrounding(contents) {
  if (!CHAT_SEARCH_ENABLED) return false;
  const latestUserText = extractLatestUserText(contents);
  if (!latestUserText) return false;
  const normalized = latestUserText.replace(/\s+/g, "");
  const hasQuestionCue = CHAT_SEARCH_QUESTION_RE.test(normalized);
  const hasFactualCue = CHAT_SEARCH_FACTUAL_CUE_RE.test(normalized);
  const hasRegionCue = CHAT_SEARCH_REGION_CUE_RE.test(normalized);
  if (hasFactualCue || hasRegionCue) return true;
  return hasQuestionCue && /(像哪里|像哪国|是哪|在哪|哪里的|真实吗|真的|常识)/i.test(normalized);
}

function buildAnalyzeSystemInstruction(language) {
  const normalizedLanguage = normalizeOutputLanguage(language);
  if (normalizedLanguage === "en") {
    return ANALYZE_IMAGE_PROMPT_EN;
  }
  return [ANALYZE_IMAGE_PROMPT_V4, "所有字符串字段都必须用简体中文。"].join("\n");
}

function buildChatSystemInstruction(useGrounding, language) {
  const normalizedLanguage = normalizeOutputLanguage(language);
  const base =
    normalizedLanguage === "en"
      ? [COMPANION_CHAT_STYLE_PROMPT_EN]
      : [COMPANION_CHAT_STYLE_PROMPT_V3, "所有回复都必须用简体中文，像朋友聊天一样自然。"];
  if (!useGrounding) return base.join("\n");
  return [
    ...base,
    "Use Google Search only when the user is asking about real-world facts, countries, cities, travel context, weather, seasons, culture, or local scenes.",
    "If the query does not depend on outside facts, stay focused on the user's memory and respond naturally without searching.",
    "Never invent location-specific details when search results are weak or absent.",
  ].join("\n");
}

function buildOpeningRewritePrompt(language) {
  return normalizeOutputLanguage(language) === "en" ? OPENING_REWRITE_PROMPT_EN : OPENING_REWRITE_PROMPT;
}

function buildDiarySystemInstruction(language) {
  if (normalizeOutputLanguage(language) === "en") {
    return `You are a ghostwriter for the user's personal memory diary.
You will receive a conversation transcript between the User and Afterglow (AI).

Your task is to write a First-Person Narrative Diary Entry in English based on this conversation.

Writing Style Requirements:
1. Narrative Flow: Write a story. Start with the visual scene, transition to the chat with Afterglow, and end with the inner emotion.
2. Emotional Arc: Capture the contrast between the visible scene and the feeling underneath it.
3. Include the AI: Mention 'Afterglow' or 'Gemini' as a character naturally.
4. Tone: Reflective, intimate, lightly poetic, but still natural.

Output Format:
- title: Poetic 4-8 word title.
- mood: One specific emotion.
- highlights: 2-3 memorable phrases from the chat.
- diary: A paragraph-long entry (150-250 words).
- tags: 3-5 relevant tags.`;
  }
  return `You are a ghostwriter for the user's personal memory diary.
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
- **tags**: 3-5 relevant tags.`;
}

async function generateStructured({ model = DEFAULT_MODEL, systemInstruction, contents, schema, tools, generationConfig }) {
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
    model,
    systemInstructionType: typeof normalized.systemInstruction,
    usesTools: Array.isArray(tools) && tools.length > 0,
    contents: normalized.contents.map((item) => ({
      role: item.role,
      hasText: Array.isArray(item.parts) && item.parts.some((part) => typeof part?.text === "string"),
    })),
  };
  let result;
  try {
    result = await client.models.generateContent({
      model,
      contents: normalized.contents,
      config: {
        systemInstruction: normalized.systemInstruction,
        responseMimeType: "application/json",
        responseJsonSchema: schema,
        ...(generationConfig && typeof generationConfig === "object" ? generationConfig : {}),
        ...(Array.isArray(tools) && tools.length ? { tools } : {}),
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
    opener: { type: "string" },
    questions: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 3 },
  },
  required: ["vibe", "caption", "opener", "questions"],
};

const chatSchema = {
  type: "object",
  properties: {
    text: { type: "string" },
  },
  required: ["text"],
};

async function rewriteOpeningLine({ caption = "", vibe = "", opener = "", language = DEFAULT_OUTPUT_LANGUAGE }) {
  const normalizedLanguage = normalizeOutputLanguage(language);
  const data = await generateStructured({
    model: MODEL_ROUTES.chat,
    systemInstruction: buildOpeningRewritePrompt(normalizedLanguage),
    generationConfig: GENERATION_CONFIGS.chat,
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              normalizedLanguage === "en"
                ? `caption: ${caption || "none"}\nvibe: ${vibe || "none"}\ndraft: ${opener || "none"}`
                : `caption: ${caption || "无"}\nvibe: ${vibe || "无"}\n初稿: ${opener || "无"}`,
          },
        ],
      },
    ],
    schema: chatSchema,
  });
  return typeof data.text === "string" ? data.text : "";
}

async function rewriteOpeningLineV2({
  caption = "",
  vibe = "",
  opener = "",
  language = DEFAULT_OUTPUT_LANGUAGE,
  referenceName = "",
}) {
  const normalizedLanguage = normalizeOutputLanguage(language);
  const localizedReference = localizeReferenceName(referenceName, normalizedLanguage);
  const referenceInstruction = localizedReference
    ? normalizedLanguage === "en"
      ? `A reliable web reference name is available: ${localizedReference}. Mention it naturally if it fits.`
      : `有一个可靠的网络识别名字：${localizedReference}。如果合适，请自然提到它，不要改名。`
    : "";
  const data = await generateStructured({
    model: MODEL_ROUTES.chat,
    systemInstruction: [buildOpeningRewritePrompt(normalizedLanguage), referenceInstruction].filter(Boolean).join("\n"),
    generationConfig: GENERATION_CONFIGS.chat,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `caption: ${caption || "none"}\nvibe: ${vibe || "none"}\ndraft: ${opener || "none"}\nreference: ${localizedReference || "none"}`,
          },
        ],
      },
    ],
    schema: chatSchema,
  });
  return typeof data.text === "string" ? data.text : "";
}

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
    const language = normalizeOutputLanguage(req.body?.language);
    console.info(
      `[analyze:${requestId}] recv size=${req.file.size}B type=${req.file.mimetype || "unknown"}`
    );
    const base64 = req.file.buffer.toString("base64");
    const mimeType = req.file.mimetype || "image/jpeg";
    const webReferencePromise = detectWebReference({
      buffer: req.file.buffer,
      mimeType,
      language,
      requestId,
    });
    const t1 = Date.now();
    console.info(`[analyze:${requestId}] base64 +${t1 - t0}ms`);
    const t2 = Date.now();
    console.info(`[analyze:${requestId}] model=${MODEL_ROUTES.analyze}`);
    const data = await generateStructured({
      model: MODEL_ROUTES.analyze,
      systemInstruction: buildAnalyzeSystemInstruction(language),
      generationConfig: GENERATION_CONFIGS.analyze,
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
    const webReference = await webReferencePromise;
    let caption = typeof data.caption === "string" ? data.caption : "";
    let opener = typeof data.opener === "string" ? data.opener : "";
    if (webReference && !hasReferenceMention(caption, webReference.name, language)) {
      const referenceLabel = localizeReferenceName(webReference.name, language);
      caption = caption
        ? normalizeOutputLanguage(language) === "en"
          ? `${referenceLabel}. ${caption}`
          : `${referenceLabel}，${caption}`
        : referenceLabel;
    }
    if (webReference && !hasReferenceMention(opener, webReference.name, language)) {
      try {
        opener = await rewriteOpeningLineV2({
          caption,
          vibe: typeof data.vibe === "string" ? data.vibe : "",
          opener,
          language,
          referenceName: webReference.name,
        });
      } catch (rewriteErr) {
        console.warn(`[analyze:${requestId}] opener rewrite failed`, rewriteErr);
      }
    } else if (looksLikeCatalogOpener(opener, language)) {
      try {
        opener = await rewriteOpeningLineV2({
          caption,
          vibe: typeof data.vibe === "string" ? data.vibe : "",
          opener,
          language,
        });
      } catch (rewriteErr) {
        console.warn(`[analyze:${requestId}] opener rewrite failed`, rewriteErr);
      }
    }
    if (!webReference && looksLikeCatalogOpener(opener, language)) {
      opener = buildUnknownSubjectOpener(language);
    }

    res.json({
      vibe: typeof data.vibe === "string" ? data.vibe : "",
      caption,
      opener: sanitizeModelText(opener, { maxChars: getOpenerMaxChars(language), language }),
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
    const language = normalizeOutputLanguage(req.body?.language);
    console.info("[chat] incoming roles=", contents.map((item) => item?.role));
    const useGrounding = shouldUseChatGrounding(contents);
    console.info(`[chat] model=${MODEL_ROUTES.chat} grounding=${useGrounding}`);
    const data = await generateStructured({
      model: MODEL_ROUTES.chat,
      systemInstruction: buildChatSystemInstruction(useGrounding, language),
      generationConfig: GENERATION_CONFIGS.chat,
      contents,
      schema: chatSchema,
      tools: useGrounding ? [{ googleSearch: {} }] : undefined,
    });
    const rawText = typeof data.text === "string" ? data.text : "";
    res.json({ text: sanitizeModelText(rawText, { maxChars: getChatMaxChars(language), language }) });
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
    const language = normalizeOutputLanguage(req.body?.language);
    console.info(`[diary] model=${MODEL_ROUTES.diary}`);
    const data = await generateStructured({
      model: MODEL_ROUTES.diary,
      generationConfig: GENERATION_CONFIGS.diary,
      systemInstruction: buildDiarySystemInstruction(language),
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
  console.info(
    "[models]",
    MODEL_ROUTES,
    "chat_search=",
    CHAT_SEARCH_ENABLED,
    "vision_web_detection=",
    VISION_WEB_DETECTION_ENABLED
  );
  console.log(`Afterglow server listening on ${PORT}`);
});
