# Contracts & Invariants (Do Not Break)

## 1. API Contracts (Port 8787)
- **POST `/api/analyze-image`**: Returns `{ vibe, caption, questions }`.
- **POST `/api/chat`**: Returns JSON `{ text }` (not streaming).
- **POST `/api/generate-diary`**: Returns `{ title, mood, diary, tags, highlights }`.

## 2. Storage Contracts (IndexedDB)
- **DB Name**: `memory-particles` (Version 1).
- **Stores**:
  - `memories` (Key: UUID `id`).
  - `assets` (Key: String `key`).
- **Invariant**: Assets must be stored as **Blobs**, not Base64 strings.

## 3. DOM & UI Invariants
- **Do not rename these IDs** (used by `src/dom.js`):
  - `#canvas-container`, `#fileInput`
  - `#af-hud`
  - `#af-diary-modal`, `#enter-hall-btn`

## 4. Shader Uniforms
- **Vertex**: `uTime`, `uSize`, `uWaveAmplitude`.
- **Fragment**: `uTexture`, `uGridOpacity`, `uImageAspect`.

## 5. Chat Output Contract
- AI 回复仅用简体中文，禁英文字母；≤28字、最多2句，需包含具体物体/氛围与情绪词。
- 每次 `/api/chat` 调用在 `contents` 最前注入系统消息：包含照片摘要与关键词，并明确“本轮要问/本轮不要问”。
- 上传新照片需重置 `chatContents` 并覆盖 `imageContext`，避免串图。
