# Afterglow (MemoryNote)
A local-first memory palace web app.

## Documentation
See **[ai/PROJECT.md](ai/PROJECT.md)** for architecture and run instructions.
See **[ai/DECISIONS.md](ai/DECISIONS.md)** for architectural decisions.

## Deploy
Frontend and backend should be deployed separately:

- Frontend: Vercel
- Backend API: Render

### Frontend on Vercel
Import this repository as a Vite project.

- Build command: `npm run build`
- Output directory: `dist`
- Environment variable: `VITE_API_BASE=https://your-render-service.onrender.com`

### Backend on Render
Use the included [render.yaml](render.yaml) blueprint or create a Web Service manually.

- Root directory: `server`
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/api/health`

Required backend environment variables:

```env
GEMINI_API_KEY=your_key_here
GEMINI_ANALYZE_MODEL=gemini-2.5-flash
GEMINI_CHAT_MODEL=gemini-2.5-flash
GEMINI_DIARY_MODEL=gemini-2.5-flash
GEMINI_CHAT_USE_SEARCH=1
```
