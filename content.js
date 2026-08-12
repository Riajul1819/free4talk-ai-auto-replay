/* ============================================================================
 * Free4Talk AI Bot — content script
 * - Detects new chat messages and join notifications
 * - Sends fast replies (textarea + send button)
 * - Reply-only focus (no reactions, no PM cancel)
 * ========================================================================== */

(() => {
  "use strict";

  if (window.__F4T_AI_BOT_LOADED__) {
    console.warn("[F4T-AI] Already loaded; skipping re-init.");
    return;
  }
  window.__F4T_AI_BOT_LOADED__ = true;

  console.log("✅ Free4Talk AI Bot content script loaded");

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const STORAGE_KEY_REPLIED = "f4tReplyBotReplied";
  const STORAGE_KEY_WELCOMED = "f4tReplyBotWelcomed";
  const MAX_STORED_IDS = 500;
  const JOIN_SILENCE_MS = 60_000;
  const DEDUP_SAVE_DEBOUNCE_MS = 1200;
  const ROOM_CHECK_INTERVAL_MS = 3000;
  const OBSERVER_REBIND_INTERVAL_MS = 10_000;
  const FALLBACK_SCAN_INTERVAL_MS = 4000;

  let repliedIds = new Set();
  let welcomedNotifIds = new Set();
  let repliedFallbackKeys = new Set();
  let observer = null;
  let joinSilenceUntil = 0;
  let lastRoomKey = "";
  let dedupSaveTimer = null;
  let debugLogs = false;
  let onlyReplyWhenMentioned = true;

  // Self-echo guard: prevent the bot from replying to its own messages
  // (especially visible in PM chat where every send loops back through
  // the MutationObserver as a "new message").
  //
  // Layered defense:
  //   1. learnedChatUsername — the name shown on YOUR bubbles in chat;
  //      learned from the first echo or send-lock. Popup "botUsername" is
  //      kept separately (mention keyword) and often defaults to "Bot"
  //      while the real site display is "Pro User" — never conflate them
  //      or self-echo detection breaks.
  //   2. configuredBotUsername — optional match when popup name equals
  //      the real Free4Talk display name.
  //   3. selfSentQueue — text + timestamp of every recent outgoing reply.
  //      Entries live for the full TTL so the SAME outgoing message can
  //      match more than once (DOM virtualization, fallback rescans, etc).
  let learnedChatUsername = null;
  let configuredBotUsername = null;
  const selfSentQueue = []; // [{ text: string, t: number }]
  const SELF_SENT_TTL_MS = 120_000;
  const SELF_SENT_MAX = 80;
  const JOIN_EVENT_TTL_MS = 60_000;
  const recentJoinEvents = new Map(); // key -> timestamp

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function loadDebugFlag() {
    try {
      const r = await chrome.storage.local.get("debugLogs");
      debugLogs = !!r?.debugLogs;
    } catch {
      debugLogs = false;
    }
  }

  async function loadConfiguredBotUsername() {
    try {
      const r = await chrome.storage.local.get(["botUsername", "onlyReplyWhenMentioned"]);
      const v = (r?.botUsername || "").trim();
      configuredBotUsername = v || null;
      onlyReplyWhenMentioned = r?.onlyReplyWhenMentioned !== undefined
        ? !!r.onlyReplyWhenMentioned
        : true;
    } catch {
      configuredBotUsername = null;
      onlyReplyWhenMentioned = true;
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.botUsername) {
        const v = (changes.botUsername.newValue || "").trim();
        configuredBotUsername = v || null;
      }
      if (changes.onlyReplyWhenMentioned) {
        onlyReplyWhenMentioned = !!changes.onlyReplyWhenMentioned.newValue;
      }
    });
  } catch {
    /* chrome.storage.onChanged unavailable */
  }

  function escapeRegExp(str) {
    return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function isBotNameMentioned(content, botName) {
    const raw = String(content || "");
    const bot = String(botName || "").trim().toLowerCase();
    if (!bot || bot.length < 2) return false;
    const escaped = escapeRegExp(bot).replace(/ +/g, "\\s+");
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}_])@?${escaped}(?:$|[^\\p{L}\\p{N}_])`, "iu");
    return re.test(raw);
  }

  function didMentionAnyBotName(content) {
    const names = [configuredBotUsername, learnedChatUsername]
      .map((s) => String(s || "").trim())
      .filter(Boolean);
    if (!names.length) return false;
    return names.some((name) => isBotNameMentioned(content, name));
  }

  function dlog(...args) {
    if (!debugLogs) return;
    console.log(...args);
  }

  function getRoomKey() {
    try {
      const m = (location.pathname + location.hash).match(/\/(room|group)\/([^/?#]+)/i);
      return m ? `${m[1].toLowerCase()}:${m[2]}` : "";
    } catch {
      return "";
    }
  }

  function isRoomPage() {
    return /free4talk\.com$/i.test(location.hostname.replace(/^www\./, "")) || location.hostname.includes("free4talk.com");
  }

  async function loadDedup() {
    try {
      const r = await chrome.storage.local.get([STORAGE_KEY_REPLIED, STORAGE_KEY_WELCOMED]);
      if (Array.isArray(r[STORAGE_KEY_REPLIED])) repliedIds = new Set(r[STORAGE_KEY_REPLIED]);
      if (Array.isArray(r[STORAGE_KEY_WELCOMED])) welcomedNotifIds = new Set(r[STORAGE_KEY_WELCOMED]);
    } catch (e) {
      /* ignore */
    }
  }

  async function saveDedup() {
    try {
      let r = Array.from(repliedIds);
      if (r.length > MAX_STORED_IDS) r = r.slice(-MAX_STORED_IDS);
      let w = Array.from(welcomedNotifIds);
      if (w.length > MAX_STORED_IDS) w = w.slice(-MAX_STORED_IDS);
      repliedIds = new Set(r);
      welcomedNotifIds = new Set(w);
      await chrome.storage.local.set({
        [STORAGE_KEY_REPLIED]: r,
        [STORAGE_KEY_WELCOMED]: w,
      });
    } catch (e) {
      /* ignore */
    }
  }

  function queueSaveDedup() {
    if (dedupSaveTimer) return;
    dedupSaveTimer = setTimeout(() => {
      dedupSaveTimer = null;
      saveDedup();
    }, DEDUP_SAVE_DEBOUNCE_MS);
  }

  function normalizeText(s) {
    // Strip trailing ellipsis added by the background's clampLen, collapse
    // whitespace (incl. NBSP), drop trailing punctuation the chat may add.
    // Fold curly quotes / apostrophes to ASCII — stripping U+2019 used to turn
    // "Nothing's" into "nothings" and break selfSentQueue matching vs the DOM.
    return (s || "")
      .replace(/\u00a0/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[`´ʻʼʹˈꞌ＇\u02bc\u02b9]/g, "'")
      .replace(/\*+/g, "")
      .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035]/g, "'")
      .replace(/[\u201c\u201d\u201e\u201f\u00ab\u00bb]/g, '"')
      .replace(/[\u2026]+\s*$/g, "")        // unicode ellipsis "…"
      .replace(/\.{3,}\s*$/g, "")           // ASCII "..."
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /** Same normalization the background uses for room-info filtering. */
  function normalizeForRoomMeta(s) {
    return (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function normalizeJoinContent(s) {
    return normalizeForRoomMeta(s)
      .toLowerCase()
      .replace(/\[\s*\d{1,2}:\d{2}\s*(?:am|pm)?\s*\]/gi, "")
      .replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function makeJoinDedupKey(sysInfo) {
    const user = normalizeForRoomMeta(sysInfo?.username || "").toLowerCase();
    const content = normalizeJoinContent(sysInfo?.content || "");
    if (user) return `${user}|${content}`;
    return content;
  }

  function shouldSkipRecentJoinEvent(sysInfo) {
    const key = makeJoinDedupKey(sysInfo);
    if (!key) return true;
    const now = Date.now();
    for (const [k, t] of recentJoinEvents.entries()) {
      if (now - t > JOIN_EVENT_TTL_MS) recentJoinEvents.delete(k);
    }
    const last = recentJoinEvents.get(key);
    if (last && now - last < JOIN_EVENT_TTL_MS) return true;
    recentJoinEvents.set(key, now);
    return false;
  }

  const ROOM_INFO_CONTENT_RE =
    /\b(room\s+info|language\s*:|topic\s*:|participants?\s*:|country\s*:|level\s*:|room rules?)\b/i;

  function isRoomInfoLikeMessage(content) {
    const n = normalizeForRoomMeta(content);
    if (!n) return false;
    if (ROOM_INFO_CONTENT_RE.test(n)) return true;
    if (/room\s+info/i.test(n) && /\b(change|changed|update|updated)\b/i.test(n)) {
      return true;
    }
    return false;
  }

  function normChatUser(n) {
    return (n || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim()
      .toLowerCase();
  }

  function isOurChatUsername(name) {
    const u = normChatUser(name);
    if (!u) return false;
    if (learnedChatUsername && normChatUser(learnedChatUsername) === u) return true;
    if (configuredBotUsername && normChatUser(configuredBotUsername) === u) return true;
    return false;
  }

  function pruneSelfSent() {
    const cutoff = Date.now() - SELF_SENT_TTL_MS;
    while (selfSentQueue.length && selfSentQueue[0].t < cutoff) {
      selfSentQueue.shift();
    }
  }

  function recordSelfSent(text) {
    const norm = normalizeText(text);
    if (!norm) return;
    pruneSelfSent();
    selfSentQueue.push({ text: norm, t: Date.now() });
    if (selfSentQueue.length > SELF_SENT_MAX) selfSentQueue.shift();
  }

  function setLearnedChatUsername(name) {
    const trimmed = (name || "").trim();
    if (!trimmed) return;
    if (learnedChatUsername === trimmed) return;
    learnedChatUsername = trimmed;
    console.log(`[F4T-AI] learned chat display name: ${learnedChatUsername}`);
  }

  function contentMatchesSelfSentQueue(norm) {
    if (!norm) return false;
    pruneSelfSent();
    for (const entry of selfSentQueue) {
      const a = entry.text;
      const b = norm;
      if (
        a === b ||
        (a.length >= 6 && b.startsWith(a)) ||
        (b.length >= 6 && a.startsWith(b)) ||
        (a.length >= 12 && b.includes(a)) ||
        (b.length >= 12 && a.includes(b))
      ) {
        return true;
      }
      const maxL = Math.max(a.length, b.length);
      const minL = Math.min(a.length, b.length);
      if (maxL >= 14 && minL / maxL >= 0.82 && (a.includes(b) || b.includes(a))) {
        return true;
      }
      if (maxL >= 18 && minL >= 8 && minL / maxL >= 0.22 && (a.includes(b) || b.includes(a))) {
        return true;
      }
    }
    return false;
  }

  /** Heuristic: Free4Talk / Ant Design chat "my" bubble markers. */
  function bubbleLooksLikeOurs(node) {
    if (!(node instanceof HTMLElement)) return false;
    let cur = node;
    for (let depth = 0; depth < 8 && cur; depth++) {
      const cls = (cur.getAttribute("class") || "").toLowerCase();
      if (
        /\b(message-right|msg-right|self-message|is-self|isself|own-message|ownmessage|sent-by-me|my-message|mymessage)\b/.test(
          cls
        ) ||
        cur.dataset?.isSelf === "true" ||
        cur.dataset?.self === "true" ||
        cur.dataset?.mine === "true"
      ) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function isSelfEcho(msg, sourceNode) {
    if (!msg) return false;

    // 0. Layout hint — catches own bubbles when username is parsed wrong.
    if (sourceNode instanceof HTMLElement && bubbleLooksLikeOurs(sourceNode)) {
      if (msg.username) setLearnedChatUsername(msg.username);
      return true;
    }

    // 1. Username match — learned name OR popup name when it really matches F4T.
    if (msg.username && isOurChatUsername(msg.username)) {
      return true;
    }

    const norm = normalizeText(msg.content);
    if (!norm) return false;

    // 2. Text match against the recent-outgoing queue. Entries are NOT
    //    removed on match — the same outgoing message may legitimately be
    //    re-observed by the fallback scanner with a different node.
    if (contentMatchesSelfSentQueue(norm)) {
      if (!learnedChatUsername && msg.username) setLearnedChatUsername(msg.username);
      return true;
    }

    return false;
  }

  function markBacklogReplied() {
    const blocks = document.querySelectorAll("[data-message-id]");
    blocks.forEach((el) => {
      const id = el.getAttribute("data-message-id");
      if (id) repliedIds.add(id);
    });
    document.querySelectorAll(".system [id], div.system").forEach((el) => {
      const id = el.id || el.getAttribute("data-id");
      if (id) welcomedNotifIds.add(id);
    });
    queueSaveDedup();
  }

  function learnOwnUsernameFromBacklog(root) {
    const scope = root instanceof HTMLElement ? root : document.body;
    if (!(scope instanceof HTMLElement)) return;
    const rows = scope.querySelectorAll("[data-message-id], .message, [class*='message']");
    for (const row of rows) {
      if (!(row instanceof HTMLElement)) continue;
      if (!bubbleLooksLikeOurs(row)) continue;
      const msg = parseChatMessage(row) || parseGenericMessage(row);
      if (msg?.username) {
        setLearnedChatUsername(msg.username);
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Find chat container
  // ---------------------------------------------------------------------------

  const CONTAINER_SELECTORS = [
    ".translate-container",
    ".messages-container",
    ".message-container",
    ".chat-container",
    '[class*="translate"]',
    '[class*="message"]',
  ];

  function findMessageContainer() {
    for (const sel of CONTAINER_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  async function waitForContainer(maxAttempts = 40) {
    for (let i = 0; i < maxAttempts; i++) {
      const c = findMessageContainer();
      if (c) return c;
      await sleep(750);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Message parsing
  // ---------------------------------------------------------------------------

  function getQuotedUsername(quoteEl) {
    const nameEl = quoteEl.querySelector(".quote-name");
    if (!nameEl) return null;
    const clone = nameEl.cloneNode(true);
    clone.querySelectorAll(".ant-avatar").forEach((a) => a.remove());
    return (clone.textContent || "").trim() || null;
  }

  function getQuotedContent(quoteEl) {
    const c =
      quoteEl.querySelector(".quote-content .html") ||
      quoteEl.querySelector(".quote-content p") ||
      quoteEl.querySelector(".quote-content");
    if (!c) return null;
    return (c.textContent || "").trim() || null;
  }

  function parseSystemNotification(node) {
    if (!(node instanceof HTMLElement)) return null;
    // `querySelector(".system …")` misses when `node` *is* the system row (no nested .system).
    const root =
      (node.matches && node.matches(".system, div.system")) ? node
      : node.querySelector(".system, div.system");
    if (!root) return null;

    const sysSpan =
      root.querySelector("span.ant-typography.ant-typography-secondary") ||
      root.querySelector("span.ant-typography-secondary") ||
      root.querySelector(".ant-typography-secondary");
    if (!sysSpan) return null;

    const strong = sysSpan.querySelector("strong") || root.querySelector("strong");
    const content = (sysSpan.innerText || sysSpan.textContent || "").trim();
    let username = (strong?.textContent || "").trim();
    if (!username) {
      const m = content.match(/^\s*([^\n]{1,60}?)\s+(?:has\s+)?(?:just\s+)?(?:joined|entered)\b/i);
      if (m?.[1]) username = m[1].trim();
    }

    return { username, content };
  }

  function getMessageAuthorUsername(node) {
    const safe = (el) => {
      if (!el) return "";
      if (el.closest?.(".quote, .main-quote-content, .text.quote, [class*='main-quote']")) return "";
      return (el.textContent || "").trim();
    };
    const orderedSelectors = [
      ".user .name span",
      ".user .name",
      ".name.primary span",
    ];
    for (const sel of orderedSelectors) {
      const u = safe(node.querySelector(sel));
      if (u) return u;
    }
    const candidates = node.querySelectorAll(".name span, .user .name");
    for (const el of candidates) {
      const u = safe(el);
      if (u) return u;
    }
    return "";
  }

  function parseChatMessage(node) {
    const isPM = node.firstElementChild?.classList?.contains("pm-mode") || false;
    const username = getMessageAuthorUsername(node);
    if (!username) return null;

    const time = node.querySelector(".user .time")?.textContent ||
                 node.querySelector(".time span")?.textContent || "";

    // Exclude reply-quote blocks from the main body so echoed sends still
    // match selfSentQueue / background echo detection (quote text was inflating
    // `content` and breaking substring checks).
    const mainContentRoot =
      node.querySelector(".text.main-content") ||
      node.querySelector(".main-content");
    let content = "";
    if (mainContentRoot) {
      const clone = mainContentRoot.cloneNode(true);
      clone
        .querySelectorAll(".quote, .main-quote-content, .text.quote, [class*='quote']")
        .forEach((q) => q.remove());
      const bodyEl =
        clone.querySelector(".html") ||
        clone.querySelector("p") ||
        clone;
      content = (bodyEl.textContent || bodyEl.innerText || "").trim();
    } else {
      const mainEl =
        node.querySelector(".text.main-content .html") ||
        node.querySelector(".text.main-content p") ||
        node.querySelector(".main-content .html") ||
        node.querySelector(".main-content p") ||
        node.querySelector(".text p");
      if (!mainEl) return null;
      content = (mainEl.textContent || mainEl.innerText || "").trim();
    }
    if (!content) return null;

    let replyTo = null;
    const quoteEl =
      node.querySelector(".text.quote.main-quote-content") ||
      node.querySelector(".main-quote-content") ||
      node.querySelector(".quote");
    if (quoteEl) {
      const quotedUsername = getQuotedUsername(quoteEl);
      const quotedContent  = getQuotedContent(quoteEl);
      const quotedIdEl     = quoteEl.querySelector(".quote-content[data-message-id]");
      const quotedId       = quotedIdEl?.getAttribute("data-message-id") || null;
      if (quotedUsername || quotedContent || quotedId) {
        replyTo = { messageId: quotedId, username: quotedUsername, content: quotedContent };
      }
    }

    const messageId = node.getAttribute("data-message-id") || node.id || "";

    return {
      username,
      content,
      timestamp: time || new Date().toLocaleTimeString(),
      messageId,
      isPM,
      replyTo,
    };
  }

  function parseGenericMessage(node) {
    const text = (node.innerText || node.textContent || "").trim();
    if (!text) return null;
    if (text.length < 4 || text.length > 1200) return null;
    if (/type a message|mention someone|online|settings|profile|mute|block/i.test(text)) return null;

    const lines = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length < 2) return null;

    const first = lines[0];
    const last = lines[lines.length - 1];
    if (!first || !last) return null;
    if (first.length > 40) return null;
    if (last.length < 1 || last.length > 400) return null;
    if (first.toLowerCase() === last.toLowerCase()) return null;

    const msgId = node.getAttribute("data-message-id") || node.id || "";
    return {
      username: first,
      content: last,
      timestamp: new Date().toLocaleTimeString(),
      messageId: msgId,
      isPM: false,
      replyTo: null,
    };
  }

  // ---------------------------------------------------------------------------
  // NEW_MESSAGE dispatch (stabilize DOM before notifying background)
  // ---------------------------------------------------------------------------

  const NEW_MESSAGE_STABILIZE_MS = 95;
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const pendingNewMessageTimers = new Map();

  function dataMessageIdSelector(id) {
    const s = String(id);
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return `[data-message-id="${CSS.escape(s)}"]`;
    }
    return `[data-message-id="${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
  }

  function cancelPendingNewMessage(mid) {
    const h = pendingNewMessageTimers.get(mid);
    if (h != null) {
      clearTimeout(h);
      pendingNewMessageTimers.delete(mid);
    }
  }

  function clearAllPendingNewMessages() {
    for (const h of pendingNewMessageTimers.values()) {
      clearTimeout(h);
    }
    pendingNewMessageTimers.clear();
  }

  function finalizeNewMessageDispatch(msg) {
    const fallbackKey = `${msg.username}|${msg.content.slice(0, 220)}|${msg.timestamp || ""}|${msg.isPM ? "pm" : "room"}`;
    const dedupKey = msg.messageId || fallbackKey;

    if (msg.messageId) {
      if (repliedIds.has(dedupKey)) return;
      repliedIds.add(dedupKey);
    } else {
      if (repliedFallbackKeys.has(dedupKey)) return;
      repliedFallbackKeys.add(dedupKey);
      if (repliedFallbackKeys.size > 800) {
        repliedFallbackKeys = new Set(Array.from(repliedFallbackKeys).slice(-500));
      }
    }
    queueSaveDedup();

    chrome.runtime.sendMessage({ type: "NEW_MESSAGE", data: msg })
      .then(() => {
        dlog("[F4T-AI] NEW_MESSAGE sent to background");
      })
      .catch((e) => {
        console.warn("[F4T-AI] NEW_MESSAGE send failed:", e?.message || e);
      });
  }

  function scheduleStabilizedNewMessage(msg, node) {
    const mid = msg.messageId;
    if (!mid || mid === "pm") {
      finalizeNewMessageDispatch(msg);
      return;
    }

    if (repliedIds.has(mid) || pendingNewMessageTimers.has(mid)) return;

    const handle = setTimeout(() => {
      pendingNewMessageTimers.delete(mid);

      if (repliedIds.has(mid)) return;

      const el = document.querySelector(dataMessageIdSelector(mid));
      const target = el instanceof HTMLElement ? el : node;
      const reparsed = parseChatMessage(target) || parseGenericMessage(target);

      const useMsg = reparsed && reparsed.messageId === mid ? reparsed : msg;

      if (isRoomInfoLikeMessage(useMsg.content)) {
        repliedIds.add(mid);
        return;
      }
      if (isSelfEcho(useMsg, target)) {
        repliedIds.add(mid);
        dlog("[F4T-AI] stabilized skip self-echo:", useMsg.username, useMsg.content.slice(0, 50));
        return;
      }
      if (contentMatchesSelfSentQueue(normalizeText(useMsg.content))) {
        repliedIds.add(mid);
        dlog("[F4T-AI] stabilized skip self-queue");
        return;
      }

      finalizeNewMessageDispatch(useMsg);
    }, NEW_MESSAGE_STABILIZE_MS);

    pendingNewMessageTimers.set(mid, handle);
  }

  // ---------------------------------------------------------------------------
  // Process new node
  // ---------------------------------------------------------------------------

  function processNode(node) {
    if (!(node instanceof HTMLElement)) return;

    const sysInfo = parseSystemNotification(node);
    if (sysInfo && sysInfo.content) {
      const dedupKey = makeJoinDedupKey(sysInfo);
      const notifId = dedupKey || node.id || `${sysInfo.username}|${sysInfo.content}`;
      if (welcomedNotifIds.has(notifId)) return;

      const lc = sysInfo.content.toLowerCase();
      const joined =
        lc.includes("joined") ||
        lc.includes("entered") ||
        lc.includes("just\u00a0joined") ||
        /\bhas\s+joined\b/.test(lc) ||
        /\bjoined\s+the\s+(room|chat)\b/.test(lc);

      welcomedNotifIds.add(notifId);
      queueSaveDedup();

      if (joined) {
        if (shouldSkipRecentJoinEvent(sysInfo)) return;
        chrome.runtime.sendMessage({
          type: "JOIN_NOTIFICATION",
          data: { username: sysInfo.username, content: sysInfo.content },
        }).catch(() => { /* worker asleep, will spin up */ });
      }
      return;
    }

    const msg = parseChatMessage(node) || parseGenericMessage(node);
    if (!msg) return;

    const mentionedBot = didMentionAnyBotName(msg.content);

    // Hard guard: in strict mention mode, never forward non-mentioned messages.
    if (onlyReplyWhenMentioned && !mentionedBot) {
      if (msg.messageId) {
        cancelPendingNewMessage(msg.messageId);
        repliedIds.add(msg.messageId);
      }
      dlog("[F4T-AI] strict mention gate blocked (content):", msg.content.slice(0, 80));
      return;
    }

    if (isRoomInfoLikeMessage(msg.content)) {
      if (msg.messageId) {
        cancelPendingNewMessage(msg.messageId);
        repliedIds.add(msg.messageId);
      }
      dlog("[F4T-AI] skipped room-info / meta message:", msg.content.slice(0, 80));
      return;
    }

    // Drop the bot's own messages so it can't reply to itself (PM-loop fix).
    if (isSelfEcho(msg, node)) {
      if (msg.messageId) {
        cancelPendingNewMessage(msg.messageId);
        repliedIds.add(msg.messageId);
      }
      dlog("[F4T-AI] skipped self-echo:", msg.username, msg.content.slice(0, 60));
      return;
    }

    // Last line of defense: never notify background for text we literally just sent
    // (parses can still disagree on username / bubble heuristics).
    const normForQueue = normalizeText(msg.content);
    if (contentMatchesSelfSentQueue(normForQueue)) {
      if (msg.messageId) {
        cancelPendingNewMessage(msg.messageId);
        repliedIds.add(msg.messageId);
      }
      dlog("[F4T-AI] skipped self-sent body (queue re-check)");
      return;
    }

    const fallbackKey = `${msg.username}|${msg.content.slice(0, 220)}|${msg.timestamp || ""}|${msg.isPM ? "pm" : "room"}`;
    const dedupKey = msg.messageId || fallbackKey;

    if (msg.messageId) {
      if (repliedIds.has(dedupKey)) return;
      scheduleStabilizedNewMessage({ ...msg, botMentioned: mentionedBot }, node);
      return;
    }

    if (repliedFallbackKeys.has(dedupKey)) return;
    repliedFallbackKeys.add(dedupKey);
    if (repliedFallbackKeys.size > 800) {
      repliedFallbackKeys = new Set(Array.from(repliedFallbackKeys).slice(-500));
    }
    queueSaveDedup();

    finalizeNewMessageDispatch({ ...msg, botMentioned: mentionedBot });
  }

  function processPotentialMessageRoots(root) {
    if (!(root instanceof HTMLElement)) return;
    processNode(root);

    const candidates = root.querySelectorAll(
      "[data-message-id], .system, div.system, .pm-mode, .text.main-content, .message, [class*='message'], [class*='chat'] [class*='item'], [class*='list'] > div"
    );
    candidates.forEach((el) => {
      const msgRoot =
        el.closest("[data-message-id], [id], .message, [class*='message'], .translate-item, [class*='translate']") ||
        el;
      if (msgRoot instanceof HTMLElement) processNode(msgRoot);
    });
  }

  function scanLatestMessages(container) {
    const root = container instanceof HTMLElement ? container : document.body;
    if (!(root instanceof HTMLElement)) return;
    const candidates = root.querySelectorAll(
      "[data-message-id], .message, [class*='message'], .text.main-content, .main-content, [class*='chat'] [class*='item'], [class*='list'] > div"
    );
    const start = Math.max(0, candidates.length - 18);
    for (let i = start; i < candidates.length; i++) {
      const el = candidates[i];
      if (!(el instanceof HTMLElement)) continue;
      const msgRoot =
        el.closest("[data-message-id], [id], .message, [class*='message'], .translate-item, [class*='translate']") ||
        el;
      if (msgRoot instanceof HTMLElement) processNode(msgRoot);
    }
  }

  // ---------------------------------------------------------------------------
  // Observe
  // ---------------------------------------------------------------------------

  function startObserver(container) {
    const target = container instanceof HTMLElement ? container : document.body;
    if (!(target instanceof HTMLElement)) return;
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type !== "childList") continue;
        m.addedNodes.forEach((n) => {
          if (n instanceof HTMLElement) processPotentialMessageRoots(n);
        });
      }
    });
    observer.observe(target, { childList: true, subtree: true });
  }

  function checkRoomChange() {
    const k = getRoomKey();
    if (k && k !== lastRoomKey) {
      clearAllPendingNewMessages();
      lastRoomKey = k;
      joinSilenceUntil = Date.now() + JOIN_SILENCE_MS;
      markBacklogReplied();
      console.log(`🛑 Join silence engaged for ${JOIN_SILENCE_MS / 1000}s`);
    }
  }

  // ---------------------------------------------------------------------------
  // Reply sender
  // ---------------------------------------------------------------------------

  function findChatInput() {
    return (
      document.querySelector(".input-send-box textarea") ||
      document.querySelector("textarea")
    );
  }

  function findSendButton() {
    const selectors = [
      '.input-send-box button[type="button"]',
      ".input-send-box button",
      "button.send-box",
      'button[class*="send-box"]',
      '.ant-btn.send-box[type="button"]',
    ];

    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn instanceof HTMLButtonElement && btn.offsetParent !== null) {
        return btn;
      }
    }
    return null;
  }

  async function setupReplyToMessage(messageId) {
    if (!messageId || messageId === "pm") return;
    const msg = document.querySelector(`[data-message-id="${messageId}"]`) ||
                document.getElementById(messageId);
    if (!msg) return;

    msg.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await sleep(250);

    const btns = Array.from(msg.querySelectorAll("button"));
    const replyBtn = btns.find((btn) => {
      const span = btn.querySelector("span");
      const text = (span?.textContent || btn.textContent || "").toLowerCase();
      const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
      const title = (btn.getAttribute("title") || "").toLowerCase();
      return (
        text.includes("reply") || aria.includes("reply") || title.includes("reply") ||
        text.includes("replay") || aria.includes("replay") || title.includes("replay")
      );
    });

    if (replyBtn && replyBtn.offsetParent !== null) {
      replyBtn.click();
      await sleep(150);
    }
  }

  function setNativeValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function sendReply(text, originalMessage) {
    try {
      const input = findChatInput();
      if (!input) {
        console.error("[F4T-AI] chat input not found");
        return false;
      }

      if (originalMessage?.messageId && originalMessage.messageId !== "pm" && !originalMessage.isWelcome) {
        await setupReplyToMessage(originalMessage.messageId);
      }

      // Mark this text as our own BEFORE it can appear in the DOM,
      // so the MutationObserver won't treat it as an incoming message.
      recordSelfSent(text);

      setNativeValue(input, text);
      await sleep(80);

      const waitForEnabledSendButton = async (attempts = 12) => {
        for (let i = 0; i < attempts; i++) {
          const b = findSendButton();
          if (b && !b.disabled) return b;
          await sleep(100);
        }
        return null;
      };

      const btn = await waitForEnabledSendButton();
      if (btn) {
        btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        btn.click();
        console.log(`✉️  Sent via button: ${text.slice(0, 60)}…`);
        return true;
      }

      input.focus();
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })
      );
      input.dispatchEvent(
        new KeyboardEvent("keypress", { key: "Enter", code: "Enter", bubbles: true })
      );
      input.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true })
      );
      console.log(`✉️  Sent via Enter fallback: ${text.slice(0, 60)}…`);
      return true;
    } catch (err) {
      console.error("[F4T-AI] sendReply error:", err);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Background listener
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
    (async () => {
      try {
        if (req?.type === "SEND_REPLY") {
          const { text, originalMessage } = req.data || {};
          if (text) await sendReply(text, originalMessage || {});
          sendResponse({ ok: true });
          return;
        }
        sendResponse({ ok: false, reason: "unknown" });
      } catch (e) {
        console.error("[F4T-AI] msg handler:", e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  });

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  async function bootstrap() {
    if (!isRoomPage()) {
      console.log("[F4T-AI] not on free4talk; idle.");
      return;
    }

    await loadDebugFlag();
    await loadConfiguredBotUsername();
    await loadDedup();
    lastRoomKey = getRoomKey();
    joinSilenceUntil = Date.now() + JOIN_SILENCE_MS;

    const container = await waitForContainer();
    if (!container) {
      console.warn("[F4T-AI] Could not find message container — using document-level fallback.");
      startObserver(document.body);
      learnOwnUsernameFromBacklog(document.body);
      scanLatestMessages(document.body);
    } else {
      markBacklogReplied();
      startObserver(container);
      learnOwnUsernameFromBacklog(container);
      console.log("✅ Message observer started.");
      scanLatestMessages(container);
    }

    setInterval(checkRoomChange, ROOM_CHECK_INTERVAL_MS);

    setInterval(() => {
      const c = findMessageContainer();
      if (c && (!observer || !document.body.contains(c))) {
        markBacklogReplied();
        startObserver(c);
        console.log("🔄 Re-bound observer.");
      }
    }, OBSERVER_REBIND_INTERVAL_MS);

    // Fallback scanner: some Free4Talk builds patch DOM without clean childList adds.
    setInterval(() => {
      const c = findMessageContainer();
      scanLatestMessages(c || document.body);
    }, FALLBACK_SCAN_INTERVAL_MS);
  }

  bootstrap();

  window.addEventListener("beforeunload", () => {
    clearAllPendingNewMessages();
    if (observer) observer.disconnect();
    if (dedupSaveTimer) {
      clearTimeout(dedupSaveTimer);
      dedupSaveTimer = null;
    }
    saveDedup();
  });
})();
