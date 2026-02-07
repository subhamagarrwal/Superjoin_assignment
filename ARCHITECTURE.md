# Architecture Deep Dive

> A comprehensive technical breakdown of every layer, data flow, and design decision in the Superjoin 2-Way Sync Engine.

---

## 📐 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (React 19 + Vite)                   │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │ Google Sheet  │  │  Database View   │  │   SQL Terminal       │  │
│  │  (iframe)     │  │  (1s polling)    │  │   (Monaco Editor)    │  │
│  └──────┬───────┘  └───────┬──────────┘  └──────────┬───────────┘  │
│         │                  │ GET /api/sql/execute     │ POST        │
└─────────┼──────────────────┼────────────────────────┼──────────────┘
          │                  │                         │
          │ (user edits)     │                         │
          ▼                  ▼                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     BACKEND (Express 5 + TypeScript)                │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                      Routes Layer                            │   │
│  │  /api/webhook   /api/sql   /api/bots   /api/setup  /config  │   │
│  └──────┬─────────────┬──────────┬────────────┬────────────────┘   │
│         │             │          │            │                     │
│  ┌──────▼──────┐ ┌────▼────┐ ┌──▼──────┐ ┌──▼───────────┐        │
│  │  Webhook    │ │  SQL    │ │  Bot    │ │  Setup       │        │
│  │ Controller  │ │Controller│ │Controller│ │  Routes      │        │
│  └──────┬──────┘ └────┬────┘ └──┬──────┘ └──────────────┘        │
│         │             │          │                                  │
│  ┌──────▼──────┐      │    ┌────▼─────────┐                       │
│  │  BullMQ     │      │    │  Lock        │                       │
│  │  Queue      │      ├────┤  Service     │◄── Redis SET NX EX    │
│  └──────┬──────┘      │    └────┬─────────┘                       │
│         │             │         │                                   │
│  ┌──────▼──────┐      │         │                                   │
│  │  Sheet      │      │         │                                   │
│  │  Worker     │──────┤         │                                   │
│  └─────────────┘      │         │                                   │
│                       │         │                                   │
│  ┌────────────────────▼─────────▼─────────────────────────────┐   │
│  │                    CDC MONITOR                              │   │
│  │  • Polls Google Sheets API every 3s                        │   │
│  │  • Diffs current state vs in-memory snapshot               │   │
│  │  • Sheet→DB: INSERT/UPDATE/DELETE per changed cell          │   │
│  │  • DB→Sheet: batchUpdate via Sheets API v4                 │   │
│  │  • Sets Redis ignore-keys to prevent echo loops             │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                     │
└──────────────┬──────────────────────────┬───────────────────────────┘
               │                          │
               ▼                          ▼
        ┌──────────┐              ┌──────────────┐
        │  MySQL   │              │    Redis     │
        │  (Data)  │              │ (Locks/Queue)│
        └──────────┘              └──────────────┘
               │                          │
               ▼                          │
       ┌──────────────┐                   │
       │ Google Sheets │◄─────────────────┘
       │    API v4     │   (ignore-keys suppress echo)
       └──────────────┘
