# 10 — Real-World Scenarios

These are "what will you do?" questions. The interviewer wants a calm, step-by-step plan. Always follow this order: **stop the bleeding → investigate → root cause → fix → prevent**. Talk about data and tools, not guesses.

---

## Node.js / API

### S1. Your Node.js API p99 latency jumped from 200ms to 4s after yesterday's deploy. CPU is normal. What do you do?
**🟢 In simple words:** The API became slow right after a release. CPU is fine, so the server is mostly *waiting* for something (DB, network, a lock). The interviewer wants to see that you first protect users, then use data to find the cause.
**🏠 Real-life example:** A restaurant got slow after a new menu. The cooks are not busy. So the problem is waiting — maybe for a supplier, or one dish needs a slow oven.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** Is it all endpoints or one? All users or some? If the timing matches the deploy, **roll back first** (or turn off the new feature flag). Debug later, with users safe.
2. **Investigate:**
   - Grafana / APM (Application Performance Monitoring, e.g. Datadog, New Relic): p99 per route. Which route got slow?
   - Distributed traces (OpenTelemetry/Jaeger): which span is long — DB query, Redis, or an HTTP call?
   - `git diff` between the two releases: new queries, new `include` in Sequelize, new external calls, changed config.
   - DB: slow query log, `SHOW PROCESSLIST` (MySQL) or `pg_stat_activity` (Postgres). Run `EXPLAIN ANALYZE` on the new query.
   - Pool metrics: are requests waiting for a free DB connection?
3. **Find the root cause (most likely first):**
   - A new query with no index, or an **N+1 query** (one query per row in a loop).
   - DB connection pool is full, so requests wait in a queue.
   - A new call to a slow external service with no timeout.
   - Lock waits in the DB (a new long transaction).
   - Low CPU but high latency = waiting on I/O, not computing.
4. **Fix:**
   - Short-term: roll back, or disable the feature flag.
   - Permanent: add the index, fix N+1 with one `include` or a batch `WHERE id IN (...)`, add timeouts.
   ```js
   // N+1 (bad): 1 query per order
   for (const o of orders) o.user = await User.findByPk(o.userId);
   // Fixed: 1 query
   const orders = await Order.findAll({ include: [{ model: User }] });
   ```
5. **Prevent:** Alert on p99 per route. Canary deploys (send 5% traffic to the new version first). Load test important routes in CI. Check `EXPLAIN` in code review for new queries. Write a blameless postmortem.

**🔍 Internal working:**
1. Node.js runs JS on one thread. While it waits for the DB, the thread is free, so CPU stays low.
2. Each request needs a DB connection from the pool. If queries become slow, connections are held longer.
3. When all pool connections are busy, new requests wait in the pool queue. This waiting adds to latency.
4. A query without an index makes the DB do a full table scan. Time grows with table size.
5. So one slow query can slow *all* routes, because they all share the same pool.

**🎤 Say this in the interview:** "First I roll back, because the timing matches the deploy. Then I use traces and per-route p99 to find the slow span. Low CPU with high latency means waiting on I/O, so I check new queries with EXPLAIN ANALYZE, N+1 patterns and pool wait time."

**❓ Follow-up questions they may ask:**
- Why p99 and not average? → Average hides the slow tail; p99 shows what the slowest 1% of users feel.
- What if rollback is not possible (DB migration already ran)? → Roll forward with a hotfix or turn off the feature flag; keep migrations backward compatible.

---

### S2. Memory of your Node.js service keeps growing. The Kubernetes pod is OOMKilled every few hours. How do you fix it?
**🟢 In simple words:** Something keeps objects in memory and never lets them go. This is a **memory leak**. The interviewer wants to see how you find *which* object leaks, not just "add more RAM".
**🏠 Real-life example:** A cupboard where people keep putting things in, but nobody ever takes anything out. One day the door will not close.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** Restarts are already "saving" you. Short-term: raise the memory limit a bit, or add more replicas so a restart hurts fewer users. Check: did it start after a release?
2. **Investigate:**
   - Graph memory over time: `process.memoryUsage()` → `heapUsed`, `rss`, `external`. Leak = a slow "staircase" that never comes down after GC.
   - Take **heap snapshots**: run with `node --inspect`, or call `v8.writeHeapSnapshot()`. Take 2–3 snapshots minutes apart. Compare them in Chrome DevTools ("Comparison" view). Look at what grows.
   - `kubectl describe pod` shows `OOMKilled` with exit code 137.
3. **Find the root cause (most likely first):**
   - A global cache / `Map` / array with no size limit or TTL.
   - Event listeners added on every request and never removed (`emitter.on` inside a handler).
   - `setInterval` / timers never cleared.
   - Closures that hold big objects (e.g. a whole request object).
   - Heap is fine but `rss` grows → native memory / Buffers (e.g. big file uploads kept in memory).
4. **Fix:**
   ```js
   // Bad: grows forever
   const cache = new Map();
   // Good: bounded cache with TTL
   const { LRUCache } = require('lru-cache');
   const cache = new LRUCache({ max: 5000, ttl: 60_000 });
   ```
   Remove listeners (`emitter.off`), clear timers, stream big files instead of loading them fully.
   Set `--max-old-space-size` a little below the container limit, so V8 does GC harder before the kernel kills the pod.
5. **Prevent:** Alert when memory grows for N hours. Run a soak test (long load test) before big releases. Use Redis for shared caches instead of in-process memory.

**🔍 Internal working:**
1. V8 uses garbage collection (GC). It frees an object only when nothing can reach it from the "roots" (globals, the stack).
2. If a global `Map` holds a reference, the object is always reachable. So GC can never free it.
3. The heap keeps growing. GC runs more often and takes longer, so latency also gets worse.
4. The container has a cgroup memory limit. When the process goes over it, the Linux kernel OOM killer kills it (exit 137).
5. If the V8 heap limit is reached first, Node crashes with "JavaScript heap out of memory" instead.

**🎤 Say this in the interview:** "I confirm it is a leak by seeing memory that never drops after GC. Then I compare two heap snapshots to find which objects grow and who retains them. Usually it is an unbounded cache, a listener added per request, or an uncleared timer. I fix it with bounded caches and cleanup, and add a memory-growth alert."

**❓ Follow-up questions they may ask:**
- Heap is stable but RSS grows — what now? → Look at Buffers / native addons / `external` memory; stream data instead of buffering.
- Why not just set a big memory limit? → It only delays the crash and wastes money; the leak is still there.

---

### S3. When an admin generates a big report (CSV/Excel of 200k rows), the whole API stops responding for all users for 20 seconds. Why, and how do you fix it?
**🟢 In simple words:** Node.js runs your JavaScript on one main thread. A long CPU job (building a big JSON/CSV in memory) blocks that thread. Then no other request can run. The interviewer wants to hear "event loop blocked" and real fixes.
**🏠 Real-life example:** A shop with one cashier. One customer wants 500 items billed one by one. Everybody else in the line just waits.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** Confirm the timing: the freeze happens exactly when the report runs. Short-term: limit the report size or run it only at night.
2. **Investigate:**
   - Measure event loop lag: `perf_hooks.monitorEventLoopDelay()`, or APM "event loop delay" metric.
   - CPU profile: `node --cpu-prof`, or `clinic flame`. Look for `JSON.stringify`, a big loop, or a sync CSV library.
   - Search code for sync calls: `fs.readFileSync`, `zlib.gzipSync`, `crypto.pbkdf2Sync`.
3. **Find the root cause:**
   - Loading 200k rows into one array, then building one huge string.
   - `JSON.stringify` / `JSON.parse` on a huge object (it is synchronous).
   - Sync file or crypto calls inside a request.
4. **Fix:**
   - **Stream** from DB to the response, row by row. Memory stays small and the loop gets breaks.
   ```js
   // mysql2 streaming (raw driver) piped into a CSV stream
   const { pipeline } = require('stream/promises');
   const { stringify } = require('csv-stringify');
   const rows = pool.query('SELECT id,name,marks FROM results').stream();
   res.setHeader('Content-Type', 'text/csv');
   await pipeline(rows, stringify({ header: true }), res);
   ```
   - Better for very big reports: make it a **background job** (BullMQ queue + worker process). Upload the file to S3. Send the user a download link when it is ready.
   - CPU-heavy work (Excel building, PDF) → `worker_threads` or a separate worker service.
5. **Prevent:** Alert on event loop lag (e.g. > 100ms). Code review rule: no sync APIs in request handlers. Keep reports in a separate worker deployment.

**🔍 Internal working:**
1. Node has one main JS thread. The event loop picks one callback, runs it fully, then picks the next.
2. A callback cannot be paused in the middle. If it takes 20s, the loop is stuck for 20s.
3. Incoming requests wait in the OS/socket queue. Timers and health checks are also delayed. So Kubernetes may even restart the pod.
4. The libuv thread pool helps only for some async I/O (fs, dns.lookup, crypto, zlib). It does not help pure JS loops.
5. Streams split work into small chunks. Between chunks, the loop can serve other requests.

**🎤 Say this in the interview:** "The event loop is blocked by a long synchronous job. I confirm it with event loop lag and a CPU profile. I fix it by streaming rows from DB to the response, and for heavy reports I move work to a queue and worker, then send a download link."

**❓ Follow-up questions they may ask:**
- worker_threads vs child_process vs a separate service? → worker_threads share the process and are good for CPU tasks; a separate worker service scales and deploys independently.
- How does `setImmediate` help? → You can split a loop into chunks and yield with `setImmediate`, but streaming or workers are cleaner.

---

### S4. The Node.js server crashes at night. Logs show "UnhandledPromiseRejection". In the morning, users see errors. What do you do?
**🟢 In simple words:** A promise failed and nobody caught the error. Since Node.js 15, this crashes the process by default. The interviewer wants: find the missing catch, make the system restart safely, and add alerts.
**🏠 Real-life example:** A guard forgot to lock one door. At night someone came in. You must fix the lock and also install an alarm.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** Make sure a process manager restarts the app (Kubernetes, ECS, PM2, Docker `restart: unless-stopped`). Run 2+ replicas so one crash does not cause downtime.
2. **Investigate:**
   - Read the stack trace in central logs (CloudWatch / ELK / Loki). Find the file and line.
   - What runs at night? Cron jobs, scheduled reports, DB backups (DB may be slow or restart), token refresh.
   - Check if DB/Redis was down at that time — a connection error in a promise with no `.catch()`.
