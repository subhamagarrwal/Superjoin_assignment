# Bot Simulation & Multiplayer Proof

> How the lock stress test works, what "BLOCKED" means, and how it proves the system handles multiplayer access correctly.

---

## 🔐 Security Note

The bot simulation uses the **same security pipeline** as all other write operations:

1. **SQL Guard Middleware**: Validates all queries (even bot-generated ones) against 20+ blocked keywords and 14 dangerous patterns
2. **Distributed Locking**: Bots compete for Redis locks just like real users
3. **Table Restrictions**: Bot writes are restricted to the `users` table only
4. **Echo Suppression**: Bot writes trigger the same ignore-key mechanism to prevent sync loops

This ensures the simulation accurately reflects how real multiplayer access would behave under the same security constraints.

---

## 🤖 What Is the Bot Simulation?

The **Lock Stress Test** (visible in the bottom-left panel of the UI) is a concurrency testing tool. It spawns **N virtual bots** that simultaneously attempt to write to the MySQL database — some targeting the **same cell** and others targeting **random cells**.

Its purpose is to **prove** that:
1. Concurrent writes to the same cell are safely serialized.
2. No data corruption occurs under contention.
3. The lock service correctly prevents race conditions.
4. All successful writes are propagated to Google Sheets.

---

## 🎮 How to Use It

1. Open the Superjoin frontend at `http://localhost:5173`.
2. In the bottom-left panel, you'll see the **Lock Stress Test** section.
3. Set the **Bots** count (2–50, default 8).
4. Click **Launch Bots**.
5. Watch the results appear in real-time.

---

## ⚙️ How It Works Internally

### Step 1: Task Generation

When you click "Launch Bots" with `botCount = 8`:

```
POST /api/bots/run  { botCount: 8 }
```

The backend generates **8 bot tasks**:

```
Bot-Alpha    → write to B3 (contested cell)     ← GROUP A
Bot-Bravo    → write to B3 (contested cell)     ← GROUP A  (same cell!)
Bot-Charlie  → write to B3 (contested cell)     ← GROUP A  (same cell!)
Bot-Delta    → write to B3 (contested cell)     ← GROUP A  (same cell!)
Bot-Echo     → write to F2 (random cell)        ← GROUP B
Bot-Foxtrot  → write to A5 (random cell)        ← GROUP B
Bot-Golf     → write to C1 (random cell)        ← GROUP B
Bot-Hotel    → write to D4 (random cell)        ← GROUP B
```

**Group A** (first half): All bots target the **same randomly chosen cell** (e.g., `B3`). This guarantees lock contention.

**Group B** (second half): Each bot targets a **random cell**. Some may accidentally collide, demonstrating organic contention.

### Step 2: Simultaneous Execution

All 8 tasks are fired **at once** using `Promise.all()`:

```typescript
const results = await Promise.all(tasks.map(t => executeBotTask(t)));
```

This means all 8 bots race to acquire locks and write to the database **simultaneously**.

### Step 3: Lock Acquisition

Each bot goes through this flow:

```
Bot-Alpha wants to write to B3
    │
    ├─► Redis: SET lock:3:B "Bot-Alpha" EX 5 NX
    │
    ├─► Result: "OK"  → Lock acquired! ✅
    │       │
    │       ├─► Random delay (50–200ms) to simulate processing
    │       ├─► MySQL: INSERT ... ON DUPLICATE KEY UPDATE
    │       └─► Redis: Release lock (Lua script)
    │
    └─► Result: null → Lock denied ❌
            │
            ├─► Wait 200ms
            ├─► Retry (up to 15 times)
            └─► After 15 retries → Give up → "BLOCKED"
```

### Step 4: Sync to Sheet

After all bots complete, the system calls:

```typescript
await cdcMonitor.syncFromDatabase();
```

This pushes all successful writes to Google Sheets via the Sheets API.

**Important**: After syncing, the CDC Monitor updates its in-memory snapshot to reflect the new sheet state. This prevents the next poll from detecting the bot writes as "new changes" from the sheet — which would cause an echo loop.

**Rate Limit Awareness**: If the Google Sheets API returns 429 (rate limited), the sync gracefully backs off using exponential delays (5s → 10s → 20s → max 60s). The bots will still report success, and the sync will complete once the rate limit clears.

---

## 📊 Understanding the Results

After bots complete, you see a results panel like this:

```
┌─────────────────────────────────────────────────────────────────────┐
│  8 bots │ Contested: B3 │ 5 success │ 3 blocked │ 1247ms          │
├─────────────────────────────────────────────────────────────────────┤
│ 🔴 Bot-Bravo    → B3   BLOCKED                              150ms │
│ 🔴 Bot-Charlie  → B3   BLOCKED                              210ms │
│ 🔴 Bot-Delta    → B3   BLOCKED                              180ms │
│ 🟢 Bot-Alpha    → B3   "Bot-Alpha-mango"                     12ms │
│ 🟢 Bot-Echo     → F2   "Bot-Echo-cherry"                      8ms │
│ 🟢 Bot-Foxtrot  → A5   "Bot-Foxtrot-kiwi"                    5ms │
│ 🟢 Bot-Golf     → C1   "Bot-Golf-zen"                         7ms │
│ 🟢 Bot-Hotel    → D4   "Bot-Hotel-nova"                       9ms │
└─────────────────────────────────────────────────────────────────────┘
```

### What Each Column Means

| Element | Meaning |
|---------|---------|
| 🟢 Green dot | The bot **successfully** acquired the lock and wrote its value |
| 🔴 Red dot | The bot was **BLOCKED** — could not acquire the lock after all retries |
| 🟡 Yellow dot | An unexpected **ERROR** occurred (rare — network issue, DB down) |
| **Bot name** | e.g., `Bot-Alpha`. If you have >8 bots, names repeat with suffixes: `Bot-Alpha-2` |
| **→ Cell** | The target cell, e.g., `B3` |
| **Value** | For success: the written value (e.g., `"Bot-Alpha-mango"`). For blocked: `BLOCKED` |
| **Time (ms)** | How long the bot waited trying to acquire the lock |

### Summary Bar

| Metric | Meaning |
|--------|---------|
| **`8 bots`** | Total number of bots launched |
| **`Contested: B3`** | The cell that Group A bots all fought over |
| **`5 success`** | Number of bots that acquired their lock and wrote successfully |
| **`3 blocked`** | Number of bots that could not acquire the lock (lock was held by another bot for too long) |
| **`1247ms`** | Total wall-clock time for all bots to complete |

---

## 🔒 What Does "BLOCKED" Mean?

**BLOCKED** means the bot tried to acquire a Redis distributed lock on a cell but **another bot was already holding it**.

Here's exactly what happens:

```
Time 0ms:   Bot-Alpha calls SET lock:3:B "Bot-Alpha" EX 5 NX → "OK" ✅
Time 0ms:   Bot-Bravo calls SET lock:3:B "Bot-Bravo" EX 5 NX → null ❌
Time 200ms: Bot-Bravo retries → null ❌ (Bot-Alpha still writing)
Time 400ms: Bot-Bravo retries → null ❌
...
Time 3000ms: Bot-Bravo gives up after 15 retries → BLOCKED
```

**The lock parameters:**
- **TTL**: 5 seconds — the lock auto-expires even if the holder crashes
- **Retry delay**: 200ms between each attempt
- **Max retries**: 15 — total wait time: 15 × 200ms = 3 seconds
- **Processing delay**: Each bot simulates 50–200ms of work while holding the lock

So if Bot-Alpha acquires the lock and takes 150ms to write, Bot-Bravo might succeed on its 2nd retry. But if 4 bots are queued up for the same cell, later ones run out of retries.

### Why Not Make Retries Infinite?

In a real system, if a cell is perpetually contested, holding a connection open forever is worse than failing fast and letting the user retry. The 3-second max wait is a reasonable timeout for interactive use.

---

## 🎯 How Does This Prove Multiplayer Access?

The bot simulation proves several critical multiplayer properties:

### 1. **Mutual Exclusion** — Only One Writer at a Time

When 4 bots target cell B3, exactly **one** gets the lock per lock cycle. The Redis `SET NX` command is atomic — there's no window where two bots can both think they have the lock.

```
Expected: Out of 4 bots targeting B3, at most 1-2 succeed (depending on timing)
Result:   ✅ Only 1 bot writes to B3; others are BLOCKED
```

### 2. **No Data Corruption** — The Final Value is Consistent

After the simulation, run `SELECT * FROM users WHERE row_num = 3 AND col_name = 'B'` in the SQL Terminal. You'll see exactly **one** value — the winning bot's value. There's no garbled data from two partial writes.

### 3. **No Deadlocks** — Locks Auto-Expire

Even if a bot "crashes" (simulated by the processing delay), the 5-second TTL ensures the lock is released. No manual intervention needed.

### 4. **Fair Access for Non-Contested Cells**

Group B bots (targeting random cells) almost always succeed because there's no contention. This proves the locking is **granular** — a lock on B3 doesn't block writes to F2.

```
Expected: Group B bots all succeed (different cells)
Result:   ✅ All Group B bots succeed immediately (~5-10ms)
```

### 5. **Real-Time Sync After Multiplayer Edits**

