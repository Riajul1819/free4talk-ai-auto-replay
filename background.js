/* ============================================================================
 * Free4Talk AI Bot — Auto Reply Pro
 * Background service worker
 *
 * Provider routing:
 *   - ChatGPT (gpt-5.6-mini)    → ultra fast / cheap replies
 *   - Gemini (gemini-3.6-flash) → long / detailed replies
 *   - Auto Fallback when primary provider fails
 *
 * Reply-only focus + editable welcome for new users.
 * ========================================================================== */

"use strict";

console.log("🤖 Free4Talk AI Bot background starting…");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENAI_ENDPOINT       = "https://api.openai.com/v1/chat/completions";
const GEMINI_ENDPOINT_BASE  = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENROUTER_ENDPOINT   = "https://openrouter.ai/api/v1/chat/completions";
const NVIDIA_ENDPOINT       = "https://integrate.api.nvidia.com/v1/chat/completions";
const GROQ_ENDPOINT         = "https://api.groq.com/openai/v1/chat/completions";

const DEFAULT_OPENAI_MODEL  = "gpt-4o-mini";
const DEFAULT_GEMINI_MODEL  = "gemini-2.0-flash";
const DEFAULT_NVIDIA_MODEL  = "meta/llama-3.3-70b-instruct";
const DEFAULT_GROQ_MODEL    = "llama-3.3-70b-versatile";

// "Keep every message." We no longer cap chatHistory or the persistent
// slice by a fixed row count — users explicitly asked for the full
// conversation history to survive across sessions, not just the recent
// window. The only hard ceiling that remains is chrome.storage.local's
// own 10 MB quota; the safety prune below (see PERSISTENT_SAFETY_*)
// drops the oldest rows ONLY when we would otherwise exceed it, so the
// extension can never be silently disabled by a quota error.
//
// HISTORY_LIMIT used to truncate chatHistory.shift() on every push.
// It's kept (with a much higher value) only as a defense-in-depth
// against a runaway loop pushing millions of rows into RAM before the
// next persist tick can fingerprint-skip them. 50k rows × ~150 bytes
// each ≈ 7.5 MB in memory — well within reason for a long-running
// service worker, and we should never realistically hit it because the
// persistent slice gets pruned to fit the quota long before that.
const HISTORY_LIMIT       = 50_000;
const STATE_SAVE_INTERVAL = 30_000;
// 0 = persist on the *next* microtask. Persisting synchronously here was
// the single biggest culprit behind "messages take a few seconds to appear":
// any debounce > 1 frame means a user-visible delay between the bubble
// landing in the live DOM and the popup/Memory Manager reflecting it. With
// the microtask queue we still coalesce the user+bot pair into one write
// (both push happen in the same async function), but never delay by wall
// time.
const RUNTIME_SAVE_DEBOUNCE_MS = 0;
const PERSISTENT_HISTORY_KEY = "botPersistentHistory";
// Soft upper bound for the persistent slice. chrome.storage.local is 10 MB
// total; we reserve ~1 MB for config, welcome map, etc. and aim to keep
// the message slice under PERSISTENT_SAFETY_BYTES. When the JSON-encoded
// slice exceeds that, we drop the oldest 10% of rows and try again. Users
// who want true "every message ever" can crank this up; the only reason
// it isn't Infinity is that chrome.storage rejects writes over quota with
// a hard error and we'd lose the latest message too.
const PERSISTENT_SAFETY_BYTES = 9 * 1024 * 1024;
const PERSISTENT_PRUNE_FRACTION = 0.10;
// A monotonically increasing token written to storage so subscribers can
// trivially confirm "I saw the latest state" without having to deep-compare
// arrays. Useful when chrome.storage.onChanged fires for unrelated keys.
const RUNTIME_REV_KEY = "botRuntimeRev";

const DEFAULT_WELCOME_TEMPLATE =
  "Welcome {username}";

const DEFAULT_PERSONA =
  "You are a friendly, sharp, helpful chat partner on Free4Talk. " +
  "Reply naturally like a real person — warm, human, never robotic. " +
  "Never mention being an AI or bot.";

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULTS = {
  botEnabled: true,
  chatRepliesEnabled: true,

  openaiApiKey: "",
  geminiApiKey: "",
  openrouterApiKey: "",
  nvidiaApiKey: "",
  groqApiKey: "",

  openaiModel: DEFAULT_OPENAI_MODEL,
  geminiModel: DEFAULT_GEMINI_MODEL,
  nvidiaModel: DEFAULT_NVIDIA_MODEL,
  groqModel: DEFAULT_GROQ_MODEL,
  autoSwitch: true,
  longReplyThreshold: 140,

  botUsername: "Bot",
  botPersona: DEFAULT_PERSONA,

  shortCharLimit: 160,
  longCharLimit: 600,
  replyDelayMs: 120,

  ignoreSelfMessages: true,
  mentionUserInReply: false,
  onlyReplyWhenMentioned: false,
  replyToPM: true,
  excludedUsernames: [],

  welcomeEnabled: true,
  welcomeTemplate: DEFAULT_WELCOME_TEMPLATE,
  welcomeCooldownMs: 4 * 60 * 60 * 1000,
  welcomeDelaySec: 0,
};

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

let cfg = { ...DEFAULTS };
let chatHistory = [];
let lastBotReplyTo = null;
let lastBotReplyTime = 0;
let lastBotReplyText = "";
let welcomedUsers = {};
let runtimeSaveTimer = null;
let runtimeRev = 0;
// Whenever persistRuntime() runs, it bumps this; setRuntimeDirty() flips
// `runtimeDirty=true` and chains a microtask if no save is pending yet.
let runtimeDirty = false;
let runtimePersistInFlight = null;

// Recent outgoing replies — used by shouldRespond to detect self-echo when
// a message comes back to us with our own bot username on it. Tracking the
// last N replies (not just the last one) closes the "two-message window"
// loop where an older reply still echoes back.
const recentBotReplies = []; // [{ text: string, t: number }]
const RECENT_BOT_REPLIES_TTL_MS = 120_000;
const RECENT_BOT_REPLIES_MAX = 30;

function recordBotReply(text) {
  const t = normalizeEchoText(text);
  if (!t) return;
  const now = Date.now();
  recentBotReplies.push({ text: t, t: now });
  const cutoff = now - RECENT_BOT_REPLIES_TTL_MS;
  while (recentBotReplies.length && recentBotReplies[0].t < cutoff) {
    recentBotReplies.shift();
  }
  if (recentBotReplies.length > RECENT_BOT_REPLIES_MAX) recentBotReplies.shift();
}

function matchesRecentBotReply(content) {
  const c = normalizeEchoText(content);
  if (!c) return false;
  const cutoff = Date.now() - RECENT_BOT_REPLIES_TTL_MS;
  for (const entry of recentBotReplies) {
    if (entry.t < cutoff) continue;
    const a = normalizeEchoText(entry.text);
    if (a === c) return true;
    if (a.length >= 6 && c.startsWith(a)) return true;
    if (c.length >= 6 && a.startsWith(c)) return true;
    if (a.length >= 12 && c.includes(a)) return true;
    if (c.length >= 12 && a.includes(c)) return true;
  }
  return false;
}