3. **Find the root cause:**
   - An `async` function called without `await` and without `.catch()` (fire-and-forget).
   - Express 4 does not catch errors thrown in `async` handlers by itself (Express 5 does).
   - Error inside a `setTimeout` / event handler callback.
4. **Fix:**
   ```js
   // Express 4: wrap async handlers
   const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
   app.get('/report', wrap(async (req, res) => { /* ... */ }));

   // Last safety net: log, then exit cleanly. Do not keep running in a broken state.
   process.on('unhandledRejection', (err) => {
     logger.fatal({ err }, 'unhandledRejection');
     server.close(() => process.exit(1));
     setTimeout(() => process.exit(1), 10_000).unref();
   });
   ```
   Add `.catch()` to fire-and-forget calls. Add retry for night jobs.
5. **Prevent:** ESLint rule `@typescript-eslint/no-floating-promises` (or similar). Alert on process restarts and on error rate. Test cron jobs with a "DB down" case.

**🔍 Internal working:**
1. When a promise rejects, V8 checks if it has a rejection handler.
2. If not, Node tracks it. At the end of the current microtask processing, Node emits `unhandledRejection`.
3. Since Node 15, the default mode is `--unhandled-rejections=throw`. If no listener handles the event, Node throws it as an uncaught exception.
4. An uncaught exception ends the process with a non-zero exit code. All in-flight requests fail.
5. The orchestrator sees the exit and starts a new process. That is why you need replicas plus restarts.

**🎤 Say this in the interview:** "Since Node 15 an unhandled rejection crashes the process. I find the missing catch from the stack trace, usually a fire-and-forget async call or an async Express handler. I fix the code, add a lint rule for floating promises, and keep a global handler that logs and exits cleanly so the orchestrator restarts it."

**❓ Follow-up questions they may ask:**
- Why not just catch it globally and keep running? → The app may be in an unknown state (half-done work, leaked resources); safer to log, exit and restart.
- How do you avoid downtime during the restart? → Multiple replicas behind a load balancer, plus readiness probes.

---

### S5. A third-party payment API becomes slow and times out. Soon your whole app is down, even pages that do not use payments. Why, and how do you fix it?
**🟢 In simple words:** One slow dependency used up all your shared resources. Then everything failed. This is a **cascading failure**. The interviewer wants timeouts, circuit breakers, and isolation.
**🏠 Real-life example:** One slow toll booth on a highway. Cars pile up and block the whole road. Even cars going to other exits are stuck.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** Turn off or degrade payments (feature flag: "Payments are slow, please try later"). The rest of the site should work again.
2. **Investigate:**
   - Traces: the payment span takes 30s+.
   - Metrics: open sockets, DB pool usage, memory, number of in-flight requests.
   - Payment provider status page.
3. **Find the root cause:**
   - No timeout (or a very long one) on the HTTP call. Requests hang and pile up.
   - The code holds a DB transaction/connection open while waiting for the payment call. Pool gets empty. All routes fail.
   - Automatic retries make the load on the slow provider even worse (retry storm).
4. **Fix:**
   - Short timeouts on every external call.
   - **Circuit breaker** (stop calling a failing service for a while, e.g. the `opossum` library).
   - Retries only with exponential backoff + jitter (random delay), and only for safe/idempotent calls.
   - Never hold a DB transaction during an external HTTP call.
   - **Bulkhead** (separate limits per dependency), so payments cannot use all resources.
   ```js
   const CircuitBreaker = require('opossum');
   const callPay = (body) => fetch(PAY_URL, { method: 'POST', body, signal: AbortSignal.timeout(3000) });
   const breaker = new CircuitBreaker(callPay, { errorThresholdPercentage: 50, resetTimeout: 30_000 });
   breaker.fallback(() => ({ status: 'PENDING' })); // confirm later via webhook / status check
   ```
   - Make payment async: save order as `PENDING`, then confirm by webhook or a status-check job.
5. **Prevent:** Chaos test: make the payment mock slow in staging. Alerts on dependency latency. Rule: every outbound call has a timeout.

**🔍 Internal working:**
1. Each waiting request keeps memory, a socket, and maybe a DB connection.
2. Without a timeout, waits can last a long time. In-flight requests grow quickly.
3. Shared resources (DB pool, memory, outbound sockets) run out. Now healthy routes also wait or fail.
4. A circuit breaker has 3 states: **closed** (normal), **open** (fail fast, do not call), **half-open** (try a few calls to test recovery).
5. Failing fast frees resources in milliseconds instead of seconds. So the rest of the system stays healthy.

**🎤 Say this in the interview:** "A slow dependency without timeouts holds resources until the shared pool is empty, so everything fails. I add tight timeouts, a circuit breaker with a fallback, backoff with jitter on retries, and bulkheads. I also never hold a DB transaction across an external call, and I make payment confirmation async via webhooks."

**❓ Follow-up questions they may ask:**
- Is it safe to retry a payment call? → Only with an idempotency key, so the provider does not charge twice.
- What does the user see when the breaker is open? → A clear message, or the order saved as "pending" and confirmed later.

---

### S6. Some users are charged twice, or get duplicate orders, when they double-click "Pay" or the mobile app retries on a bad network. How do you fix it?
**🟢 In simple words:** The same request reached the server twice, and the server did the work twice. You need **idempotency** (doing the same request many times gives the same result as doing it once). The interviewer wants a server-side fix, not only a disabled button.
**🏠 Real-life example:** You press the lift button 5 times. The lift still comes only once. The button is idempotent.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** Find duplicate orders with a SQL query (same user, same amount, a few seconds apart). Refund the duplicates. Disable the button on click as a quick UI fix.
2. **Investigate:** Check access logs: two POSTs a few ms apart? Client retries after a timeout? Load balancer or proxy retries?
3. **Find the root cause:** The POST endpoint creates a new order every time. It has no unique key to detect "I have seen this request".
4. **Fix:**
   - The client creates an **Idempotency-Key** (a UUID) once per checkout. It sends the same key on every retry.
   - The server stores the key with a **unique constraint**. Second request with the same key → return the first result.
   ```sql
   CREATE TABLE idempotency_keys (
     idem_key    VARCHAR(64) PRIMARY KEY,
     user_id     BIGINT NOT NULL,
     status      VARCHAR(20) NOT NULL,   -- IN_PROGRESS / DONE
     response    JSON,
     created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   );
   ```
   ```js
   try {
     await IdemKey.create({ idemKey, userId, status: 'IN_PROGRESS' }); // unique insert = the lock
   } catch (e) {
     if (e.name === 'SequelizeUniqueConstraintError') {
       const row = await IdemKey.findByPk(idemKey);
       return row.status === 'DONE' ? res.json(row.response) : res.status(409).json({ msg: 'In progress' });
     }
     throw e;
   }
   const result = await createOrderAndCharge(); // pass the same key to the payment provider too
   await IdemKey.update({ status: 'DONE', response: result }, { where: { idemKey } });
   res.json(result);
   ```
   - Also pass the idempotency key to the payment provider (Stripe and Razorpay-style APIs support this or an order id).
   - Add a business unique constraint where possible, e.g. `UNIQUE(cart_id)` on orders.
5. **Prevent:** Tests that send the same request twice in parallel. Delete old keys after 24–48h. Alert on duplicate payment patterns.

**🔍 Internal working:**
1. HTTP POST is not idempotent by default. Every request is new to the server.
2. "Check first, then insert" in code has a race: two requests can both see "not found" and both insert.
3. A **unique index** moves the check into the database. The DB lets only one insert win. The other gets a duplicate-key error.
4. So the DB constraint is the real lock. Not the `if` in your code.
5. Network timeouts mean the client cannot know if the server did the work. So safe retries need idempotency.

**🎤 Say this in the interview:** "I make the endpoint idempotent. The client sends an Idempotency-Key, and the server inserts it under a unique constraint before doing the work. A retry with the same key gets the saved response instead of a second charge. The button disable is only UX; the database constraint is the real guarantee."

**❓ Follow-up questions they may ask:**
- Why not just check "does an order exist" before inserting? → Two parallel requests can both pass the check; only a unique constraint or lock is safe.
- Where can you store keys besides SQL? → Redis `SET key value NX EX 86400`, but SQL in the same transaction as the order is stronger.

---

## Database / Sequelize

### S7. A monthly report query takes 40 seconds on a 50-million-row table. Users complain. How do you make it fast?
**🟢 In simple words:** The query reads too much data. The interviewer wants you to measure with `EXPLAIN ANALYZE`, fix indexes and query shape, and know when to pre-compute.
**🏠 Real-life example:** Finding all "Sharma" students in a school by reading every register page. A sorted index by surname finds them in seconds.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** What filters do users use (date range, district, status)? How fresh must data be — live, or yesterday is OK? Short-term: run the report on a **read replica**, not the primary DB.
2. **Investigate:**
   - Get the real SQL (Sequelize `logging: console.log`, or slow query log).
   - Run `EXPLAIN ANALYZE` (Postgres, MySQL 8.0.18+). Look for: full table scan (`Seq Scan` / `type: ALL`), rows examined vs rows returned, `Using filesort`, `Using temporary`.
   - Check existing indexes: `SHOW INDEX FROM results;` or `\d results`.
3. **Find the root cause (most likely first):**
   - No index for the `WHERE` columns, or wrong column order in a composite index.
   - A function on an indexed column: `WHERE YEAR(created_at) = 2025` cannot use the index.
   - `SELECT *` pulling big columns.
   - `OFFSET` pagination deep into the table.
   - Aggregating 50M rows live each time.