```

---

## 🧱 Layer-by-Layer Breakdown

### 1. Data Storage — MySQL

**Table: `users`**

```sql
CREATE TABLE users (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    row_num         INT NOT NULL,
    col_name        VARCHAR(10) NOT NULL,
    cell_value      TEXT,
    last_modified_by VARCHAR(50) DEFAULT 'system',
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_cell (row_num, col_name)
);
```

**Design Decisions:**

- **Cell-as-a-row model**: Each spreadsheet cell is stored as a row with `(row_num, col_name)` as a composite unique key. This allows the system to handle **any table structure** without schema changes — the sheet's structure is the schema.
- **`UNIQUE KEY unique_cell`**: Enables `ON DUPLICATE KEY UPDATE` for idempotent upserts. Whether a cell is new or modified, the same query handles both.
- **`last_modified_by`**: Critical for echo suppression. Values: `'sheet'` (from Google), `'sql_terminal'` (from UI), `'user'` (from webhook), `'Bot-Alpha'` etc. (from bot simulation).
- **`updated_at` with `ON UPDATE CURRENT_TIMESTAMP`**: Auto-tracks the last modification time for every cell without application-level code.
- **Connection Pool**: 10 connections, `waitForConnections: true`, `enableKeepAlive: true` — handles burst traffic without connection storms.

---

### 2. Cache, Locks & Queue Backend — Redis

Redis serves **three distinct roles** in this system:

#### Role A: Distributed Locks
```
Key:    lock:{row}:{col}
Value:  owner_name (e.g., "Bot-Alpha", "job:123")
TTL:    5 seconds
Method: SET NX EX (atomic acquire)
```

- **`NX`** (Not eXists): Only one client can set the key → mutual exclusion.
- **`EX 5`**: Auto-expire after 5s → no deadlocks even if holder crashes.
- **Lua script for release**: Atomically checks `GET == owner` before `DEL` — prevents one client from releasing another's lock.

#### Role B: Echo Suppression
```
Key:    ignore:{row}:{col}
Value:  "1"
TTL:    10 seconds
```

When a Sheet→DB sync writes a cell, this key is set. If the DB→Sheet sync runs within 10 seconds, it checks for this key and skips the cell — breaking the echo loop.

#### Role C: Job Queue (BullMQ)

BullMQ uses Redis as its persistence layer for the `sheet-update` queue. Job data, state transitions, and retry metadata are all stored in Redis streams.

---

### 3. The CDC Monitor — The Brain

**File**: `backend/src/services/CDCMonitor.ts`

The CDC (Change Data Capture) Monitor is the central sync engine. It's a singleton service with two responsibilities:

**Why Polling, Not Push Notifications?**

Google Sheets API v4 supports "watch" requests that trigger Pub/Sub notifications, but these only fire for **file-level metadata changes** (renames, permission changes, trashing). **Cell edits do not trigger push notifications.** This is a fundamental limitation of the API.

The only reliable way to detect cell changes is polling. Our implementation:
- **Minimum 3-second interval** (enforced in code: `Math.max(3000, userInterval)`)
- **Smart rate limiting** (exponential backoff on 429 errors)
- **In-memory diffing** (only API calls, no per-cell tracking overhead)

#### 3a. Sheet → DB (Polling)

```
┌─────────────┐     poll every 3s     ┌──────────────┐
│ Google Sheet │ ───────────────────► │  CDC Monitor  │
│   (source)   │ ◄─── Sheets API GET  │  (in-memory   │
└─────────────┘                       │   snapshot)    │
                                       └───────┬───────┘
                                               │ diff
                                               ▼
                                       ┌──────────────┐
                                       │   Changes?   │
                                       └───┬──────┬───┘
                                        yes│      │no
                                           ▼      ▼
                                    ┌──────────┐  (skip)
                                    │  MySQL   │
                                    │  UPSERT  │
                                    └──────────┘
```

**How the diff works:**
1. Fetch the sheet range (e.g., `Sheet1!A1:H20`) → returns a 2D array of values.
2. Build a `Map<string, string>` keyed by `"{row}:{col}"` (e.g., `"1:A"` → `"Name"`).
3. Compare every key against `lastSnapshot`:
   - Key exists in both, value differs → **UPDATE**
   - Key exists in current but not in snapshot → **INSERT**
   - Key exists in snapshot but not in current → **DELETE**
4. Execute the corresponding MySQL query for each change.
5. Replace `lastSnapshot` with the current map.

**Rate Limit Protection**: The CDC Monitor implements **smart exponential backoff**:

```typescript
// On 429 error:
this.rateLimitBackoffMs = Math.min(60000, this.rateLimitBackoffMs * 2); // 5s → 10s → 20s → 40s → max 60s
this.rateLimitedUntil = Date.now() + this.rateLimitBackoffMs;

// On each poll:
if (Date.now() < this.rateLimitedUntil) return null; // Silent skip
```

**Why exponential backoff?** Linear backoff doesn't adapt to sustained rate limiting. Exponential backoff (doubling each time) quickly backs off during outages but recovers fast when the API is available again. The 60s cap prevents excessive delays.

**Why silent skipping?** Logging "rate limited" every second floods the console and obscures real errors. We log once when entering backoff, then silently skip until recovery.

#### 3b. DB → Sheet (On-Demand Sync)

```
SQL Terminal / Bot ─► MySQL WRITE
                         │
                         ▼
              debouncedSyncFromDatabase()
                         │
                    (2s debounce)
                         │
                         ▼
                  syncFromDatabase()
                         │
          ┌──────────────┴───────────────┐
          │ Read all rows from MySQL     │
          │ Fetch current sheet state    │
          │ Diff: DB cells vs Sheet cells│
          └──────────────┬───────────────┘
                         │
                         ▼
              batchUpdate to Sheets API