/** Same normalization as content script echo matching (unicode ellipsis, NBSP). */
function normalizeEchoText(s) {
  return (s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[`´ʻʼʹˈꞌ＇\u02bc\u02b9]/g, "'")
    .replace(/\*+/g, "")
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u00ab\u00bb]/g, '"')
    .trim()
    .toLowerCase()
    .replace(/[\u2026]+\s*$/g, "")
    .replace(/\.{3,}\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const FRESH_OUTGOING_ECHO_MAX_MS = 25_000;

/**
 * True when this message is almost certainly our own reply echoed from the site
 * under the real account display name (not cfg.botUsername).
 * Uses a short time window + strict similarity to avoid blocking unrelated chat.
 */
function matchesFreshOutgoingEcho(content) {
  const c = normalizeEchoText(content);
  if (c.length < 6) return false;
  const now = Date.now();
  for (const entry of recentBotReplies) {
    if (now - entry.t > FRESH_OUTGOING_ECHO_MAX_MS) continue;
    const a = normalizeEchoText(entry.text);
    if (a.length < 6) continue;
    if (a === c) return true;
    if (a.length >= 10 && c.startsWith(a)) return true;
    if (c.length >= 10 && a.startsWith(c)) return true;
    const maxL = Math.max(a.length, c.length);
    const minL = Math.min(a.length, c.length);
    if (maxL >= 16 && minL / maxL >= 0.82 && (a.includes(c) || c.includes(a))) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeUsername(name) {
  return (name || "").toLowerCase().trim();
}

function escapeRegExp(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Match the bot name as a *whole token* only — never as a substring inside
// another word. This is critical for "Reply only when bot name is mentioned":
// a substring match would falsely trigger on words like "main"/"rain" when
// the bot is named "Ai", or "robot"/"about" when named "Bot".
//
// Uses Unicode-aware boundaries so names with non-ASCII characters are handled
// correctly and do not accidentally match inside larger words.
function isBotNameMentioned(content, botName) {
  const raw = String(content || "");
  const bot = String(botName || "").trim().toLowerCase();
  if (!bot || bot.length < 2) return false;

  // Escape regex metacharacters, then allow flexible whitespace inside
  // multi-word names (e.g. "My Bot" matches "my  bot").
  const escaped = escapeRegExp(bot).replace(/ +/g, "\\s+");

  // Boundary = start/end of string OR any non letter/number/underscore.
  // Optional leading "@" is allowed (e.g. "@Bot").
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}_])@?${escaped}(?:$|[^\\p{L}\\p{N}_])`, "iu");
  return re.test(raw);
}

function safeArr(v) {
  return Array.isArray(v) ? v : [];
}

function clampLen(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

// ---------------------------------------------------------------------------
// Storage / persistence
// ---------------------------------------------------------------------------

async function loadConfig() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  cfg = { ...DEFAULTS, ...stored };
  if (typeof cfg.excludedUsernames === "string") {
    cfg.excludedUsernames = cfg.excludedUsernames
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  cfg.excludedUsernames = safeArr(cfg.excludedUsernames);
  if (cfg.geminiModel === "gemini-2.5-flash") cfg.geminiModel = "gemini-2.0-flash";
  if (cfg.geminiModel === "gemini-2.5-pro") cfg.geminiModel = "gemini-1.5-pro";
  console.log("⚙️  Config loaded:", {
    enabled: cfg.botEnabled,
    autoSwitch: cfg.autoSwitch,
    hasNvidia: !!cfg.nvidiaApiKey,
    hasOpenAI: !!cfg.openaiApiKey,
    hasGemini: !!cfg.geminiApiKey,
    welcome: cfg.welcomeEnabled,
  });
}

// Last-written persistent slice fingerprint, used to skip redundant writes.
// Writing chatHistory unchanged still fires chrome.storage.onChanged in every
// listener, which would in turn cause the popup / Memory Manager to re-render
// even though nothing changed. A cheap length+last-key fingerprint is enough
// here because chatHistory is append-only between mutations.
let lastPersistedFingerprint = "";

function fingerprintForSlice(slice) {
  if (!Array.isArray(slice) || slice.length === 0) return "0|";
  const last = slice[slice.length - 1] || {};
  // Keep the fingerprint short — full content hashes aren't worth the CPU.
  return `${slice.length}|${String(last.username || "")}|${(String(last.content || "")).length}|${last.timestamp ?? ""}|${last.fromAI ? 1 : 0}`;
}

async function persistRuntime() {
  runtimeDirty = false;
  runtimeRev = Date.now();

  // Always write the live (session) slice. Subscribers depend on
  // chrome.storage.session changes for instant UI updates even when the
  // persistent slice didn't move (e.g. after delete-all). We used to cap
  // this at the last 30 rows; the user wants every message preserved, so
  // we now mirror the full chatHistory into session storage too. Session
  // has its own 10 MB quota and the safety prune below keeps us inside it.
  try {
    await chrome.storage.session.set({
      botRuntimeState: {
        chatHistory: chatHistory.slice(),
        lastBotReplyTo,
        lastBotReplyTime,
        lastBotReplyText,
        welcomedUsers,
        // Embedding the most recent server time lets the UI detect a "fresh"
        // update even when content is identical (e.g. a config save races a
        // history write and the snapshot looks the same on a content basis).
        updatedAt: runtimeRev,
        rev: runtimeRev,
      },
    });
  } catch (e) {
    /* session storage may not exist on older builds */
  }

  // Durable chat context across worker/browser restarts (also the source of
  // truth for the Memory Manager UI). We DO write empty slices — that's how
  // RESET_HISTORY propagates to the UI. We only skip writes when the slice
  // is genuinely unchanged so we don't spam chrome.storage.onChanged.
  try {
    // Write the *full* in-memory history. Quota-safe prune below trims the
    // oldest rows ONLY if the JSON payload would exceed PERSISTENT_SAFETY_BYTES.
    let slice = chatHistory.slice();
    // Cheap byte estimate: JSON.stringify().length ≈ byte count for ASCII
    // and a small overestimate for multi-byte characters, which is exactly
    // the direction we want to err on for a "stay under quota" guard.
    let serialized = slice.length === 0 ? "[]" : JSON.stringify(slice);
    if (serialized.length > PERSISTENT_SAFETY_BYTES) {
      // Drop the oldest 10% until we fit. Re-serializing inside the loop
      // is O(N²) in the absolute worst case, but in practice a single
      // pass is enough — the prune fraction is conservative and the JSON
      // size scales linearly with row count.
      const dropPerPass = Math.max(1, Math.ceil(slice.length * PERSISTENT_PRUNE_FRACTION));
      while (serialized.length > PERSISTENT_SAFETY_BYTES && slice.length > 0) {
        slice = slice.slice(dropPerPass);
        serialized = slice.length === 0 ? "[]" : JSON.stringify(slice);
      }
      // Also reflect the prune back to in-memory chatHistory so the next
      // write doesn't have to repeat the work. Without this, every commit
      // would re-prune the same prefix forever.
      chatHistory = slice;
      console.warn(`[persist] pruned oldest rows to fit quota; kept ${slice.length} messages.`);
    }

    const fp = fingerprintForSlice(slice);
    if (fp !== lastPersistedFingerprint) {
      lastPersistedFingerprint = fp;
      if (slice.length === 0) {
        await chrome.storage.local.remove(PERSISTENT_HISTORY_KEY);
      } else {
        await chrome.storage.local.set({
          [PERSISTENT_HISTORY_KEY]: slice,
        });
      }
    }
    // Always bump the rev key so subscribers have a single, cheap signal
    // to listen on. This is important for things like the storage usage
    // bar that should refresh on ANY mutation, not just history writes.
    await chrome.storage.local.set({ [RUNTIME_REV_KEY]: runtimeRev });
  } catch (e) {
    /* ignore local persistence errors */
  }

  // Best-effort push to any open extension page (popup / Memory Manager).
  // If no listener is alive the promise rejects silently — fine, the
  // storage.onChanged path is the durable fallback. This shaves another
  // ~1 frame of latency off the "I sent → I see the bubble" loop.
  try {
    chrome.runtime.sendMessage({
      type: "RUNTIME_STATE_CHANGED",
      rev: runtimeRev,
    }).catch(() => { /* no receiver — fine */ });
  } catch { /* runtime gone (unloading) — ignore */ }
}

// Coalesces back-to-back persistRuntime calls into a single write. With
// RUNTIME_SAVE_DEBOUNCE_MS=0 we still collapse synchronous bursts (push
// twice in the same tick → one write) but never delay by wall time, which
// fixes the visible "messages appear seconds late" complaint.
function queuePersistRuntime() {
  runtimeDirty = true;
  if (runtimePersistInFlight) return runtimePersistInFlight;
  const trigger = async () => {
    try {
      // Loop while writes keep coming in mid-flight, so the final state on
      // disk always reflects the latest in-memory state.
      while (runtimeDirty) {
        await persistRuntime();
      }
    } finally {
      runtimePersistInFlight = null;
    }
  };

  if (RUNTIME_SAVE_DEBOUNCE_MS > 0) {
    runtimePersistInFlight = new Promise((resolve) => {
      runtimeSaveTimer = setTimeout(async () => {
        runtimeSaveTimer = null;
        await trigger();
        resolve();
      }, RUNTIME_SAVE_DEBOUNCE_MS);
    });
  } else {
    // Microtask. Multiple synchronous push() calls in the same tick still
    // collapse into a single write because `trigger`'s while-loop drains
    // `runtimeDirty`.
    runtimePersistInFlight = Promise.resolve().then(trigger);
  }
  return runtimePersistInFlight;
}

async function refreshStrictMentionConfig() {
  try {
    const latest = await chrome.storage.local.get([
      "onlyReplyWhenMentioned",
      "botUsername",
      "botEnabled",
      "chatRepliesEnabled",
      "welcomeEnabled",
      "welcomeDelaySec",
      "openaiApiKey",
      "geminiApiKey",
      "openrouterApiKey",
      "nvidiaApiKey",
      "groqApiKey",
      "openaiModel",
      "geminiModel",
      "nvidiaModel",
      "groqModel",
      "autoSwitch",
      "botPersona",
      "shortCharLimit",
      "longCharLimit",
    ]);
    if (latest.openaiApiKey !== undefined) cfg.openaiApiKey = String(latest.openaiApiKey || "").trim();
    if (latest.geminiApiKey !== undefined) cfg.geminiApiKey = String(latest.geminiApiKey || "").trim();
    if (latest.openrouterApiKey !== undefined) cfg.openrouterApiKey = String(latest.openrouterApiKey || "").trim();
    if (latest.nvidiaApiKey !== undefined) cfg.nvidiaApiKey = String(latest.nvidiaApiKey || "").trim();
    if (latest.groqApiKey !== undefined) cfg.groqApiKey = String(latest.groqApiKey || "").trim();
    if (latest.openaiModel !== undefined) cfg.openaiModel = latest.openaiModel;
    if (latest.geminiModel !== undefined) cfg.geminiModel = latest.geminiModel;
    if (latest.nvidiaModel !== undefined) cfg.nvidiaModel = latest.nvidiaModel;
    if (latest.groqModel !== undefined) cfg.groqModel = latest.groqModel;
    if (latest.autoSwitch !== undefined) cfg.autoSwitch = !!latest.autoSwitch;
    if (latest.botPersona !== undefined) cfg.botPersona = latest.botPersona;
    if (latest.shortCharLimit !== undefined) cfg.shortCharLimit = latest.shortCharLimit;
    if (latest.longCharLimit !== undefined) cfg.longCharLimit = latest.longCharLimit;

    if (latest.onlyReplyWhenMentioned !== undefined) {
      cfg.onlyReplyWhenMentioned = !!latest.onlyReplyWhenMentioned;
    }
    if (latest.botUsername !== undefined) {
      const name = String(latest.botUsername || "").trim();
      cfg.botUsername = name || DEFAULTS.botUsername;
    }
    if (latest.botEnabled !== undefined) {
      cfg.botEnabled = !!latest.botEnabled;
    }
    if (latest.chatRepliesEnabled !== undefined) {
      cfg.chatRepliesEnabled = !!latest.chatRepliesEnabled;
    }
    if (latest.welcomeEnabled !== undefined) {
      cfg.welcomeEnabled = !!latest.welcomeEnabled;
    }
    if (typeof latest.welcomeDelaySec === "number" && Number.isFinite(latest.welcomeDelaySec)) {
      cfg.welcomeDelaySec = latest.welcomeDelaySec;
    }
  } catch {
    // Ignore transient storage read errors; existing cfg remains in effect.
  }
}

async function restoreRuntime() {
  try {
    const r = await chrome.storage.session.get("botRuntimeState");
    const s = r?.botRuntimeState;
    if (s) {
      chatHistory = safeArr(s.chatHistory);
      lastBotReplyTo = s.lastBotReplyTo || null;
      lastBotReplyTime = s.lastBotReplyTime || 0;
      lastBotReplyText = s.lastBotReplyText || "";
      welcomedUsers = s.welcomedUsers || {};
    }
  } catch (e) {
    /* ignore */
  }

  // Fallback to durable local history when session state is missing.
  // Load the FULL persistent slice — capping to HISTORY_LIMIT here would
  // silently throw away exactly the older messages the user just told us
  // to preserve. The 50k row safety ceiling in HISTORY_LIMIT applies to
  // *new* pushes (defense against runaway loops), not to restoring what
  // we've already legitimately saved.
  if (!Array.isArray(chatHistory) || chatHistory.length === 0) {
    try {
      const localData = await chrome.storage.local.get(PERSISTENT_HISTORY_KEY);
      const persistent = safeArr(localData?.[PERSISTENT_HISTORY_KEY]);
      if (persistent.length > 0) {
        chatHistory = persistent.slice();
      }
    } catch (e) {
      /* ignore */
    }
  }
}

setInterval(persistRuntime, STATE_SAVE_INTERVAL);

if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(async () => {
    if (runtimeSaveTimer) {
      clearTimeout(runtimeSaveTimer);
      runtimeSaveTimer = null;
    }
    await persistRuntime();
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const initPromise = (async function init() {
  await restoreRuntime();
  await loadConfig();
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let touched = false;
  for (const key of Object.keys(changes)) {
    if (key in DEFAULTS) {
      cfg[key] = changes[key].newValue;
      touched = true;
    }
  }
  if (touched) {
    cfg.excludedUsernames = safeArr(cfg.excludedUsernames);
  }
});

// Deferred welcome alarms — fired by chrome.alarms after welcomeDelaySec.
// Must be registered at the top level so it survives service-worker restarts
// triggered by the alarm itself.
if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (!alarm || !alarm.name || !alarm.name.startsWith(WELCOME_ALARM_PREFIX)) return;
    try {
      await initPromise;
      const pending = await popPendingWelcome(alarm.name);
      if (!pending) {
        console.log(`[welcome-alarm] no pending payload for ${alarm.name}`);
        return;
      }
      // Re-check the kill switches just before firing — the user may have
      // disabled welcomes / the whole bot during the wait.
      await refreshStrictMentionConfig();
      if (!cfg.botEnabled || !cfg.welcomeEnabled) {
        console.log(`[welcome-alarm] skipped (botEnabled=${cfg.botEnabled}, welcomeEnabled=${cfg.welcomeEnabled})`);
        return;
      }
      const text = pending.text || await buildWelcomeText(pending.username);
      lastBotReplyText = text;
      lastBotReplyTime = Date.now();
      recordBotReply(text);
      await dispatchReply(pending.tabId, text, { username: pending.username, isWelcome: true });
      await queuePersistRuntime();
      console.log(`[welcome-alarm] sent welcome for ${pending.username}`);
    } catch (e) {
      console.error("[welcome-alarm] dispatch failed:", e);
    }
  });
}

// ---------------------------------------------------------------------------
// AI Calls — ChatGPT (OpenAI) & Google Gemini
// ---------------------------------------------------------------------------

function getValidChatGPTModel(model) {
  const validModels = new Set([
    "gpt-4o",
    "gpt-4o-mini",
    "o3-mini",
    "o1",
    "o1-mini",
    "gpt-4.5-preview",
    "gpt-4-turbo",
    "gpt-3.5-turbo"
  ]);
  if (validModels.has(model)) return model;
  return "gpt-4o-mini";
}

function getValidGeminiModel(model) {
  const validModels = new Set([
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite-preview-02-05",
    "gemini-2.0-pro-exp-02-05",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
    "gemini-2.0-flash-thinking-exp-01-21",
    "gemma-2-9b-it",
    "gemma-2-27b-it",
    "gemma-2-2b-it"
  ]);
  if (validModels.has(model)) return model;
  return "gemini-2.0-flash";
}

async function callChatGPT(messages, maxTokens) {
  if (!cfg.openaiApiKey) throw new Error("ChatGPT API key not configured");

  const rawModel = cfg.openaiModel || DEFAULT_OPENAI_MODEL;
  const model = getValidChatGPTModel(rawModel);
  const isReasoning = /^(o1|o3)/i.test(model);

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${cfg.openaiApiKey}`,
  };

  const body = {
    model,
    messages: isReasoning
      ? messages.map((m) => (m.role === "system" ? { ...m, role: "developer" } : m))
      : messages,
  };

  if (isReasoning) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.temperature = 0.7;
    body.max_tokens = maxTokens;
  }

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(OPENAI_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (res.status === 401 || res.status === 403) {
        throw new Error("Invalid ChatGPT API key");
      }
      if (res.status === 429) {
        if (attempt < 3) {
          await sleep(800 * attempt);
          continue;
        }
        throw new Error("ChatGPT rate limit exceeded");
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        let apiErr = "";
        try {
          const parsed = JSON.parse(txt);
          apiErr = parsed?.error?.message || "";
        } catch {}
        throw new Error(apiErr ? `ChatGPT API Error (${res.status}): ${apiErr}` : `HTTP ${res.status} ${txt.slice(0, 200)}`);
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text || typeof text !== "string") {
        throw new Error("Empty response from ChatGPT model");
      }
      return text.trim();
    } catch (err) {
      lastErr = err;
      const msg = (err?.message || "").toLowerCase();
      if (attempt < 3 && (msg.includes("network") || msg.includes("fetch"))) {
        await sleep(500 * attempt);
        continue;
      }
      break;
    }
  }
  throw lastErr || new Error("Unknown ChatGPT error");
}

async function callGemini(messages, maxTokens) {
  if (!cfg.geminiApiKey) throw new Error("Gemini API key not configured");

  const rawModel = cfg.geminiModel || DEFAULT_GEMINI_MODEL;
  const model = getValidGeminiModel(rawModel);

  const endpoint = `${GEMINI_ENDPOINT_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.geminiApiKey)}`;

  const systemMsg = messages.find((m) => m.role === "system");
  const systemInstruction = systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined;

  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const body = {
    contents,
    ...(systemInstruction ? { system_instruction: systemInstruction } : {}),
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: maxTokens,
    },
  };

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
        const txt = await res.text().catch(() => "");
        let apiErr = "";
        try {
          const parsed = JSON.parse(txt);
          apiErr = parsed?.error?.message || "";
        } catch {}
        if (txt.includes("API_KEY_INVALID") || res.status === 401 || res.status === 403) {
          throw new Error("Invalid Gemini API key");
        }
        throw new Error(apiErr ? `Gemini API Error (${res.status}): ${apiErr}` : `Gemini API Error ${res.status}: ${txt.slice(0, 200)}`);
      }
      if (res.status === 429) {
        if (attempt < 3) {
          await sleep(800 * attempt);
          continue;
        }
        throw new Error("Gemini rate limit exceeded");
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${txt.slice(0, 200)}`);
      }

      const data = await res.json();
      const candidate = data?.candidates?.[0];
      if (candidate?.finishReason === "SAFETY") {
        throw new Error("Gemini content flagged by safety filter");
      }

      const text = candidate?.content?.parts?.[0]?.text;
      if (!text || typeof text !== "string") {
        throw new Error("Empty response from Gemini model");
      }
      return text.trim();
    } catch (err) {
      lastErr = err;
      const msg = (err?.message || "").toLowerCase();
      if (attempt < 3 && (msg.includes("network") || msg.includes("fetch"))) {
        await sleep(500 * attempt);
        continue;
      }
      break;
    }
  }
  throw lastErr || new Error("Unknown Gemini error");
}