4. **Fix:**
   ```sql
   -- Bad: function on column, index not used
   WHERE YEAR(created_at) = 2025
   -- Good: range, index can be used
   WHERE created_at >= '2025-01-01' AND created_at < '2026-01-01'

   -- Composite index: equality columns first, then range column
   CREATE INDEX idx_res_district_status_created
     ON results (district_id, status, created_at);
   ```
   - Select only needed columns. A **covering index** (index has all needed columns) avoids reading the table.
   - Keyset pagination: `WHERE id > :lastId ORDER BY id LIMIT 100` instead of big `OFFSET`.
   - For heavy aggregates: a **summary table** updated nightly or by a job (or a Postgres materialized view). The report reads small pre-computed data.
   - For time-based data: **partitioning** by month, so the DB skips old partitions.
5. **Prevent:** Slow query log alert (e.g. > 1s). Review `EXPLAIN` for new report queries. Separate OLTP (live app DB) from reporting (replica or warehouse).

**🔍 Internal working:**
1. InnoDB and Postgres use **B-tree** indexes. A B-tree finds a key in O(log n) steps.
2. A composite index `(a, b, c)` is sorted by a, then b, then c. It helps only from the left side ("leftmost prefix").
3. A range condition on a column stops the use of the following index columns for seeking. So put equality columns first.
4. Wrapping a column in a function changes the value. The B-tree is sorted on the raw value, so it cannot seek.
5. Without a useful index, the DB reads every row (full scan). 50M rows from disk takes many seconds.
6. In InnoDB, a secondary index stores the primary key. Extra columns need a second lookup in the clustered index, unless the index is covering.

**🎤 Say this in the interview:** "I run EXPLAIN ANALYZE to see if it is a full scan and how many rows are examined. Usually the fix is a composite index matching the filters, with equality columns first, and rewriting non-sargable conditions like YEAR(col). For heavy aggregates I pre-compute into a summary table and run reports on a read replica."

**❓ Follow-up questions they may ask:**
- Can too many indexes hurt? → Yes: every insert/update must update every index, and they use memory and disk.
- What is "sargable"? → A condition the DB can use an index for, e.g. a plain range on the raw column.

---

### S8. At peak time you see "Too many connections" in MySQL, and the app throws SequelizeConnectionAcquireTimeoutError. What do you do?
**🟢 In simple words:** There are two related problems. The DB has a limit on total connections. Your app's pool has a limit too, and requests wait too long to get one. The interviewer wants you to do the math and find why connections are held so long.
**🏠 Real-life example:** A bank with 10 counters. If each customer takes 30 minutes, the line becomes huge. More counters help a bit. Faster service helps much more.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** How many app instances? What is the pool `max` per instance? What is the DB `max_connections`? Short-term: kill long idle queries; scale the DB up if needed.
2. **Investigate:**
   - `SHOW PROCESSLIST;` / `SHOW STATUS LIKE 'Threads_connected';` (MySQL) or `SELECT state, count(*) FROM pg_stat_activity GROUP BY state;` (Postgres).
   - Many connections in `Sleep` / `idle in transaction`? → a transaction is open and not finished.
   - Do the math: `pods × pool.max` must be less than `max_connections` (leave room for admin and migrations).
3. **Find the root cause (most likely first):**
   - Autoscaling added pods. 20 pods × max 20 = 400 connections > DB limit.
   - Slow queries hold connections longer (see S7).
   - Transactions not committed/rolled back on error, so the connection is not returned.
   - External API call inside a transaction (see S5).
   - Each Lambda / each request creating a new Sequelize instance.
4. **Fix:**
   ```js
   const sequelize = new Sequelize(DB_URL, {
     pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
   });
   // Always use managed transactions: auto commit / rollback
   await sequelize.transaction(async (t) => {
     await Order.create(data, { transaction: t });
     await Stock.decrement('qty', { by: 1, where: { id }, transaction: t });
   });
   ```
   - Set pool `max` from the math. Create Sequelize **once** per process.
   - Use a connection proxy/pooler: **RDS Proxy** (MySQL/Postgres) or **PgBouncer** (Postgres).
   - Move reads to a read replica (Sequelize supports `replication: { read: [...], write: {...} }`).
5. **Prevent:** Dashboards for pool usage and DB connections. Alert at 80% of `max_connections`. Include the connection math in the autoscaling plan.

**🔍 Internal working:**
1. In MySQL, each connection is served by a server thread with its own memory buffers. So the DB limits total connections.
2. Sequelize uses a pool (sequelize-pool). `acquire()` gives a free connection or waits in a queue.
3. If no connection is free within `acquire` ms, Sequelize throws `ConnectionAcquireTimeoutError`.
4. A connection is returned only after the query finishes, or the transaction commits/rolls back.
5. Little's law: connections needed ≈ requests per second × time each connection is held. Shorter hold time = fewer connections.

**🎤 Say this in the interview:** "I check the math: pods times pool max must stay under the DB's max_connections. Then I find why connections are held long: slow queries, open transactions, or external calls inside a transaction. I fix pool sizes, use managed transactions, add RDS Proxy or PgBouncer, and move reads to replicas."

**❓ Follow-up questions they may ask:**
- Why not just set max_connections to 5000? → Each connection uses memory and CPU; too many causes contention and makes the DB slower.
- What is "idle in transaction"? → A session that started a transaction but is not running a query; it holds locks and a connection.

---

### S9. Production logs show many "Deadlock found when trying to get lock; try restarting transaction". How do you handle it?
**🟢 In simple words:** Two transactions wait for each other's locks. The DB kills one of them. The interviewer wants you to find the lock order and fix it, plus add a safe retry.
**🏠 Real-life example:** Two people in a narrow corridor. Each waits for the other to move. Nobody moves until a guard sends one back.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** How often? Which endpoints? Add a retry for the failed transaction (deadlock errors are safe to retry), so users do not see errors.
2. **Investigate:**
   - MySQL: `SHOW ENGINE INNODB STATUS\G` → section "LATEST DETECTED DEADLOCK" shows both queries and locks. Turn on `innodb_print_all_deadlocks` to log all of them.
   - Postgres: the server log shows deadlock details (both processes and queries).
   - Map the queries to code paths.
3. **Find the root cause (most likely first):**
   - Two code paths update the same rows in a **different order** (A then B vs B then A).
   - Missing index: an `UPDATE ... WHERE` scans and locks many rows (InnoDB locks the index records it scans).
   - Long transactions that hold locks while doing other work.
   - Gap locks in MySQL REPEATABLE READ on range queries.
4. **Fix:**
   - Always lock rows in the same order (e.g. sort ids before updating).
   ```js
   const ids = [...accountIds].sort((a, b) => a - b);
   await sequelize.transaction(async (t) => {
     for (const id of ids) {
       await Account.findByPk(id, { lock: t.LOCK.UPDATE, transaction: t });
     }
     // ...updates
   });
   ```
   - Add indexes so updates lock fewer rows.
   - Keep transactions short. No network calls inside.
   - Retry on deadlock with a small random backoff (2–3 tries).
5. **Prevent:** Track deadlock count as a metric. Code review rule for lock order. Load test concurrent flows.

**🔍 Internal working:**
1. When a row is updated or `SELECT ... FOR UPDATE` is used, the DB takes a row lock until commit/rollback.
2. Transaction T1 locks row A, then wants row B. T2 locked B and wants A. Both wait.
3. InnoDB keeps a "wait-for graph". When it finds a cycle, it picks a victim (usually the smaller transaction) and rolls it back. Postgres checks for cycles after `deadlock_timeout` (1s by default).
4. The victim gets an error. The other transaction continues.
5. InnoDB locks index records it scans, not only the rows it changes. So a bad index means more locks and more deadlocks.

**🎤 Say this in the interview:** "I read the latest deadlock from SHOW ENGINE INNODB STATUS to see both queries. The usual fix is a consistent lock order, better indexes so fewer rows are locked, and short transactions. Deadlocks are safe to retry, so I also add a retry with backoff."

**❓ Follow-up questions they may ask:**
- Deadlock vs lock wait timeout? → Deadlock is a cycle detected immediately; lock wait timeout is waiting too long for one lock (`innodb_lock_wait_timeout`, default 50s).
- Would READ COMMITTED help? → In MySQL it removes most gap locks, so it can reduce deadlocks on range queries.

---

### S10. You ran a migration to add a column and index on a 30M-row table. Production got locked and the site went down. How should it be done?
**🟢 In simple words:** Some schema changes lock or rewrite a big table. Writes stop until it finishes. The interviewer wants a **zero-downtime migration** plan: small safe steps, online DDL tools, and batching.
**🏠 Real-life example:** Repairing one lane of a highway at a time, instead of closing the whole highway.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** If it is still running, decide: kill it (rollback may also take time) or wait. Check `SHOW PROCESSLIST` for "Waiting for table metadata lock".
2. **Investigate:** What did the DDL do? Was it an instant change, an in-place change, or a full table copy? Was there a long-running query before it that blocked the metadata lock?
3. **Find the root cause:**
   - The DDL needed a full table copy, or it could not get the **metadata lock** because a long query held it. While it waited, every new query on that table queued behind it.
   - Backfilling all rows in one huge `UPDATE`.
   - App code and schema changed at the same time.
4. **Fix: the expand–contract pattern:**
   - **Expand:** add the new column as nullable (no default backfill). In MySQL 8, adding a column can often use `ALGORITHM=INSTANT`. Postgres 11+ adds a column with a constant default without rewriting the table.
   - **Deploy code** that writes both old and new columns.
   - **Backfill in batches:**
   ```sql
   UPDATE users SET full_name = CONCAT(first_name,' ',last_name)
   WHERE id BETWEEN :start AND :start + 4999 AND full_name IS NULL;
   -- loop with a small sleep between batches
   ```
   - **Switch reads** to the new column.
   - **Contract:** later, remove the old column in a separate release.
   - Indexes: Postgres `CREATE INDEX CONCURRENTLY` (cannot run inside a transaction). MySQL: `ALGORITHM=INPLACE, LOCK=NONE`, or tools like **gh-ost** / **pt-online-schema-change** for big tables.
   - Set a short `lock_wait_timeout` (MySQL) / `lock_timeout` (Postgres) for the migration, so it fails fast instead of blocking everyone.
5. **Prevent:** Test migrations on a production-size copy. Review every migration for lock type. Run heavy ones at low traffic. Separate "migration deploy" from "code deploy".