```

**Why debounce?** If a user runs 5 SQL inserts in quick succession, we don't want 5 separate API calls. The **500ms debounce** collapses them into one `batchUpdate`.

**Why 500ms instead of longer?** User-perceived latency matters. 2 seconds felt sluggish in testing; 500ms provides a good balance between batching efficiency and responsiveness.

**Snapshot Update After Sync**: After pushing DB changes to the sheet, we immediately update `lastSnapshot` to reflect the new sheet state. This prevents the next poll from detecting our own changes as "new" — breaking the echo loop at the source.

---

### 4. The Lock Service

**File**: `backend/src/services/lockService.ts`

```
acquireLock(row, col, owner)
    │
    ├─► SET lock:{row}:{col} {owner} EX 5 NX
    │
    ├─► If "OK" → Lock acquired ✅
    │
    └─► If null → Wait 200ms, retry (up to 15 times)
                   │
                   └─► After 15 retries → Lock denied ❌

releaseLock(row, col, owner)
    │
    └─► Lua: if GET(key) == owner then DEL(key) end
```

**Why not just use MySQL `SELECT ... FOR UPDATE`?**
- Redis locks are ~100× faster (in-memory vs disk).
- They work across multiple backend instances (distributed).
- TTL-based auto-expiry is simpler than managing transaction timeouts.
- The lock scope (individual cells) is more granular than row-level MySQL locks.

---

### 5. The Job Queue (BullMQ)

**Queue**: `sheet-update`  
**Worker concurrency**: 5  
**Rate limit**: 55 jobs per 60 seconds  
**Retries**: 3 with exponential backoff (1s → 2s → 4s)

```
Webhook POST ─► Queue.add('sheet_update', data)
                        │
                        ▼
                ┌──────────────────┐
                │  BullMQ Worker   │
                │  (5 concurrent)  │
                └────────┬─────────┘
                         │
              ┌──────────┴──────────┐
              │  1. Acquire lock    │
              │  2. UPSERT to MySQL │
              │  3. Release lock    │
              └─────────────────────┘
```

**Why BullMQ instead of direct writes?**
- **Backpressure**: If the DB is slow, jobs queue up instead of causing timeouts.
- **Retries**: Transient failures (network glitch, lock contention) are automatically retried.
- **Rate limiting**: Prevents overwhelming the Google Sheets API (100 requests per 100 seconds quota).
- **Observability**: Job completion/failure events are logged.

---

### 6. The SQL Guard Middleware — Defense in Depth

**File**: `backend/src/middleware/sqlGuardMiddleware.ts`

A comprehensive, multi-layer security system that blocks SQL injection before queries reach the database:

```
Request ─► SQL Guard Middleware
                │
                ├─► 1. Type check (must be non-empty string)
                ├─► 2. Length check (max 2000 chars)
                ├─► 3. Statement type whitelist (SELECT, INSERT, UPDATE, DELETE, SHOW, DESCRIBE, EXPLAIN only)
                ├─► 4. Blocked keyword check (20+ keywords)
                ├─► 5. Dangerous pattern regex (14 patterns)
                ├─► 6. Table restriction (writes only to 'users' table)
                │
                └─► All pass? → next() → SQL Controller → MySQL