async function callOpenRouter(messages, maxTokens) {
  if (!cfg.openrouterApiKey) throw new Error("OpenRouter API key not configured");

  const candidateModels = [
    "openrouter/auto",
    "meta-llama/llama-3.3-70b-instruct:free",
    "google/gemini-2.0-flash-lite-preview:free"
  ];
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${cfg.openrouterApiKey}`,
    "HTTP-Referer": "https://free4talk.com",
    "X-Title": "Free4Talk AI Bot",
  };

  let lastErr;
  for (const model of candidateModels) {
    try {
      const res = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
        }),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        let apiErr = "";
        try {
          const parsed = JSON.parse(txt);
          apiErr = parsed?.error?.message || "";
        } catch {}
        throw new Error(apiErr ? `OpenRouter API Error (${res.status}): ${apiErr}` : `HTTP ${res.status} ${txt.slice(0, 200)}`);
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text || typeof text !== "string") {
        throw new Error("Empty response from OpenRouter model");
      }
      return text.trim();
    } catch (err) {
      lastErr = err;
      const msg = (err?.message || "").toLowerCase();
      if (attempt < 3 && (msg.includes("network") || msg.includes("fetch"))) {
        await sleep(500 * attempt);
        continue;
      }
      break;
    }
  }
  throw lastErr || new Error("Unknown OpenRouter error");
}

function getValidNvidiaModel(model) {
  const validModels = new Set([
    "meta/llama-3.3-70b-instruct",
    "nvidia/llama-3.1-nemotron-70b-instruct",
    "deepseek-ai/deepseek-r1",
    "meta/llama-3.1-405b-instruct",
    "meta/llama-3.1-70b-instruct",
    "meta/llama-3.1-8b-instruct",
    "mistralai/mistral-large-2-instruct",
    "mistralai/mixtral-8x22b-instruct",
    "qwen/qwen2.5-72b-instruct",
    "qwen/qwen2.5-coder-32b-instruct",
    "google/gemma-2-27b-it",
    "microsoft/phi-3-medium-4k-instruct"
  ]);
  if (validModels.has(model)) return model;
  return DEFAULT_NVIDIA_MODEL;
}

async function callGroq(messages, maxTokens) {
  if (!cfg.groqApiKey) throw new Error("Groq API key not configured");
  const model = cfg.groqModel || DEFAULT_GROQ_MODEL;
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${cfg.groqApiKey}`,
  };

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(GROQ_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
        }),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        let apiErr = "";
        try {
          const parsed = JSON.parse(txt);
          apiErr = parsed?.error?.message || "";
        } catch {}
        throw new Error(apiErr ? `Groq API Error (${res.status}): ${apiErr}` : `HTTP ${res.status} ${txt.slice(0, 200)}`);
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text || typeof text !== "string") {
        throw new Error("Empty response from Groq model");
      }
      return text.trim();
    } catch (err) {
      lastErr = err;
      const msg = (err?.message || "").toLowerCase();
      if (attempt < 3 && (msg.includes("network") || msg.includes("fetch"))) {
        await sleep(500 * attempt);
        continue;
      }
      break;
    }
  }
  throw lastErr || new Error("Unknown Groq error");
}