**🔍 Internal working:**
1. Every query on a table holds a shared **metadata lock** (MySQL) or a light table lock (Postgres) during the query.
2. DDL needs an exclusive lock, at least for a short moment.
3. If a long query is running, the DDL waits. New queries queue behind the waiting DDL. So the table looks "frozen".
4. A table-copy DDL builds a new copy row by row. On 30M rows this takes a long time.
5. Online tools (gh-ost, pt-osc) create a shadow table, copy rows in chunks, keep it in sync (gh-ost reads the binlog; pt-osc uses triggers), then swap tables with a quick rename.

**🎤 Say this in the interview:** "I use expand-contract: add the column nullable with an instant or online change, deploy code that writes both, backfill in small batches, switch reads, then drop the old column later. Indexes are built concurrently or with gh-ost. I set a short lock timeout so a blocked migration fails fast instead of freezing the table."

**❓ Follow-up questions they may ask:**
- How do you rename a column with zero downtime? → Add new column, dual-write, backfill, switch reads, then drop old — never a direct rename while old code runs.
- Why batches for backfill? → Small transactions hold locks briefly, keep replica lag low, and can be paused.

---

### S11. Two users booked the last seat at the same time. Now inventory shows -1. How do you fix this race condition?
**🟢 In simple words:** Two requests read "1 seat left" at the same time. Both booked. The check and the update were not atomic. The interviewer wants DB-level protection: atomic update, row lock, or a constraint.
**🏠 Real-life example:** Two people grab the last cake in a shop at the same moment. The shopkeeper must hand it to only one person.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** Find oversold records with SQL. Contact affected users, give a refund or another seat.
2. **Investigate:** Look at the code: is it `read → check in JS → write`? Look at logs for two bookings within milliseconds.
3. **Find the root cause:** Read-then-write without a lock. Both transactions read `qty = 1` before any writes.
4. **Fix (pick one, best first):**
   - **Atomic conditional update** — simple and fast:
   ```sql
   UPDATE seats SET available = available - 1
   WHERE show_id = ? AND available > 0;
   -- affectedRows = 0 → sold out
   ```
   ```js
   const [affected] = await Seat.update(
     { available: sequelize.literal('available - 1') },
     { where: { showId, available: { [Op.gt]: 0 } }, transaction: t }
   );
   if (affected === 0) throw new Error('SOLD_OUT');
   ```
   - **Pessimistic lock:** `SELECT ... FOR UPDATE` in a transaction (Sequelize `lock: t.LOCK.UPDATE`).
   - **Optimistic lock:** a `version` column; update only `WHERE version = :old` (Sequelize `version: true`).
   - **Constraint as last line:** `CHECK (available >= 0)` (enforced in MySQL 8.0.16+ and Postgres). For per-seat booking: `UNIQUE(show_id, seat_no)` on bookings.
5. **Prevent:** Concurrency tests (fire 50 parallel requests for 1 seat). Code review rule: no "read, check in JS, write" for counters.

**🔍 Internal working:**
1. In REPEATABLE READ (MySQL default), a plain `SELECT` reads from a snapshot. It does not lock rows.
2. So both transactions see `available = 1` at the same time.
3. An `UPDATE` takes a row lock. The second `UPDATE` waits for the first to commit.
4. After the first commits, InnoDB evaluates the second `UPDATE` on the latest committed row. Now `available > 0` is false, so 0 rows change.
5. So putting the check inside the `UPDATE ... WHERE` makes check-and-write atomic.

**🎤 Say this in the interview:** "It is a read-then-write race. I move the check into the database with an atomic UPDATE ... WHERE available > 0 and check affected rows. For complex flows I use SELECT FOR UPDATE or optimistic locking with a version column, and I add a CHECK or UNIQUE constraint as the final guarantee."

**❓ Follow-up questions they may ask:**
- Pessimistic vs optimistic locking — when? → Pessimistic for high contention (hot seats); optimistic for low contention, with retries on conflict.
- What about a flash sale with 1M users? → Pre-load stock in Redis and use atomic `DECR` or a Lua script, then write orders to the DB via a queue.

---

## Redis / Caching

### S12. An admin updated a student's marks, but users still see the old marks for 10 minutes. How do you fix stale cache data?
**🟢 In simple words:** The cache still has the old value. Nobody removed or updated it after the DB change. The interviewer wants a clear invalidation strategy and its trade-offs.
**🏠 Real-life example:** A notice board still shows the old exam date. Someone changed the date in the office but forgot to update the board.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** Delete the affected keys now (`DEL result:12345`). How fresh must this data be? Marks must be correct; a "top news" list can be a bit old.
2. **Investigate:**
   - Which pattern is used? Cache-aside with only a TTL?
   - Check `TTL result:12345` in redis-cli.
   - Are there other caches? CDN, browser cache (`Cache-Control`), an in-process cache in each pod?
3. **Find the root cause (most likely first):**
   - Only TTL-based expiry, no delete on update.
   - Update path writes DB but forgets one of many keys (e.g. list cache, per-district cache).
   - Race: a reader puts the old value back into cache just after the writer deleted it.
   - CDN or in-memory cache in each pod not cleared.
4. **Fix:**
   - On update: **write to DB first, then delete the cache key** (not update it).
   ```js
   await Result.update({ marks }, { where: { id } });
   await redis.del(`result:${id}`, `district-toppers:${districtId}`);
   ```
   - Keep a TTL as a safety net (e.g. 5–15 minutes).
   - For the race: delete again after a short delay ("delayed double delete"), or use versioned keys (`result:12345:v7`).
   - Many pods with local caches: publish an invalidation message (Redis Pub/Sub) so every pod clears its copy.
   - For heavy systems: listen to DB changes (CDC, Change Data Capture, e.g. Debezium reading the binlog) and invalidate from there.
5. **Prevent:** One shared function for "update + invalidate". Test that reads after a write return new data. Document the key names for each entity.

**🔍 Internal working:**
1. Cache-aside: read Redis → on miss read DB → `SET key value EX ttl`.
2. The DB and Redis are two separate systems. There is no shared transaction between them.
3. If you write DB and then **update** the cache, two parallel writers can finish in a different order. The cache keeps the wrong one.
4. Deleting is safer: the next reader loads fresh data from the DB.
5. A small race still exists: a slow reader reads old DB data, then sets it after the delete. TTL or a delayed second delete limits the damage.

**🎤 Say this in the interview:** "I use cache-aside: update the DB, then delete the key, with a TTL as a safety net. Deleting is safer than updating because of concurrent writers. For multi-pod local caches I broadcast invalidations over Pub/Sub, and for strict cases I use versioned keys or CDC-based invalidation."

**❓ Follow-up questions they may ask:**
- Why delete after the DB write, not before? → If you delete first, a reader can refill the cache with old DB data before your write lands.
- What data should not be cached? → Data that must be strongly consistent and changes often, like an account balance during payment.

---

### S13. Redis went down for 5 minutes. The database CPU hit 100% and the whole site crashed. How do you design so this does not happen?
**🟢 In simple words:** The DB was sized only for cache misses. When the cache disappeared, all traffic hit the DB at once. The interviewer wants: Redis high availability, a fallback plan, and stampede protection.
**🏠 Real-life example:** Many small shops get stock from a nearby warehouse. The warehouse closes, and all shops rush to the one factory together. The factory gate breaks.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** Shed load (return 503 for non-critical routes, rate-limit). Serve simple "degraded" pages for heavy pages. Bring Redis back. Warm up hot keys before opening traffic fully.
2. **Investigate:** Why did Redis go down — memory full (`maxmemory`), a slow command, a node failure, a network problem? Check Redis `INFO`, `SLOWLOG GET`, and cloud events (ElastiCache).
3. **Find the root cause:**
   - Single Redis node, no replica, no automatic failover.
   - No timeout on Redis calls, so app requests also hung.
   - No protection: thousands of requests for the same missing key all hit the DB (**cache stampede**).
4. **Fix:**
   - **High availability:** ElastiCache with replicas and Multi-AZ automatic failover, or Redis Sentinel / Redis Cluster.
   - **Short timeouts** on Redis calls (e.g. 50–100ms). If Redis fails, skip it quickly.
   - **Circuit breaker** around Redis, plus a **concurrency limit** on DB fallback calls.
   - **Stampede protection:**
     - Single-flight (request coalescing): only one request loads a key; others wait for its result.
     - A lock key: `SET lock:key 1 NX EX 10`. Only the lock owner rebuilds the value.
     - Stale-while-revalidate: serve the old value while one worker refreshes it.
     - Random jitter on TTLs, so many keys do not expire at the same moment.
   - A small in-process LRU cache (a few seconds) for the hottest keys.
5. **Prevent:** Load test "Redis down" in staging. Size the DB for a realistic miss rate. Alert on Redis memory, evictions and failovers.

**🔍 Internal working:**
1. With a 95% hit rate, the DB sees only 5% of reads.
2. If Redis is gone, the DB suddenly gets 100% of reads — 20× more load.
3. DB queries get slower, so connections are held longer, so the pool fills up (see S8). Latency rises everywhere.
4. Clients and users retry, which adds even more load. It is a positive feedback loop.
5. Single-flight keeps DB load per key at one query, no matter how many requests wait for it.

**🎤 Say this in the interview:** "Redis must be highly available with replicas and automatic failover. The app needs short Redis timeouts and a circuit breaker so it degrades instead of hanging. To protect the DB I use single-flight or a lock when rebuilding keys, TTL jitter, stale-while-revalidate, and load shedding for non-critical routes."

**❓ Follow-up questions they may ask:**
- What is a cache stampede (thundering herd)? → Many requests miss the same key at once and all go to the DB together.
- What is cache penetration? → Requests for keys that never exist; cache the "not found" result briefly or use a Bloom filter.

---

### S14. A celebrity post / very popular item gets huge traffic. One Redis node is at 100% CPU while the others are idle. How do you fix this hot key problem?
**🟢 In simple words:** In Redis Cluster, one key lives on one node. If one key gets most of the traffic, that node is overloaded. The interviewer wants you to spread or absorb the reads.
**🏠 Real-life example:** Everyone in a mall wants to visit one famous shop. That shop is full while others are empty. You open more branches of that shop.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** Is the hot traffic reads or writes? Add a short in-process cache in the app for that key right now.
2. **Investigate:**
   - `redis-cli --hotkeys` (works only when `maxmemory-policy` is an LFU policy).
   - `redis-cli --bigkeys` and `MEMORY USAGE key` — is it also a **big key**?
   - Per-node CPU and ops/sec in CloudWatch or Redis `INFO`.
   - Use `MONITOR` only for a few seconds — it is expensive in production.
