# 02 — Node.js (Senior / Lead Level)

---

### Q1. Explain the Node.js architecture and event loop phases.
**🟢 In simple words:** Node runs your JavaScript on one main thread. Slow jobs like reading files or waiting for the network are given to the operating system or to a small group of helper threads. When a job is done, its callback waits in a queue. The event loop picks callbacks from these queues one by one, in a fixed order of "phases".
**🏠 Real-life example:** One waiter in a restaurant. He takes your order, gives it to the kitchen, and goes to the next table. He does not stand and wait for your food. When the kitchen rings the bell, he brings the food.

**Answer:** Node = **V8** (runs the JS) + **libuv** (event loop, thread pool, async I/O) + C++ bindings. JS runs on a single main thread. Network I/O uses OS async mechanisms (epoll/kqueue/IOCP — the OS tools that tell you "this socket is ready"). Blocking work (fs, dns.lookup, crypto, zlib) runs on the **libuv thread pool**. It has 4 threads by default. You can change this with `UV_THREADPOOL_SIZE`.

**Event loop phases (each has a FIFO queue):**
1. **timers** — `setTimeout` / `setInterval` callbacks
2. **pending callbacks** — some deferred system I/O errors
3. **idle/prepare** — internal
4. **poll** — fetch new I/O events and run I/O callbacks; may block here waiting
5. **check** — `setImmediate` callbacks
6. **close callbacks** — `socket.on('close')`

Between every callback, two queues are fully emptied: first the **`process.nextTick` queue**, then the **Promise microtask queue**.

**🔍 Internal working:**
1. At startup, `node` creates a V8 **isolate** (a separate JS engine instance with its own heap) and a context. It sets up libuv's default loop (`uv_default_loop()`) and runs the internal bootstrap JS. Then it runs your main module **synchronously**. The event loop (`uv_run(loop, UV_RUN_DEFAULT)`) starts only after the main script finishes.
2. JS APIs call C++ through bindings. Example: `fs.readFile` → `internalBinding('fs')` → a C++ `FSReqCallback` object → `uv_fs_read()`. The C++ object holds a reference to your JS callback. It keeps it until libuv reports that the work is done.
3. One `uv_run` iteration: update the cached "now" → run due **timers** → run **pending** callbacks → **idle/prepare** → **poll** (block in `epoll_wait` / `kevent` / `GetQueuedCompletionStatusEx`) → **check** (`setImmediate`) → **close** callbacks. The loop exits when no active, *referenced* handles or requests remain. This is why `timer.unref()` lets the process exit.
4. How poll decides how long to block (`uv_backend_timeout`):
   - **0** (do not block) if the loop is stopping, or there are pending or closing handles, or there are idle handles. (Node turns on an idle handle whenever `setImmediate` callbacks are queued.)
   - Otherwise, the time until the **nearest timer**.
   - **-1** (block forever) if there are no timers.
5. Sometimes the kernel reports a ready socket. Sometimes a threadpool job finishes (the worker thread calls `uv_async_send`, which writes to an eventfd/pipe that the poll phase watches). In both cases libuv calls the C++ callback. C++ enters JS through `MakeCallback` / `InternalCallbackScope`. When that scope closes, Node calls `processTicksAndRejections`. This empties the nextTick queue first, then V8's microtask queue.
6. Since **Node 11**, microtasks are emptied after **each** `setTimeout`/`setImmediate` callback. Before Node 11 they ran only between phases. Now it matches browser behavior.

```text
   ┌──────────────► timers  (min-heap of due timers)
   │                pending callbacks
   │                idle / prepare
   │                poll  ◄── epoll/kqueue/IOCP, timeout = 0 | next timer | -1
   │                check (setImmediate)
   └─────────────── close callbacks
   after EVERY callback: nextTick queue → Promise microtasks
```

**🎤 Say this in the interview:** "Node is V8 plus libuv. My JS runs on one thread. libuv's uv_run loop goes through timers, pending, poll, check and close phases. The poll phase blocks in epoll/kqueue/IOCP only as long as the nearest timer allows. After every callback, Node empties the nextTick queue and then the promise microtasks."

**🧪 Real scenario:** After adding a "Download PDF report" feature to the MIS portal, all other API calls become slow whenever someone downloads a report. Why, and how do you fix it?

**✅ Scenario answer:**
1. **Root cause:** the PDF is built with synchronous JS (loops, layout, maybe `JSON.stringify` of big data) on the main thread. While it runs, the event loop cannot pick any other callback, so every user waits.
2. **Confirm:** watch event-loop lag with `perf_hooks.monitorEventLoopDelay()`. p99 jumps during downloads. Take a CPU profile (`node --cpu-prof` or `--inspect` + DevTools). The flame graph shows the PDF library as the widest box.
3. **Fix:** move PDF building off the main thread. Use a worker pool (`piscina`), or a job queue (BullMQ) that builds the file and gives the user a download link later.
   ```js
   const pool = new Piscina({ filename: './pdf-worker.js', maxThreads: 4 });
   app.get('/report/:id/pdf', async (req, res) => {
     const buf = await pool.run({ id: req.params.id }); // main thread stays free
     res.type('application/pdf').send(Buffer.from(buf));
   });
   ```
4. **Prevent:** add an alert on event-loop lag, and load-test heavy endpoints before release.

---

### Q2. `process.nextTick` vs `setImmediate` vs `setTimeout(fn, 0)`.
**🟢 In simple words:** All three say "run this later", but "later" means different things. `nextTick` runs almost immediately, before anything else. `setImmediate` runs after the loop has checked for I/O. `setTimeout(0)` runs in the timers phase, after at least 1 ms.
**🏠 Real-life example:** A doctor's clinic. `nextTick` is "just one more question" before the patient leaves the room. `setImmediate` is the next patient in the waiting room. `setTimeout(0)` is a patient with an appointment slot that starts in one minute.

- `nextTick` — runs right after the current operation, **before** promise microtasks. If you use it too much, it can starve I/O (I/O never gets a turn).
- `setImmediate` — runs in the **check** phase, right after poll.
- `setTimeout(0)` — timers phase (minimum ~1ms).

In the main module, the order of `setTimeout(0)` vs `setImmediate` is **non-deterministic** (not fixed). Inside an I/O callback, `setImmediate` always runs first.

```js
setTimeout(() => console.log('timeout'));
setImmediate(() => console.log('immediate'));
process.nextTick(() => console.log('nextTick'));
Promise.resolve().then(() => console.log('promise'));
// nextTick, promise, then timeout/immediate (order may vary)
```

**🔍 Internal working:**
1. `process.nextTick(fn)` only pushes `fn` into a JS-side `FixedQueue` (`lib/internal/process/task_queues.js`). It also sets a "tick scheduled" flag. libuv is not involved at all.
2. `processTicksAndRejections()` runs after every callback from C++ into JS. It loops: run **all** queued ticks → call V8's `runMicrotasks()` → handle unhandled rejections → repeat until both queues are empty. So a recursive `nextTick` never lets the loop reach the poll phase. This is I/O starvation.
3. Promise `.then` callbacks are V8 **microtasks**. Node sets V8's microtask policy to "explicit". So V8 runs them only when Node calls `runMicrotasks()`. That happens after the nextTick queue is empty.
4. `setImmediate(fn)` adds `fn` to a JS linked list. It makes sure a libuv **check** handle is running. It also starts an **idle** handle, so the poll phase does not block. In the check phase, `processImmediate()` runs only the immediates that were queued before this phase started. New ones wait for the next iteration.
5. `setTimeout(fn, 0)` becomes 1 ms. Why is the main-module order random? If more than 1 ms passed between scheduling and the first timers phase, the timer fires first. Otherwise the loop goes to poll → check, and the immediate runs first. Inside an I/O callback you are already in the poll phase. So check always comes before the next timers phase.
6. ESM detail: in an ES module (`.mjs`), the top-level code itself runs as part of a promise job. So the example prints `promise` **before** `nextTick`. In CommonJS the order is `nextTick`, then `promise`.

**🎤 Say this in the interview:** "nextTick is a pure JS queue. Node empties it before V8's microtask queue, after every callback. setImmediate is a libuv check-phase handle that runs right after poll. setTimeout(0) is a 1 ms timer. That is why its order against setImmediate depends on how fast the loop starts."

**🧪 Real scenario:** A teammate processes 50,000 pending SMS records with a recursive function that uses `process.nextTick` "so it does not block". After deploy, the server stops answering health checks while this job runs, and Kubernetes restarts the pod. Why?

**✅ Scenario answer:**
1. **Root cause:** Node empties the whole nextTick queue before the loop can move on. A recursive `nextTick` keeps adding to that queue, so the poll phase never runs. No I/O (health checks, API calls) gets a turn. This is I/O starvation.
2. **Confirm:** CPU is at 100% on one core, event-loop lag is huge, and the health check times out only while the job runs. A CPU profile shows the job function on top.
3. **Fix:** yield with `setImmediate` after each batch. Then the loop can do I/O between batches.
   ```js
   function processBatch(items, i = 0) {
     const end = Math.min(i + 500, items.length);
     for (; i < end; i++) sendSms(items[i]);
     if (i < items.length) setImmediate(() => processBatch(items, i));
   }
   ```
4. **Better:** move bulk jobs like this to a background queue worker, not the API process.
5. **Prevent:** in code review, treat recursive `nextTick` as a red flag.