async function callNvidia(messages, maxTokens) {
  if (!cfg.nvidiaApiKey) throw new Error("NVIDIA API key not configured");

  const rawModel = cfg.nvidiaModel || DEFAULT_NVIDIA_MODEL;
  const model = getValidNvidiaModel(rawModel);

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${cfg.nvidiaApiKey}`,
  };

  const body = {
    model,
    messages,
    temperature: 0.7,
    max_tokens: maxTokens,
  };

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(NVIDIA_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (res.status === 401 || res.status === 403) {
        throw new Error("Invalid NVIDIA API key");
      }
      if (res.status === 429) {
        if (attempt < 3) {
          await sleep(800 * attempt);
          continue;
        }
        throw new Error("NVIDIA rate limit exceeded");
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        let apiErr = "";
        try {
          const parsed = JSON.parse(txt);
          apiErr = parsed?.error?.message || parsed?.detail || "";
        } catch {}
        throw new Error(apiErr ? `NVIDIA API Error (${res.status}): ${apiErr}` : `HTTP ${res.status} ${txt.slice(0, 200)}`);
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text || typeof text !== "string") {
        throw new Error("Empty response from NVIDIA model");
      }
      return text.trim();
    } catch (err) {
      lastErr = err;
      const msg = (err?.message || "").toLowerCase();
      if (attempt < 3 && (msg.includes("network") || msg.includes("fetch"))) {
        await sleep(500 * attempt);
        continue;
      }
      break;
    }
  }
  throw lastErr || new Error("Unknown NVIDIA error");
}

// ---------------------------------------------------------------------------
// Smart routing — short vs long answers
// ---------------------------------------------------------------------------

const LONG_KEYWORDS_RE =
  /\b(advice|help|suggest|recommend|how do i|how to|how can|what should|guide|tips|teach|explain|tutorial|why does|why is|differen[ct])\b/i;
// Use \s+ between "room" and "info" so NBSP (U+00A0) from the site still matches.
const ROOM_INFO_RE =
  /\b(room\s+info|language\s*:|topic\s*:|participants?\s*:|country\s*:|level\s*:|room rules?)\b/i;

function normalizeForRoomMeta(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function isRoomInfoLikeMessage(content) {
  const n = normalizeForRoomMeta(content);
  if (!n) return false;
  if (ROOM_INFO_RE.test(n)) return true;
  if (/room\s+info/i.test(n) && /\b(change|changed|update|updated)\b/i.test(n)) {
    return true;
  }
  return false;
}

function needsLongAnswer(content) {
  if (!content) return false;
  const len = content.length;
  const hasQ = content.includes("?");
  const hasKw = LONG_KEYWORDS_RE.test(content);

  if (hasKw && (hasQ || len > 60)) return true;
  if (hasQ && len > cfg.longReplyThreshold) return true;
  if (len > cfg.longReplyThreshold * 1.5) return true;
  return false;
}

function pickProvider(message) {
  const haveGroq = !!(cfg.groqApiKey && cfg.groqApiKey.trim());
  const haveNvidia = !!(cfg.nvidiaApiKey && cfg.nvidiaApiKey.trim());
  const haveGemini = !!(cfg.geminiApiKey && cfg.geminiApiKey.trim());
  const haveOpenAI = !!(cfg.openaiApiKey && cfg.openaiApiKey.trim());
  const haveOpenRouter = !!(cfg.openrouterApiKey && cfg.openrouterApiKey.trim());

  if (haveGroq) return "groq";
  if (haveNvidia) return "nvidia";
  if (haveGemini) return "gemini";
  if (haveOpenAI) return "chatgpt";
  if (haveOpenRouter) return "openrouter";
  return null;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildSystemPrompt(targetUser, isLong) {
  const charLimit = isLong ? cfg.longCharLimit : cfg.shortCharLimit;
  const persona = (cfg.botPersona || DEFAULT_PERSONA).trim();

  let mentionRule;
  if (cfg.mentionUserInReply && targetUser) {
    mentionRule =
      `When relevant, naturally address ${targetUser} by name once near the start. ` +
      "Do not over-mention or @-tag — keep it like real human conversation.";
  } else {
    mentionRule = "Do not address the user by name — reply naturally.";
  }

  const lengthRule = isLong
    ? `This is a help/advice request. You may use up to ${charLimit} characters. Be clear, practical, friendly. No fluff.`
    : `Keep it short and natural — max ${charLimit} characters. 1–2 sentences for casual chat.`;

  return [
    persona,
    "",
    "STYLE RULES:",
    "- Sound like a real person on a chat app, not an assistant.",
    "- Never say you are AI, model, bot, GPT, LLM, or assistant.",
    "- No corporate disclaimers, no lectures.",
    "- Match the user's energy — playful with playful, calm with calm.",
    "- Never start your reply with your own name.",
    "- Never prefix replies like 'BotName:' or 'Name -'.",
    "- " + lengthRule,
    "- " + mentionRule,
  ].join("\n");
}

function buildMessages(message, history, isLong) {
  const systemPrompt = buildSystemPrompt(message.username, isLong);

  // Keep recent 6 messages to minimize input token usage while retaining conversation context
  const histMsgs = history.slice(-6).map((m) => ({
    role: m.fromAI ? "assistant" : "user",
    content: `${m.username}: ${m.content}`,
  }));

  const userTurn = {
    role: "user",
    content: `${message.username}: ${message.content}\n\nReply naturally in-chat. Do not include your name in the reply.`,
  };

  return [
    { role: "system", content: systemPrompt },
    ...histMsgs,
    userTurn,
  ];
}

// ---------------------------------------------------------------------------
// Should-respond decision
// ---------------------------------------------------------------------------

function shouldRespond(message) {
  if (!cfg.botEnabled) return { ok: false, reason: "bot_disabled" };
  // Chat-replies kill switch — independent from welcomeEnabled so users can
  // greet new joiners while keeping ongoing chat auto-replies silenced.
  if (cfg.chatRepliesEnabled === false) return { ok: false, reason: "chat_replies_disabled" };

  const username = message.username || "";
  const content  = (message.content || "").trim();
  const lc       = content.toLowerCase();
  const botLC    = normalizeUsername(cfg.botUsername);
  const userLC   = normalizeUsername(username);

  if (!content) return { ok: false, reason: "empty" };

  // Never auto-reply to room metadata / join context messages.
  if (isRoomInfoLikeMessage(content) || userLC === "room info") {
    return { ok: false, reason: "room_info" };
  }

  // Only ignore messages if their text matches an actual recent outgoing bot reply
  if (cfg.ignoreSelfMessages && (matchesFreshOutgoingEcho(content) || matchesRecentBotReply(content))) {
    return { ok: false, reason: "self_echo_recent_outgoing" };
  }

  const sysUsers = ["free4talk system", "coffee notification", "system"];
  if (sysUsers.includes(userLC)) {
    return { ok: false, reason: "system_user" };
  }

  if (cfg.excludedUsernames.map(normalizeUsername).includes(normalizeUsername(username))) {
    return { ok: false, reason: "excluded" };
  }

  if (message.isPM && !cfg.replyToPM) {
    return { ok: false, reason: "pm_disabled" };
  }

  // Strict mention mode: reply ONLY when exact configured bot name is
  // explicitly mentioned in content.
  if (cfg.onlyReplyWhenMentioned) {
    const named = !!message.botMentioned || isBotNameMentioned(content, cfg.botUsername);
    if (!named) {
      return { ok: false, reason: "mention_only_mode" };
    }
    return { ok: true, reason: "name_mentioned_strict" };
  }

  if (message.replyTo && message.replyTo.username) {
    if (normalizeUsername(message.replyTo.username) === botLC) {
      return { ok: true, reason: "reply_to_bot" };
    }
  }

  if (isBotNameMentioned(content, cfg.botUsername)) {
    return { ok: true, reason: "name_mentioned" };
  }

  const now = Date.now();
  if (lastBotReplyTo === normalizeUsername(username) && now - lastBotReplyTime < 60_000) {
    if (lc.length > 3 && !/^(ok|cool|nice|lol|haha|yeah|yup|nope|ty|thanks)$/i.test(lc)) {
      return { ok: true, reason: "followup" };
    }
  }

  if (lc.includes("?") || /^(what|how|why|who|where|when|can\s|could\s|is\s|are\s|do\s|does\s|did\s|would\s|should\s|tell\s)/i.test(lc)) {
    return { ok: true, reason: "question" };
  }

  if (LONG_KEYWORDS_RE.test(lc)) {
    return { ok: true, reason: "engagement_keyword" };
  }

  if (lc.length > 30) {
    return { ok: true, reason: "substantial_message" };
  }

  // Fail-open for reliability: reply to any normal non-empty room message.
  if (lc.length >= 1) {
    return { ok: true, reason: "fallback_any_message" };
  }

  return { ok: false, reason: "not_relevant" };
}

// ---------------------------------------------------------------------------
// Reply generation
// ---------------------------------------------------------------------------

async function generateReply(message) {
  const provider = pickProvider(message);
  if (!provider) {
    throw new Error("No API key configured. Add Groq, NVIDIA, ChatGPT, Gemini, or OpenRouter API key in popup.");
  }

  const isLong  = cfg.autoSwitch && needsLongAnswer(message.content);
  const messages = buildMessages(message, chatHistory, isLong);
  const maxTok   = isLong ? Math.ceil(cfg.longCharLimit / 3) + 80 : Math.ceil(cfg.shortCharLimit / 3) + 40;

  console.log(`🚀 Reply via ${provider} (${isLong ? "long" : "short"} mode)`);

  let text;
  try {
    text = provider === "groq"
      ? await callGroq(messages, maxTok)
      : provider === "nvidia"
      ? await callNvidia(messages, maxTok)
      : provider === "gemini"
      ? await callGemini(messages, maxTok)
      : provider === "openrouter"
      ? await callOpenRouter(messages, maxTok)
      : await callChatGPT(messages, maxTok);
  } catch (err) {
    const fallback = provider !== "groq" && cfg.groqApiKey ? "groq"
                    : provider !== "nvidia" && cfg.nvidiaApiKey ? "nvidia"
                    : provider !== "gemini" && cfg.geminiApiKey ? "gemini"
                    : provider !== "chatgpt" && cfg.openaiApiKey ? "chatgpt"
                    : provider !== "openrouter" && cfg.openrouterApiKey ? "openrouter"
                    : null;
    if (fallback) {
      console.warn(`⚠️ ${provider} failed (${err.message}); falling back to ${fallback}`);
      text = fallback === "groq"
        ? await callGroq(messages, maxTok)
        : fallback === "nvidia"
        ? await callNvidia(messages, maxTok)
        : fallback === "gemini"
        ? await callGemini(messages, maxTok)
        : fallback === "openrouter"
        ? await callOpenRouter(messages, maxTok)
        : await callChatGPT(messages, maxTok);
    } else {
      throw err;
    }
  }

  const botName = (cfg.botUsername || "").trim();
  if (botName) {
    const esc = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const botPrefixRe = new RegExp(`^[\\s"'` + "`" + `]*${esc}\\s*[:\\-–—]\\s*`, "i");
    text = text.replace(botPrefixRe, "");
  }
  text = text.replace(/^[\s"'`]*(\w+\s*:\s*)?/, "").trim();

  const limit = isLong ? cfg.longCharLimit : cfg.shortCharLimit;
  return clampLen(text, limit);
}