3. **Find the root cause:**
   - One key (e.g. `post:123`) gets most of the reads.
   - A big key (huge hash or list) read with costly commands like `HGETALL` or `LRANGE 0 -1`.
   - A counter key that everyone increments.
4. **Fix:**
   - **Local cache** in each app instance (1–5 second TTL). This removes most reads from Redis.
   - **Key copies:** store `post:123:c0` … `post:123:c9`. Each read picks a random copy, so reads spread across nodes.
   - **Read from replicas** (Redis Cluster `READONLY` on replica connections) if slightly stale data is OK.
   - Hot counters: split into N sub-counters and sum them. Or count in memory and flush every second.
   - Big keys: split into smaller keys; avoid full reads like `HGETALL` on huge hashes.
5. **Prevent:** Monitor per-node ops/sec. Detect hot keys early. Plan ahead for "viral" items before big events.

**🔍 Internal working:**
1. Redis Cluster has 16384 **hash slots**. Slot = `CRC16(key) mod 16384`. Each node owns a set of slots.
2. So one key always goes to the same node. Adding more nodes does not spread a single key.
3. Redis executes commands on one main thread. So one node's command speed is limited by one CPU core.
4. Key copies with different names get different hash slots, so they land on different nodes.
5. Hash tags `{...}` force keys onto the same slot — do **not** use them for copies.

**🎤 Say this in the interview:** "A hot key always maps to one hash slot, so one node takes all its traffic. I add a short local cache in the app, make several copies of the key with different names, read from replicas, and split hot counters. I also check for big keys, because they overload a node in the same way."

**❓ Follow-up questions they may ask:**
- Hot key vs big key? → Hot key = too many requests; big key = too much data in one key. Both can overload one node.
- How do you delete a big key safely? → Use `UNLINK` (frees memory in a background thread) instead of `DEL`.

---

## React / Frontend

### S15. A page shows a table with 10,000 rows. Scrolling is janky and typing in the filter box is very slow. How do you fix it?
**🟢 In simple words:** The browser has to create and update too many DOM nodes. React also re-renders all rows on each keystroke. The interviewer wants measurement first, then virtualization and memoization.
**🏠 Real-life example:** A teacher reads out all 10,000 names every time one name changes. Better: read only the names on the current page.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** Do users really need 10k rows at once? Often server-side pagination and search are the real fix.
2. **Investigate:**
   - React DevTools **Profiler**: which components render, and how long does each take?
   - Chrome Performance tab: long tasks (> 50ms), layout and paint time.
   - Count DOM nodes: 10k rows × 10 cells = 100k+ nodes.
3. **Find the root cause:**
   - All rows are in the DOM.
   - Each keystroke re-renders the whole table.
   - New object/function props on every render, so `React.memo` does not help.
   - Heavy filter/sort logic runs on every render.
4. **Fix:**
   - **Virtualization (windowing):** render only visible rows (react-window, TanStack Virtual).
   ```jsx
   import { FixedSizeList } from 'react-window';
   <FixedSizeList height={600} itemCount={rows.length} itemSize={40} width="100%">
     {({ index, style }) => <Row style={style} row={rows[index]} />}
   </FixedSizeList>
   ```
   - `useMemo` for filtered/sorted data, `React.memo` for `Row`, `useCallback` for handlers.
   - `useDeferredValue` (React 18) keeps typing smooth while the list updates a bit later.
   ```jsx
   const deferredQuery = useDeferredValue(query);
   const filtered = useMemo(
     () => rows.filter(r => r.name.includes(deferredQuery)),
     [rows, deferredQuery]
   );
   ```
   - Debounce the input if filtering calls the server.
   - Stable `key` (row id, not index).
   - Very big data: server-side pagination, filtering and sorting.
5. **Prevent:** Performance budget in review. Profile big screens with production-size data, not 20 test rows.

**🔍 Internal working:**
1. On a state change, React re-renders the component and its children (unless memoized), then diffs the new tree with the old one.
2. Diffing 10k rows takes time on the main thread. Then the browser does style, layout and paint for changed nodes.
3. The main thread also handles input. If it is busy, keystrokes feel delayed.
4. Virtualization keeps only about 20–50 rows in the DOM. It positions them inside a tall container to fake the full scroll height.
5. `useDeferredValue` lets React render the urgent update (the input) first, and the slow list update at lower priority.

**🎤 Say this in the interview:** "I profile first with React Profiler and the Performance tab. The main fix is virtualization, so only visible rows are in the DOM. Then I memoize rows and derived data, and use useDeferredValue or debounce for the filter. For very large data I move filtering and pagination to the server."

**❓ Follow-up questions they may ask:**
- Why not use the index as key? → On sort or filter, index keys make React reuse the wrong DOM and state for rows.
- Downsides of virtualization? → Ctrl+F cannot find hidden rows, and accessibility and variable row heights need extra work.

---

### S16. The React app's JS bundle is 5MB. On mobile, the first load takes 12 seconds. How do you make it fast?
**🟢 In simple words:** Too much JavaScript is sent before the user sees anything. The interviewer wants you to measure the bundle, cut it, and split it.
**🏠 Real-life example:** Packing your whole house for a one-day trip. Take only what you need today; get the rest later.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** Check that compression (gzip/brotli) and caching headers are on. That alone can save a lot, fast.
2. **Investigate:**
   - Lighthouse / PageSpeed: LCP (Largest Contentful Paint), TBT (Total Blocking Time).
   - Bundle analyzer: `webpack-bundle-analyzer`, or `rollup-plugin-visualizer` for Vite. Find the biggest libraries.
   - Is it a production build? Are source maps sent to users?
3. **Find the root cause (most likely first):**
   - One big bundle with all routes (admin pages loaded for every user).
   - Big libraries: `moment` with all locales, full `lodash`, chart, PDF or Excel libraries.
   - Imports that block tree-shaking (e.g. `import _ from 'lodash'`).
   - Large images and fonts.
4. **Fix:**
   - **Code splitting by route:**
   ```jsx
   const Reports = React.lazy(() => import('./pages/Reports'));
   <Suspense fallback={<Spinner />}><Reports /></Suspense>
   ```
   - Load heavy libraries only when needed: `const XLSX = await import('xlsx')` on the "Export" click.
   - Replace heavy libraries: `moment` → `dayjs` or `date-fns`; `lodash` → `lodash-es` or per-function imports.
   - Brotli, a CDN, and long caching for hashed files (`Cache-Control: max-age=31536000, immutable`).
   - Images: WebP/AVIF, correct size, `loading="lazy"`.
   - For public pages: SSR/SSG (e.g. Next.js), so HTML shows before the JS loads.
5. **Prevent:** Bundle size budget in CI (e.g. `size-limit`). Review new dependencies. Track Core Web Vitals.

**🔍 Internal working:**
1. The browser must download, parse, compile and run the JS before React can render.
2. On a slow mobile CPU, parsing and running JS can take longer than downloading it.
3. While JS runs, the main thread is busy, so the page cannot respond (high TBT).
4. A dynamic `import()` makes the bundler create a separate chunk. It is loaded only when that code is needed.
5. Tree-shaking removes unused exports. It works best with ES modules and side-effect-free code.

**🎤 Say this in the interview:** "I measure with Lighthouse and a bundle analyzer. Then I split code by route with React.lazy, load heavy libraries on demand, replace or tree-shake big dependencies, and make sure brotli and CDN caching are on. A size budget in CI stops the bundle from growing back."

**❓ Follow-up questions they may ask:**
- What is a good JS budget? → Many teams aim for roughly 150–200KB of compressed JS on first load for mobile.
- Preload vs prefetch? → Preload = needed now for this page; prefetch = probably needed for the next page, low priority.

---

### S17. In production, one page calls the same API hundreds of times per minute and the tab freezes. You suspect a useEffect loop. How do you debug it?
**🟢 In simple words:** A `useEffect` runs, sets state, that causes a re-render, and the effect runs again — forever. The interviewer wants the common causes and the right fixes.
**🏠 Real-life example:** A dog chasing its own tail. Each turn starts the next turn.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** Hotfix or roll back the page. Add rate limiting on the API, so one client cannot overload the server.
2. **Investigate:**
   - Network tab: the same request repeats.
   - React DevTools Profiler with "Record why each component rendered" turned on.
   - Console: "Maximum update depth exceeded" error.
   - Log the effect's dependencies to see which one changes on each render.
3. **Find the root cause (most likely first):**
   - A dependency is an object/array/function created during render: `useEffect(fn, [filters])` where `filters = {...}` is new every time.
   - The effect sets a state that is in its own dependency list.
   - No dependency array: `useEffect(fn)` runs after every render.
   - `setState` called directly during render.
4. **Fix:**
   ```jsx
   // Bad: new object each render -> effect runs every render
   const filters = { status, district };
   useEffect(() => { fetchData(filters).then(setData); }, [filters]);

   // Good: depend on primitive values, and clean up
   useEffect(() => {
     const ctrl = new AbortController();
     fetchData({ status, district }, { signal: ctrl.signal })
       .then(setData)
       .catch(() => {});
     return () => ctrl.abort();   // cancels the old request
   }, [status, district]);
   ```
   - `useMemo` / `useCallback` for objects or functions that must be dependencies.
   - Better: a data-fetching library (TanStack Query, SWR) with caching and request de-duplication.
5. **Prevent:** ESLint `react-hooks/exhaustive-deps`. Develop with `StrictMode`. Monitor API calls per user session.

**🔍 Internal working:**
1. After each render, React compares each dependency with its old value using `Object.is`.
2. `{}`, `[]` and arrow functions are new objects on every render. So `Object.is` says "changed".
3. The effect runs again. It calls the API and sets state. New state → new render → new object → effect again.
4. Note: in development `StrictMode` (React 18+), effects run twice on mount on purpose. This is not a loop.
5. The cleanup function runs before the next effect run. Aborting there stops old requests from setting stale state.