---

### Q3. If Node is single-threaded, how does it handle 10k concurrent connections?
**🟢 In simple words:** Most server work is waiting: waiting for the database, the disk, or the network. Node does not keep a thread waiting for each user. It asks the operating system to tell it when data is ready, and then it does the small piece of work. One thread can serve thousands of users this way, as long as no single job takes a lot of CPU.
**🏠 Real-life example:** A bank token system. You take a token and sit down. One clerk calls the token number only when your papers are ready. One clerk can serve a full hall of people because most of them are just waiting.

Most server work is I/O-bound (it waits for input/output, not CPU). Node doesn't block a thread per request. It tells the OS "I am interested in this I/O", and moves on. When data arrives, the callback is queued. One thread can multiplex (handle together) thousands of sockets. **It is bad at CPU-bound work** (image processing, big JSON parsing, crypto loops). Such work blocks the loop for every user.

**🔍 Internal working:**
1. `server.listen()` → libuv creates a **non-blocking** socket and calls `bind()` and `listen()` (Node's default backlog is 511). Then it registers the listening fd with the kernel using `uv__io_start` (`epoll_ctl(ADD)` on Linux, `kevent` on macOS/BSD).
2. In the poll phase, `epoll_wait` returns the list of **ready** fds. For the listening socket, libuv calls `accept4()` in a loop. Each new connection is wrapped in a C++ `TCPWrap` and a JS `net.Socket`. Then `'connection'` is emitted.
3. Each connection fd is also registered with epoll for "readable". The cost per connection is a few KB (socket object, HTTP parser, buffers). It is not a full thread stack (about 1–8 MB per thread in thread-per-request servers).
4. When data arrives, libuv reads it (`uv_read_start` with an allocation callback). C++ `OnRead` calls JS `onStreamRead`. llhttp parses the bytes, and `'request'` is emitted.
5. Writes first try `write()` directly. If the kernel send buffer is full, libuv queues the data. It waits for "writable" (`EPOLLOUT`) before sending the rest.
6. Network sockets never use the threadpool. Windows uses **IOCP**, a *completion* model. libuv starts overlapped reads and is told when they are finished. It is not told that the socket is "ready". Only fs, `dns.lookup` (`getaddrinfo`), some crypto, and zlib use the threadpool.

```text
 10k sockets ──► kernel (epoll / kqueue / IOCP)
                      │  "fds 7, 91, 4031 are ready"
                      ▼
           libuv poll phase ──► JS callbacks, one at a time, on ONE thread
```

**🎤 Say this in the interview:** "Every socket is non-blocking and registered with epoll, kqueue or IOCP. So one epoll_wait call in libuv's poll phase tells the single JS thread which of the 10k sockets are ready. A connection costs a few kilobytes of memory, not a thread."

**🧪 Real scenario:** On result day, about 10,000 users are online. CPU is only 30% and simple JSON APIs are fast. But file uploads, login (bcrypt) and calls to other services by hostname are very slow. What is going on?

**✅ Scenario answer:**
1. **Root cause:** network sockets do not use the threadpool, so JSON APIs are fine. But fs work, `bcrypt`/`crypto.pbkdf2`, and `dns.lookup` all share the **libuv threadpool**, which has only 4 threads by default. They wait in a queue for a free thread.
2. **Confirm:** event-loop lag is low, CPU is low, but latency is high only on routes that touch fs, password hashing, or hostname lookups. Tracing shows time "before" the actual work starts.
3. **Fix:** set a bigger pool through the environment, before Node starts, e.g. `UV_THREADPOOL_SIZE=16`. Stream uploads directly to storage instead of writing temp files. Reuse connections with keep-alive so fewer DNS lookups happen.
4. **Prevent:** load-test with a realistic mix of logins and uploads, not only simple GET calls.

---

### Q4. How do you handle CPU-intensive tasks in Node?
**🟢 In simple words:** Heavy calculation blocks the single main thread, so every other user has to wait. The fix is to move that work somewhere else: to another thread, another process, or another service. Or you cut the work into small pieces and give other users a turn between pieces.
**🏠 Real-life example:** A shop cashier should not also bake the bread. The baking is sent to the kitchen staff (worker threads) or to a bakery outside (another service). The cashier keeps serving customers.

1. **worker_threads** — real threads, each with its own V8 isolate. They talk using `postMessage`. They can share memory with `SharedArrayBuffer`. Use a pool (e.g. `piscina`).
2. **child_process** (`fork`/`spawn`) — a separate process. Good for running other binaries.
3. **Offload** to a job queue (BullMQ + Redis) and process it in separate worker services.
4. Break the work into chunks with `setImmediate` (cooperative yielding — giving the loop a turn between chunks).
5. Use native modules / a different service (Go/Rust) for hot paths (the most-used, slowest code).

**🔍 Internal working:**
1. `new Worker(file)` → C++ starts a new OS thread. Inside it, it creates a **new V8 isolate** (separate heap and GC), a **new libuv loop**, and a new Node environment. Then it runs `file`. Startup takes tens of milliseconds and several MB of memory. So you reuse workers through a pool.
2. `postMessage(data)` serializes `data` with V8's `ValueSerializer` (the structured clone algorithm). It puts it in the target port's queue (C++ `MessagePortData`). Then it calls `uv_async_send` to wake the other thread's event loop. That loop deserializes the data and emits `'message'`.
3. A **transfer list** moves an `ArrayBuffer` without copying. The sender's copy becomes detached (length 0). A `SharedArrayBuffer` shares the same memory in both isolates. Use `Atomics` (`wait`/`notify`, `add`) to synchronize.
4. A pool such as `piscina` keeps N workers and a task queue. It sends each task to an idle worker. It returns a promise that resolves when the worker replies.
5. `child_process.fork()` calls `uv_spawn` (fork + exec on Unix, `CreateProcess` on Windows). It opens an **IPC channel** (inter-process communication: a Unix domain socket or named pipe). Messages are JSON by default, or V8-serialized with `serialization: 'advanced'`.
6. Chunking with `setImmediate` works because each chunk returns control to the loop. So the poll phase can handle I/O between chunks. Chunking with `process.nextTick` does **not** yield, because ticks run before the loop moves on.

**🎤 Say this in the interview:** "A worker thread is a separate V8 isolate, with its own heap and its own libuv loop, on a new OS thread. postMessage structured-clones the data into a MessagePort queue and wakes the other loop with uv_async_send. Transferables or SharedArrayBuffer avoid the copy."

**🧪 Real scenario:** You moved Excel report generation into `worker_threads`. Now, when 50 officers export reports at the same time, memory jumps and the server crashes. What went wrong?

**✅ Scenario answer:**
1. **Root cause:** the code creates `new Worker()` for every request. Each worker is a new V8 isolate with its own heap and event loop, so it costs several MB and tens of ms to start. 50 at once means no limit on memory.
2. **Confirm:** memory graph rises with the number of parallel exports. Logs or `process.memoryUsage()` show the spike. The code has `new Worker` inside the route handler.
3. **Fix:** use a fixed-size pool, so extra tasks wait in a queue.
   ```js
   const pool = new Piscina({ filename: './excel-worker.js', maxThreads: 4 });
   const file = await pool.run({ filters });
   ```
4. For very big reports, use a BullMQ job and notify the user when the file is ready.
5. **Prevent:** never create workers per request. Load-test with many users exporting at the same time.

---

### Q5. `cluster` module vs worker_threads vs PM2.
**🟢 In simple words:** `cluster` starts several copies of your server as separate processes, so you can use all CPU cores. `worker_threads` are extra threads inside one process, used for heavy calculations. PM2 is a tool that starts, watches and restarts your processes for you.
**🏠 Real-life example:** `cluster` is opening several billing counters in a supermarket, with a manager sending each customer to a free counter. `worker_threads` is one counter getting a helper for heavy work. PM2 is the store manager who replaces a cashier who falls sick.

- **cluster:** forks N **processes** (one per CPU core) that share the server port. The primary distributes connections (round-robin by default on all platforms except Windows). Each process has separate memory → state must live outside (Redis/DB). Use it to scale HTTP across cores.
- **worker_threads:** threads within ONE process, for CPU tasks.
- **PM2:** a process manager. It uses cluster mode, plus restarts, logs, and zero-downtime reload. In Kubernetes you usually run **1 process per container** and scale with replicas instead.

**🔍 Internal working:**
1. `cluster.fork()` is `child_process.fork()` of the same script, with an environment variable (`NODE_UNIQUE_ID`). That variable decides `cluster.isPrimary` / `isWorker`. It also creates the IPC channel between primary and worker.
2. In a worker, `server.listen(3000)` does **not** bind the port. Instead, the cluster code sends an internal `queryServer` message to the primary over IPC.
3. **`SCHED_RR`** (the default everywhere except Windows): the primary creates a `RoundRobinHandle`. It binds and listens on the port itself. It **accepts** each connection. Then it sends the accepted socket handle to the next free worker over IPC (on Unix the fd is passed with `sendmsg` + `SCM_RIGHTS`). The worker wraps that fd in a `net.Socket`.
4. **`SCHED_NONE`** (the Windows default): the primary shares the *listening* handle with all workers. Each worker calls `accept()` itself. The OS decides who wins, and this is often unbalanced.
5. Every worker is a full process with its own V8 heap and event loop. The primary listens for `'exit'` and can fork a replacement. You choose the policy with `cluster.schedulingPolicy` or `NODE_CLUSTER_SCHED_POLICY`.
6. PM2 cluster mode uses Node's `cluster` module. `pm2 reload` restarts workers one by one. It waits for the new worker to be listening (or to send `process.send('ready')` with `wait_ready`). Only then does it stop the old one.

```text
            client connections
                   │
          ┌────────▼────────┐  accept()
          │ primary (RR)    │──────────────┐
          └──┬──────┬───────┘   IPC: send socket fd
             ▼      ▼       ▼
          worker1 worker2 worker3  (own V8 heap + own event loop)
```

**🎤 Say this in the interview:** "With cluster, workers do not really bind the port. They ask the primary over IPC. In the default round-robin mode, the primary accepts every connection and passes the socket fd to a worker. worker_threads are different: they are isolates inside one process, used for CPU work."

**🧪 Real scenario:** You moved the app from 1 process to PM2 cluster mode with 4 instances. Now users are randomly logged out, OTP checks fail, and the daily reminder cron job sends every email 4 times. Why?

**✅ Scenario answer:**
1. **Root cause:** each cluster worker is a separate process with its own memory. Sessions and OTPs stored in memory exist only in one worker. The next request may go to another worker. Also, the cron code runs in all 4 processes.
2. **Confirm:** log `process.pid` with each request. You see the OTP was saved in one pid and checked in another. Cron logs show 4 runs at the same time.
3. **Fix:** keep shared state in Redis (sessions with `connect-redis`, OTP with a TTL). Run cron in only one place, e.g. a separate worker service, or only when `process.env.NODE_APP_INSTANCE === '0'` in PM2.
4. **Prevent:** design the app to be stateless from day one. This also makes Kubernetes scaling easy.

---

### Q6. Explain streams. Why are they important? What is backpressure?
**🟢 In simple words:** A stream handles data in small pieces instead of loading everything into memory at once. This keeps memory low even for very big files. Backpressure means: if the receiver is slower than the sender, the sender pauses until the receiver catches up.
**🏠 Real-life example:** A water pipe filling a bucket. You do not pour the whole tank at once; water flows bit by bit. If the bucket's small drain is slow, you close the tap a little until the water level goes down. That is backpressure.

Streams process data **piece by piece** instead of loading everything in memory. Types: **Readable, Writable, Duplex** (socket), **Transform** (zlib, crypto).
Example: serving a 2GB file with `fs.readFile` uses 2GB of RAM. With `createReadStream().pipe(res)` it uses ~64KB chunks.

**Backpressure** (telling the fast sender to slow down): when the consumer is slower than the producer, `writable.write()` returns `false`. The producer should then pause until the `'drain'` event. `pipe()` and `stream.pipeline()` handle this automatically. **Always prefer `pipeline`** — it also passes errors along and cleans up:
```js
const { pipeline } = require('node:stream/promises');
await pipeline(fs.createReadStream('in.csv'), zlib.createGzip(), fs.createWriteStream('in.csv.gz'));
```

**🔍 Internal working:**
1. Every Readable has a `_readableState`. It holds an internal buffer (a linked list of chunks), its current `length`, and a `highWaterMark` (the buffer size limit). The generic default was 16 KiB (16 objects in objectMode). **Node 22 raised the byte default to 64 KiB**. `fs.createReadStream` has always used 64 KiB.
2. The stream calls your `_read()` to get data, and `_read()` calls `push(chunk)`. `push()` returns `false` once `length >= highWaterMark`, so the source stops producing. For `fs` streams, each `_read()` is a `uv_fs_read` on the libuv threadpool.
3. `readable.readableFlowing` has three states:
   - `null` — no consumer yet.
   - `true` — flowing: a `'data'` listener, `pipe()` or `resume()`.
   - `false` — paused with `pause()` or `unpipe()`.
   Adding a `'data'` listener switches a `null` stream to flowing.
4. Writable: `write(chunk)` adds to the writable buffer and returns `length < highWaterMark`. When it returns `false`, the stream sets `needDrain`. When the buffer is empty again, it emits `'drain'`.
5. `pipe()`: on each `'data'` it calls `dest.write(chunk)`. If that returns `false`, it calls `src.pause()`. On `dest`'s `'drain'`, it calls `src.resume()`. For TCP sockets, pausing calls `uv_read_stop`. Then the kernel receive buffer fills, the TCP window shrinks, and the remote sender slows down. This is real network backpressure.
6. `pipeline()` attaches `finished()` (end-of-stream) to every stream. On the first error it destroys **all** streams (closing fds). It calls the callback (or rejects the promise) exactly once. `pipe()` alone does not do this.

```text
 fs.read (threadpool) ─► [Readable buffer ≤ hwm] ─► gzip ─► [Writable buffer ≤ hwm] ─► disk
                                   ▲                                   │
                                   └──── pause() / resume() on 'drain' ┘
```

**🎤 Say this in the interview:** "Each stream keeps an internal buffer limited by highWaterMark. push() and write() return false when it is full. pipe and pipeline turn that signal into pause, and resume on 'drain'. On sockets this goes down to uv_read_stop, so TCP flow control slows the real sender."

**🧪 Real scenario:** A "Export all applicants to CSV" feature works fine in dev. In production, with 5 lakh records, the pod is OOMKilled every time someone clicks export. How do you fix it?

**✅ Scenario answer:**
1. **Root cause:** the code loads all rows with one `findAll()`, builds one big CSV string, and then sends it. All of it sits in memory at the same time.
2. **Confirm:** the memory graph shows a big spike on export. A heap snapshot shows huge arrays of row objects and a big string.
3. **Fix:** stream it. Read rows from the DB in a stream or in batches, convert each row to a CSV line with a Transform stream, and send it with `pipeline`. Backpressure keeps memory flat even if the user's network is slow.
   ```js
   res.setHeader('Content-Type', 'text/csv');
   await pipeline(dbRowStream, toCsvTransform, res);
   ```
4. **Prevent:** add a rule in code review: no unbounded `findAll()` for lists or exports. Use pagination or streams.

---

### Q7. How do you find and fix a memory leak in a production Node app?
**🟢 In simple words:** A memory leak means your app keeps holding objects it no longer needs, so memory keeps growing until the app crashes. The garbage collector cannot free them because something still points to them. You find the leak by taking memory snapshots at different times and seeing which objects keep growing, and who is holding them.
**🏠 Real-life example:** A library where people borrow books but never return them. The shelves get emptier every day. To fix it, you check the register to see who is holding the books, and you make them return them.

1. **Detect:** RSS/heap keeps growing in monitoring (Prometheus/Grafana, Datadog), or you see OOM (out of memory) restarts.
2. **Reproduce:** load-test with `autocannon`/`k6`.
3. **Capture:** `node --inspect` + Chrome DevTools. Take **heap snapshots** at intervals and compare them. Look for growing object counts and their retainers (the objects holding them). Or use `--heapsnapshot-signal=SIGUSR2` or `clinic heapprofiler`.
4. **Common causes:** unbounded caches/Maps (use an LRU with TTL), listeners not removed (`MaxListenersExceededWarning`), global arrays, closures in timers, unresolved promises piling up, not consuming response bodies.
5. **Fix + guard:** bounded caches, `--max-old-space-size`, alerting on heap usage.

**🔍 Internal working:**
1. The V8 heap is split into spaces:
   - **new space** (young generation): small, two semi-spaces, cleaned by the fast *Scavenger*, which copies live objects.
   - **old space**: objects that survived two scavenges are promoted here. It is cleaned by **Mark-Sweep-Compact**, with concurrent/incremental marking.
   - **large object space**, and **code space**.
2. `Buffer` and `ArrayBuffer` data lives **outside** the V8 heap. It appears in `process.memoryUsage().external` / `arrayBuffers` and in RSS, not in `heapUsed`. So "RSS grows but heap is flat" points to buffers or native memory.
3. The GC frees only objects that are **unreachable** from roots (globals, the stack, handles). A leak is an object that is still reachable through a reference you forgot. Examples: a module-level `Map`, a listener array on a long-lived emitter, or a closure context captured by a timer.
4. Taking a heap snapshot: V8's HeapProfiler **pauses the JS thread**. It walks the whole object graph and writes nodes and edges to a `.heapsnapshot` file. This can take seconds. It may need about as much extra memory as the heap itself. So do it on one instance that is taken out of traffic. You can also call `v8.writeHeapSnapshot()` from code.
5. DevTools builds a **dominator tree** to compute *retained size* (how much memory would be freed if this object were gone). The "Comparison" view shows which constructors grew between snapshots. The "Retainers" panel shows the reference chain that keeps them alive.
6. `--max-old-space-size` sets the old-space limit (in MB). If the heap is still full after last-resort full GCs, V8 aborts with "JavaScript heap out of memory". Set it below the container memory limit. Leave room for buffers and native memory.

**🎤 Say this in the interview:** "V8's generational GC only frees unreachable objects, so a leak is always an unexpected retainer. I compare heap snapshots and follow the retainer chain in the dominator tree. I also check process.memoryUsage().external, because Buffers live outside the V8 heap."

**🧪 Real scenario:** The API's memory grows by about 100 MB every day. Every 3 days the pod restarts with "JavaScript heap out of memory". There are no errors in the logs. How do you find and fix it?

**✅ Scenario answer:**
1. **What is happening:** something keeps a reference to objects that should be freed, so the GC cannot remove them. A common cause is an in-memory cache `Map` that only grows.
2. **Confirm:** check if `heapUsed` grows (JS objects) or only RSS/`external` grows (Buffers). Take a heap snapshot on one instance taken out of traffic (`--heapsnapshot-signal=SIGUSR2`), wait some hours, take another. In the Comparison view, find the object type that keeps growing and follow its Retainers chain.
3. **Fix:** if it is a cache, give it a size limit and a TTL.
   ```js
   const { LRUCache } = require('lru-cache');
   const cache = new LRUCache({ max: 5000, ttl: 10 * 60 * 1000 });
   ```
4. **Prevent:** alert on heap usage growth, and in code review ask "who removes this?" for every module-level Map, array, or listener.

---

### Q8. Error handling best practices in Node/Express.
**🟢 In simple words:** There are two kinds of errors. Expected problems, like bad user input or a database being down, should be handled and answered with a proper HTTP status code. Real bugs in your code should be logged, and then the app should restart cleanly. Keep all error handling in one central place and never show internal details to users.
**🏠 Real-life example:** In a restaurant, "this dish is sold out" is an expected problem: the waiter politely tells you. A fire in the kitchen is a real failure: everyone leaves safely, and the restaurant opens again after a check.

- **Operational errors** (DB down, invalid input) → handle them and return proper status codes. **Programmer errors** (bugs) → log, then crash and let the orchestrator (Docker/Kubernetes/PM2) restart.
- Use custom error classes (`AppError` with `statusCode`, `isOperational`).
- Express: use one central error middleware `(err, req, res, next)`. Express 4 doesn't catch async errors → wrap handlers, or use Express 5 (which handles rejected promises).
- `process.on('unhandledRejection')` / `'uncaughtException'` → log, then **graceful shutdown**. Do not continue.
- Never leak stack traces to clients in production.

**🔍 Internal working:**
1. Express 4: `Layer.handle_request` calls your handler inside a `try/catch`. So a **synchronous** `throw` becomes `next(err)`. An `async` handler returns a rejected promise. Express 4 ignores the return value, so the error becomes an unhandled rejection.
2. Express 5 (which uses `router` v2) checks if the handler's return value is a promise. If yes, it attaches `.then(undefined, next)`. So rejections reach your error middleware.
3. After `next(err)`, the router skips normal middleware. It calls only layers whose function has **4 parameters** (`fn.length === 4`). That is why the error handler must declare `(err, req, res, next)`, even if you do not use `next`.
4. If no error handler responds, Express's `finalhandler` sends a 500. It includes the stack trace only when `NODE_ENV` is not `production`.
5. `unhandledRejection`: V8 calls Node's `PromiseRejectCallback` when a promise is rejected with no handler. Node remembers it. After the microtask queue is empty, `processPromiseRejections()` emits `'unhandledRejection'`. Since **Node 15** the default mode is `--unhandled-rejections=throw`. With no listener, it becomes an uncaught exception and the process exits.
6. `uncaughtException`: an exception that reaches the top of a callback goes through C++ `TriggerUncaughtException` to `process._fatalException`. That emits `'uncaughtException'`. With no listener, Node prints the stack and exits with code 1. After this, your app state may be half-updated. So log, shut down gracefully, and let the orchestrator restart the process.

**🎤 Say this in the interview:** "Express 4 only wraps handlers in a synchronous try/catch. Express 5 attaches .then(undefined, next) to returned promises. The router finds error handlers by function arity 4. At process level, since Node 15 an unhandled rejection is thrown as an uncaught exception. So I log and restart instead of continuing."

**🧪 Real scenario:** In production, one bad request to an `async` route makes the whole Node process crash. For a few seconds all users get 502 errors. The app uses Express 4. Why, and what do you change?

**✅ Scenario answer:**
1. **Root cause:** Express 4 does not catch errors from `async` handlers. The rejected promise becomes an unhandled rejection. Since Node 15, this crashes the process by default.
2. **Confirm:** logs show an unhandled rejection stack and exit code 1. The route is `async` and has no try/catch.
3. **Fix:** wrap async handlers so errors go to `next()`, or upgrade to Express 5, which does this itself.
   ```js
   const asyncHandler = fn => (req, res, next) =>
     Promise.resolve(fn(req, res, next)).catch(next);
   router.get('/applications/:id', asyncHandler(getApplication));
   ```
4. Keep the central error middleware, so the user gets a clean 400/500 JSON and not a crash.
5. **Prevent:** run more than one instance so one crash is not visible to users, add a lint rule for async handlers, and write a test that sends bad input.

---

### Q9. Implement graceful shutdown.
**🟢 In simple words:** Graceful shutdown means stopping the app politely. First stop taking new requests, then finish the requests already running, then close database and Redis connections, and only then exit. Also keep a backup timer that force-exits if cleanup takes too long.
**🏠 Real-life example:** A shop closing at night. The guard closes the door so no new customers come in. The customers already inside finish shopping and pay. Then the staff switch off the lights and lock up.

```js
const server = app.listen(3000);
async function shutdown(signal) {
  console.log(`${signal} received`);
  server.close(async () => {          // stop accepting new connections, finish in-flight ones
    await sequelize.close();          // close DB pool
    await redis.quit();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref(); // force exit
}
['SIGTERM', 'SIGINT'].forEach(s => process.on(s, () => shutdown(s)));
```
This matters in Docker/K8s: they send `SIGTERM` before `SIGKILL`. Also fail the readiness probe first, so the load balancer stops sending traffic.

**🔍 Internal working:**
1. `process.on('SIGTERM', …)` makes Node create a libuv `uv_signal_t` handle. libuv installs the real OS signal handler. That handler only writes the signal number to an internal pipe. This is the "self-pipe trick", because very little is safe to do inside a signal handler. The poll phase sees the pipe is readable and calls your JS listener on the main thread.
2. Adding a listener **replaces** the default action (terminate). `SIGKILL` and `SIGSTOP` can never be caught. On Windows, `SIGINT` (Ctrl+C) and `SIGBREAK` work, but other processes cannot really send `SIGTERM`.
3. `server.close()` closes the listening handle, so no new connections are accepted. Its callback fires only after all existing connections have ended. Idle keep-alive sockets used to keep the server open. Since **Node 19**, `close()` also closes idle connections. On Node 18.2+ you can call `server.closeIdleConnections()` or `server.closeAllConnections()` yourself.
4. `.unref()` on the force-exit timer removes it from the loop's count of active handles. So the timer alone does not keep the process alive. If cleanup finishes first, the process can exit normally.
5. `process.exit()` runs `'exit'` listeners synchronously and then exits at once. Pending async work can be lost, for example log lines still being written to a pipe. When possible, it is safer to set `process.exitCode` and let the loop become empty.
6. Containers: if Node runs as **PID 1**, the kernel does not apply default signal actions to it. So without a handler, `SIGTERM` is ignored. Kubernetes then kills the pod with `SIGKILL` after the grace period (30 s by default). Use the exec form `CMD ["node", "server.js"]`, because a shell or npm wrapper may not forward signals reliably. Or use an init process like `tini` / `docker run --init`.

**🎤 Say this in the interview:** "libuv turns SIGTERM into a normal event through a self-pipe, so my handler runs on the main thread. server.close() stops accepting and waits for in-flight requests. Node 19+ also closes idle keep-alive sockets. An unref'd timer forces exit before Kubernetes sends SIGKILL."

**🧪 Real scenario:** Every time you deploy on Kubernetes, some users get 502 errors and a few form submissions are lost. How do you fix it?

**✅ Scenario answer:**
1. **Root cause:** the app is killed while requests are still running. Often the container starts with `npm start`, so the `SIGTERM` does not reach Node reliably. Or Node has no `SIGTERM` handler, so it never closes cleanly and gets `SIGKILL` later.
2. **Confirm:** logs have no "SIGTERM received" line on deploy. The Dockerfile uses `CMD npm start`. 502s appear only during rollout.
3. **Fix:** use `CMD ["node", "server.js"]` (or `tini`). Add a `SIGTERM` handler: fail the readiness probe, wait a few seconds so the load balancer stops sending traffic, then `server.close()`, close DB/Redis, and exit. Keep the force-exit timer below `terminationGracePeriodSeconds`.
4. **Prevent:** test a rolling deploy while a load test is running, and check that there are zero errors.

---

### Q10. How do you secure a Node.js API?
**🟢 In simple words:** Security is many small locks, not one big lock. Check every input, use safe database queries, add security headers, limit how many requests one user can send, and store passwords and secrets safely. In Node, also be careful about anything that can block the single thread, like a bad regex.
**🏠 Real-life example:** An apartment building: a guard checks ID at the gate (auth), bags are scanned (input validation), each flat has its own key (permissions), and there is a limit on visitors per day (rate limiting).

- Validate input (Joi/Zod/celebrate). Use parameterized queries/ORM (this prevents SQL injection).
- `helmet` for security headers, strict CORS config, rate limiting (`express-rate-limit` + Redis store).
- Auth: a short-lived JWT access token + a refresh token in an httpOnly, secure, SameSite cookie. Rotate refresh tokens.
- Hash passwords with bcrypt/argon2. Keep secrets in env/secret manager, never in git.
- `npm audit`, Dependabot/Snyk, lockfiles, avoid `eval`.
- Limit body size. Guard against ReDoS (bad regex), prototype pollution, and path traversal.
- Log and monitor; use HTTPS everywhere.

**🔍 Internal working:**
1. `helmet` is normal middleware. It calls `res.setHeader()` for headers such as `Content-Security-Policy`, `Strict-Transport-Security` and `X-Content-Type-Options`, before your routes run. The browser enforces them. The server does nothing else.
2. Body size limit: `express.json()` (body-parser → `raw-body`) first checks `Content-Length`. Then it counts bytes while the body streams in. It stops with **413** as soon as the limit (default `100kb`) is passed. The large body is never fully held in memory.
3. bcrypt/argon2 (native addons), and async `crypto.scrypt` / `crypto.pbkdf2`, run the hashing on the **libuv threadpool**. So the main thread stays free. They share the default 4 threads with fs and `dns.lookup`. The `*Sync` versions block the event loop.
4. ReDoS (Regular expression Denial of Service): V8's regex engine (Irregexp) uses **backtracking**. A pattern like `/(a+)+$/` on a crafted input takes exponential time on the main thread. This blocks every request.
5. Prototype pollution: a naive deep merge of user JSON that contains a `__proto__` key writes into `Object.prototype`. Then the property appears on **every** object. Defenses: schema validation, `Object.create(null)` or `Map` for lookups, and the `--disable-proto=delete` flag.
6. Parameterized queries: the driver sends the SQL text and the values separately (PostgreSQL extended query protocol, MySQL prepared statements). So values are never parsed as SQL. Note: in `mysql2`, `query()` with `?` escapes on the client side. `execute()` uses real server-side prepared statements.

**🎤 Say this in the interview:** "Most of these protections are mechanical. helmet only sets headers. body-parser counts bytes and stops at the limit with 413. Password hashing runs on the libuv threadpool. The Node-specific risks are things that block the single thread, like ReDoS on V8's backtracking regex engine, and prototype pollution through __proto__."

**🧪 Real scenario:** A security audit of your government portal reports that sending a special long string to the search API makes the whole server stop responding for 30 seconds. What is it and how do you fix it?

**✅ Scenario answer:**
1. **Root cause:** ReDoS. A regex with nested quantifiers (like `/(\w+\s?)+$/`) backtracks for a very long time on crafted input. It runs on the main thread, so every request is blocked.
2. **Confirm:** reproduce with the audit's input. Event-loop lag jumps to many seconds. A CPU profile shows the time inside the regex.
3. **Fix:** rewrite the regex without nested `+`/`*`. Limit input length in validation (e.g. Joi/Zod `max(100)`) before any regex runs. For complex user patterns, use a linear-time engine like `re2`.
4. **Prevent:** add `eslint-plugin-security` or a safe-regex check in CI, and always put a max length on text inputs.

---

### Q11. JWT — how does it work? Pros and cons? How do you revoke one?
**🟢 In simple words:** A JWT is a small signed note that says "this is user X, valid until time Y". The server signs it, so any service can check it is real without asking the database. The problem is that once given, you cannot easily cancel it before it expires, so you keep its life short.
**🏠 Real-life example:** A cinema ticket with a hologram stamp. Any gate staff can check the stamp without calling the box office. But if you want to cancel a ticket already sold, every gate needs a "cancelled tickets" list.

A JWT = `header.payload.signature` (base64url). The server signs it (HS256 secret or RS256 private key). Any service can verify it without a DB lookup → **stateless**.
**Cons:** you can't revoke it before expiry. The payload is readable (not encrypted). It's large.
**Revocation strategies:**
- A short access-token TTL (5–15 min) + refresh tokens stored in the DB (revocable).
- A token blacklist in Redis, keyed by `jti`, until expiry.
- A `tokenVersion` on the user that you bump (increase) on logout/password change.

**🔍 Internal working:**
1. **Sign:** build the header `{"alg":"HS256","typ":"JWT"}` and the payload. The library adds `iat`, and `exp` from `expiresIn`. Base64url-encode both and join them: `signingInput = header + "." + payload`.
2. Compute the signature over `signingInput`:
   - **HS256** = HMAC-SHA256 with a shared secret.
   - **RS256** = RSA (PKCS#1 v1.5) signature of the SHA-256 hash, with the **private** key.
   - **ES256** = ECDSA.
   Base64url the result and add it as the third part. In Node, `jsonwebtoken` uses the `crypto` module (OpenSSL), and this runs on the main thread.
3. **Verify:** split on `.`, decode the header, and check that `alg` is in your allowed `algorithms` list. This blocks `alg: "none"`. It also blocks the RS256 → HS256 "algorithm confusion" attack, where the public key is used as an HMAC secret.
4. Recompute the HMAC (compare in **constant time** to avoid timing attacks). Or verify the RSA/ECDSA signature with the **public** key. Only after that, parse the payload and check `exp` and `nbf` (with `clockTolerance`), plus `aud` and `iss` if configured.
5. With RS256, other services get the public key from a **JWKS** endpoint. They pick the right key by the `kid` header and cache it. This makes key rotation possible without sharing a secret.
6. The payload is only base64url, not encrypted: anyone can decode it. For encryption you need JWE. A `jti` blacklist adds back one fast Redis lookup per request. But the set stays small, because each entry's TTL equals the token's remaining lifetime.

**🎤 Say this in the interview:** "A JWT is a base64url header and payload, plus a signature over 'header.payload'. It is HMAC for HS256, or an RSA signature with the private key for RS256. Verification must pin the allowed algorithms and check the signature (in constant time for HMAC). Only then can I trust exp, aud and iss."

**🧪 Real scenario:** An admin officer's laptop was stolen. Management asks you to log him out of all devices right now. Your app uses JWT access tokens that are valid for 24 hours. What do you do?

**✅ Scenario answer:**
1. **Problem:** a JWT stays valid until `exp`. You cannot "delete" it on the server.
2. **Immediate fix:** increase a `tokenVersion` on that user and put it in new tokens. In the auth middleware, compare the token's version with the current one (cache it in Redis to keep it fast). Old tokens fail at once. Also delete all his refresh tokens from the DB.
   ```js
   if (payload.tv !== await getTokenVersion(payload.sub))
     return res.status(401).json({ message: 'Session expired' });
   ```
3. If the signing secret itself may be leaked, rotate the secret. Note: this logs out everyone.
4. **Prevent:** use short access tokens (5–15 min) with rotating refresh tokens stored in the DB, so revoking access is easy and fast.

---

### Q12. Express middleware — how does it work? Write an auth middleware.
**🟢 In simple words:** Middleware are small functions that a request passes through, one after another, in the order you added them. Each one can change the request, send a reply, or call `next()` to pass it on. An auth middleware checks the token and either stops the request or lets it continue.
**🏠 Real-life example:** Airport security. You pass the ticket check, then the ID check, then the bag scan, then boarding. Any checkpoint can stop you. If all say "OK", you reach the plane (the route handler).

Middleware are functions `(req, res, next)` that run in order. Each can change req/res, end the response, or call `next()`. `next(err)` jumps to the error handlers.
```js
const authorize = (...roles) => (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    if (roles.length && !roles.includes(req.user.role))
      return res.status(403).json({ message: 'Forbidden' });
    next();
  } catch { return res.status(401).json({ message: 'Invalid token' }); }
};
router.get('/admin', authorize('admin'), handler);
```

**🔍 Internal working:**
1. `app.use()` and `router.get()` push **Layer** objects onto `router.stack`. Each Layer has a path matcher (compiled by `path-to-regexp`) and a handle function. `router.get()` creates a Layer that points to a **Route**. The Route has its own stack of handlers per HTTP method.
2. A request arrives: the `http` server emits `'request'` → `app.handle(req, res)` → `router.handle()`. This creates a closure `next()` with an index that starts at 0.
3. Each call to `next()` moves the index forward to the first Layer whose path matches (and, for a Route, whose method matches). Then it calls `layer.handle_request(req, res, next)`. So **registration order is execution order**. A middleware that neither responds nor calls `next()` leaves the request hanging.
4. `next(err)` → only 4-argument layers are called. `next('route')` skips the remaining handlers of the current route. `next('router')` leaves the current router.
5. Mounted routers (`app.use('/api', router)`) remove the mount path from `req.url` and save it in `req.baseUrl`. They restore it when the router is done.
6. If the stack ends and nobody responded, `finalhandler` sends a 404. In the example, `authorize('admin')` is a factory: the closure captures `roles` once at startup. `jwt.verify` (HMAC) runs synchronously on the main thread.

```text
router.stack: [ Layer(json) → Layer(cors) → Layer('/admin' → Route{ GET: [authorize, handler] }) → Layer(errorHandler, 4 args) ]
                   next() ───────► next() ───────► next() ... next(err) jumps to 4-arg layers
```

**🎤 Say this in the interview:** "Express keeps a stack of Layer objects, each with a compiled path regexp. next() is a closure that moves an index to the next matching layer. Middleware order is registration order. next(err) skips everything except 4-argument error handlers."

**🧪 Real scenario:** In a code review you find that `/api/reports/export` returns data even without a login token. The auth middleware exists and works on other routes. How can this happen, and how do you fix it?

**✅ Scenario answer:**
1. **Root cause:** Express runs middleware in registration order. The reports router was mounted **before** `app.use(authenticate)`, so the request matched and was answered before auth ran. Another common cause: auth calls `next()` inside `catch` by mistake.
2. **Confirm:** call the route without a token from Postman or a Supertest test. Check the order of `app.use(...)` lines in `app.js`.
3. **Fix:** apply auth at the router level, so every route inside is protected by default.
   ```js
   const reports = express.Router();
   reports.use(authenticate, authorize('admin'));
   reports.get('/export', exportReport);
   app.use('/api/reports', reports);
   ```
4. **Prevent:** write one integration test that calls every protected route with no token and expects 401. Use "deny by default", and list public routes explicitly.

---

### Q13. How would you implement rate limiting?
**🟢 In simple words:** Rate limiting means each user can only make a fixed number of requests in a time period. Extra requests get a "429 Too Many Requests" reply. When you have many servers, the counters must live in one shared place like Redis, and be updated safely.
**🏠 Real-life example:** A water tap with a token bucket: you get 10 tokens, and one new token drops in every minute. Each glass of water costs one token. If the bucket is empty, you wait.

Algorithms:
- **fixed window** — simple, but allows bursts at the window edges.
- **sliding window log/counter** — accurate.
- **token bucket** — allows bursts, refills smoothly. Most common.
- **leaky bucket** — constant output rate.

For a distributed setup, store counters in **Redis** (`INCR` + `EXPIRE`, or a Lua script for atomicity). Return `429 Too Many Requests` with a `Retry-After` header. Limit per user/API key/IP. Also limit at the API gateway or Nginx level.

**🔍 Internal working:**
1. Redis runs commands on a single thread, so one `INCR` is atomic. But `INCR` followed by `EXPIRE` is two commands. If the app crashes between them, the key never expires. Use `MULTI`, a Lua script, or set the TTL atomically on the first request.
2. A Lua script (`EVAL` / `EVALSHA`) runs **atomically** in Redis. No other command runs in the middle. This is how you do "read, compute, write" safely across many Node instances.
3. Token bucket inside Lua: store `tokens` and `lastRefill`. On each request: `tokens = min(capacity, tokens + (now - lastRefill) * rate)`. If `tokens >= 1`, subtract 1 and allow. Otherwise reject and compute `Retry-After`.
4. Sliding window log: `ZADD key now now`, `ZREMRANGEBYSCORE key 0 now-window`, `ZCARD key`. It is exact, but stores one entry per request. A sliding window *counter* only keeps two counters (current and previous window). It gives the previous one a weight.
5. `express-rate-limit`: a `keyGenerator` (default `req.ip`) → `store.increment(key)` → set the `RateLimit-*` headers → `next()` or 429. Behind a load balancer you must set `app.set('trust proxy', …)`. Otherwise `req.ip` is the LB's IP, and all users share one bucket.
6. Nginx `limit_req` uses a leaky-bucket algorithm, with counters in a shared-memory zone. So requests are rejected before they reach Node.

**🎤 Say this in the interview:** "For distributed rate limiting I keep the bucket state in Redis and update it with a Lua script. Redis runs the script atomically, so many Node instances cannot race on the same counter. I also make sure req.ip is correct behind the proxy."

**🧪 Real scenario:** You added `express-rate-limit` with 100 requests per 15 minutes. After go-live behind Nginx, at 10 AM when offices open, almost all users start getting 429 errors. Why?

**✅ Scenario answer:**
1. **Root cause:** `trust proxy` is not set. So `req.ip` is Nginx's IP for every request, and all users share one bucket. Also, many government offices use one public IP for all staff.
2. **Confirm:** log `req.ip` and the `X-Forwarded-For` header. All requests show the same IP.
3. **Fix:** set `app.set('trust proxy', 1)` (one proxy hop). For logged-in users, use the user ID as the key instead of the IP. With many instances, use a Redis store so limits are shared.
   ```js
   rateLimit({ windowMs: 15 * 60 * 1000, limit: 300,
     keyGenerator: req => req.user?.id ?? req.ip });
   ```
4. **Prevent:** test rate limits behind the real proxy in staging, and watch the count of 429 responses on a dashboard.

---

### Q14. How do you make an API idempotent?
**🟢 In simple words:** Idempotent means: if the same request is sent twice, the result is the same as sending it once. For example, a payment should not be charged twice if the user clicks "Pay" twice or the network retries. The client sends a unique key, and the server remembers the answer for that key.
**🏠 Real-life example:** A courier receipt number. If you go to the counter twice with the same receipt, the clerk says "this parcel is already booked, here is your old receipt". He does not book it again.

GET/PUT/DELETE are idempotent by definition; POST is not. For payments/orders:
- The client sends an `Idempotency-Key` header.
- The server stores key + response (Redis/DB with a unique constraint).
- Retries get the stored response. The work is not run again.

Also use DB unique constraints and upserts.

**🔍 Internal working:**
1. Middleware reads `Idempotency-Key` and tries to **claim** it atomically. Either `SET idem:{key} "in_progress" NX EX 86400` in Redis, or an `INSERT` into an `idempotency_keys` table that has a unique index on the key. Only one concurrent request can win.
2. If the claim fails, look at the stored record:
   - `completed` → return the saved status code and body, without running the handler again.
   - `in_progress` → return 409 (or wait and poll).
3. Save a **fingerprint** of the request (a hash of method + path + body) with the key. If the same key arrives with a different body, return 422. That is a client bug, not a retry.
4. Capture the response by wrapping `res.json` / `res.send`. Store the status and body, and mark the key `completed`. On a 5xx or a crash, delete the key (or let it expire), so the client can retry.
5. Strongest version: write the idempotency record in the **same DB transaction** as the business change (the order or payment row). Then a crash cannot leave "payment done, key not saved".
6. Upserts (`INSERT … ON CONFLICT DO NOTHING/UPDATE`) depend on the unique index. The database does the "does it exist?" check and the write as one atomic step. This avoids the race of "SELECT first, then INSERT".

**🎤 Say this in the interview:** "The first request atomically claims the idempotency key with SET NX or a unique index. It stores a fingerprint and saves the final response. A retry with the same key gets the stored response. A different body with the same key is rejected."

**🧪 Real scenario:** Applicants complain that the exam fee was charged twice. Logs show two payment requests for the same application within one second. How do you fix this?

**✅ Scenario answer:**
1. **Root cause:** a double-click, or the browser/network retried the POST. The server treated both as new payments.
2. **Confirm:** logs show the same application ID and user, two requests close together, and two payment orders created.
3. **Fix (server):** the frontend creates one `Idempotency-Key` per payment attempt. The server claims it with `SET key NX` in Redis, or a DB unique index. The second request gets the first response. Also add a unique constraint in the DB, e.g. only one successful payment per application.
4. **Fix (gateway callback):** handle the payment gateway's webhook idempotently too, using its transaction ID as a unique key, because gateways can send the same callback more than once.
5. **Prevent:** disable the Pay button after the first click, and add a test that sends two requests in parallel and expects only one payment.

---

### Q15. How do you scale a Node.js application to handle 10x traffic?
**🟢 In simple words:** First measure to find what is actually slow. Then run many copies of the app behind a load balancer, cache common answers, make the database faster, and push slow work to background queues. Watch the database connection count, because more app copies means more connections.
**🏠 Real-life example:** A restaurant getting 10 times more customers. You open more counters (more instances), keep popular dishes ready (cache), make the kitchen faster (database tuning), and do home deliveries from a separate kitchen (queues).

1. **Measure first:** use APM to find the bottleneck (CPU, DB, external calls).
2. **Horizontal scaling:** a stateless app (sessions in Redis/JWT), with multiple instances behind a load balancer / K8s HPA.
3. **Caching:** Redis (cache-aside), HTTP caching, CDN for static assets.
4. **Database:** indexes, query optimization, connection pooling, read replicas, partitioning.
5. **Async processing:** move heavy/slow work to queues (BullMQ/SQS/Kafka).
6. **Code:** avoid blocking the loop, use streams, compression, pagination.
7. Rate limiting and circuit breakers to protect downstream services.

**🔍 Internal working:**
1. One Node process runs your JS on **one** main thread. So it uses about one CPU core for JS work (GC and the threadpool add a little more). To use N cores you need N processes: cluster workers or container replicas.
2. Saturation (being overloaded) shows up as **event-loop lag** before CPU reaches 100% on the dashboard. Callbacks wait in queues, so p99 latency rises. Event-loop delay is a better scaling signal than average CPU.
3. Kubernetes HPA checks metrics regularly (every 15 s by default). It computes `desired = ceil(current × currentMetric / targetMetric)`. New pods receive traffic only after their readiness probe passes.
4. Every process has its **own** DB connection pool. So total connections = replicas × pool size. Scaling pods 10x can go over the database's `max_connections`. A pooler such as PgBouncer or RDS Proxy sits in between to fix this.
5. Cache-aside: read Redis → on a miss, read the DB → write to Redis with a TTL. When a popular key expires, many requests can hit the DB at once (a "stampede"). Use request coalescing, a lock, or TTL jitter (random extra time).
6. Outgoing HTTP: reuse connections with keep-alive (`http.Agent({ keepAlive: true })`). This is the default for the global agent since **Node 19**. Then each call does not pay for a new TCP and TLS handshake. Set `maxSockets`, so a slow downstream cannot open unlimited sockets.

**🎤 Say this in the interview:** "One Node process uses about one core for JS. So I scale out with stateless replicas, and I watch event-loop lag as the saturation signal. After that, the usual hidden limit is replicas times pool size against the database's max connections."

**🧪 Real scenario:** Before result day you scaled the API from 3 to 30 pods. Instead of becoming faster, the API starts failing with "too many connections" errors from PostgreSQL. Why?

**✅ Scenario answer:**
1. **Root cause:** each pod has its own DB pool. 30 pods × pool size 20 = 600 connections, which is more than the DB's `max_connections`.
2. **Confirm:** count connections in `pg_stat_activity` and compare with `max_connections`. Errors start when the new pods come up.
3. **Fix:** reduce the pool size per pod. Put PgBouncer or RDS Proxy in front of the DB. Results are read-heavy, so cache them in Redis (or as static files on a CDN) so most requests never touch the DB.
4. Add a read replica for read-only queries if the DB CPU is still high.
5. **Prevent:** do capacity planning with the formula "replicas × pool size", and load-test before big days.

---

### Q16. What is the circuit breaker pattern?
**🟢 In simple words:** When a service you depend on keeps failing, you stop calling it for a while and return a fallback answer quickly. After some time, you try one test call. If it works, you go back to normal; if not, you wait again. This stops one broken service from slowing down everything.
**🏠 Real-life example:** The electric fuse/circuit breaker in your house. When there is a fault, it trips and cuts the power so the house does not burn. After the fault is fixed, you switch it on again.

It wraps calls to an unreliable dependency. States:
- **Closed** (normal) → after N failures → **Open** (fail fast, return a fallback).
- **Open** → after a timeout → **Half-open** (allow a test request).
- **Half-open**: success → closed, failure → open.

It prevents cascading failures (one failure causing many others) and thread/connection exhaustion. Library: `opossum`.

**🔍 Internal working:**
1. `new CircuitBreaker(asyncFn, options)` wraps your function. Every `breaker.fire(...args)` first checks the current state.
2. **Closed:** it calls `asyncFn` and races it against a timer (`timeout`, default 10 s in opossum). Each result (success, failure, timeout, reject) is counted in a **rolling window** split into buckets (`rollingCountTimeout` 10 s, `rollingCountBuckets` 10).
3. The breaker goes **Open** when two things are true: the failure percentage in the window is at least `errorThresholdPercentage` (default 50%), and enough calls were made (`volumeThreshold`). It then starts a `resetTimeout` timer (default 30 s).
4. **Open:** `fire()` rejects immediately or calls your `fallback`, without calling the dependency. This frees sockets and pool connections. It also gives the dependency time to recover.
5. When `resetTimeout` ends → **Half-open:** the next call is allowed through as a test. Success → Closed (counters reset). Failure → Open again.
6. A timeout only rejects the promise that the caller sees. The real request keeps running. To really stop it, pass an `AbortSignal` to the underlying call yourself. With several Node instances, each process has its **own** breaker state.

```text
 CLOSED ──(errors ≥ threshold)──► OPEN ──(resetTimeout)──► HALF-OPEN
   ▲                                ▲                         │
   └────────── success ─────────────┼──────── failure ────────┘
```

**🎤 Say this in the interview:** "A breaker like opossum counts successes and failures in a rolling window of buckets. When the failure percentage crosses the threshold, it opens and fails fast. After resetTimeout, it lets one test call through in half-open. The state is per process. A timeout does not cancel the real call unless I pass an AbortSignal."

**🧪 Real scenario:** Your registration flow calls a third-party SMS / identity-verification API. One day that API becomes very slow. Your whole registration page hangs, and open sockets and memory keep growing on your Node servers. How do you protect your app?

**✅ Scenario answer:**
1. **Root cause:** calls have no timeout, so every request waits for the slow API. Waiting requests pile up and hold sockets and memory.
2. **Confirm:** traces show most time spent in the external call. Your CPU and DB look normal.
3. **Fix:** add a timeout to every external call, and wrap it in a circuit breaker with a fallback.
   ```js
   const breaker = new CircuitBreaker(
     (data) => fetch(SMS_URL, { method: 'POST', body: JSON.stringify(data),
       signal: AbortSignal.timeout(3000) }),
     { timeout: 3000, errorThresholdPercentage: 50, resetTimeout: 30000 });
   breaker.fallback(data => smsQueue.add('retry', data)); // send later
   ```
4. The user sees "SMS will arrive shortly" instead of a hanging page.
5. **Prevent:** rule: no external call without a timeout. Put breaker state on a dashboard.

---

### Q17. EventEmitter — how does it work? Pitfalls?
**🟢 In simple words:** An EventEmitter lets one part of the code say "this happened" and other parts react to it. When you call `emit`, all listeners run immediately, one after another, on the same thread. Common mistakes: no listener for `'error'` (the app crashes), and adding listeners again and again without removing them (memory leak).
**🏠 Real-life example:** A school announcement speaker. The principal speaks once (emit), and every classroom that is tuned in (listeners) hears it, in order. If nobody is listening to a fire alarm, that is a big problem.

It is a synchronous pub/sub (publish/subscribe). `emit` calls listeners **synchronously**, in registration order. Many core modules extend it (streams, http server). Pitfalls:
- An `'error'` event without a listener **throws/crashes**.
- Listener leaks (going over the default max of 10 gives a warning).
- Exceptions in listeners go up to the code that called `emit`.

**🔍 Internal working:**
1. Listeners are stored in `this._events`, an object created with a `null` prototype. The key is the event name. The value is a **single function** when there is one listener (an optimization), or an **array** when there are more.
2. `on()` first emits `'newListener'` if anyone listens for it. Then it adds the listener at the end (`prependListener` adds it to the front). If the count goes over `maxListeners` (default 10, `EventEmitter.defaultMaxListeners`), it prints a `MaxListenersExceededWarning` once. It is only a warning, not an error.
3. `emit(type, ...args)`: if `type === 'error'` and there is no listener, it **throws** the error (or `ERR_UNHANDLED_ERROR` if the value is not an Error). Otherwise it takes the listeners, **copies the array**, and calls each one synchronously with `Reflect.apply`. Because of the copy, listeners added or removed during an emit do not change the current emit.
4. `once()` registers a wrapper function. The wrapper removes itself first, and then calls your listener.
5. There is no try/catch around listeners. So a throw stops the remaining listeners and goes to whoever called `emit()`. A rejected promise from an `async` listener is not caught. The exception: if you create the emitter with `captureRejections: true`, it is sent to `'error'` (or `Symbol.for('nodejs.rejection')`).
6. `emit` itself is synchronous. Events from sockets and streams only *feel* async, because core code calls `emit` from inside libuv callbacks.

**🎤 Say this in the interview:** "EventEmitter is a plain object that maps an event name to a listener function or array. emit copies the array and calls each listener synchronously, in order. 'error' with no listener throws. The max-listeners limit is only a warning that helps you find listener leaks."

**🧪 Real scenario:** After a few hours in production you see "MaxListenersExceededWarning: 11 message listeners added" for the Redis client, and memory grows slowly. What is wrong?

**✅ Scenario answer:**
1. **Root cause:** code inside a request handler calls `redisSub.on('message', ...)` on every request and never removes it. Listeners pile up on a long-lived emitter, and each one keeps its closure (and `req`/`res`) in memory.
2. **Confirm:** run with `--trace-warnings` to see the stack that adds the listener. Log `emitter.listenerCount('message')`; it grows with traffic.
3. **Fix:** register the listener once at startup and route messages by ID. Or, if it must be per request, remove it when done (`emitter.off(...)` in `finally`, or use `once`).
4. Do not "fix" it by only raising `setMaxListeners`. That hides the leak.
5. **Prevent:** in code review, any `.on(` inside a request handler needs a matching remove.

---

### Q18. How do you debug a production performance issue (high latency)?
**🟢 In simple words:** First find out where the time is going: is the main thread busy (CPU), or is the app waiting for something (database, other service)? Use metrics, tracing and CPU profiles to answer this. Then fix the slow part, such as a heavy function, a missing index, or a full connection pool.
**🏠 Real-life example:** A slow food delivery. You check the tracking: was the delay in cooking (CPU), waiting for the delivery boy (pool), or stuck in traffic (external service)? You fix only the step that is slow.

- Check metrics: p95/p99 latency, event-loop lag (`perf_hooks.monitorEventLoopDelay`), CPU, memory, GC pauses.
- Distributed tracing (OpenTelemetry) → is the time spent in the DB, an external API, or the app?
- CPU profile: `node --prof`, `clinic flame` (0x) → a flamegraph to find hot functions (often synchronous JSON or regex, crypto).
- DB: slow query log, `EXPLAIN ANALYZE`, missing indexes, N+1, pool exhaustion.

**🔍 Internal working:**
1. `perf_hooks.monitorEventLoopDelay({ resolution: 10 })` starts a repeating libuv timer in C++. Each time it fires, it measures how late it is compared with the expected time. It records that delay in an HDR histogram (in nanoseconds). You read `p50`, `p99` and `max` from it. A high delay means synchronous work is blocking the loop.
2. CPU profiling (`--cpu-prof`, or the inspector Profiler in DevTools) uses V8's **sampling profiler**. At a fixed interval (default 1000 µs for `--cpu-prof`), it interrupts the JS thread and records the current call stack. `--prof` writes V8's tick log, which you read with `node --prof-process`.
3. A flame graph combines those samples. The **width** of a box is the share of samples (time on CPU). The vertical stack is the call chain. Wide boxes at the top are the hot functions, for example `JSON.parse`, a regex, or sync crypto.
4. GC: a `PerformanceObserver` with `entryTypes: ['gc']` (or `--trace-gc`) shows each GC's kind and duration. Scavenges are short. Mark-compact pauses are longer, and they grow when old space is close to its limit.
5. OpenTelemetry auto-instrumentation patches modules like `http`, `pg` and `ioredis` when they are loaded. It creates spans around their calls. It keeps the current span across `await` using `AsyncLocalStorage`. It sends the `traceparent` header (W3C Trace Context) to the next service.
6. Pool exhaustion has a clear pattern: CPU and event-loop lag are low, but latency is high. Requests are waiting in the DB pool's internal queue for a free connection.

**🎤 Say this in the interview:** "First I separate 'loop blocked' from 'waiting on I/O'. monitorEventLoopDelay measures how late a libuv timer fires. V8's sampling profiler gives a flame graph of hot functions. If CPU and loop lag are low but latency is high, I follow the OpenTelemetry traces to the DB, the pool queue, or a downstream service."

**🧪 Real scenario:** Every day between 10 and 11 AM, the dashboard API's p99 goes from 200 ms to 8 seconds. CPU is only 25% and event-loop lag is normal. How do you find the cause?

**✅ Scenario answer:**
1. **What it means:** low CPU and normal loop lag say the code is not busy. It is waiting: most likely for a DB connection or a slow query.
2. **Confirm:** traces (OpenTelemetry) show the time before the query starts (waiting for the pool) or inside the query. Check pool stats, e.g. `pool.waitingCount` in `pg`. Check the DB slow query log and run `EXPLAIN ANALYZE` on the slow query.
3. **Common findings:** a missing index (Seq Scan on a big table), an N+1 query loop, or a transaction that does not release its connection on an error path.
4. **Fix:** add the index, replace N+1 with one join or `IN (...)` query, always release connections in `finally`, and cache dashboard counts for a short time.
5. **Prevent:** alert on pool wait count and slow queries, not only on CPU.

---

### Q19. What's new / important in modern Node (v18–v22+)?
**🟢 In simple words:** Modern Node has many tools built in that used to need extra packages: `fetch`, a test runner, watch mode, `.env` loading, and even running TypeScript files. It also has a permission model to limit what code can do. In production, always use an LTS (long-term support) version.
**🏠 Real-life example:** A new smartphone that comes with a torch, scanner and calculator already installed, so you no longer need to download separate apps for them.

Built-in `fetch`, a `node:test` test runner, `--watch` mode, `--env-file`, a permission model (`--permission`), stable `worker_threads`, `AbortController`, `require(esm)` support, native TypeScript type-stripping (`--experimental-strip-types`, unflagged in v23.6+), and the WebSocket client. Always mention using the **LTS** version in production.

**🔍 Internal working:**
1. **`fetch`** is built on **undici**. undici is an HTTP/1.1 client written in JS. It uses `net`/`tls` sockets directly (not the old `http` module). It has its own connection pool and keep-alive by default. It was experimental in Node 18 and became stable in Node 21. Always read or cancel the response body. Otherwise the connection is not returned to the pool.
2. **`node --test`** finds test files. By default, it runs each file in its **own child process** for isolation. Results come back as a stream of events. Reporters (`spec`, `tap`, `dot`, `junit`) format them.
3. **`--watch`** records every module the app loads (`require`/`import`). It restarts the process when any of those files changes.
4. **`--env-file=.env`** (Node 20.6+) is parsed in C++ before your code runs. By default it does not override variables that already exist in the real environment.
5. **Permission model:** the checks live in the C++ layer. So fs, `child_process`, worker threads and native addons are blocked unless granted (`--allow-fs-read=…`, `--allow-child-process`, …). It started as `--experimental-permission` in Node 20. It became stable as `--permission` in Node 23.5 / 22.13.
6. **`require(esm)`** (on by default since Node 22.12 and 20.19) loads and evaluates the ES module graph **synchronously**. It works only if that graph has no top-level `await`. Otherwise it throws `ERR_REQUIRE_ASYNC_MODULE`.
7. **Type stripping** uses Amaro (based on SWC) to replace type annotations with **spaces**. So line and column numbers stay the same, and no source maps are needed. There is **no type checking**. Syntax that generates code (`enum`, `namespace`) needs `--experimental-transform-types`.

**🎤 Say this in the interview:** "Modern Node removes many dependencies. fetch is undici, with its own connection pool. The permission model is enforced in the C++ layer. require(esm) evaluates ES modules synchronously when there is no top-level await. TypeScript support only replaces types with spaces, without type checking."

**🧪 Real scenario:** Your team upgrades from Node 16 to Node 20 LTS and replaces axios with the built-in `fetch`. After some hours, outgoing calls to a partner API start to hang. What do you check?

**✅ Scenario answer:**
1. **Likely cause:** some code checks `if (!res.ok) return ...` and never reads the response body. With undici, an unread body can keep the connection busy, so it does not go back to the pool quickly. Also, `fetch` has no short default timeout like many teams set in axios.
2. **Confirm:** hangs grow over time and happen after partner errors. Search the code for `fetch(` calls where the body is not read on every path.
3. **Fix:** always read or cancel the body, and add a timeout.
   ```js
   const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
   if (!res.ok) { await res.body?.cancel(); throw new Error(`Partner ${res.status}`); }
   return res.json();
   ```
4. **Prevent:** use one small shared HTTP helper for all outgoing calls, and run the full test suite and a load test before a Node major upgrade.

---

### Q20. How do you structure a large Node.js project?
**🟢 In simple words:** Split the code into clear layers: routes receive the request, controllers handle HTTP details, services hold business logic, and repositories talk to the database. Each layer only calls the layer below it. Add shared things like config, validation, error handling, logging and tests around this.
**🏠 Real-life example:** A hotel. The receptionist (route/controller) talks to guests, the manager (service) makes decisions, and the store keeper (repository) brings things from the storeroom (database). Nobody skips the chain.

A layered / feature-based structure: `routes → controllers → services (business logic) → repositories/models (data access)`. Plus:
- config per environment, a validation layer, centralized error handling;
- logging (pino/winston with correlation IDs);
- dependency injection for testability;
- unit + integration tests (Jest/Vitest + Supertest);
- OpenAPI docs, lint + prettier + husky, a CI pipeline.

For multiple services, use a monorepo (Nx/Turborepo) with shared packages.

**🔍 Internal working:**
1. `require('x')` works like this:
   - `Module._resolveFilename` finds the file (relative path, or walk up the `node_modules` folders, respecting `package.json` `"exports"` / `"main"`).
   - It looks in `Module._cache` by **absolute path**.
   - If missing, it creates a `Module` and wraps the source in `function (exports, require, module, __filename, __dirname) { … }`.
   - It compiles it with V8, runs it, and caches `module.exports`.
2. Because of that cache, each module is a **singleton per process** (only one copy). A `db.js` that creates a pool, or a `config.js`, runs only once, no matter how many files require it. (Two different resolved paths, for example two copies of a package, mean two instances.)
3. Circular requires: if A requires B and B requires A, B receives A's **partly filled** `exports` (often `{}`). This causes "undefined is not a function" bugs. A strict one-direction layering (routes → controllers → services → repositories) prevents these cycles.
4. ES modules work in three phases: **parse** (find the static `import` graph), **link** (connect live bindings between modules), **evaluate**. This allows static analysis, tree-shaking and top-level `await`.
5. DI containers (for example `awilix`) keep a registry of factories. They build each service with its dependencies. So tests can register fakes instead of patching `require`.
6. Request context, such as a correlation ID, is carried through `await` chains by `AsyncLocalStorage`. So loggers can add it without passing `req` through every layer.
7. Monorepos: npm/pnpm/yarn workspaces **symlink** local packages into `node_modules`. Nx/Turborepo build a task graph from package dependencies. They skip tasks whose input hash has not changed (local or remote cache).

**🎤 Say this in the interview:** "Node's module system makes each module a cached singleton per resolved path. So config and DB pools are created once. A strict one-direction layering avoids circular-require bugs. On top of that, I use DI for testability and AsyncLocalStorage for request context like correlation IDs."

**🧪 Real scenario:** In a large MIS project, after someone adds a new import, the app crashes at startup with "TypeError: userService.getUser is not a function". The function clearly exists. What happened?

**✅ Scenario answer:**
1. **Root cause:** a circular require. For example, `userService` requires `notificationService`, and that now requires `userService`. One of them receives the other's partly filled `exports` (often `{}`).
2. **Confirm:** run `npx madge --circular src/` to list the cycles. The new import is in the cycle.
3. **Fix:** move the shared logic to a separate lower-level module, or pass the dependency in (DI) instead of requiring it. Keep the direction one way: routes → controllers → services → repositories.
4. **Prevent:** add `madge --circular` or ESLint `import/no-cycle` to the CI pipeline, so the build fails on any new cycle.