// ---------------------------------------------------------------------------
// Welcome handling
// ---------------------------------------------------------------------------

// Pending welcomes scheduled via chrome.alarms. Stored to storage so they
// survive service-worker shutdown (MV3 SWs idle out aggressively, which is
// exactly why `setTimeout` for the welcome delay didn't work before).
const PENDING_WELCOMES_KEY = "botPendingWelcomes";
const WELCOME_ALARM_PREFIX = "f4tWelcome:";

async function getPendingWelcomes() {
  try {
    const r = await chrome.storage.local.get(PENDING_WELCOMES_KEY);
    const map = r?.[PENDING_WELCOMES_KEY];
    return (map && typeof map === "object") ? map : {};
  } catch {
    return {};
  }
}

async function savePendingWelcomes(map) {
  try {
    await chrome.storage.local.set({ [PENDING_WELCOMES_KEY]: map });
  } catch {
    /* ignore */
  }
}

async function addPendingWelcome(alarmName, payload) {
  const map = await getPendingWelcomes();
  map[alarmName] = payload;
  await savePendingWelcomes(map);
}

async function popPendingWelcome(alarmName) {
  const map = await getPendingWelcomes();
  const item = map[alarmName];
  if (item) {
    delete map[alarmName];
    await savePendingWelcomes(map);
  }
  return item || null;
}