**🎤 Say this in the interview:** "The usual cause is a dependency that is a new object or function on every render, or an effect that sets state it depends on. I find it with the Network tab and the Profiler's 'why did this render'. I fix it with primitive dependencies, useMemo/useCallback, an AbortController cleanup, or a library like TanStack Query."

**❓ Follow-up questions they may ask:**
- Why does my effect run twice in dev? → React 18 StrictMode mounts, unmounts and mounts again to expose missing cleanups; production runs it once.
- How do you avoid race conditions in fetch effects? → Abort the old request in the cleanup, or ignore late results with an `ignore` flag.

---

## Docker / Deployment

### S18. The app works on your machine, but the Docker container crashes in production right after it starts. How do you debug it?
**🟢 In simple words:** Something is different between your laptop and prod: env vars, files, network, CPU architecture, or permissions. The interviewer wants a systematic way to find the difference.
**🏠 Real-life example:** A recipe works in your kitchen but fails in a hotel kitchen. Maybe the oven is different, or one ingredient is missing.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** Keep the old version running (roll back). Note the exact image tag that fails.
2. **Investigate:**
   - `docker logs <container>` or `kubectl logs <pod> --previous` (logs of the crashed run).
   - `kubectl describe pod` → exit code and events (`CrashLoopBackOff`, `OOMKilled`, image pull errors).
   - Exit codes: `1` = app error, `137` = killed by SIGKILL (often OOM), `139` = segfault, `127` = command not found.
   - Run the **same image** locally with the prod config: `docker run --rm -it --env-file prod.env image:tag sh`.
3. **Find the root cause (most likely first):**
   - A missing or wrong env var / secret (e.g. `DB_HOST`).
   - The app connects to `localhost` — inside a container, localhost is the container itself, not the DB.
   - CPU architecture: built on an Apple Silicon Mac (arm64), prod is amd64 → `exec format error`. Or native modules (bcrypt, sharp) built for the wrong platform.
   - Host `node_modules` copied into the image (wrong OS binaries). Fix with `.dockerignore`.
   - File permissions: a non-root user cannot write to a folder.
   - Lower memory limit in prod.
   - A different Node version (`node:latest` instead of a pinned tag).
4. **Fix:**
   ```dockerfile
   FROM node:20-alpine
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --omit=dev      # install inside the image, for the image's OS
   COPY . .
   USER node
   CMD ["node", "server.js"]
   ```
   - Validate env vars at startup and fail with a clear message (e.g. with `zod` or `envalid`).
   - Build for the target platform: `docker buildx build --platform linux/amd64`.
   - Pin base image versions.
5. **Prevent:** Build the image once in CI and deploy the same image to staging and prod. Staging that matches prod. Docker Compose for local development.

**🔍 Internal working:**
1. A container uses the host kernel but has its own filesystem from the image.
2. Native npm modules contain compiled binaries for one OS + CPU + libc (Alpine uses musl, Debian uses glibc).
3. If the binary does not match, loading it fails with errors like "invalid ELF header" or "exec format error".
4. Each container has its own network namespace. `localhost` is the container's own loopback interface.
5. When PID 1 (your app) exits, the container stops. Kubernetes restarts it with growing delays → `CrashLoopBackOff`.

**🎤 Say this in the interview:** "I read the logs of the crashed container and its exit code, then run the exact same image locally with the prod config. Common causes are missing env vars, localhost inside the container, wrong CPU architecture for native modules, or host node_modules copied in. I prevent it by building once in CI, validating config at startup, and pinning versions."

**❓ Follow-up questions they may ask:**
- What does exit code 137 mean? → The process got SIGKILL (128 + 9), usually from the OOM killer or a forced stop.
- How do you debug a distroless image with no shell? → Use `kubectl debug` with an ephemeral debug container, or a debug image variant.

---

### S19. Every deploy causes about 30 seconds of 502 errors. How do you get zero-downtime deploys?
**🟢 In simple words:** Old pods are killed while they still serve requests, or new pods get traffic before they are ready. The interviewer wants graceful shutdown, readiness probes and correct rolling-update settings.
**🏠 Real-life example:** A shop changes cashiers. The new cashier should be ready first. The old one should finish the current customer before leaving.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** Deploy at low traffic for now. Check when the 502s happen: when new pods start, or when old pods stop?
2. **Investigate:**
   - Load balancer logs (ALB / Nginx): 502 = bad response or connection closed/refused by the upstream; 504 = upstream timeout.
   - Does the app handle `SIGTERM`? Is there a readiness probe?
   - Is the app started with `npm start`? npm may not forward signals properly to Node.
3. **Find the root cause (most likely first):**
   - No readiness probe: traffic reaches the new pod before it is ready.
   - The app exits at once on SIGTERM, dropping in-flight requests.
   - Kubernetes sends SIGTERM and removes the pod from endpoints at the same time. The load balancer may still send traffic for a few seconds.
   - Keep-alive mismatch: Node's `keepAliveTimeout` (5s default) is shorter than the ALB idle timeout (60s default). The ALB reuses a socket Node already closed → 502.
4. **Fix:**
   ```js
   let shuttingDown = false;
   app.get('/ready', (req, res) => res.status(shuttingDown ? 503 : 200).end());

   process.on('SIGTERM', () => {
     shuttingDown = true;                 // fail readiness first
     setTimeout(() => {
       server.close(async () => {         // stop new connections, finish in-flight ones
         await sequelize.close();
         await redis.quit();
         process.exit(0);
       });
     }, 10_000);                          // give the LB time to stop sending traffic
   });

   server.keepAliveTimeout = 65_000;      // longer than the ALB idle timeout (60s)
   server.headersTimeout = 66_000;
   ```
   ```yaml
   readinessProbe: { httpGet: { path: /ready, port: 3000 }, periodSeconds: 5 }
   strategy: { rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } }
   terminationGracePeriodSeconds: 40
   ```
   - Use exec-form `CMD ["node", "server.js"]` (or `tini`), so the signal reaches Node.
   - Optionally a `preStop` sleep hook, to wait for endpoint removal.
5. **Prevent:** A test that sends traffic during a deploy and fails on any 5xx. Keep `/ready` (can serve traffic) separate from `/live` (process alive).

**🔍 Internal working:**
1. In a rolling update, Kubernetes starts a new pod. It gets traffic only after its readiness probe passes.
2. To stop an old pod, Kubernetes runs `preStop`, then sends SIGTERM. In parallel it removes the pod from the Service endpoints.
3. Endpoint removal reaches kube-proxy and the load balancer with a small delay. So some requests still arrive after SIGTERM.
4. `server.close()` stops accepting new connections and waits for open ones to finish. Idle keep-alive sockets can keep it waiting, so keep a time limit.
5. After `terminationGracePeriodSeconds`, Kubernetes sends SIGKILL. Anything still running is cut.

**🎤 Say this in the interview:** "I add a readiness probe so new pods get traffic only when ready, and graceful shutdown: on SIGTERM fail readiness, wait a few seconds, then server.close and close the DB pool. I set maxUnavailable to 0, use exec-form CMD so signals reach Node, and set keepAliveTimeout above the load balancer's idle timeout."

**❓ Follow-up questions they may ask:**
- Liveness vs readiness probe? → A failing liveness probe restarts the pod; a failing readiness probe only removes it from traffic.
- Should the liveness probe check the DB? → No; if the DB is down, restarting all pods does not help and causes a restart storm.

---

### S20. Your Docker image is 1.5GB and CI takes 20 minutes to build and push. How do you make it small and fast?
**🟢 In simple words:** The image has things it does not need (build tools, dev dependencies, source files, caches). The layer cache is also not used well. The interviewer wants multi-stage builds, a good layer order and CI caching.
**🏠 Real-life example:** Moving house and taking along all the construction tools used to build it. You only need the furniture.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** See what is inside: `docker history image:tag`, or the `dive` tool to see each layer's size.
2. **Investigate:**
   - Base image: `node:20` (full Debian, large) vs `node:20-slim` / `node:20-alpine`.
   - Are dev dependencies installed? Are `.git`, tests or logs copied in?
   - Is `COPY . .` before `npm ci`? Then every code change re-installs all packages.
3. **Find the root cause:** Full base image, no `.dockerignore`, dev dependencies and build tools in the final image, wrong layer order, no CI cache.
4. **Fix:**
   ```dockerfile
   # ---- build stage ----
   FROM node:20-alpine AS build
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci
   COPY . .
   RUN npm run build && npm prune --omit=dev

   # ---- runtime stage ----
   FROM node:20-alpine
   WORKDIR /app
   ENV NODE_ENV=production
   COPY --from=build /app/node_modules ./node_modules
   COPY --from=build /app/dist ./dist
   COPY package.json ./
   USER node
   CMD ["node", "dist/server.js"]
   ```
   ```text
   # .dockerignore
   node_modules
   .git
   coverage
   *.log
   .env
   ```
   - CI: BuildKit remote cache (`docker buildx build --cache-from type=registry,ref=... --cache-to type=registry,ref=...,mode=max`, or `type=gha` on GitHub Actions).
   - BuildKit cache mount for npm: `RUN --mount=type=cache,target=/root/.npm npm ci`.
   - Unchanged layers are not pushed again.
5. **Prevent:** Image size check in CI. Regular base image updates. Scan with Trivy (fewer packages also means fewer CVEs).

**🔍 Internal working:**
1. Each `RUN`, `COPY` and `ADD` creates a layer. A layer is cached by its instruction and its input files.
2. If one layer changes, all layers after it rebuild. So copy `package*.json` first, install, then copy the source.
3. A file deleted in a later layer still exists in the earlier layer. Only multi-stage builds truly leave it out.
4. In a multi-stage build, only the final stage becomes the image. `COPY --from` takes only the files you choose.
5. Registries store layers by digest. A layer that already exists is not uploaded again.

**🎤 Say this in the interview:** "I use a multi-stage build with a slim or alpine base, copy only production node_modules and the built output, and add a .dockerignore. I order layers so the dependency install is cached, and use BuildKit registry cache in CI. This usually brings the image from over 1GB to a few hundred MB and the build to a few minutes."

