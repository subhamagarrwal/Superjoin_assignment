# Edge Cases & How They're Handled

> A comprehensive guide to every edge case the Superjoin sync system handles, with detailed explanations of **why** each case matters and **how** it's solved.

---

## 📋 Table of Contents

- [Concurrency & Locking](#-concurrency--locking)
- [Sync Integrity](#-sync-integrity)
- [Rate Limiting & API Quotas](#-rate-limiting--api-quotas)
- [Security & SQL Injection](#-security--sql-injection)
- [Data Validation](#-data-validation)
- [Reliability & Fault Tolerance](#-reliability--fault-tolerance)
- [Multiplayer Scenarios](#-multiplayer-scenarios)

---

## 🔒 Concurrency & Locking

### 1. Two users write to the same cell simultaneously

**The Problem:**  
Without coordination, two users editing cell `B3` at the same time could corrupt data. User A reads "Hello", User B reads "Hello", both write their changes — one overwrites the other silently.

**The Solution:**  
Redis distributed lock using `SET key value EX 5 NX`:
- `NX` = only set if key doesn't exist (atomic mutual exclusion)
- `EX 5` = auto-expire after 5 seconds (prevents deadlocks)

```
User A: SET lock:3:B "user_A" EX 5 NX → "OK" ✅ (acquired)
User B: SET lock:3:B "user_B" EX 5 NX → null ❌ (denied)
```

User B receives HTTP 409 with message: `"Cell B3 is locked by another user. Try again."`

**Why Redis instead of MySQL locks?**  
Redis is ~100× faster (in-memory), works across multiple backend instances, and TTL-based expiry is simpler than managing transaction timeouts.

---

### 2. Lock holder crashes without releasing

**The Problem:**  
If User A acquires a lock, then their browser crashes or network dies, the lock would be held forever — deadlock.

**The Solution:**  
The `EX 5` parameter on `SET` means the lock auto-expires after 5 seconds, even if the holder never calls `releaseLock()`.

**Why 5 seconds?**  
Long enough for normal write operations (DB insert + sync), short enough that other users don't wait too long if the holder crashes.

---

### 3. Lock starvation under heavy contention

**The Problem:**  
If 10 users all try to write to the same cell, the first one gets the lock. What happens to the other 9? If they fail immediately, user experience is poor.

**The Solution:**  
Retry loop with exponential backoff:
```typescript
const RETRY_DELAY = 200;  // ms between retries
const MAX_RETRIES = 15;   // total attempts

// Total max wait: 15 × 200ms = 3 seconds
while (retries < MAX_RETRIES) {
    const acquired = await redis.set(lockKey, owner, 'EX', 5, 'NX');
    if (acquired) return true;
    await delay(RETRY_DELAY);
    retries++;
}
return false; // Give up gracefully
```

**Why not infinite retries?**  
Holding a connection open forever is worse than failing fast. 3 seconds is a reasonable timeout for interactive use.

---

### 4. Lock release by wrong owner

**The Problem:**  
User A acquires the lock. Before they finish, the lock expires (5s TTL). User B acquires it. User A finishes and calls `releaseLock()` — they'd release User B's lock!

**The Solution:**  
Lua script for atomic check-and-delete:
```lua
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
else
    return 0  -- Not your lock, don't touch it
end
```

This runs atomically in Redis — no race condition between GET and DEL.

---

### 5. SQL query doesn't specify cell coordinates

**The Problem:**  
User runs: `UPDATE users SET cell_value = 'X' WHERE row_num = 5`  
There's no `col_name` in the WHERE clause — which cell should we lock? All of row 5?

**The Solution:**  
The `parseAffectedCells()` function requires **both** `row_num` AND `col_name` to identify a lockable cell:
```typescript
const rowMatch = query.match(/row_num\s*=\s*(\d+)/i);
const colMatch = query.match(/col_name\s*=\s*'([A-Za-z])'/i);

if (rowMatch && colMatch) {
    cells.push({ row: parseInt(rowMatch[1]), col: colMatch[1].toUpperCase() });
}
// If only row_num is specified, no cell-level lock is acquired
```

**Why allow it to proceed without locking?**  
The query still runs — MySQL handles row-level consistency. We just can't provide cell-level conflict detection for ambiguous queries.

---

### 6. Invalid cell coordinates in query

**The Problem:**  
A malformed query could produce `{ row: NaN, col: undefined }` — attempting to lock this would fail silently or cause errors.

**The Solution:**  
Validation guard before attempting lock:
```typescript
if (!cell.row || !cell.col) {
    console.warn('⚠️ Skipping lock for invalid cell:', cell);
    continue;
}
```

---

### 7. Updating a cell that doesn't exist

**The Problem:**  
User runs: `UPDATE users SET cell_value = 'X' WHERE row_num = 5 AND col_name = 'B'`  
But cell B5 was never created — UPDATE affects 0 rows, user thinks it worked.

**The Solution:**  
Pre-check before executing UPDATE:
```typescript
const [rows] = await pool.query(
    'SELECT id FROM users WHERE row_num = ? AND col_name = ?',
    [cell.row, cell.col]
);
if (!rows || rows.length === 0) {
    return res.status(400).json({
        error: `Cannot update an empty cell. Cell ${cellName} does not exist. Use INSERT to create it first.`
    });
}
```

---

## 🔄 Sync Integrity

### 8. Echo loop (Sheet → DB → Sheet → DB → …)

**The Problem:**  
1. User edits cell A1 in Google Sheet → "Hello"
2. CDC Monitor detects change → writes "Hello" to MySQL
3. `syncFromDatabase()` sees MySQL has "Hello" → writes "Hello" back to Sheet
4. CDC Monitor detects "change" → writes "Hello" to MySQL again
5. Infinite loop!

**The Solution — Three Layers:**

**Layer 1: `last_modified_by` column**  
Every MySQL write records its source: `'sheet'`, `'sql_terminal'`, `'Bot-Alpha'`, etc.  
`syncFromDatabase()` only pushes cells where `last_modified_by ≠ 'sheet'`.

**Layer 2: Redis ignore keys**  
When Sheet→DB sync writes a cell, it sets `ignore:{row}:{col}` with 10s TTL.  
The webhook handler checks this key and skips processing if set.

**Layer 3: Snapshot diffing**  
CDC Monitor only acts on *changes* between polls. After pushing to Sheet, we update the snapshot immediately. Next poll sees no diff → no action.

---

### 9. Rapid successive edits from DB side

**The Problem:**  
User runs 5 INSERT statements in quick succession. Without batching, that's 5 separate Google Sheets API calls — wasteful and slow.

**The Solution:**  
500ms debounce window:
```typescript
debouncedSyncFromDatabase() {
    if (this.syncDebounceTimer) {
        clearTimeout(this.syncDebounceTimer);
    }
    this.syncDebounceTimer = setTimeout(() => {
        this.syncFromDatabase();
    }, 500);
}
```

**Why 500ms?**  
2 seconds (original) felt sluggish. 500ms batches rapid edits while keeping the UI responsive.

---

### 10. Cell deletion in Google Sheet

**The Problem:**  
User clears cell B3 in Google Sheet. How does the system know to delete it from MySQL? The cell isn't "changed" — it's gone.

**The Solution:**  
Snapshot diffing detects missing keys:
```typescript
// Check for deletions: keys in old snapshot but not in current data
for (const [key, oldValue] of this.lastSnapshot.entries()) {
    if (!currentData.has(key) && oldValue !== '') {
        // Cell was deleted
        await pool.query('DELETE FROM users WHERE row_num = ? AND col_name = ?', [row, col]);
    }
}
```

---

### 11. Cell deletion from DB side

**The Problem:**  
User runs `DELETE FROM users WHERE row_num = 3 AND col_name = 'B'`.  
How does this propagate to clear cell B3 in Google Sheet?

**The Solution:**  
`syncFromDatabase()` detects cells in Sheet that no longer exist in DB:
```typescript
// For each cell in current sheet state:
if (!dbCells.has(key)) {
    // Cell exists in sheet but not in DB — push empty string
    updates.push({ range: `Sheet1!${col}${row}`, values: [['']] });
}
```

---

### 12. Snapshot becomes stale after DB→Sheet sync

**The Problem:**  
1. User inserts "Hello" into B3 via SQL
2. `syncFromDatabase()` pushes "Hello" to Sheet
3. Next poll: CDC fetches Sheet, sees "Hello" in B3
4. Snapshot still has old value → detects as "new change" → writes to DB again!

**The Solution:**  
Update snapshot immediately after successful sync:
```typescript
await this.sheets.spreadsheets.values.batchUpdate({ ... });

// Update snapshot to reflect what we just pushed
for (const cell of syncedCells) {
    this.lastSnapshot.set(`${cell.row}:${cell.col}`, cell.value);
}
```

---

### 13. Partial failure during batch sync

**The Problem:**  
Syncing 10 cells to Google Sheet. Cell #5 fails (invalid character, quota, etc.). Do the other 9 fail too?

**The Solution:**  
Each cell update is independent. We use `batchUpdate` but handle errors gracefully:
```typescript
for (const cell of changes) {
    try {
        await updateCell(cell);
        console.log(`✅ Synced ${cell.col}${cell.row}`);
    } catch (error) {
        console.error(`❌ Failed to sync ${cell.col}${cell.row}:`, error);
        // Continue with remaining cells
    }
}
```

---

## ⏱ Rate Limiting & API Quotas

### 14. Google API rate limiting (HTTP 429)

**The Problem:**  
Google Sheets API has a quota (~300 requests/minute). Polling every 1 second + DB→Sheet syncs can exceed this, causing 429 errors that spam the logs.

**The Solution — Smart Exponential Backoff:**

```typescript
// State variables
private rateLimitedUntil: number = 0;
private rateLimitBackoffMs: number = 5000;
private consecutiveRateLimits: number = 0;

// On each fetch:
if (Date.now() < this.rateLimitedUntil) {
    return null; // Silent skip — no log spam
}

// On 429 error:
this.consecutiveRateLimits++;
this.rateLimitBackoffMs = Math.min(60000, this.rateLimitBackoffMs * 2);
this.rateLimitedUntil = Date.now() + this.rateLimitBackoffMs;

// Log only once when entering backoff
if (this.consecutiveRateLimits === 1) {
    console.warn(`⚠️ Rate limited. Backing off for ${this.rateLimitBackoffMs / 1000}s...`);
}
```

**Backoff progression:** 5s → 10s → 20s → 40s → max 60s

**Why exponential?**  
Linear backoff doesn't adapt to sustained rate limiting. Exponential backs off quickly during outages but recovers fast when API is available.

---

### 15. Minimum poll interval enforcement

**The Problem:**  
User sets `POLL_INTERVAL=500` in `.env`. This causes 120 requests/minute just from polling — leaving no headroom for sync operations.

**The Solution:**  
Enforce minimum in code:
```typescript
const POLL_INTERVAL = Math.max(3000, parseInt(process.env.POLL_INTERVAL || '3000'));
```

Values below 3000ms are silently clamped. This keeps the system well under the 300 req/min quota.

---

### 16. BullMQ worker rate limiting

**The Problem:**  
Webhook flood: 100 rapid edits in Google Sheet trigger 100 webhook POSTs. Processing all immediately would exceed API quota.

**The Solution:**  
BullMQ rate limiter:
```typescript
const worker = new Worker('sheet-update', processor, {
    limiter: {
        max: 55,      // max 55 jobs
        duration: 60000  // per 60 seconds
    }
});
```

Jobs queue up and process at a sustainable rate.

---

## 🛡 Security & SQL Injection

### 17. Destructive SQL commands (DROP, TRUNCATE, ALTER)

**The Problem:**  
User runs: `DROP TABLE users` — entire database gone.

**The Solution:**  
Keyword blocklist in SQL Guard middleware:
```typescript
const BLOCKED_KEYWORDS = [
    'DROP', 'TRUNCATE', 'ALTER', 'RENAME',
    'CREATE TABLE', 'CREATE DATABASE', 'DROP DATABASE',
    'GRANT', 'REVOKE', 'FLUSH', 'RESET', 'PURGE',
    'CREATE USER', 'DROP USER', 'ALTER USER', 'SET PASSWORD',
    'CREATE INDEX', 'DROP INDEX',
    'LOAD DATA', 'LOAD_FILE', 'INTO OUTFILE', 'INTO DUMPFILE',
    'PREPARE', 'EXECUTE', 'DEALLOCATE'
];
```

**Why so many?**  
Each keyword targets a specific attack vector:
- `DROP`/`TRUNCATE`: Schema destruction
- `GRANT`/`REVOKE`: Privilege escalation
- `LOAD_FILE`/`INTO OUTFILE`: File system access
- `PREPARE`/`EXECUTE`: Stored procedure injection

---

### 18. SQL injection via functions (SLEEP, BENCHMARK)

**The Problem:**  
Attacker runs: `SELECT * FROM users WHERE id = 1 AND SLEEP(10)`  
This is valid SQL — no blocked keywords — but causes a 10-second delay (time-based blind SQLi).

**The Solution:**  
Regex pattern detection:
```typescript
const DANGEROUS_PATTERNS = [
    /SLEEP\s*\(/i,           // Time-based blind SQLi
    /BENCHMARK\s*\(/i,        // CPU-based blind SQLi
    /LOAD_FILE\s*\(/i,        // File read
    /@@[a-z_]+/i,             // System variable probing (@@version, @@datadir)
    /INTO\s+(OUTFILE|DUMPFILE)/i,  // File write
];
```

---

### 19. Multi-statement injection (stacked queries)

**The Problem:**  
Attacker runs: `SELECT * FROM users; DROP TABLE users`  
The semicolon separates two statements — the SELECT is innocent, the DROP is catastrophic.

**The Solution — Two Layers:**

**Layer 1: MySQL driver setting**
```typescript
const pool = mysql.createPool({
    multipleStatements: false,  // Reject queries with semicolons
});
```

**Layer 2: Guard regex**
```typescript
/;\s*(DROP|DELETE|UPDATE|INSERT|CREATE|ALTER)/i
```

---

### 20. Comment-based obfuscation

**The Problem:**  
Attacker runs: `SELECT * FROM users /*! DROP TABLE users */`  
MySQL's conditional comment syntax can hide malicious payloads.

**The Solution:**  
```typescript
/\/\*.*\*\//   // Inline comments /* ... */
/--[^\n]*/     // Line comments -- ...
```

---

### 21. Hex/CHAR() obfuscation

**The Problem:**  
Attacker encodes `DROP` as `0x44524F50` (hex) or `CHAR(68,82,79,80)` to bypass keyword blocklist.

**The Solution:**  
```typescript
/0x[0-9a-f]+/i           // Hex strings
/CHAR\s*\(/i             // CHAR() function
/CONCAT\s*\(/i           // CONCAT() often used with CHAR()
```

---

### 22. Write to unauthorized tables

**The Problem:**  
Attacker runs: `INSERT INTO admin_users (username, role) VALUES ('hacker', 'admin')`  
Even if SQLi keywords are blocked, they could write to sensitive tables.

**The Solution:**  
Table restriction:
```typescript
if (/\b(INSERT|UPDATE|DELETE)\b/i.test(query)) {
    if (!/\busers\b/i.test(query)) {
        return res.status(403).json({
            error: 'Writes only allowed to users table'
        });
    }
}
```

---

### 23. Statement type whitelist

**The Problem:**  
Blocking dangerous keywords is a blacklist approach — there's always something you might miss.

**The Solution:**  
Explicit whitelist of allowed statement types:
```typescript
const ALLOWED_STATEMENTS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'SHOW', 'DESCRIBE', 'EXPLAIN'];

const statementType = query.trim().split(/\s+/)[0].toUpperCase();
if (!ALLOWED_STATEMENTS.includes(statementType)) {
    return res.status(403).json({ error: `Statement type '${statementType}' is not allowed` });
}
```

---

## ✅ Data Validation

### 24. Webhook input injection

**The Problem:**  
The webhook endpoint is public. Attacker POSTs:
```json
{ "row": "1; DROP TABLE users", "col": "A", "value": "test" }
```

**The Solution:**  
Strict type + range validation:
```typescript
// Row: must be integer 1-10000
if (typeof row !== 'number' || !Number.isInteger(row) || row < 1 || row > 10000) {
    return res.status(400).json({ error: 'Invalid row: must be integer 1-10000' });
}

// Col: must be single letter A-Z
if (typeof col !== 'string' || !/^[A-Z]$/.test(col)) {
    return res.status(400).json({ error: 'Invalid col: must be single letter A-Z' });
}

// Value: must be string, max 5000 chars
if (typeof value !== 'string' || value.length > 5000) {
    return res.status(400).json({ error: 'Invalid value: must be string under 5000 chars' });
}

// SheetId: alphanumeric + hyphens/underscores only
if (!/^[a-zA-Z0-9_-]+$/.test(sheetId)) {
    return res.status(400).json({ error: 'Invalid sheetId format' });
}
```

---

### 25. Oversized query payloads

**The Problem:**  
Attacker sends a 10MB SQL query to cause memory exhaustion or slow regex matching.

**The Solution:**  
```typescript
if (query.length > 2000) {
    return res.status(400).json({ error: 'Query too long (max 2000 characters)' });
}
```

---

## 🔧 Reliability & Fault Tolerance

### 26. Google Sheets goes offline (no internet)

**The Problem:**  
User's internet goes down, or Google has an outage. The CDC Monitor can't fetch sheet data. Sync stops completely.

**The Solution — Optimistic Offline Mode:**

1. **Redis Snapshot Storage**: Every successful sheet fetch saves the data to Redis:
   ```typescript
   await redisClient.set('snapshot:sheet', JSON.stringify(data), 'EX', 86400); // 24h TTL
   ```

2. **Pending Change Queue**: When Sheet is offline but DB changes occur, they're queued:
   ```typescript
   await redisClient.rpush('pending:to_sheet', JSON.stringify({
       row, col, value, source, timestamp: Date.now()
   }));
   ```

3. **Auto-Recovery**: When connectivity is restored, pending changes are automatically processed:
   ```typescript
   if (!this.sheetOnline) {
       console.log('✅ Google Sheets connectivity restored');
       this.sheetOnline = true;
       await this.processPendingChanges('sheet');
   }
   ```

**Why queue instead of dropping?** Data integrity. Users expect their DB changes to eventually sync to Sheet, even if there's a temporary outage.

---

### 27. Database goes offline

**The Problem:**  
MySQL server crashes or becomes unreachable. All queries fail, sync stops.

**The Solution — Graceful Degradation:**

1. **Offline Detection**: Specific error codes indicate DB is offline:
   ```typescript
   const offlineErrors = ['ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST'];
   ```

2. **Cached Reads**: SELECT queries return cached data from Redis:
   ```typescript
   if (isDbOffline && isSelect) {
       const cachedSnapshot = cdcMonitor.getCachedSnapshot();
       return res.json({ data: cachedSnapshot, fromCache: true });
   }
   ```

3. **Pending Write Queue**: Sheet changes are queued until DB is back:
   ```typescript
   await this.queuePendingChange('db', { row, col, value, source: 'sheet' });
   ```

4. **Auto-Flush on Recovery**: Queued changes are processed when DB is back online.

---

### 28. Both Sheet and DB go offline simultaneously

**The Problem:**  
Complete connectivity loss. Neither data source is available.

**The Solution:**

1. **Dual Redis Caches**: Both `snapshot:sheet` and `snapshot:db` are maintained
2. **Read-Only Mode**: System serves cached data with clear `fromCache: true` flags
3. **Change Accumulation**: Both pending queues (`pending:to_sheet`, `pending:to_db`) accumulate changes
4. **Eventual Consistency**: When connectivity is restored, changes are replayed in order

---

### 29. Server restart with pending changes

**The Problem:**  
Server crashes with changes queued in Redis. Will they be lost?

**The Solution:**  
Pending changes are stored in Redis lists (persistent), not in-memory. On restart:
1. `loadSnapshotFromRedis()` restores the last known state
2. Pending queues are intact in Redis
3. Normal polling resumes and auto-flushes queues when targets are online

---

### 30. Webhook delivery failure

**The Problem:**  
Google Sheet edit triggers webhook, but the backend is temporarily down. Edit is lost.

**The Solution:**  
BullMQ with retries:
```typescript
const queue = new Queue('sheet-update', {
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 1000  // 1s, 2s, 4s
        }
    }
});
```

---

### 31. Redis connection drop

**The Problem:**  
Redis server restarts. All active locks are lost. New lock attempts fail.

**The Solution:**  
ioredis auto-reconnection:
```typescript
const redis = new Redis({
    retryStrategy: (times) => Math.min(times * 100, 3000),
    maxRetriesPerRequest: null  // Prevent BullMQ stalls
});
```

---

### 32. MySQL pool exhaustion

**The Problem:**  
Under heavy load, all 10 DB connections are in use. New requests fail.

**The Solution:**  
```typescript
const pool = mysql.createPool({
    connectionLimit: 10,
    waitForConnections: true,  // Queue requests instead of failing
    queueLimit: 0              // Unlimited queue
});
```

---

### 33. Server restart mid-sync

**The Problem:**  
Server crashes while syncing. When it restarts, the in-memory snapshot is empty — is data consistent?

**The Solution:**  
On startup:
1. First try to load cached snapshot from Redis (fast startup)
2. Then fetch fresh data from Sheet
3. Any inconsistencies are resolved by the normal diff logic

The system is **self-healing** — any inconsistencies are resolved on restart.

---

### 34. Empty/blank cells

**The Problem:**  
How do we distinguish "cell has empty string" from "cell doesn't exist"?

**The Solution:**  
- During initial sync: empty cells are **skipped** (not inserted)
- During polling: if a cell had a value and now doesn't, it's a **deletion**
- In the DB: we use `DELETE` for empty cells, not `UPDATE cell_value = ''`

---

## 👥 Multiplayer Scenarios

### 35. Multiple people editing different cells simultaneously

**The Problem:**  
User A edits B3, User B edits D5, both at the same instant. Will they conflict?

**The Solution:**  
No conflict — locks are **cell-level**, not table-level. Each user acquires their own lock independently.

---

### 36. Multiple people editing the same cell simultaneously

**The Problem:**  
User A and User B both edit cell B3 within the same second.

**The Solution:**  
Only one acquires the lock. The other receives:
```json
{
    "success": false,
    "error": "Cell B3 is locked by another user. Try again.",
    "lockConflict": true
}
```

The frontend can auto-retry or show a notification.

---

### 37. Bot simulation: N bots targeting the same cell

**The Problem:**  
Testing concurrency is hard. How do we prove the locking actually works?

**The Solution:**  
The Lock Stress Test spawns N bots:
- Half target the **same cell** (guaranteed contention)
- Half target **random cells** (throughput test)

Results show exactly which bots succeeded vs. got blocked, proving:
1. Mutual exclusion works
2. No data corruption
3. No deadlocks
4. Fair access for non-contested cells

---

## 📊 Summary Table

| Category | Edge Cases Handled |
|----------|-------------------|
| **Concurrency & Locking** | 7 |
| **Sync Integrity** | 6 |
| **Rate Limiting** | 3 |
| **Security** | 7 |
| **Data Validation** | 2 |
| **Reliability & Offline Resilience** | 9 |
| **Multiplayer** | 3 |
| **Total** | **37** |

---

## 🔗 Related Documentation

- [README.md](README.md) — Project overview and setup
- [ARCHITECTURE.md](ARCHITECTURE.md) — Technical deep dive
- [BOT_SIMULATION.md](BOT_SIMULATION.md) — Lock stress test guide