async function buildWelcomeText(username) {
  // Always read the template from storage just before composing. Welcome
  // events are rare and infrequent enough that the extra read is free, and
  // it eliminates a class of bugs where cfg.welcomeTemplate goes stale
  // (e.g. service worker just woke from idle, popup save raced this handler,
  // multi-tab edits, etc.) and we silently fall back to DEFAULT_WELCOME_TEMPLATE.
  let tplValue = cfg.welcomeTemplate;
  try {
    const stored = await chrome.storage.local.get("welcomeTemplate");
    if (typeof stored?.welcomeTemplate === "string" && stored.welcomeTemplate.trim()) {
      tplValue = stored.welcomeTemplate;
      cfg.welcomeTemplate = tplValue;
    }
  } catch {
    /* fall through to in-memory cfg */
  }
  const tpl = (tplValue || DEFAULT_WELCOME_TEMPLATE).trim();
  const safeName = String(username || "friend").replace(/`+/g, "").trim() || "friend";
  return tpl.replace(/\{username\}/gi, safeName).trim();
}

function buildFallbackReply(message, err) {
  const name = (message?.username || "").trim();
  const prefix = cfg.mentionUserInReply && name ? `${name}, ` : "";
  const hasKey = !!(cfg.openaiApiKey && cfg.openaiApiKey.trim()) || !!(cfg.geminiApiKey && cfg.geminiApiKey.trim());

  if (!hasKey) {
    return clampLen(`${prefix}Please add your ChatGPT or Gemini API key in the extension popup to enable AI replies!`, cfg.shortCharLimit);
  }
  const errText = (err?.message || "").toLowerCase();
  if (errText.includes("api key") || errText.includes("401") || errText.includes("403")) {
    return clampLen(`${prefix}API key error. Please check your ChatGPT / Gemini key in popup.`, cfg.shortCharLimit);
  }
  return clampLen(`${prefix}Sorry, AI service is temporarily busy. Please try again in a moment.`, cfg.shortCharLimit);
}

function pruneWelcomedUsers(now) {
  const cutoff = now - cfg.welcomeCooldownMs;
  let pruned = false;
  for (const k of Object.keys(welcomedUsers)) {
    if (welcomedUsers[k] < cutoff) {
      delete welcomedUsers[k];
      pruned = true;
    }
  }
  return pruned;
}

function shouldWelcome(username) {
  if (!cfg.botEnabled) return false;
  if (!cfg.welcomeEnabled) return false;
  // Join welcomes are controlled by welcomeEnabled; strict mention mode applies
  // to normal chat messages only, so a user can require @mentions for AI
  // replies while still using auto-greet on join.
  if (!username) return false;
  const norm = normalizeUsername(username);
  if (norm === normalizeUsername(cfg.botUsername)) return false;
  if (cfg.excludedUsernames.map(normalizeUsername).includes(norm)) return false;

  const now = Date.now();
  pruneWelcomedUsers(now);

  const last = welcomedUsers[norm];
  if (last && now - last < cfg.welcomeCooldownMs) return false;

  welcomedUsers[norm] = now;
  return true;
}

// ---------------------------------------------------------------------------
// Reply dispatch
// ---------------------------------------------------------------------------

async function dispatchReply(tabId, text, originalMessage) {
  if (!tabId) return;
  if (cfg.replyDelayMs > 0) await sleep(cfg.replyDelayMs);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "SEND_REPLY",
      data: { text, originalMessage },
    });
  } catch (err) {
    console.error("Failed to send reply to tab:", err);
  }
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  (async () => {
    try {
      await initPromise;
      switch (req?.type) {
        case "PING_CONFIG": {
          sendResponse({ ok: true, config: cfg });
          return;
        }
        
        case "UPDATE_BOT_STATUS": {
          cfg.botEnabled = !!req.enabled;
          await chrome.storage.local.set({ botEnabled: cfg.botEnabled });
          sendResponse({ ok: true });
          return;
        }

        case "RESET_HISTORY": {
          chatHistory = [];
          lastBotReplyTo = null;
          lastBotReplyTime = 0;
          lastBotReplyText = "";
          welcomedUsers = {};
          if (runtimeSaveTimer) { clearTimeout(runtimeSaveTimer); runtimeSaveTimer = null; }
          // Force the fingerprint cache to invalidate so the empty slice
          // actually gets written (otherwise lastPersistedFingerprint may
          // match the previous "0|" and we'd skip the write entirely).
          lastPersistedFingerprint = "__reset__";
          await persistRuntime();
          await chrome.storage.local.remove(["botMemoryUi"]);
          sendResponse({ ok: true });
          return;
        }

        case "DELETE_MEMORY_ITEMS": {
          // Delete by stable "key" (username + content + fromAI + timestamp).
          // We can't use array index because the live (session) and persistent
          // (local) slices can disagree, and trusting an index from one of them
          // would silently delete the wrong row in the other.
          const keys = new Set(safeArr(req.keys).map(String));
          if (keys.size === 0) {
            sendResponse({ ok: false, reason: "no_keys" });
            return;
          }
          const keyOf = (m) =>
            `${String(m.username || "")}\u0001${String(m.content || "")}\u0001${m.fromAI ? "1" : "0"}\u0001${m.timestamp ?? ""}`;

          const filterFn = (arr) => safeArr(arr).filter((m) => !keys.has(keyOf(m)));

          chatHistory = filterFn(chatHistory);

          let removed = 0;
          try {
            const localData = await chrome.storage.local.get(PERSISTENT_HISTORY_KEY);
            const persistent = safeArr(localData?.[PERSISTENT_HISTORY_KEY]);
            const next = filterFn(persistent);
            removed = persistent.length - next.length;
            // Bypass the fingerprint cache — the persistent slice is being
            // truncated by the same number of rows the in-memory slice was,
            // so the cached fingerprint may incorrectly mark the next
            // persistRuntime() as a no-op.
            lastPersistedFingerprint = "__deleted__";
            if (next.length === 0) {
              await chrome.storage.local.remove(PERSISTENT_HISTORY_KEY);
            } else {
              await chrome.storage.local.set({ [PERSISTENT_HISTORY_KEY]: next });
            }
          } catch (e) {
            console.warn("DELETE_MEMORY_ITEMS persistent write failed:", e?.message || e);
          }

          await persistRuntime();
          sendResponse({ ok: true, removed, remaining: chatHistory.length });
          return;
        }

        case "STORAGE_USAGE": {
          // chrome.storage.local is 10 MB on Chrome 114+ (5 MB on older
          // builds). Prefer the live constant the browser exposes so the bar
          // matches reality on every channel; only fall back when missing.
          const localQuota = (chrome.storage.local.QUOTA_BYTES) || (10 * 1024 * 1024);
          const sessionQuota = (chrome.storage.session?.QUOTA_BYTES) || (10 * 1024 * 1024);

          let localBytes = 0;
          let sessionBytes = 0;
          let historyBytes = 0;
          try {
            localBytes = await chrome.storage.local.getBytesInUse(null);
          } catch (e) { /* not supported on some channels */ }
          try {
            historyBytes = await chrome.storage.local.getBytesInUse(PERSISTENT_HISTORY_KEY);
          } catch (e) { /* ignore */ }
          try {
            if (chrome.storage.session?.getBytesInUse) {
              sessionBytes = await chrome.storage.session.getBytesInUse(null);
            }
          } catch (e) { /* ignore */ }

          sendResponse({
            ok: true,
            local: { used: localBytes, quota: localQuota, historyUsed: historyBytes },
            session: { used: sessionBytes, quota: sessionQuota },
            limits: {
              historyLimit: HISTORY_LIMIT,
              // No fixed row cap on the persistent slice anymore — we keep
              // every message until we'd otherwise exceed the byte budget.
              // Surface the byte budget instead so the Memory Manager can
              // show "X of Y MB used" if it wants.
              persistentSafetyBytes: PERSISTENT_SAFETY_BYTES,
            },
            rev: runtimeRev,
          });
          return;
        }

        case "GET_RUNTIME_STATE": {
          // Direct snapshot for UIs that want to bootstrap without going
          // through chrome.storage. Faster than a storage round-trip when
          // the worker is already warm. Return the full in-memory history;
          // the safety prune in persistRuntime() is the only thing that
          // ever drops rows, and once a row is gone from chatHistory we
          // genuinely don't have it to hand back.
          sendResponse({
            ok: true,
            rev: runtimeRev,
            chatHistory: chatHistory.slice(),
            lastBotReplyTo,
            lastBotReplyTime,
            lastBotReplyText,
            welcomedUsers,
          });
          return;
        }

        case "JOIN_NOTIFICATION": {
          const { username } = req.data || {};
          // refreshStrictMentionConfig now also re-pulls botEnabled /
          // welcomeEnabled / chatRepliesEnabled / welcomeDelaySec so a stale
          // service-worker cfg doesn't ignore the latest popup edits.
          await refreshStrictMentionConfig();
          if (!shouldWelcome(username)) {
            sendResponse({ ok: true, sent: false });
            return;
          }
          const text = await buildWelcomeText(username);
          const tabId = sender?.tab?.id;

          // Free-form delay: clamp only the lower bound. The user explicitly
          // asked for no upper cap, so a 2-hour wait is allowed if they type
          // 7200. NaN / negative / non-numeric → fall back to 0 = immediate.
          const rawDelay = Number(cfg.welcomeDelaySec);
          const delaySec = Number.isFinite(rawDelay) && rawDelay > 0 ? Math.floor(rawDelay) : 0;

          // Tiny delays (≤ 3s) stay inline — service worker won't shut down
          // that fast and the latency keeps the welcome feeling natural.
          if (delaySec <= 3) {
            if (delaySec > 0) await sleep(delaySec * 1000);
            lastBotReplyText = text;
            lastBotReplyTime = Date.now();
            recordBotReply(text);
            await dispatchReply(tabId, text, { username, isWelcome: true });
            await queuePersistRuntime();
            sendResponse({ ok: true, sent: true, text, delayedSec: delaySec });
            return;
          }

          // Real delay → use chrome.alarms so the worker can sleep and still
          // fire the welcome at the right time. setTimeout/sleep does NOT
          // survive MV3 service-worker shutdown — that was the original bug.
          const alarmName = `${WELCOME_ALARM_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          await addPendingWelcome(alarmName, { username, text, tabId, scheduledAt: Date.now() });

          // chrome.alarms uses minutes; convert seconds → minutes.
          // Packed extensions clamp delays below 30s up to 30s — we surface
          // this in the popup help text so users aren't surprised.
          const delayInMinutes = delaySec / 60;
          try {
            chrome.alarms.create(alarmName, { delayInMinutes });
            console.log(`[welcome] scheduled alarm ${alarmName} for ${username} in ${delaySec}s`);
          } catch (e) {
            console.error("[welcome] alarm create failed; firing inline:", e);
            await popPendingWelcome(alarmName);
            lastBotReplyText = text;
            lastBotReplyTime = Date.now();
            recordBotReply(text);
            await dispatchReply(tabId, text, { username, isWelcome: true });
            await queuePersistRuntime();
          }

          sendResponse({ ok: true, sent: true, text, delayedSec: delaySec, alarmName });
          return;
        }

        case "NEW_MESSAGE": {
          const data = req.data;
          if (!data || !data.username || !data.content) {
            sendResponse({ ok: false, reason: "invalid" });
            return;
          }

          // Guard against stale service-worker config after popup edits.
          await refreshStrictMentionConfig();

          // Drop echoes before mutating history (content script can still race).
          if (cfg.ignoreSelfMessages && matchesFreshOutgoingEcho(data.content)) {
            sendResponse({ ok: true, replied: false, reason: "self_echo_recent_outgoing" });
            return;
          }

          // Always stamp incoming messages with epoch ms in addition to any
          // human-readable string the content script supplied. tsToMs() in
          // the UI falls back to "today" when it can't parse a string, which
          // broke date filtering and broke the "Recent (24h)" stat for any
          // user message older than the current popup session.
          const incomingTs = (typeof data.timestamp === "number" && Number.isFinite(data.timestamp))
            ? data.timestamp
            : Date.now();
          const incomingDisplayTs = (typeof data.timestamp === "string" && data.timestamp.trim())
            ? data.timestamp
            : new Date(incomingTs).toLocaleTimeString();
          chatHistory.push({
            ...data,
            fromAI: false,
            timestamp: incomingTs,
            displayTime: incomingDisplayTs,
          });
          if (chatHistory.length > HISTORY_LIMIT) chatHistory.shift();
          // Persist immediately so the popup / Memory Manager sees the
          // user-side message render before the AI reply lands (which can
          // take 1–3 seconds). We deliberately AWAIT the queued write so
          // any subscribers see the user bubble *before* the AI reply pass
          // schedules its own write — keeps the visual ordering stable
          // even when the popup is on a slow connection / cold worker.
          await queuePersistRuntime();

          const decision = shouldRespond(data);
          if (!decision.ok) {
            sendResponse({ ok: true, replied: false, reason: decision.reason });
            return;
          }

          let text = "";
          try {
            text = await generateReply(data);
          } catch (err) {
            console.warn("AI generation failed; using fallback reply:", err?.message || err);
            text = buildFallbackReply(data, err);
          }
          if (!text) {
            sendResponse({ ok: true, replied: false, reason: "empty_reply" });
            return;
          }

          const replyTs = Date.now();
          chatHistory.push({
            username: cfg.botUsername,
            content: text,
            fromAI: true,
            timestamp: replyTs,
            displayTime: new Date(replyTs).toLocaleTimeString(),
          });
          if (chatHistory.length > HISTORY_LIMIT) chatHistory.shift();

          lastBotReplyTo   = normalizeUsername(data.username);
          lastBotReplyTime = Date.now();
          lastBotReplyText = text;
          recordBotReply(text);

          const tabId = sender?.tab?.id;
          await dispatchReply(tabId, text, data);
          await queuePersistRuntime();

          sendResponse({ ok: true, replied: true, text, reason: decision.reason });
          return;
        }

        default:
          sendResponse({ ok: false, reason: "unknown_request" });
      }
    } catch (err) {
      console.error("Background error:", err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});

console.log("✅ Free4Talk AI Bot background ready");
