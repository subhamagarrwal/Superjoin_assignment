# Offline Resilience

> How Superjoin handles backend downtime gracefully — keeping the Google Sheet accessible, queuing SQL commands, and replaying them on reconnect.

---

## Overview

When the backend server goes down (intentionally or due to a crash), the frontend detects the outage within 3 seconds and switches to an offline-aware mode:

| Component | Online | Offline |
|-----------|--------|---------|
| Google Sheet | Visible & editable | Visible & editable |
| Database View | Visible with live data | Hidden |
| SQL Terminal | Executes immediately | Queues to localStorage |
| Bot Simulator | Active | Disabled |

The Google Sheet remains fully functional at all times because it's embedded directly via Google's iframe using a build-time environment variable (`VITE_GOOGLE_SHEET_ID`), with no backend dependency.

---

## Graceful Shutdown

The backend registers signal handlers for `SIGTERM`, `SIGINT`, and `uncaughtException`. On shutdown, it stops services in order:

1. **CDC Monitor** — clears the polling interval
2. **BullMQ Worker** — closes the sheet update worker
3. **MySQL Pool** — ends all database connections
4. **Redis Client** — disconnects from Redis

This prevents zombie Node processes from continuing to poll Google Sheets or process queue jobs after the server is stopped.

---

## Health Checks

The frontend's `ConnectivityContext` pings `GET /health` every 3 seconds with a 2-second timeout.

- **Response `{ status: 'ok' }`** → backend is online
- **Timeout or error** → backend is offline

The health check starts 100ms after the app mounts, then runs on a fixed 3-second interval. State transitions (online → offline, offline → online) are tracked to trigger queue replay.

---

## Offline SQL Queue

### How It Works

1. User types a SQL command in the terminal while the backend is down.
2. The "Run" button shows **"📥 Queue (Offline)"** to indicate the command will be queued.
3. The query is stored in `localStorage` under the key `superjoin_offline_queue` as a JSON array.
4. Each queued item has a unique ID, the raw SQL string, and a timestamp.

### Storage Format

```json
[
  {
    "id": "1719500000000-abc123def",
    "query": "INSERT INTO sheet_data (row_num, A, B) VALUES (5, '100', '200')",
    "timestamp": 1719500000000
  }
]
```

### Persistence

The queue survives page refreshes and browser restarts because it's backed by `localStorage`. On mount, the context reads any existing queue from storage and restores it.

---

## Auto-Replay on Reconnect

When the health check detects the backend is back online and there are queued queries:

1. A 500ms delay prevents race conditions with the server still initializing.
2. Queries execute **sequentially** in the order they were queued (FIFO).
3. Successfully executed queries are removed from the queue.
4. Failed queries remain in the queue for the next retry cycle.

### Stale Closure Prevention

The queue processor uses `useRef` instead of reading state directly. This ensures the callback always sees the latest queue contents, even when triggered by a `useEffect` that closed over an earlier state snapshot.

- `offlineQueueRef` — always points to the current queue array
- `isProcessingRef` — prevents concurrent processing
- `isOnlineRef` — ensures processing only happens when online

---

## UI Behavior

### When Online

The layout splits vertically:

- **Top half** — Google Sheet iframe
- **Bottom half** — Database grid view (live MySQL data)
- **SQL Terminal** — executes queries immediately
- **Bot button** — enabled

### When Offline

- **Full height** — Google Sheet iframe expands to fill the entire panel
- **Database view** — completely hidden (not just empty, the DOM section is removed)
- **SQL Terminal** — queues queries with visual feedback
- **Bot button** — disabled

The transition is seamless with no extra status bars or banners. The only visual indicator is the SQL terminal button text changing.

---

## Frontend Environment Variable

To render the Google Sheet without any backend call, the sheet ID is baked into the frontend at build time:

```env
VITE_GOOGLE_SHEET_ID=your-google-sheet-id-here
```

The app resolves the sheet ID in this priority order:

1. `VITE_GOOGLE_SHEET_ID` environment variable (build-time)
2. `localStorage` cache from a previous session
3. Backend API fetch (only works when online)

---

## Files Involved

| File | Role |
|------|------|
| `backend/src/app.ts` | Graceful shutdown handlers |
| `frontend/src/context/ConnectivityContext.tsx` | Health checks, offline queue, auto-replay |
| `frontend/src/App.tsx` | ConnectivityProvider wrapper, sheetId resolution |
| `frontend/src/components/SQLTerminal.tsx` | Queue-on-offline logic, button state |
| `frontend/src/components/SheetViewer.tsx` | Conditional DB view, responsive layout |
| `frontend/.env` | `VITE_GOOGLE_SHEET_ID` |

---

## Limitations

- **No offline writes to the database.** Queued queries only execute when the backend is back. There is no client-side SQL engine.
- **No conflict resolution.** If someone edits the Google Sheet while queries are queued, the queued queries execute as-is on reconnect. The CDC Monitor will reconcile any conflicts after.
- **Queue is per-browser.** The localStorage queue is local to the browser instance. Different browsers or devices maintain separate queues.
- **Health check interval is fixed.** The 3-second polling interval is not configurable at runtime.