**❓ Follow-up questions they may ask:**
- Alpine vs slim? → Alpine is smaller but uses musl libc, which can break some native modules; slim (Debian) is safer.
- What is distroless? → A runtime image with no shell or package manager: smaller and safer, but harder to debug.

---

## Scale / Design

### S21. Exam results will be declared tomorrow at 10 AM. Normal traffic is 2,000 requests/min. You expect 50× more for about 2 hours. How do you prepare?
**🟢 In simple words:** This is a planned traffic spike. You know the time and the main pages. The interviewer wants capacity planning, caching, load testing and a "war room" plan — not just "add more servers".
**🏠 Real-life example:** A temple expects a huge crowd on a festival day. They add queues, extra volunteers, barricades and a backup plan — before the day, not during it.

**Step-by-step answer:**
1. **Clarify / stop the bleeding (here: plan ahead):**
   - Which pages get the spike? Usually: result lookup by roll number, and the home page.
   - Can results be read-only on that day? (Yes — data is final before 10 AM.)
   - What is the peak? 2,000 × 50 = 100,000 requests/min ≈ 1,700 requests/sec, with bursts much higher in the first minutes.
2. **Investigate (find limits before users do):**
   - Load test the result API with k6, JMeter or Artillery up to 2–3× the expected peak.
   - Watch DB CPU, connections, Redis ops, p99 latency, error rate. Find the first part that breaks.
3. **Find the root cause (usual bottlenecks):**
   - Every lookup hits the DB.
   - DB connection limit (see S8).
   - Home page and static files served by the app instead of a CDN.
   - Auto-scaling that is too slow to react to a sudden spike.
4. **Fix (the plan):**
   - **Pre-compute and cache:** load all results into Redis the night before (`result:<rollNo>` → small JSON). Or generate static JSON files per roll number on S3 + CloudFront.
   - **CDN** for the home page, JS, CSS and images. Short cache (e.g. 60s) for semi-static pages.
   - **Pre-scale** (do not wait for auto-scaling): more app instances, a bigger DB or read replicas, before 9 AM.
   - **Protect the system:** rate limit per IP, a CAPTCHA if bots appear, a waiting room/queue page if load goes over capacity.
   - **Turn off heavy features** for those 2 hours (reports, bulk uploads, admin exports) with feature flags.
   - **Code freeze** 2–3 days before. No deploys on result day.
   - Keep the result lookup on a separate, simple endpoint: one Redis `GET`, no joins.
5. **Prevent / on the day:** A war room with dashboards (RPS, p99, errors, DB, Redis). A runbook: "if X happens, do Y". Rollback and scale-up steps written down. A postmortem after, even if all went well.

**🔍 Internal working:**
1. Each request uses app CPU, a DB or Redis call, and a network connection. The smallest limit decides the maximum throughput.
2. Auto-scaling reacts after metrics rise, and new instances take minutes to boot. A spike at 10:00:00 is faster than that. So pre-scaling is needed.
3. A Redis `GET` by key is O(1) and served from memory. Redis can serve far more simple reads per second than a SQL query with joins.
4. A CDN serves cached content from edge locations near users. Those requests never reach your servers.
5. When load is above capacity, queues grow and latency explodes for everyone. Rate limits and a waiting room keep the system working for most users.

**🎤 Say this in the interview:** "Since the date is known, I pre-compute results into Redis or static files on S3 plus CloudFront, pre-scale before the spike, and load test to 2–3× the peak. I turn off heavy features, freeze code, rate-limit and keep a waiting-room fallback. On the day we run a war room with dashboards and a written runbook."

**❓ Follow-up questions they may ask:**
- Why not rely only on auto-scaling? → It reacts in minutes; the spike comes in seconds, so scale before the event.
- How do you stop people scraping all results? → Rate limit per IP, require roll number plus date of birth, add CAPTCHA when abuse is seen.

---

### S22. An admin uploads a CSV with 1 lakh (100,000) rows. The request times out after 60 seconds and half the rows are saved. How do you redesign it?
**🟢 In simple words:** A long job is done inside one HTTP request. The request dies, and the data is half-saved. The interviewer wants an async design: upload, queue, background worker, streaming, batching and progress.
**🏠 Real-life example:** You give a tailor 100 shirts. He does not make you wait at the counter. He gives you a token, and you check the status later.

**Step-by-step answer:**
1. **Clarify / stop the bleeding:** Find the half-imported data (by an `upload_id` or created time). Delete it, or fix it. Tell users to stop re-uploading the same file, which creates duplicates.
2. **Investigate:** Where does time go? Parsing the whole file in memory? One `INSERT` per row? Validation queries per row (N+1)? The 60s timeout comes from the load balancer or Nginx.
3. **Find the root cause:**
   - Sync processing inside the HTTP request.
   - One insert per row: 100k round trips to the DB.
   - Whole file loaded in memory.
   - No transaction or job tracking, so a failure leaves half the data.
4. **Fix (new design):**
   - **Upload:** the file goes to S3 (a pre-signed URL lets the browser upload directly). The API creates an `upload_jobs` row (`PENDING`) and returns `202 Accepted` with a `jobId`.
   - **Queue:** push the job to BullMQ (Redis) or SQS.
   - **Worker:** stream the file, parse row by row, validate, and insert in **batches** of 500–1,000.
   ```js
   const { parse } = require('csv-parse');
   const parser = s3Stream.pipe(parse({ columns: true }));
   let batch = [], done = 0, errors = [];
   for await (const row of parser) {
     const err = validate(row);
     if (err) { errors.push({ line: done + 1, err }); } else { batch.push(toModel(row)); }
     done++;
     if (batch.length === 1000) {
       await Student.bulkCreate(batch, { updateOnDuplicate: ['name', 'marks'] }); // MySQL upsert
       batch = [];
       await job.updateProgress(done);   // BullMQ progress
     }
   }
   if (batch.length) await Student.bulkCreate(batch, { updateOnDuplicate: ['name', 'marks'] });
   ```
   - **Idempotent:** use a natural unique key (e.g. roll number) with upsert, so a retry does not create duplicates.
   - **Progress:** the UI polls `GET /uploads/:jobId` (or uses WebSocket/SSE) and shows "45,000 / 100,000".
   - **Error report:** save bad rows to a downloadable error CSV ("line 532: invalid date"). Do not fail the whole file for a few bad rows — or validate everything first if the business needs all-or-nothing.
   - **All-or-nothing option:** load into a staging table first, validate, then move to the main table in one step.
5. **Prevent:** Limit file size and row count. Limit concurrent jobs per worker. Alert on failed jobs. Test with a 1-lakh-row file in staging.

**🔍 Internal working:**
1. Load balancers and proxies close requests that run longer than their timeout (e.g. Nginx `proxy_read_timeout` default 60s).
2. When the connection closes, Node may keep running, but the user sees a failure and often uploads again.
3. Each single `INSERT` is one network round trip plus one commit. With autocommit, every commit forces a log flush to disk. 100k commits is slow.
4. A multi-row `INSERT` (what `bulkCreate` sends) does one round trip and one commit for 1,000 rows.
5. Streaming reads the file in small chunks, so memory stays flat even for big files.
6. BullMQ stores jobs in Redis. Workers take a job, process it, and report progress. Failed jobs can retry with backoff.

**🎤 Say this in the interview:** "I move the import out of the request. The file goes to S3, the API returns 202 with a job id, and a worker streams the CSV, validates each row and inserts in batches of about a thousand using upserts on a natural key, so retries are safe. The UI shows progress and gives a downloadable error report for bad rows."

**❓ Follow-up questions they may ask:**
- Why batches of 1,000 and not all 100k in one insert? → Huge statements hit packet-size limits (`max_allowed_packet`), hold locks long and cause replica lag.
- What if the worker crashes in the middle? → The job retries; upserts make re-processing safe, or you resume from a saved row offset.

---

### S23. You must design audit logs for an MIS portal: every create, update and delete must record who changed what, when, and the old and new values. How do you design it?
**🟢 In simple words:** Government and finance systems need a trail of every change. The log must be complete, hard to tamper with, and searchable. The interviewer wants the data model, how you capture changes, and how it scales.
**🏠 Real-life example:** A bank passbook. Every deposit and withdrawal is written with date and amount. Nobody erases a line; mistakes are fixed with a new entry.

**Step-by-step answer:**
1. **Clarify:** Which tables? How long to keep logs (e.g. 7 years)? Who can read them? Must they be tamper-proof? Do we also log reads/exports of sensitive data?
2. **Design the table:**
   ```sql
   CREATE TABLE audit_logs (
     id          BIGINT AUTO_INCREMENT PRIMARY KEY,
     entity      VARCHAR(50)  NOT NULL,       -- 'student', 'result'
     entity_id   VARCHAR(50)  NOT NULL,
     action      VARCHAR(10)  NOT NULL,       -- CREATE / UPDATE / DELETE
     changed_by  BIGINT       NOT NULL,       -- user id
     old_values  JSON,
     new_values  JSON,
     ip_address  VARCHAR(45),
     request_id  VARCHAR(64),                 -- links to app logs/traces
     created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     INDEX idx_entity (entity, entity_id, created_at),
     INDEX idx_user (changed_by, created_at)
   );
   ```
3. **How to capture changes (options):**
   - **App level (Sequelize hooks):** `afterCreate`, `afterUpdate`, `afterDestroy`. Use `instance.previous()` / `instance.changed()` for old values. Pass the user via AsyncLocalStorage (request context).
   ```js
   Result.addHook('afterUpdate', async (row, options) => {
     const ctx = requestContext.getStore();     // AsyncLocalStorage
     const changed = row.changed() || [];
     await AuditLog.create({
       entity: 'result', entityId: row.id, action: 'UPDATE',
       changedBy: ctx.userId, ipAddress: ctx.ip, requestId: ctx.requestId,
       oldValues: Object.fromEntries(changed.map(k => [k, row.previous(k)])),
       newValues: Object.fromEntries(changed.map(k => [k, row.get(k)])),
     }, { transaction: options.transaction });  // same transaction = no lost logs
   });
   ```
   - Careful: bulk methods (`Model.update`, `Model.destroy` with `where`) skip per-row hooks unless you pass `individualHooks: true`.
   - **DB triggers:** catch every change, even manual SQL. But they do not know the app user (unless you set a session variable).
   - **CDC (Change Data Capture):** Debezium reads the MySQL binlog / Postgres WAL and sends changes to Kafka. No load on the main write path; good at large scale.
