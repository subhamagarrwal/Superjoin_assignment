# Superjoin — Live 2-Way Google Sheets ↔ MySQL Sync

> A production-grade, real-time bidirectional sync engine between Google Sheets and a MySQL database, with cell-level locking, multiplayer simulation, and a full-featured testing interface.

![Node.js](https://img.shields.io/badge/Node.js-22-green) ![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue) ![React](https://img.shields.io/badge/React-19-61dafb) ![MySQL](https://img.shields.io/badge/MySQL-8-orange) ![Redis](https://img.shields.io/badge/Redis-7-red) ![BullMQ](https://img.shields.io/badge/BullMQ-5-purple)

---

## 📋 Table of Contents

- [How It Works](#-how-it-works)
- [Tech Stack & Why](#-tech-stack--why)
- [Getting Started](#-getting-started)
- [Environment Variables](#-environment-variables)
- [Testing the Sync](#-testing-the-sync)
- [Nuances & Edge Cases Handled](#-nuances--edge-cases-handled)
- [Offline Resilience](#-offline-resilience)
- [What Could Have Been Done](#-what-could-have-been-done)

---

## 🔁 How It Works

The system maintains **two independent data flows** that together form a bidirectional sync loop:

### Direction 1: Google Sheet → MySQL (CDC Polling)

1. The **CDC Monitor** polls the Google Sheets API every 3 seconds (minimum enforced).
2. On each tick, it fetches the current sheet state and diffs it against an in-memory snapshot.
3. Detected changes (inserts, updates, deletes) are written to MySQL with `last_modified_by = 'sheet'`.
4. A **Redis ignore-key** (`ignore:{row}:{col}`, TTL 10s) is set for each change so the reverse path doesn't echo it back.
5. The snapshot is updated to the current state.

**Why polling?** Google Sheets doesn't provide a native push API for cell changes. Pub/Sub push notifications only fire for file-level metadata changes (renames, permission changes), not cell edits. Polling with smart rate limiting is the only reliable approach.

**Rate Limit Protection:** If Google returns HTTP 429, the system uses **exponential backoff** (5s → 10s → 20s → max 60s) and silently skips polls until the backoff window expires. This prevents log spam and respects API quotas.

### Direction 2: MySQL → Google Sheet (On-Demand + Debounced)

1. A user writes to the database via the **SQL Terminal** or the **Bot Simulator**.
2. Every write operation triggers `cdcMonitor.debouncedSyncFromDatabase()`.
3. After a **500ms debounce window** (to batch rapid edits), the system:
   - Reads all rows from MySQL.
   - Compares each cell against the current Google Sheet state.
   - Sends a `batchUpdate` to the Sheets API for every cell where `last_modified_by ≠ 'sheet'`.
4. After a successful push:
   - All synced rows are marked `last_modified_by = 'sheet'` so they aren't re-pushed.
   - The **in-memory snapshot is updated** to reflect the new sheet state.

**Why debounce?** Without debouncing, 5 rapid SQL inserts would trigger 5 separate API calls. The debounce collapses them into one `batchUpdate`, reducing API usage by ~80%.

**Why update the snapshot?** After pushing DB changes to the Sheet, we immediately update the snapshot. This prevents the next poll from detecting the change we just pushed as a "new" change, breaking the echo loop before it starts.

### Direction 3 (Alternative): Google Sheet → Backend via Webhook

An **Apps Script trigger** (auto-installable) fires `onEdit` for every manual sheet edit and POSTs to the backend's `/api/webhook` endpoint. This is processed through a **BullMQ queue** with:
- 3 retry attempts with exponential backoff
- Worker concurrency of 5
- Rate limiting (55 jobs / 60s to stay under Google API quotas)

> The webhook path and the CDC polling path are complementary. Polling catches everything (including programmatic edits); webhooks provide sub-second latency for interactive edits.

---

## 🛠 Tech Stack & Why

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **Runtime** | Node.js + TypeScript | Type safety, async-first, fast prototyping |
| **Database** | MySQL 8 | Widely used relational DB; `ON DUPLICATE KEY UPDATE` is perfect for cell upserts |
| **Cache / Locks** | Redis (ioredis) | Sub-ms latency; `SET NX EX` gives atomic distributed locks; used for both locking and echo suppression |
| **Job Queue** | BullMQ | Redis-backed, supports retries, backoff, rate limiting, concurrency control |
| **API Framework** | Express 5 | Mature, minimal, widely understood |
| **Google API** | googleapis + JWT auth | Service-account auth — no OAuth consent flow needed |
| **Frontend** | React 19 + Vite 7 | Fast HMR, modern bundling |
| **SQL Editor** | Monaco Editor | VS Code's editor — syntax highlighting, keybindings, autocomplete |
| **Styling** | Tailwind CSS 4 | Utility-first, zero-config with Vite plugin |
| **Logging** | Pino | Structured JSON logging, low overhead |

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** ≥ 18
- **MySQL** 8+ running locally or remotely
- **Redis** 7+ running locally (or use a cloud instance)
- A **Google Cloud** project with:
  - Sheets API enabled
  - A Service Account with a JSON key
  - The service account email added as an **Editor** on the target Google Sheet

### 1. Clone & Install

```bash
git clone https://github.com/subhamagarrwal/Superjoin_assignment.git
cd Superjoin_assignment

# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### 2. Configure Environment

Create `backend/.env`:

```env
# MySQL
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=yourpassword
MYSQL_DATABASE=superjoin

# Redis
REDIS_URL=redis://localhost:6379

# Google Sheets
GOOGLE_SHEET_ID=your_google_sheet_id_here
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-sa@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# Sync Config
POLL_INTERVAL=3000
SHEET_RANGE=Sheet1!A1:H20
SHEET_CACHE_TTL=10000

# Server
PORT=3000
BACKEND_URL=http://localhost:3000
```

Create `frontend/.env`:

```env
VITE_API_URL=http://localhost:3000
VITE_GOOGLE_SHEET_ID=your_google_sheet_id_here
```

### 3. Create the MySQL Database

```sql
CREATE DATABASE IF NOT EXISTS superjoin;
```

> The `users` table is **auto-created** on server startup via `initializeDatabase()`.

### 4. Start

```bash
# Terminal 1 — Backend
cd backend
npm run dev

# Terminal 2 — Frontend
cd frontend
npm run dev
```

Open **http://localhost:5173** — you'll see the embedded Google Sheet, the database grid, and the SQL terminal.

---

## 🔐 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MYSQL_HOST` | ✅ | MySQL server hostname |
| `MYSQL_PORT` | ❌ | MySQL port (default: 3306) |
| `MYSQL_USER` | ✅ | MySQL username |
| `MYSQL_PASSWORD` | ✅ | MySQL password |
| `MYSQL_DATABASE` | ✅ | Database name |
| `REDIS_URL` | ✅ | Redis connection URL |
| `GOOGLE_SHEET_ID` | ✅ | ID from the Google Sheet URL |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | ✅ | Service account email |
| `GOOGLE_PRIVATE_KEY` | ✅ | Private key from JSON key file |
| `POLL_INTERVAL` | ❌ | Sheet polling interval in ms (default: 3000, **minimum enforced: 3000**). Values below 3000ms are clamped to prevent rate limiting. |
| `SHEET_RANGE` | ❌ | Range to monitor (default: `Sheet1!A1:H20`) |
| `SHEET_CACHE_TTL` | ❌ | Cache validity in ms (default: 10000) |
| `PORT` | ❌ | Backend port (default: 3000) |
| `BACKEND_URL` | ❌ | Public URL for webhook callbacks |

---

## 🧪 Testing the Sync

### Test 1: Sheet → Database

1. Open the Google Sheet in the embedded viewer (or in a new tab).
2. Type a value in any cell (e.g., `A2 = "Hello"`).
3. Within 3 seconds, the Database View panel below will show the change.

### Test 2: Database → Sheet

1. In the SQL Terminal, run:
   ```sql
   INSERT INTO users (row_num, col_name, cell_value, last_modified_by)
   VALUES (3, 'B', 'World', 'sql_terminal');
   ```
2. Within ~5 seconds (2s debounce + API call), cell `B3` in the Google Sheet will show `World`.

### Test 3: Multiplayer (Bot Simulation)

1. Set the bot count to 8–20 in the **Lock Stress Test** panel.
2. Click **Launch Bots**.
3. Watch: some bots succeed, some get `BLOCKED` — proving that concurrent writes to the same cell are serialized.
4. All successful writes are synced to the sheet automatically.

---

## 🎯 Nuances & Edge Cases Handled

### Concurrency & Locking
| # | Edge Case | How It's Handled |
|---|-----------|------------------|
| 1 | Two users write to the same cell simultaneously | **Redis distributed lock** (`SET NX EX`) with 5s TTL ensures only one writer proceeds; others get a 409 conflict or retry |
| 2 | Lock holder crashes without releasing | TTL auto-expires the lock after 5 seconds — no deadlocks |
| 3 | Lock starvation under heavy contention | Retry loop with 200ms delay × 15 attempts = 3s max wait; graceful failure after that |
| 4 | Lock release by wrong owner | Lua script atomically checks ownership before `DEL` — only the original acquirer can release |
| 5 | SQL query doesn't specify cell coordinates | `parseAffectedCells()` requires **both** `row_num` AND `col_name` in WHERE clause; partial matches are skipped (no false lock conflicts) |
| 6 | Invalid cell coordinates in query | Cells with missing row/col are validated before lock attempt; invalid cells logged and skipped |

### Sync Integrity
| # | Edge Case | How It's Handled |
|---|-----------|------------------|
| 5 | Echo loop (Sheet→DB→Sheet→DB…) | Redis ignore-key (`ignore:{row}:{col}`) with 10s TTL; `last_modified_by` column tracks origin |
| 7 | Rapid successive edits from DB side | **500ms debounce** window batches multiple writes into a single `batchUpdate` call |
| 7 | Google API rate limiting (429) | CDC Monitor uses **exponential backoff** (5s→10s→20s→max 60s) and silently skips polls during backoff; BullMQ worker has 55 jobs/min rate limiter |
| 8 | Cell deletion in sheet | Polling detects missing keys in snapshot diff → `DELETE FROM users` |
| 9 | Cell deletion from DB side | `syncFromDatabase` detects cells in sheet that no longer exist in DB → pushes empty string |
| 10 | Partial failure during batch sync | Each cell update is independent; one failure doesn't block others |

### Security & Safety
| # | Edge Case | How It's Handled |
|---|-----------|------------------|
| 11 | `DROP TABLE`, `TRUNCATE`, destructive SQL | **SQL Guard middleware** blocks 20+ keywords: `DROP`, `TRUNCATE`, `ALTER`, `CREATE TABLE`, `RENAME`, `GRANT`, `REVOKE`, `FLUSH`, `PREPARE/EXECUTE`, etc. |
| 12 | SQL injection via functions (`SLEEP`, `BENCHMARK`, `LOAD_FILE`) | Regex-based dangerous pattern detection blocks time-based attacks, file I/O, and system variable probing |
| 13 | Multi-statement injection (`; DROP TABLE users`) | MySQL pool has `multipleStatements: false` (explicit); guard also regex-blocks stacked queries |
| 14 | Comment-based obfuscation (`/* */`, `--`) | Guard detects and blocks inline SQL comments and line comments used to hide payloads |
| 15 | Hex/CHAR() obfuscation (`0x64726F70`, `CHAR(100,114)`) | Pattern detection blocks hex-encoded strings and `CHAR()` / `CONCAT()` obfuscation |
| 16 | Write to unauthorized tables | Guard restricts `INSERT`/`UPDATE`/`DELETE` to only the `users` table; other tables are blocked |
| 17 | Oversized query payloads | Max query length enforced at 2000 characters |
| 18 | Only safe statement types allowed | Whitelist: `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `SHOW`, `DESCRIBE`, `EXPLAIN` only |
| 19 | Webhook input injection | Strict type/range validation: `row` (int 1–10000), `col` (single A-Z letter), `value` (string, max 5000 chars), `sheetId` (alphanumeric only) |
| 20 | Missing required fields in webhook | 400 response with clear error message |

### Reliability
| # | Edge Case | How It's Handled |
|---|-----------|------------------|
| 21 | Webhook delivery failure | BullMQ retries 3× with exponential backoff (1s, 2s, 4s) |
| 22 | Redis connection drop | ioredis auto-reconnects; BullMQ `maxRetriesPerRequest: null` prevents stalls |
| 23 | MySQL pool exhaustion | Connection pool with `waitForConnections: true` and 10-connection limit; requests queue instead of failing |
| 24 | Server restart mid-sync | On startup, full sheet snapshot is loaded and synced to DB — self-healing |
| 25 | Empty/blank cells | Skipped during initial sync; treated as deletions during polling |

### Multiplayer (Google Sheet)
| # | Edge Case | How It's Handled |
|---|-----------|------------------|
| 26 | Multiple people editing the sheet at once | Each edit triggers an independent `onEdit` webhook; CDC polling catches any missed edits |
| 27 | Bot simulation: N bots writing same cell | Only 1 acquires the lock; others are reported as `BLOCKED` with the lock owner's name |
| 28 | Bot simulation: mixed contested + random cells | Half the bots target the same cell; the other half target random cells — tests both contention and throughput |

---

## 🔌 Offline Resilience

The system is designed to degrade gracefully when the backend is unavailable. See [OFFLINE.md](OFFLINE.md) for a detailed breakdown.

**Summary:**

| Feature | Online | Offline |
|---------|--------|---------|
| Google Sheet (iframe) | ✅ Visible + editable | ✅ Visible + editable |
| Database View | ✅ Live data from MySQL | ❌ Hidden |
| SQL Terminal | ✅ Executes immediately | ✅ Queues to localStorage |
| Offline Queue | — | ✅ Auto-replays on reconnect |
| Graceful Shutdown | — | ✅ CDC Monitor, Worker, DB pool, Redis all cleaned up |

---

## 💡 What Could Have Been Done

### With More Time

| Improvement | Why It Matters |
|-------------|---------------|
| **MySQL Binary Log (binlog) CDC** | Replace polling with true event-driven change capture using `mysql-events` or Debezium; sub-second latency from DB→Sheet |
| **WebSocket live feed** | Push changes to the frontend instantly instead of 1-second polling; reduces DB load |
| **Operational Transform (OT) / CRDT** | Google Docs-style conflict resolution for simultaneous edits to the same cell; currently last-write-wins |
| **Column-type inference** | Auto-detect number/date/boolean types from sheet data and create typed MySQL columns |
| **Multi-sheet support** | Monitor multiple sheets/tabs in the same spreadsheet; currently limited to one range |
| **Row-level locking** | Lock entire rows for structural operations (insert row, delete row) instead of just cells |
| **Audit log table** | Record every change with before/after values, timestamp, and source for full traceability |
| **Health dashboard** | Real-time metrics: sync latency, queue depth, lock contention rate, API quota usage |
| **Docker Compose** | One-command setup with MySQL + Redis + backend + frontend in containers |
| **E2E tests** | Playwright/Cypress tests that edit the sheet, verify DB, and vice versa |
| **Batch webhook** | Collect multiple `onEdit` events and send as a single batch to reduce HTTP overhead |
| **Configurable table schema** | Let users define column names and types via UI; auto-create corresponding MySQL tables |
| **Google Sheets API v4 Push Notifications** | Use `watches` + Cloud Pub/Sub for push-based change detection instead of polling |
| **Horizontal scaling** | Run multiple backend instances with BullMQ's built-in distributed processing; Redis already handles shared state |

### Architectural Improvements at Scale

- **Event Sourcing**: Store every mutation as an immutable event; replay to reconstruct state
- **Kafka/RabbitMQ**: Replace BullMQ for cross-service event distribution in a microservice architecture
- **Read replicas**: Separate read/write MySQL connections for the viewer vs. sync engine
- **Connection pooling proxy** (PgBouncer/ProxySQL): Manage DB connections across multiple backend instances
- **Rate-limit per user**: Currently global; should be per API key / session for multi-tenant usage

---

## 📁 Project Structure

```
Superjoin_assignment/
├── backend/
│   ├── src/
│   │   ├── app.ts                    # Express server entry point
│   │   ├── config/
│   │   │   ├── database.ts           # MySQL connection pool
│   │   │   ├── redis.ts              # Redis (ioredis) client
│   │   │   └── google.ts             # Google Sheets JWT auth
│   │   ├── controllers/
│   │   │   ├── botController.ts      # Bot simulation logic
│   │   │   ├── sqlController.ts      # SQL execution with locking
│   │   │   └── webhookControllers.ts # Sheet webhook handler
│   │   ├── middleware/
│   │   │   └── sqlGuardMiddleware.ts  # Blocks dangerous SQL
│   │   ├── queues/
│   │   │   └── sheetUpdateQueue.ts   # BullMQ queue definition
│   │   ├── routes/                   # Express route definitions
│   │   ├── services/
│   │   │   ├── CDCMonitor.ts         # Core sync engine
│   │   │   ├── lockService.ts        # Redis distributed locks
│   │   │   └── appsScriptInstaller.ts# Auto-install webhook trigger
│   │   ├── types/
│   │   │   └── types.ts              # TypeScript interfaces
│   │   ├── utils/
│   │   │   └── dbInit.ts             # Auto-create tables on startup
│   │   └── workers/
│   │       └── sheetUpdateWorker.ts  # BullMQ job processor
│   ├── scripts/
│   │   └── init-db.sql               # Manual DB seed script
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.tsx                   # Main layout + bot panel
│   │   ├── components/
│   │   │   ├── SheetViewer.tsx       # Embedded sheet + DB grid
│   │   │   └── SQLTerminal.tsx       # Monaco SQL editor + results
│   │   ├── context/
│   │   │   └── ConnectivityContext.tsx # Backend health + offline queue
│   │   └── main.tsx
│   └── package.json
└── README.md                         # ← You are here
└── OFFLINE.md                        # Offline resilience documentation
```

---

## 📄 License

This project was built as a take-home assignment for **Superjoin**. Not intended for production distribution.
