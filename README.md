# ⚡ Free4Talk AI Assistant — Free4Talk Bot & Auto Reply Pro (v4.2.0 Pro)

[![Open Source Love](https://img.shields.io/badge/Open%20Source-100%25-brightgreen.svg)](https://github.com/Riajul1819/free4talk-ai-auto-replay)
[![Security Privacy](https://img.shields.io/badge/Security-Client--Side%20Direct%20API-blue.svg)](#-why-this-extension-is-the-most-secure)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Manifest%20V3-orange.svg)](manifest.json)
[![Platform](https://img.shields.io/badge/Platform-free4talk.com-purple.svg)](https://www.free4talk.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Free4Talk AI** is the ultimate open-source **Free4Talk bot** and **Free4Talk auto replay chat** companion. Specially engineered for language learners, conversationalists, and online chat enthusiasts on [free4talk.com](https://www.free4talk.com), this browser extension automatically responds to incoming messages in real-time using cutting-edge Large Language Models (LLMs).

Powered by **NVIDIA NIM (Free Unlimited Models)**, **Groq (Ultra-Fast LPU)**, and **OpenRouter**, this extension brings smart multi-provider AI auto-reply capabilities directly into your [Free4Talk chat](https://www.free4talk.com) experience.

---

> [!IMPORTANT]
> **Domain Restricted**: This extension is strictly scoped to work **ONLY on [free4talk.com](https://www.free4talk.com)**. It does not execute scripts, track data, or inject any code on any other website.

---

## 🚀 Key Features

### 1. 🤖 Free4Talk Auto Replay Chat Engine
* **Instant Message Detection**: Automatically listens for incoming messages in active Free4Talk rooms.
* **Context-Aware Responses**: Keeps track of recent conversation history to generate relevant, natural, human-like replies.
* **Hands-Free Chatting**: Perfect for practicing languages or keeping discussions alive while multitasking.

### 2. ⚡ Multi-Model AI Engine & NVIDIA NIM Integration
* **Groq (Ultra-Fast LPU)**: Lightning-fast inference powered by LLaMA 3.3 70B for instant in-room responses.
* **NVIDIA NIM (Free & Unlimited)**: Access high-performance models like Meta Llama 3.3 and Nemotron for free.
* **OpenRouter**: Leverage smart auto-routing and fallback across multiple open models.

### 3. 🛡️ Smart Fallback & Auto-Switching
* Never suffer from rate limits or server downtime! If your primary AI provider hits a quota limit or fails, Free4Talk AI automatically switches to your designated backup provider in real-time without missing a message.

### 4. 🧠 Custom AI Memory & Persona System
* **Personalized AI Tone**: Configure how your bot responds (friendly, sarcastic, academic, language tutor, etc.).
* **Persistent Knowledge Base**: Add custom memories, facts, vocabulary lists, and room context so the AI remembers past interactions.

### 5. 🎨 Modern Dark Glassmorphic React UI
* Premium, intuitive control panel built with React 19 & custom CSS glassmorphism.
* Toggle auto-reply on/off with a single hotkey or click.
* Quick API key management with local instant validation.

---

## 🔒 Why This Extension is 100% Open Source & Most Secure

Unlike third-party extension bots that route your messages and API keys through private, unverified proxy servers, **Free4Talk AI is built with security and user privacy as its top priority**.

```
[ Your Browser (free4talk.com) ] ───────── (Direct HTTPS API Call) ─────────> [ AI Provider (Groq / NVIDIA / OpenRouter) ]
                                  (NO MIDDLEMAN / NO LOGGING SERVERS)
```

### Security & Privacy Architecture:
* **100% Open Source**: Every single line of JavaScript code is publicly readable in this repository. You can audit, review, and compile it yourself.
* **Direct Client-to-API Communication**: All requests are dispatched **directly** from your browser to official API endpoints (`api.groq.com`, `integrate.api.nvidia.com`, `openrouter.ai`). There is **zero middleman server** collecting or reading your conversations.
* **Local Storage Encryption**: Your secret API keys are stored locally in Chrome's isolated storage (`chrome.storage.local`). They never leave your device.
* **Zero Telemetry / Zero Trackers**: No analytics, no session recording, and no hidden third-party tracking scripts.
* **Strict Domain Isolation**: Content scripts are declared strictly for `*://www.free4talk.com/*` and `*://free4talk.com/*`. The extension has no access to your banking, social media, or other browsing tabs.

---

## 🔮 Release Notes & Future Roadmap

### 📦 Current Release: Version 4.2.0 Pro
* **Focused 3-Engine Architecture**: Powered strictly by **Groq (LLaMA 3.3 70B)**, **NVIDIA NIM**, and **OpenRouter** for maximum speed and intelligence.
* **100% Silent Error Handling**: Removed all intrusive in-room key/error prompts so the bot remains completely silent on failures without posting unwanted messages to public chat.
* **Smart Auto-Routing & Failover**: Automatic instant fallback between Groq, NVIDIA, and OpenRouter for continuous uninterrupted chatting.
* **Retry Backoff & Rate Limit Handling**: Resilient handling with exponential backoff on transient network or rate limit responses.
* **Streamlined Manifest & Host Permissions**: Scoped strictly to necessary AI endpoints with no excess permissions.

### 🌟 Upcoming Future Features (Roadmap)
* 🎙️ **Voice AI Auto Reply (Speech-to-Text & Text-to-Speech)**: Real-time audio transcription and synthetic voice auto-reply directly in Free4Talk voice channels.
* 🌐 **Live Room Multi-Language Translation**: Instant bi-directional translation for non-native speakers practicing new languages.
* 🤖 **Automated Room Topic & Icebreaker Generator**: Automatic topic creation and discussion starters to prevent quiet rooms.
* 📊 **Conversation Analytics & Vocabulary Tracker**: Track new words learned during AI conversations in [Free4Talk chat](https://www.free4talk.com).

---

## 🛠️ How to Install in Google Chrome

1. **Download the Extension**:
   - Go to [Releases](https://github.com/Riajul1819/free4talk-ai-auto-replay/releases) and download `free4talk-ai-v4.2.0.zip`.
   - Extract the `.zip` archive to a folder on your computer.

2. **Enable Chrome Developer Mode**:
   - Open Google Chrome and navigate to `chrome://extensions/`.
   - Enable **Developer mode** using the toggle switch in the top right corner.

3. **Load Unpacked Extension**:
   - Click the **Load unpacked** button in the top left.
   - Select the extracted `Free4talk AI` directory.

4. **Start Using Free4Talk AI**:
   - Navigate to [free4talk.com](https://www.free4talk.com).
   - Click the Free4Talk AI extension icon in your toolbar.
   - Enter your preferred API key (e.g. Groq, NVIDIA NIM, or OpenRouter).
   - Turn on **Auto Reply** and enjoy automated conversation!

---

## 🌐 Official Platform Link

This extension is built for the community at **[free4talk.com](https://www.free4talk.com)** — the premier global online language exchange community.

* Official Website: [https://www.free4talk.com](https://www.free4talk.com)

## 📁 Project Structure & File Overview

| File / Directory | Description |
| :--- | :--- |
| **`icons/`** | Contains toolbar and browser UI icon assets (16px – 128px). |
| **`LICENSE`** | MIT License specifying terms of use. |
| **`README.md`** | Project documentation, setup guide, and feature highlights. |
| **`background.js`** | Background Service Worker handling API calls, AI failover, and messaging. |
| **`content.js`** | Injected script observing chat DOM & automating replies on `free4talk.com`. |
| **`manifest.json`** | Extension Manifest V3 declaring permissions, scripts, and endpoints. |
| **`memory.css`** | Glassmorphic dark styling for the Memory Manager interface. |
| **`memory.html`** | Structure for managing bot memory & saved context. |
| **`memory.js`** | Logic for viewing, searching, and deleting stored AI memories. |
| **`popup.css`** | Styling for the main browser popup window. |
| **`popup.html`** | Markup for the popup configuration panel. |
| **`popup.js`** | Handles API key settings, AI model selection, and auto-reply toggles. |

---

## 💻 Tech Stack

* **Frontend UI**: React 19, Vanilla CSS (Dark Glassmorphism)
* **Build System**: esbuild
* **Extension Standard**: Chrome Extension Manifest V3
* **AI Providers**: Groq API, NVIDIA NIM API, OpenRouter API

---

## 🤝 Contributing

Contributions are welcome! If you'd like to improve the **Free4Talk bot** auto reply chat engine or report bugs:

1. Fork the repository.
2. Create your feature branch (`git checkout -b feature/amazing-feature`).
3. Commit your changes (`git commit -m 'Add amazing feature'`).
4. Push to the branch (`git push origin feature/amazing-feature`).
5. Open a Pull Request.

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

*Created with ❤️ for the [Free4Talk](https://www.free4talk.com) community by [MdRiajulHasanRokon](https://github.com/MdRiajulHasanRokon).*
