function readSetting(key) {
  const v = localStorage.getItem(key);
  return v == null ? "" : v;
}

export function isGeminiEnabled() {
  // Default enabled when missing, matching options default.
  const raw = localStorage.getItem("geminiEnabled");
  return raw == null ? true : raw === "true";
}

function isGeminiDebugLoggingEnabled() {
  return localStorage.getItem("geminiDebugLogging") === "true";
}

function normalizeGeminiModelName(input) {
  let m = String(input || "").trim();
  if (!m) return "";

  // Allow users to paste a full REST path or URL.
  // Examples:
  // - models/gemini-2.5-flash
  // - https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent
  // - https://.../models/gemini-3-flash-preview:generateContent?key=...
  // Strip querystring/fragment early.
  const q = m.indexOf("?");
  if (q >= 0) m = m.substring(0, q);
  const hash = m.indexOf("#");
  if (hash >= 0) m = m.substring(0, hash);

  const modelsMarker = "/models/";
  const idx = m.lastIndexOf(modelsMarker);
  if (idx >= 0) {
    m = m.substring(idx + modelsMarker.length);
  }

  // Strip leading "models/" if present.
  if (m.startsWith("models/")) {
    m = m.substring("models/".length);
  }

  // If user pasted "gemini-2.5-flash:generateContent" or similar, keep only the model name.
  const colon = m.indexOf(":");
  if (colon >= 0) {
    m = m.substring(0, colon);
  }

  // If user pasted some other path-like value, use the last segment.
  if (m.includes("/")) {
    const parts = m.split("/").filter(Boolean);
    m = parts[parts.length - 1] || m;
  }

  // Final cleanup: remove stray whitespace.
  m = m.replace(/\s+/g, "").trim();
  return m.trim();
}

export function getGeminiConfig() {
  const apiKey = readSetting("geminiApiKey").trim();
  const model = normalizeGeminiModelName(readSetting("geminiModel") || "gemini-2.5-flash");
  return {apiKey, model};
}

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return String(obj);
  }
}

function extractGeminiMeta(data) {
  return {
    finishReason: data?.candidates?.[0]?.finishReason,
    safetyRatings: data?.candidates?.[0]?.safetyRatings,
    usageMetadata: data?.usageMetadata
  };
}

export function extractTextFromGeminiResponse(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map(p => p?.text).filter(Boolean).join("")
    : "";

  if (text) return text;

  const apiError =
    data?.error?.message
    || data?.promptFeedback?.blockReason
    || data?.candidates?.[0]?.finishReason;

  throw new Error(apiError || ("Gemini returned an unexpected response: " + safeJsonStringify(data)));
}

export async function geminiGenerate({
  apiKey,
  model,
  systemInstruction,
  userPrompt,
  temperature = 0.2,
  maxOutputTokens = 20000,
  signal
}) {
  if (!apiKey) {
    throw new Error("Missing Gemini API key. Set it in Options → Management.");
  }
  const normalizedModel = normalizeGeminiModelName(model);
  if (!normalizedModel) {
    throw new Error("Missing Gemini model. Set it in Options → Management.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(normalizedModel)}:generateContent`;

  const body = {
    contents: [
      {role: "user", parts: [{text: String(userPrompt || "")}]}
    ],
    generationConfig: {
      temperature,
      maxOutputTokens
    }
  };

  if (systemInstruction) {
    body.systemInstruction = {parts: [{text: String(systemInstruction)}]};
  }

  if (isGeminiDebugLoggingEnabled()) {
    console.log("[Gemini] Request", {
      model: normalizedModel,
      temperature,
      maxOutputTokens,
      systemInstruction: String(systemInstruction || ""),
      userPrompt: String(userPrompt || "")
    });
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify(body),
    signal
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `${res.status} ${res.statusText}`.trim();
    throw new Error("Gemini request failed: " + msg);
  }

  const text = extractTextFromGeminiResponse(json);
  if (isGeminiDebugLoggingEnabled()) {
    const meta = extractGeminiMeta(json);
    console.log("[Gemini] Response", {
      model: normalizedModel,
      finishReason: meta.finishReason,
      usageMetadata: meta.usageMetadata,
      responseText: text
    });
  }

  return text;
}

function stripCodeFences(text) {
  // Prefer first fenced block if present.
  const fence = text.match(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  return text.trim();
}

function stripXmlTag(text, tagName) {
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

export function extractQueryFromResponse(text, {kind} = {}) {
  if (!text) return "";
  const trimmed = String(text).trim();

  // Common patterns from other parts of the codebase (Agentforce uses <soql>).
  const tagged =
    stripXmlTag(trimmed, "soql")
    || (kind === "sql" ? stripXmlTag(trimmed, "sql") : null)
    || stripXmlTag(trimmed, "query");
  if (tagged) return stripCodeFences(tagged);

  return stripCodeFences(trimmed);
}