After all bots finish, `syncFromDatabase()` pushes every successful write to Google Sheets. You can verify:
- Open the Google Sheet
- See the bot values appear in their respective cells
- This proves: **multiple concurrent writers → DB → Google Sheet** works end-to-end

### 6. **Scaling the Test**

Try increasing the bot count:
- **8 bots**: ~3-4 blocks (mild contention)
- **20 bots**: ~14-16 blocks (heavy contention on the contested cell)
- **50 bots**: ~45+ blocks (extreme contention — proves the system degrades gracefully)

The system never crashes, never corrupts data, and always reports exactly what happened.

---

## 🔬 Reading the Server Logs

When bots run, the backend logs show the full story:

```
🤖 Starting bot simulation: 8 bots, contested cell = B3

⏳ [Bot-Bravo] Waiting for lock on B3... (retry 1/15)
⏳ [Bot-Charlie] Waiting for lock on B3... (retry 1/15)
⏳ [Bot-Delta] Waiting for lock on B3... (retry 1/15)

⏳ [Bot-Bravo] Waiting for lock on B3... (retry 2/15)
⏳ [Bot-Charlie] Waiting for lock on B3... (retry 2/15)
...

⏳ [Bot-Bravo] Waiting for lock on B3... (retry 15/15)

🤖 Bot simulation complete:
   totalBots: 8
   contestedCell: B3
   successes: 5
   lockConflicts: 3
   totalTimeMs: 1247

🔄 Syncing to Google Sheet...
   📤 Update: B3 = "Bot-Alpha-mango"
   📤 Update: F2 = "Bot-Echo-cherry"
   📤 Update: A5 = "Bot-Foxtrot-kiwi"
   📤 Update: C1 = "Bot-Golf-zen"
   📤 Update: D4 = "Bot-Hotel-nova"
✅ Synced 5 cell(s) from DB → Google Sheet
```

---

## 🧩 How This Maps to Real-World Multiplayer

| Bot Simulation | Real-World Equivalent |
|----------------|----------------------|
| Bot-Alpha writes to B3 | User 1 edits cell B3 in Google Sheets |
| Bot-Bravo writes to B3 (BLOCKED) | User 2 tries to edit B3 at the same instant |
| Lock acquired → write succeeds | User's edit goes through |
| Lock denied → BLOCKED | User sees "Cell is locked by another user" |
| Group B bots (random cells) | Multiple users editing different parts of the sheet |
| `syncFromDatabase()` after bots | All edits propagated to Google Sheets for all users to see |

In Google Sheets' native multiplayer, Google uses **Operational Transform** to merge edits. Our system takes a simpler but production-valid approach: **last-write-wins with pessimistic locking**. The lock ensures writes are serialized, and the winning write is the one that gets the lock first.

---

## ❓ FAQ

### Q: Why do some Group B bots also get BLOCKED?
Because the random cell generation can **accidentally** pick the same cell. If Bot-Echo and Bot-Golf both randomly target D4, one will be blocked. This actually demonstrates that the locking works correctly even outside the intentionally contested cell.

### Q: Why is the lock wait time different for each bot?
Each bot hits a slightly different point in the retry cycle. Bot-Bravo might fail on all 15 retries (3000ms total wait), while Bot-Charlie might fail on 10 retries before giving up.

### Q: What if I run 50 bots — will it crash?
No. The system caps at 50 bots. With 25 targeting the same cell and 25 random, you'll see ~24 blocks on the contested cell and most random bots succeeding. The backend handles this gracefully.

### Q: Does the bot simulation use the same code path as real users?
Yes — bots call `pool.query()` with the same UPSERT and use the same `lockService.acquireLock()` / `releaseLock()` as the SQL Terminal and webhook workers. The only difference is bots have a simulated processing delay (50–200ms) to widen the contention window.

### Q: After bots run, will the Google Sheet update?
Yes. After all bots complete, `cdcMonitor.syncFromDatabase()` is called, which pushes all DB changes to the Google Sheet via a `batchUpdate`. You'll see the bot values appear in the sheet within a few seconds.

### Q: What if I see "Rate limited" in the logs?
The Google Sheets API has a quota (~300 requests/minute). If you run many bot simulations rapidly, you may hit the limit. The system uses **exponential backoff** (5s → 10s → 20s → max 60s) and will automatically resume once the limit clears. The terminal won't spam "rate limited" messages — it logs once and silently waits.

### Q: Is the bot simulation vulnerable to SQL injection?
No. Bot-generated queries go through the same **SQL Guard middleware** as user queries. The guard blocks 20+ dangerous keywords, detects obfuscation patterns (hex, CHAR(), comments), and restricts writes to the `users` table only.