```

#### Layer 1: Blocked Keywords (20+)
```typescript
const BLOCKED_KEYWORDS = [
  'DROP', 'TRUNCATE', 'CREATE TABLE', 'ALTER', 'RENAME',
  'CREATE DATABASE', 'DROP DATABASE', 'GRANT', 'REVOKE',
  'FLUSH', 'RESET', 'PURGE', 'CREATE USER', 'DROP USER',
  'ALTER USER', 'SET PASSWORD', 'CREATE INDEX', 'DROP INDEX',
  'LOAD DATA', 'LOAD_FILE', 'INTO OUTFILE', 'INTO DUMPFILE',
  'PREPARE', 'EXECUTE', 'DEALLOCATE'
];
```

**Why these keywords?** Each targets a specific attack vector:
- `DROP`/`TRUNCATE`/`ALTER`: Schema destruction
- `GRANT`/`REVOKE`/`CREATE USER`: Privilege escalation
- `LOAD_FILE`/`INTO OUTFILE`: File system access
- `PREPARE`/`EXECUTE`: Stored procedure injection

#### Layer 2: Dangerous Pattern Detection (Regex)
```typescript
const DANGEROUS_PATTERNS = [
  /SLEEP\s*\(/i,           // Time-based blind SQLi
  /BENCHMARK\s*\(/i,        // CPU-based blind SQLi
  /\bOR\b.*=.*\b(OR|AND)\b/i, // Tautology attacks (OR 1=1)
  /UNION\s+(ALL\s+)?SELECT/i,  // Union-based data extraction
  /\/\*.*\*\//,             // Inline comment obfuscation
  /--[^\n]*/,               // Line comment obfuscation
  /0x[0-9a-f]+/i,           // Hex-encoded payloads
  /CHAR\s*\(/i,             // CHAR() obfuscation
  /@@[a-z_]+/i,             // System variable probing
  // ... 5 more patterns
];
```

**Why regex patterns?** Keyword blocking alone fails against obfuscation. Attackers encode `DROP` as `0x44524F50` (hex) or `CHAR(68,82,79,80)`. Regex catches these.

#### Layer 3: Table Restriction
```typescript
if (/\b(INSERT|UPDATE|DELETE)\b/i.test(query)) {
  if (!/\busers\b/i.test(query)) {
    return res.status(403).json({ error: 'Writes only allowed to users table' });
  }
}
```

**Why restrict tables?** Even valid SQL can be dangerous if it touches system tables. Restricting writes to `users` prevents accidental or malicious modification of other tables.

#### Layer 4: MySQL Pool Hardening
```typescript
// database.ts
const pool = mysql.createPool({
  multipleStatements: false,  // Blocks "; DROP TABLE users"
  connectTimeout: 10000,
  // ...
});
```

**Why `multipleStatements: false`?** Classic SQLi uses `;` to chain statements. Disabling multi-statement at the driver level is a bulletproof defense.

#### Layer 5: Webhook Input Validation
```typescript
// Strict type + range validation
if (typeof row !== 'number' || row < 1 || row > 10000) { /* reject */ }
if (typeof col !== 'string' || !/^[A-Z]$/.test(col)) { /* reject */ }
if (typeof value !== 'string' || value.length > 5000) { /* reject */ }
```

**Why per-field validation?** The webhook is a public endpoint. Attackers can POST arbitrary JSON. Validating each field by type, range, and format ensures only well-formed data reaches the database.

---

### 7. The Frontend

The frontend is a **single-page app** split into three panels:

```
┌──────────────────────────┬──────────────────────────────┐
│                          │                              │
│     SQL Terminal         │     Google Sheet (iframe)    │
│     (Monaco Editor)      │     (live embedded view)     │
│                          │                              │
│     ▶ Run (Ctrl+Enter)   │                              │
│     Query Results        │                              │
│                          ├──────────────────────────────┤
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │                              │
│                          │     Database View            │
│    Lock Stress Test      │     (auto-refresh 1s)        │
│    [Launch Bots]         │     (spreadsheet grid)       │
│    Bot results table     │                              │
│                          │                              │
└──────────────────────────┴──────────────────────────────┘
```

**Data flow:**
- `SheetViewer` polls `POST /api/sql/execute` with `SELECT * FROM users` every 1 second.
- `SQLTerminal` sends arbitrary SQL to the same endpoint.
- `App.tsx` manages bot simulation via `POST /api/bots/run`.
- `refreshKey` state triggers re-fetches after SQL execution or bot runs.

---

## 🔄 Complete Data Flow: Edit in Sheet → DB → Sheet Confirmation

```
1. User types "Hello" in cell A2 on Google Sheet
        │
2. Apps Script onEdit fires → POST /api/webhook
   {row: 2, col: "A", value: "Hello", sheetId: "..."}
        │
3. webhookController checks Redis ignore key → not set
        │
4. Job added to BullMQ queue
        │
5. Worker picks up job:
   a. acquireLock(2, "A", "job:xyz") → OK
   b. UPSERT: INSERT INTO users (2, 'A', 'Hello', 'user')
              ON DUPLICATE KEY UPDATE cell_value='Hello'
   c. releaseLock(2, "A", "job:xyz")
        │
6. Meanwhile, CDC Monitor polls sheet (3s interval):
   a. Fetches sheet data
   b. Compares with snapshot
   c. Detects A2 changed to "Hello"
   d. Sets Redis ignore key: ignore:2:A (TTL 10s)
   e. UPSERTs to MySQL (idempotent — same value)
   f. Updates snapshot
        │
7. Frontend SheetViewer polls DB (1s interval):
   → Shows "Hello" in cell A2 of the database grid
```

---

## 🔄 Complete Data Flow: SQL Terminal → Sheet

```
1. User runs: INSERT INTO users (row_num, col_name, cell_value, last_modified_by)
              VALUES (5, 'C', 'World', 'sql_terminal')
        │
2. sqlGuard middleware → passes (no blocked keywords)
        │
3. sqlController:
   a. parseAffectedCells → [{row: 5, col: 'C'}]
   b. acquireLock(5, 'C', 'user_xxx') → OK
   c. Execute INSERT query
   d. releaseLock(5, 'C', 'user_xxx')
   e. cdcMonitor.debouncedSyncFromDatabase()
        │
4. After 2s debounce:
   a. syncFromDatabase() runs
   b. Reads all MySQL rows
   c. Fetches current sheet state
   d. Cell (5, C) has 'World' in DB but empty in Sheet
   e. last_modified_by = 'sql_terminal' (not 'sheet') → needs sync
   f. batchUpdate: Sheet1!C5 = 'World'
        │
5. Google Sheet now shows "World" in C5
        │
6. Next CDC poll detects C5 = "World" in sheet
   → Matches DB → No change logged
```

---

## 🔁 Echo Prevention — How We Avoid Infinite Loops

The system has **three layers** of echo prevention:

### Layer 1: `last_modified_by` Column
Every MySQL write tags its source. `syncFromDatabase()` only pushes cells where `last_modified_by ≠ 'sheet'`. After pushing, it resets all to `'sheet'`.

### Layer 2: Redis Ignore Keys
When CDC Monitor syncs a Sheet change to DB, it sets `ignore:{row}:{col}` (TTL 10s). The webhook handler checks this key and skips processing if set.

### Layer 3: Snapshot Diffing
CDC Monitor only acts on *changes* between polls. If the DB→Sheet sync just wrote "Hello" to A2, the next poll will see "Hello" in both the sheet and the snapshot → no change detected → no action.

---

## 📊 Scalability Considerations

| Dimension | Current | Path to Scale |
|-----------|---------|---------------|
| **Concurrent users** | Single-instance locks | Redis Cluster for distributed locks across N backends |
| **Cells monitored** | ~160 (A1:H20) | Increase `SHEET_RANGE`; paginate large sheets |
| **Write throughput** | 55 jobs/min (API limit) | Batch writes; use Sheets API `batchUpdate` more aggressively |
| **Read throughput** | 1 poll/3s | Google Sheets API push notifications via Cloud Pub/Sub |
| **Database** | Single MySQL | Read replicas for viewer; writes stay on primary |
| **Queue** | Single BullMQ worker | Multiple workers across instances; BullMQ handles distribution |
| **Frontend** | HTTP polling | WebSocket server pushes changes in real-time |

---

## 🗂 API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/webhook` | Receives Google Sheet edit webhooks |
| `POST` | `/api/sql/execute` | Executes SQL with locking + sync |
| `POST` | `/api/bots/run` | Runs bot simulation (`{ botCount }`) |
| `POST` | `/api/setup/init` | Re-initializes the database |
| `POST` | `/api/setup/force-sync-to-sheet` | Forces DB→Sheet sync |
| `GET`  | `/api/config/sheet-id` | Returns configured Google Sheet ID |
| `GET`  | `/health` | Health check endpoint |