4. **Make it trustworthy:**
   - Append-only: the app DB user gets only `INSERT` and `SELECT` on `audit_logs` — no `UPDATE`/`DELETE`.
   - Tamper evidence: each row stores a hash of (its data + the previous row's hash), like a chain. Or ship logs to write-once storage (S3 Object Lock).
   - Do not store secrets (passwords, OTPs) in old/new values. Mask sensitive fields.
5. **Scale / prevent:** Partition by month. Move old partitions to cheap storage (S3) after N months. Show a "History" tab per record in the UI. Alert if audit writes fail.

**🔍 Internal working:**
1. Sequelize keeps the original values of a loaded instance in `_previousDataValues`. `changed()` compares the current values to them.
2. Hooks run inside the same Node call. If you pass the same transaction, the audit row commits or rolls back with the data change.
3. AsyncLocalStorage keeps a per-request store across `await` calls, so deep code can know the current user without passing it everywhere.
4. Triggers run inside the DB, in the same transaction as the change.
5. CDC reads the DB's own change log (binlog/WAL). Every committed change appears there, in commit order.

**🎤 Say this in the interview:** "I use an append-only audit table with entity, id, action, user, old and new values as JSON, IP and request id. I capture changes with Sequelize hooks in the same transaction, getting the user from AsyncLocalStorage, and remember that bulk updates need individualHooks. For scale or manual SQL I would use CDC from the binlog. The table is insert-only for the app user, partitioned by month, and optionally hash-chained for tamper evidence."

**❓ Follow-up questions they may ask:**
- Hooks vs triggers vs CDC? → Hooks know the app user but miss raw SQL; triggers catch everything but miss app context; CDC scales best but needs extra infrastructure.
- The audit table becomes huge — what now? → Monthly partitions, archive old ones to S3, and keep only indexed recent data online.

---

## Security

### S24. A developer pushed the `.env` file (JWT secret, DB password, AWS keys) to a public GitHub repo. What do you do now?
**🟢 In simple words:** Assume the secrets are already stolen. Bots scan GitHub for keys within minutes. The interviewer wants: rotate first, then check for abuse, then clean up, then prevent.
**🏠 Real-life example:** You lost your house key on the street. You do not just pick it up again — you change the lock, because someone may have copied it.

**Step-by-step answer:**
1. **Stop the bleeding (minutes, not hours):**
   - **Rotate every leaked secret now.** Deleting the commit is NOT enough.
   - AWS keys: deactivate and delete the access key in IAM, create a new one.
   - DB password: change it, update the app config, redeploy.
   - JWT secret: change it. All old tokens become invalid, so users must log in again. Accept this.
   - Third-party API keys (SMS, payment, email): regenerate them.
   - Make the repo private while you work, if possible.
2. **Investigate (was it abused?):**
   - AWS CloudTrail: API calls from the leaked key (new EC2 instances for crypto-mining, new IAM users, S3 downloads). Check the bill and all regions.
   - DB logs: logins from unknown IPs. Is the DB even reachable from the internet?
   - App logs: tokens signed with the old secret but for users that look strange (forged admin tokens).
3. **Find the root cause:** `.env` was not in `.gitignore`, or someone used `git add .` / `git add -A`. No secret scanning in place.
4. **Fix:**
   - Remove the file from history: `git filter-repo --path .env --invert-paths`, then force-push. Ask GitHub support to clear cached views if needed. But remember: **history cleanup does not un-leak a secret** — rotation is the real fix.
   - Move secrets to a secret manager: AWS Secrets Manager or SSM Parameter Store, injected at runtime.
   - Use IAM roles for EC2/ECS/Lambda instead of long-lived access keys.
5. **Prevent:**
   - `.env` in `.gitignore`; commit only `.env.example`.
   - Pre-commit secret scanning (gitleaks, git-secrets) and GitHub secret scanning + push protection.
   - Least privilege: each key can do only what it needs.
   - A blameless postmortem and a written "secret leak" runbook.

**🔍 Internal working:**
1. Git stores every commit forever in history. Deleting the file in a new commit does not remove it from old commits.
2. Public repos are cloned and scanned by bots quickly. Forks and caches can keep copies you cannot delete.
3. A JWT is signed with HMAC (e.g. HS256) using the secret. With the secret, anyone can create a valid token with any user id or role.
4. When you change the secret, old signatures no longer verify, so all old tokens are rejected.
5. AWS access keys work from anywhere on the internet until they are deactivated. CloudTrail records the API calls made with them.

**🎤 Say this in the interview:** "I treat the secrets as compromised and rotate all of them immediately — AWS keys, DB password, JWT secret and third-party keys — accepting that users must log in again. Then I check CloudTrail and DB logs for abuse, clean the git history, and move secrets to Secrets Manager with IAM roles. Finally I add pre-commit and GitHub secret scanning so it cannot happen again."

**❓ Follow-up questions they may ask:**
- Why not just delete the commit? → It may already be cloned or cached; only rotation makes the old secret useless.
- How do you rotate a JWT secret without logging everyone out? → Support two keys for a short time (verify with old and new, sign with new), using a `kid` header — but after a leak, cut the old key at once.

---

## Team / Leadership

### S25. A production incident happened because of a bug in a junior developer's code. The junior is very upset. How do you handle it as the senior/lead?
**🟢 In simple words:** The interviewer checks your leadership. They want: fix the problem first, no blame, find the process gap, and help the junior grow.
**🏠 Real-life example:** A new driver scratches the car while the instructor is in the seat. A good instructor asks: "Why did the mirror not show it? Let's adjust it." — not "You are a bad driver."

**Step-by-step answer:**
1. **Stop the bleeding:** Focus on the users first. Roll back or hotfix. Communicate status to stakeholders. Involve the junior in the fix if they are calm — it builds confidence.
2. **Talk to the junior privately:** "This happens to everyone. The code passed review and tests, so the system let it through, not only you." No blame in public channels.
3. **Find the root cause (process, not person):** Run a **blameless postmortem**. Ask "why" five times:
   - Why did the bug reach prod? → No test for this case.
   - Why did review miss it? → The PR was 1,500 lines; the reviewer skimmed it.
   - Why no alert? → No monitoring on that flow.
4. **Fix:** Concrete action items with owners and dates: add the missing tests, smaller PRs, a review checklist, a canary deploy or feature flag, an alert on that metric.
5. **Prevent / grow the person:** Pair with the junior on the fix and the test. Let them present part of the postmortem if they are comfortable. Share the learning with the team. I also own my part — as the lead, I approved the process.

**🔍 Internal working (why blameless works):**
1. If people fear blame, they hide mistakes and delay reporting. Incidents last longer.
2. A blameless culture makes people report early and honestly, so you get the real timeline.
3. Most incidents have many causes (code, review, tests, deploy, monitoring). Fixing one person fixes none of them.
4. Action items on the system (tests, alerts, guardrails) protect against the next mistake by anyone.

**🎤 Say this in the interview:** "First I fix the impact and keep stakeholders informed. Then I support the junior privately and run a blameless postmortem focused on why our process let the bug through — missing tests, a large PR, no alert. We leave with owned action items, and I pair with the junior so the incident becomes a learning moment."

**❓ Follow-up questions they may ask:**
- What if the same person causes repeated incidents? → Look for a pattern, give clear feedback and support (pairing, smaller tasks), and escalate through a performance process only if it continues.
- Did you ever cause an incident? → Have a real, short STAR story ready where you owned your mistake.

---

### S26. The product manager wants a feature in 1 week. Your honest estimate is 3 weeks. What do you do?
**🟢 In simple words:** The interviewer wants to see that you do not just say "yes" or "no". You negotiate scope, show trade-offs with data, and find a plan both sides accept.
**🏠 Real-life example:** A guest wants a full wedding dinner in 1 hour. The cook says: "In 1 hour I can serve 3 good dishes. The full menu needs 3 hours. Which do you want?"

**Step-by-step answer:**
1. **Clarify:** Why 1 week? Is there a real deadline (a government notification, a launch event, a client demo) or just a wish? What is the core problem the user must solve?
2. **Show the estimate with reasons:** Break the work into parts with days: API 3 days, UI 4, data migration 2, testing 3, edge cases and security 3. Mention risks and unknowns.
3. **Offer options (scope, time, people, quality):**
   - **Option A — MVP in 1 week:** only the core flow, simple UI, behind a feature flag, for a small group of users. The rest in weeks 2–3.
   - **Option B — full feature in 3 weeks.**
   - **Option C — more people:** maybe 2 weeks, but adding people has a cost (Brooks's law: adding people to a late project can make it later).
   - Not an option: skipping tests or security. Say it clearly, with the risk ("a bug in result data = wrong results to lakhs of students").
4. **Decide together and write it down:** Agree on scope, date and what is cut. Share it with the team and stakeholders.
5. **Prevent / follow through:** Give progress updates often. Raise risks early, not on the last day. After delivery, review the estimate vs actual to improve future estimates. Plan the tech debt from the MVP.

**🔍 Internal working (why this works):**
1. Every project has a triangle: scope, time, resources. Quality is fixed — you cannot cut it safely.
2. If time is fixed, scope must flex.
3. Breaking the work into small tasks gives a more honest estimate and shows the PM where the time goes.
4. A feature flag lets you ship part of the work safely and get real feedback early.

**🎤 Say this in the interview:** "I first ask why the date matters. Then I show my estimate broken into tasks and offer options: a smaller MVP behind a feature flag in one week, the full feature in three, or a trade-off with more people. I do not cut testing or security. We agree in writing, and I give early updates if risks appear."

**❓ Follow-up questions they may ask:**
- What if the PM still insists on everything in 1 week? → Escalate with data to the engineering manager, document the risk, and agree on what will be cut if it slips.
- How do you estimate better? → Break work into small tasks, add a buffer for unknowns, and compare past estimates to actuals.

---
