# 09 — Redis

---

### Q1. What is Redis and why is it so fast?
**🟢 In simple words:** Redis is a database that keeps all data in RAM (memory), not on disk. Reading RAM is thousands of times faster than reading a disk. One main thread runs all commands, so there are no locks and no waiting. It talks with clients using a very simple text protocol.
**🏠 Real-life example:** Redis is like a shop assistant who keeps the most popular items on the front desk. He does not walk to the back store. He serves one customer at a time, but each customer takes only a second.

Redis is an **in-memory key-value data structure server**. It is used as a cache, session store, queue, rate limiter, lock service, leaderboard and pub/sub broker. Typical latency is **sub-millisecond**. One instance can do **100k+ ops/sec**.

Why it is fast:
- **In-memory:** no disk read on the hot path. Disk is only used for persistence, in the background.
- **Single-threaded command execution:** no locks, no context switches, no race conditions. Every command is atomic.
- **I/O multiplexing:** one event loop uses **epoll** (Linux) / kqueue (macOS) to watch thousands of sockets at once.
- **I/O threads (Redis 6.0+):** extra threads can read/write sockets and parse the protocol. Commands still run on the main thread.
- **Efficient encodings:** small objects use compact formats (listpack, intset). This saves memory and CPU cache.
- **RESP protocol** (REdis Serialization Protocol): simple, length-prefixed, very cheap to parse. RESP3 came in Redis 6.0.
- **Most commands are O(1) or O(log N).**

**🔍 Internal working:**
1. The client opens a TCP connection. Redis registers the socket in its event loop (`ae` library, on top of epoll).
2. When data arrives, epoll wakes the loop. Redis reads bytes into the client's **query buffer**.
3. It parses RESP, e.g. `*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\nv\r\n`, into an argument array.
4. It looks up the command in the command table and runs it on the main thread. It changes the in-memory dict.
5. The reply goes into the client's **output buffer**. It is written to the socket when the socket is writable.
6. With `io-threads` > 1, steps 2–3 and 5 can run in parallel on I/O threads. Step 4 always stays on one thread.

```text
clients ──TCP──> [epoll event loop] ──> parse RESP ──> execute (main thread) ──> output buffer ──> socket
                         ▲                 (I/O threads can help here)         (I/O threads can help here)
```

**🎤 Say this in the interview:** "Redis is fast because data lives in RAM, commands run on one thread with no locks, and one epoll event loop serves thousands of connections. Since 6.0, I/O threads can do the socket reads and writes, but command execution is still single-threaded, so every command is atomic."

**🧪 Real scenario:** Your API p99 latency is 2 ms most of the day, but jumps to 200 ms when traffic is high. Redis CPU shows 100% on one core, while the other 7 cores are idle.

**✅ Scenario answer:**
1. Root cause: commands run on one main thread. That one core is full. Most of its time goes to reading and writing sockets for many small requests.
2. Confirm: run `redis-cli INFO cpu` and `INFO stats` (`instantaneous_ops_per_sec`). Check `SLOWLOG GET 10`. If the slowlog is empty, the cost is network I/O, not slow commands.
3. Fix: turn on I/O threads (`io-threads 4` in redis.conf). Reduce round trips with pipelining or `enableAutoPipelining: true` in ioredis.
4. Prevention: alert on Redis CPU above 70%. When one instance is not enough, shard with Redis Cluster.

---

### Q2. Redis data types, use cases and internal encodings.
**🟢 In simple words:** Redis is not only "key → string". A value can be a list, a set, a hash, a sorted set and more. Each type is good for a different job. Inside, Redis picks a small, compact format for small values and a faster, bigger format for large values.
**🏠 Real-life example:** It is like a toolbox. A hammer, a screwdriver and a tape measure are all tools, but each is made for one job. You pick the right tool, and the work becomes easy.

| Type | Use case | Key commands | Internal encoding |
|---|---|---|---|
| **String** | cache JSON, counters, flags | `SET`, `GET`, `INCR`, `SETEX` | `int`, `embstr` (≤44 bytes), `raw` (SDS) |
| **Hash** | user object, session fields | `HSET`, `HGET`, `HINCRBY` | `listpack` (small) → `hashtable` |
| **List** | simple queue, recent items | `LPUSH`, `RPOP`, `BLMOVE`, `LRANGE` | `listpack` (small, 7.2+) → `quicklist` |
| **Set** | unique tags, online users | `SADD`, `SISMEMBER`, `SINTER` | `intset` (only ints) / `listpack` (7.2+) → `hashtable` |
| **Sorted Set** | leaderboard, delayed jobs, sliding window | `ZADD`, `ZRANGE`, `ZRANK` | `listpack` (small) → `skiplist + hashtable` |
| **Bitmap** | daily active users, feature flags per user id | `SETBIT`, `BITCOUNT` | a String |
| **HyperLogLog** | count unique visitors (approx.) | `PFADD`, `PFCOUNT` | a String, max ~12 KB, ~0.81% error |
| **Stream** | event log, durable queue | `XADD`, `XREADGROUP`, `XACK` | radix tree of listpacks |
| **Geo** | "near me" search | `GEOADD`, `GEOSEARCH` | a Sorted Set (score = geohash) |
| **JSON** | nested documents | `JSON.SET`, `JSON.GET` | RedisJSON module (built in from Redis 8) |

Default thresholds (configurable): hash/zset stay `listpack` while ≤128 entries and each value ≤64 bytes. A set stays `intset` while ≤512 integers. Check with `OBJECT ENCODING key`.

**🔍 Internal working:**
1. Every value is a `redisObject` with a `type`, an `encoding`, an LRU/LFU field and a pointer to the data.
2. **SDS** (Simple Dynamic String): stores the length, so `STRLEN` is O(1). It is binary-safe and has spare space for cheap appends.
3. **listpack** (replaced ziplist in 7.0): one continuous memory block with entries one after another. Very compact and cache-friendly. But search is O(N), so it is only used for small values.
4. **quicklist:** a doubly linked list of listpack nodes. You get cheap push/pop at both ends with good memory use.
5. **Sorted set (big):** a **skiplist** (multi-level linked list, O(log N) range and rank) plus a **hashtable** (member → score in O(1)).
6. **hashtable (dict):** has two tables. When it grows, Redis does **incremental rehashing**. It moves a few buckets on each operation (and in a background cron), so there is no single long pause.
7. When a value crosses the threshold, Redis converts it once (listpack → hashtable). It never converts back automatically.

```text
small hash:  [listpack: f1|v1|f2|v2|f3|v3]           (one block)
big hash:    ht[0] buckets ──> entries               ht[1] (during rehash, buckets moved step by step)
```

**🎤 Say this in the interview:** "Redis has strings, hashes, lists, sets, sorted sets, bitmaps, HyperLogLog, streams and geo. Small values use compact listpack or intset. Big values switch to hashtable, quicklist or skiplist plus hashtable. The dict grows with incremental rehashing, so there is no long stop."

**🧪 Real scenario:** A "user online status" feature stores every online user id in one big Set. Memory use is 10x more than expected.

**✅ Scenario answer:**
1. Root cause: the set holds millions of members. So it uses the `hashtable` encoding, which has a big overhead per member.
2. Confirm: `OBJECT ENCODING online:users` returns `hashtable`. `MEMORY USAGE online:users` shows the size.
3. Fix: user ids are numbers, so use a Bitmap: `SETBIT online:2026-11-22 42 1` and `BITCOUNT`. 10M users fit in about 1.2 MB. If you only need an approximate count, use HyperLogLog (`PFADD`/`PFCOUNT`, ~12 KB).
4. Prevention: choose the data type by access pattern and size. Check `OBJECT ENCODING` and `MEMORY USAGE` in load tests.

---

### Q3. Caching patterns with Redis in Node.js.
**🟢 In simple words:** The most common pattern is cache-aside. First, look in Redis. If the data is there, return it. If not, read the database, save the result in Redis with a timeout, and return it. When data changes, delete the old cache key.
**🏠 Real-life example:** You keep a sticky note of a friend's phone number on your desk. You check the note first. If there is no note, you search your phone book and write a new note. If the friend changes the number, you throw the old note away.

Patterns:
- **Cache-aside (lazy loading):** the app reads/writes the cache itself. Most common.
- **Read-through / write-through:** a library or layer reads/writes the cache and DB for you.
- **Write-behind:** write to cache first, write to DB later in batches. Fast, but risk of data loss.

```js
import Redis from 'ioredis';
const redis = new Redis(process.env.REDIS_URL); // one shared connection

const TTL = 300; // seconds

async function getUser(id) {
  const key = `user:v1:${id}`;              // version in key = easy mass invalidation
  const cached = await redis.get(key);
  if (cached !== null) return JSON.parse(cached);   // cache hit

  const user = await db.users.findById(id);         // cache miss
  if (user) {
    const ttl = TTL + Math.floor(Math.random() * 60); // jitter
    await redis.set(key, JSON.stringify(user), 'EX', ttl);
  }
  return user;
}

async function updateUser(id, data) {
  await db.users.update(id, data);   // 1. write DB first
  await redis.del(`user:v1:${id}`);  // 2. then delete (not update) the cache
}
```

Key points:
- **Delete, do not update** the cache on write. Two parallel updates could write old data last.
- **Write DB first, then delete cache.** A small race is still possible. Fix it with a short TTL or a **delayed double delete**.
- For strong sync, use **CDC** (Change Data Capture, e.g. Debezium reading the DB log) to delete keys.
- **Serialization:** JSON is easy. MessagePack is smaller. Watch out for `Date` and `BigInt` (JSON turns them into strings).
- Always set a **TTL**. It is your safety net for any missed invalidation.

**🔍 Internal working:**
1. `SET key val EX 300` stores the value in the main dict. It also stores the expire time (ms) in a second dict called `expires`.
2. `GET` looks up the key in the dict (O(1)). First it checks `expires`. If the time has passed, it deletes the key and returns nil.
3. `DEL` removes the key from both dicts. For a big value, the free work happens on the main thread (use `UNLINK` to free in the background).
4. ioredis sends commands over one TCP socket. It keeps a queue of pending commands and matches replies in order.

**🎤 Say this in the interview:** "I use cache-aside: read Redis, on a miss read the DB and SET with a TTL plus jitter. On update I write the DB first and then delete the key, not update it. The TTL is the safety net. For strict consistency I invalidate from CDC events."

**🧪 Real scenario:** After a user updates the profile name, some users still see the old name for 5 minutes. It happens only under high traffic.

**✅ Scenario answer:**
1. Root cause: a race. Request A reads the old row from the DB (cache miss). Request B updates the DB and deletes the cache. Then A writes the old value into the cache.
2. Confirm: add logs with timestamps for "cache set" and "cache delete" per key. You will see a SET with old data after the DEL.
3. Fix: delete the cache again after a short delay (delayed double delete), e.g. `setTimeout(() => redis.del(key), 500)`. Or delete from a CDC event after the DB commit.
4. Prevention: keep TTLs short for data that changes often. Always delete, never update, the cache on write. Add version numbers to cached values if you need strict order.

---

### Q4. Cache problems: stampede, penetration, avalanche, hot keys, big keys.
**🟢 In simple words:** Caches can fail in a few known ways. Many requests can miss at the same time and hit the DB together. People can ask for data that does not exist, so the cache never helps. Many keys can expire at once. One key can get too much traffic, or one value can be too big.
**🏠 Real-life example:** A shop opens its doors in the morning and 1,000 people run to one cashier. That is a stampede. The fix is to let one person in, then share the answer with everyone.

| Problem | What happens | Fix |
|---|---|---|
| **Cache stampede / thundering herd** | One hot key expires. 1,000 requests miss at once and all query the DB. | **Lock / single-flight** (only one request rebuilds). Early refresh before expiry. Serve stale data while one rebuilds. |
| **Cache penetration** | Requests for keys that do not exist (e.g. `id=-1`). Always miss, always hit DB. | **Cache null** with a short TTL. **Bloom filter** (a small bit structure that says "surely not present" or "maybe present"). Input validation. |
| **Cache avalanche** | Many keys expire at the same time, or Redis goes down. DB is flooded. | **Jitter TTL** (random extra seconds). HA Redis. Circuit breaker and rate limits to the DB. |
| **Hot key** | One key gets huge traffic. One Redis node / one CPU core is overloaded. | **Local L1 cache** in Node memory (e.g. `lru-cache`, few seconds TTL). Copy the key to `key:1..N` and read a random copy. Read from replicas. |
| **Big key** | A value of many MB, or a hash with millions of fields. Slow commands, network spikes, slow delete. | Split into smaller keys. Use `HSCAN` instead of `HGETALL`. Delete with `UNLINK`. Find with `redis-cli --bigkeys` / `--memkeys`. |

Single-flight in Node (per process) plus a Redis lock (across processes):

```js
const inflight = new Map();
async function getCached(key, loader) {
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit);
  if (inflight.has(key)) return inflight.get(key);   // same process: share one promise
  const p = (async () => {
    const ok = await redis.set(`lock:${key}`, '1', 'PX', 5000, 'NX'); // across processes
    if (!ok) { await sleep(50); return getCached(key, loader); }        // others wait and retry
    try {
      const val = await loader();
      await redis.set(key, JSON.stringify(val ?? null), 'EX', val ? 300 : 30); // null caching
      return val;
    } finally { await redis.del(`lock:${key}`); }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
```

**🔍 Internal working:**
1. `SET lock NX PX 5000` is atomic. Only one client gets `OK`. The rest get nil, so only one goes to the DB.
2. A Bloom filter (e.g. `BF.ADD` / `BF.EXISTS` from RedisBloom, built in from Redis 8) hashes the id with k hash functions and sets k bits. If any bit is 0, the id surely does not exist.
3. A hot key lives on one node and is served by one main thread. So it cannot scale by adding nodes. L1 cache or key copies spread the load.
4. A big key blocks the main thread while Redis builds or frees it. All other clients wait during that time.

**🎤 Say this in the interview:** "Stampede I fix with single-flight or a lock and early refresh. Penetration with null caching and a Bloom filter. Avalanche with TTL jitter and HA. Hot keys with a local L1 cache or key copies. Big keys by splitting them and deleting with UNLINK."

**🧪 Real scenario:** Every day at 9:00 AM the homepage becomes very slow and the DB CPU hits 100%. At the same time, many cache keys were refreshed by a nightly job.

**✅ Scenario answer:**
1. Root cause: cache avalanche plus stampede. The nightly job set all keys with the same TTL, so they expire together. Then thousands of requests miss and all hit the DB.
2. Confirm: in `INFO stats`, `keyspace_misses` jumps at 9:00. `expired_keys` also jumps. DB slow query logs show the same query many times at once.
3. Fix: add random jitter to TTLs: `EX 3600 + random(0..600)`. Add single-flight or a Redis lock (`SET lock:key 1 NX PX 5000`) so only one request rebuilds a key.
4. Prevention: refresh hot keys before they expire. Serve stale data while rebuilding. Add a local L1 cache for the hottest keys.

---

### Q5. How does key expiration (TTL) work?
**🟢 In simple words:** Redis does not delete an expired key at the exact second. It uses two ways. First, when you touch a key, Redis checks if it is expired and deletes it. Second, a background job checks random keys a few times every second and deletes the expired ones.
**🏠 Real-life example:** It is like milk in a fridge. You check the date when you pick up the milk (lazy). Also, once a week you look at a few items and throw away old ones (active).

- `EXPIRE key 60`, `SET key v EX 60`, `PEXPIRE` (ms), `EXPIREAT` (unix time), `TTL` / `PTTL` to read, `PERSIST` to remove.
- `TTL` returns `-1` = no expiry, `-2` = key does not exist.
- A normal `SET` without `EX` **removes** the old TTL. Use `SET ... KEEPTTL` (6.0+) to keep it.
- Redis 7.4 added **TTL on hash fields** (`HEXPIRE`).

**🔍 Internal working:**
1. Each DB has a main dict and an `expires` dict: key → absolute unix time in ms.
2. **Lazy (passive) expiry:** every command that reads a key calls `expireIfNeeded()`. If the time has passed, the key is deleted and treated as missing.
3. **Active expiry:** a cron runs `hz` times per second (default 10). It takes a sample of keys with TTL (about 20 per DB). It deletes the expired ones.
4. If more than ~25% of the sample was expired, it repeats at once. A time budget stops it from using too much CPU.
5. So some expired keys can stay in memory for a while. They still use RAM but are never returned to clients.
6. On a **replica**, keys are not expired on their own. The master sends a `DEL` (or `UNLINK`) to replicas and to the AOF. This keeps all copies the same. A replica still hides logically expired keys from reads.

**🎤 Say this in the interview:** "Expiry is lazy plus active. On access Redis checks the expires dict and deletes the key if it is old. A background cycle samples keys with TTL about 10 times a second and repeats if over 25% are expired. The master sends DELs to replicas and the AOF."

**🧪 Real scenario:** Memory keeps growing even though all cache keys have a 1-minute TTL. `DBSIZE` is much larger than the number of live keys you expect.

**✅ Scenario answer:**
1. Root cause: active expiry samples only a few keys per cycle and has a CPU time limit. With a very high write rate, expired keys pile up faster than they are removed.
2. Confirm: `INFO keyspace` shows `keys` and `expires`. `INFO stats` shows `expired_keys` and `expired_stale_perc`. A high stale percent means many expired keys are still in memory.
3. Fix: raise `hz` (e.g. 10 → 50) or set `active-expire-effort` higher (1–10). This gives the expiry cycle more CPU.
4. Prevention: set `maxmemory` with an eviction policy as a safety net. Watch `expired_stale_perc` in monitoring.

---

### Q6. Eviction policies and how approximate LRU/LFU works.
**🟢 In simple words:** When Redis reaches its memory limit, it must decide what to do. It can refuse new writes, or remove some keys to make space. You choose the rule with a setting. Redis does not track exact "least recently used". It checks a few random keys and removes the best one, which is cheap and good enough.
**🏠 Real-life example:** Your wardrobe is full. You pick 5 random shirts and give away the one you wore least recently. It is not perfect, but it is fast and works well.

Set `maxmemory 2gb` and `maxmemory-policy`:

| Policy | Removes |
|---|---|
| `noeviction` (default) | Nothing. Writes return an OOM error. Good for queues/primary data. |
| `allkeys-lru` | Least recently used, any key. Good default for a pure cache. |
| `allkeys-lfu` | Least frequently used, any key. Good when some keys are always hot. |
| `volatile-lru` / `volatile-lfu` | Same, but only keys **with a TTL**. |
| `allkeys-random` / `volatile-random` | Random key. |
| `volatile-ttl` | Key with the shortest TTL left. |

Note: with `volatile-*` and no keys with TTL, Redis acts like `noeviction`.

**🔍 Internal working:**
1. Before running a write command, Redis checks used memory against `maxmemory`. If it is over, it runs `performEvictions()`.
2. Each object has a 24-bit field. For LRU it stores a coarse last-access clock. For LFU it stores 16 bits of last-decrement time plus an 8-bit counter.
3. Redis samples `maxmemory-samples` keys (default 5) and puts the best candidates into an **eviction pool** of 16 entries. It evicts the best one in the pool. It repeats until memory is under the limit.
4. More samples (e.g. 10) = closer to real LRU, but more CPU.
5. **LFU counter is logarithmic:** the chance to increase it gets smaller as it grows (`lfu-log-factor`, default 10). So 8 bits can represent millions of hits.
6. **LFU decay:** the counter goes down over time (`lfu-decay-time`, default 1 minute). So old hot keys can be evicted later.
7. Eviction deletes are also sent to replicas and AOF as `DEL`.

**🎤 Say this in the interview:** "For a pure cache I set maxmemory with allkeys-lru or allkeys-lfu. For queues or important data I keep noeviction. Redis LRU is approximate: it samples 5 keys into a 16-entry pool and evicts the best one. LFU uses a logarithmic 8-bit counter that decays over time."

**🧪 Real scenario:** Your BullMQ jobs disappear randomly. Jobs are added but some are never processed. The same Redis is also used as a cache with `allkeys-lru`.

**✅ Scenario answer:**
1. Root cause: Redis reached `maxmemory`. The `allkeys-lru` policy evicted job keys, not only cache keys.
2. Confirm: `INFO stats` shows `evicted_keys` growing. `INFO memory` shows `used_memory` near `maxmemory`.
3. Fix: move the queue to its own Redis with `maxmemory-policy noeviction`. Keep the cache on another instance with `allkeys-lru` or `allkeys-lfu`.
4. Prevention: never mix cache and important data on one instance with an eviction policy. Alert when `evicted_keys` grows on a non-cache instance.

---

### Q7. Persistence: RDB vs AOF vs hybrid.
**🟢 In simple words:** Redis keeps data in RAM, but it can also save to disk so data survives a restart. RDB takes a full photo of the data every few minutes. AOF writes down every change, like a diary. Hybrid mode uses both: a photo plus the diary of changes after it.
**🏠 Real-life example:** RDB is taking a photo of your room every hour. AOF is writing in a notebook every time you move something. To rebuild the room, you can look at the last photo and then read the notebook from that point.

| | RDB (snapshot) | AOF (append-only file) |
|---|---|---|
| What | Compact binary dump at a point in time | Log of every write command |
| Data loss | Minutes (since last snapshot) | ~1 second with `everysec` |
| Restart speed | Fast | Slower (replay), faster with RDB preamble |
| File size | Small | Bigger, needs rewrite |
| Best for | Backups, fast restore, replica sync | Durability |

- **AOF fsync** (`appendfsync`): `always` (safe, slow), `everysec` (default, lose ≤ ~1–2s), `no` (OS decides, ~30s).
- **Hybrid** (`aof-use-rdb-preamble yes`, default): the AOF rewrite starts with an RDB snapshot, then AOF commands follow.
- **Redis 7.0 multi-part AOF:** a folder (`appenddirname`) with one **base** file (RDB or AOF), one or more **incr** files, and a **manifest** file that lists them.
- Production common choice: AOF `everysec` + RDB for backups.

**🔍 Internal working:**
1. `BGSAVE` calls `fork()`. The child process gets the same memory pages as the parent. Pages are shared, not copied.
2. **Copy-on-write (CoW):** when the parent changes a page, the OS copies only that page. The child still sees the old page, so it writes a consistent snapshot.
3. The child writes `temp-xxx.rdb` and then atomically `rename()`s it to `dump.rdb`. With heavy writes, CoW can use a lot of extra RAM (up to 2x in the worst case). Big instances can also see a fork pause of some ms.
4. AOF: after each write command, Redis appends it to an in-memory AOF buffer. Before going back to the event loop, it writes the buffer to the file. `fsync` runs based on the policy (`everysec` uses a background thread).
5. **AOF rewrite** (`BGREWRITEAOF`): a forked child writes a new, minimal base file from the current data. In 7.0+, new writes go to a new incr file meanwhile. At the end, the manifest is switched atomically and old files are removed.
6. On startup, Redis loads the AOF if it is enabled (it is more complete). Otherwise it loads the RDB.

```text
parent (serves clients) ──fork()──> child (writes RDB)
        │ writes page X                │ still sees old page X
        └─> kernel copies page X (CoW) ┘
```

**🎤 Say this in the interview:** "RDB is a forked, copy-on-write snapshot. It is compact and fast to load, but you can lose minutes. AOF logs every write with fsync everysec, so you lose about a second. In production I use hybrid AOF with an RDB preamble, which in 7.0 is a multi-part AOF with a manifest."

**🧪 Real scenario:** Every 15 minutes Redis latency spikes to 500 ms for a moment, and once the server was killed by the OOM killer. The instance uses 20 GB of data on a 32 GB machine.

**✅ Scenario answer:**
1. Root cause: `BGSAVE` calls `fork()`. Forking a 20 GB process takes time (page table copy). With many writes, copy-on-write duplicates pages and memory goes over 32 GB.
2. Confirm: `INFO persistence` shows `latest_fork_usec` (fork time). `LATENCY DOCTOR` reports fork events. Check if Transparent Huge Pages are on: `cat /sys/kernel/mm/transparent_hugepage/enabled`.
3. Fix: disable THP (`echo never > .../transparent_hugepage/enabled`). Leave 30–50% free RAM. Do snapshots on a replica instead of the master.
4. Prevention: keep each instance smaller (e.g. under 10–15 GB) by sharding. Alert on `latest_fork_usec` and memory headroom.

---

### Q8. Is Redis single-threaded? Why is that OK? What blocks it?
**🟢 In simple words:** Redis runs all commands on one main thread. This is OK because each command is very fast and the real limit is usually the network or memory, not the CPU. But one slow command blocks everyone else. So you must avoid slow commands.
**🏠 Real-life example:** A single toll booth with a very fast worker handles many cars. But if one driver stops to count coins for a minute, the whole queue waits.

- **Command execution:** single main thread.
- **Other threads exist:** background threads (`bio`) for closing files, `fsync`, and lazy freeing. I/O threads since 6.0. Forked child processes for RDB/AOF rewrite.
- **Why OK:** no locks, every command is atomic, simple code. To use more cores, run **more shards** (Redis Cluster) or more instances.

What blocks Redis:

| Bad | Why | Use instead |
|---|---|---|
| `KEYS *` | O(N) over all keys | `SCAN 0 MATCH user:* COUNT 100` |
| `DEL bigkey` | Freeing millions of elements | `UNLINK` (free in background) |
| `HGETALL`/`SMEMBERS`/`LRANGE 0 -1` on big keys | O(N) + huge reply | `HSCAN`/`SSCAN`, pagination |
| `FLUSHALL` | Frees everything | `FLUSHALL ASYNC` |
| Long Lua script / function | Runs atomically, nothing else runs | Keep scripts short |
| `SORT`, `SUNION` on big sets | O(N log N) / O(N) | Precompute, do it in the app |
| Fork on huge instance with THP on | Fork and CoW pauses | Disable Transparent Huge Pages, keep instances smaller |

**🔍 Internal working:**
1. The event loop handles one command at a time. While a command runs, no other client is served. Even `PING` waits.
2. `SCAN` uses a **cursor** that walks the hash table buckets in a reverse-binary order. This order still works if the table grows or shrinks during the scan. It may return a key twice, but never misses a key that exists the whole time.
3. `UNLINK` removes the key from the dict in O(1). If the value is big, it gives the free job to a `bio` lazy-free thread.
4. Configs `lazyfree-lazy-eviction`, `lazyfree-lazy-expire`, `lazyfree-lazy-user-del` make normal deletes lazy too.
5. A Lua script that runs longer than `busy-reply-threshold` (old name `lua-time-limit`, 5s) makes Redis reply `BUSY` to others. You can `SCRIPT KILL` it only if it has not written anything yet. Otherwise only `SHUTDOWN NOSAVE` works.

**🎤 Say this in the interview:** "Command execution is single-threaded, which makes every command atomic and lock-free. Redis is usually limited by network and memory, not CPU. The danger is O(N) commands, so I use SCAN instead of KEYS, UNLINK instead of DEL for big keys, and short Lua scripts. To use more cores I shard."

**🧪 Real scenario:** At 2:00 AM all API calls to Redis timed out for 8 seconds. A cleanup cron job runs at 2:00 AM.

**✅ Scenario answer:**
1. Root cause: the cron job ran `KEYS session:*` and then `DEL` on a hash with millions of fields. Both are O(N) and block the single main thread.
2. Confirm: `SLOWLOG GET 20` shows `KEYS` and `DEL` with very large durations. `redis-cli --bigkeys` finds the huge hash.
3. Fix: use `SCAN` and `UNLINK`:
   ```js
   const stream = redis.scanStream({ match: 'session:*', count: 500 });
   stream.on('data', keys => keys.length && redis.unlink(...keys));
   ```
4. Prevention: block `KEYS` with ACL (`-keys`). Set `lazyfree-lazy-user-del yes`. Split big keys.

---

### Q9. Transactions: MULTI/EXEC/WATCH vs Lua scripts and Functions.
**🟢 In simple words:** MULTI/EXEC puts several commands in a queue and runs them together, with nothing in between. But if one command fails at run time, the others are not undone. WATCH adds a check: if someone changed the key, the whole thing is cancelled. Lua scripts can read, decide and write in one atomic step.
**🏠 Real-life example:** MULTI/EXEC is giving the cashier your full shopping list at once. WATCH is saying: "If the price changed since I looked, cancel my order." A Lua script is a small robot that checks the price and buys in one move.

```text
WATCH balance:42
GET balance:42           -> 100   (app decides: 100 - 30 = 70)
MULTI
SET balance:42 70
INCR spent:42
EXEC                     -> nil if balance:42 changed after WATCH (retry)
```

- **Atomic:** no other client's command runs between queued commands.
- **No rollback:** a runtime error (e.g. `INCR` on a string) fails only that command. Others still apply.
- **Queue-time errors** (wrong syntax, unknown command) make `EXEC` reject the whole transaction.
- You **cannot** use a result inside the transaction to decide the next step. That is why WATCH (optimistic locking) or Lua exists.

Lua (`EVAL`) and Redis 7.0 **Functions** (`FUNCTION LOAD` + `FCALL`):

```js
// atomic "decrement stock only if enough"
const lua = `
local s = tonumber(redis.call('GET', KEYS[1]) or '0')
if s < tonumber(ARGV[1]) then return -1 end
return redis.call('DECRBY', KEYS[1], ARGV[1])`;
const left = await redis.eval(lua, 1, 'stock:sku1', 2);
```

- Scripts are atomic and can have logic. Pass every key in `KEYS[]` (needed for Cluster routing).
- `EVALSHA` runs a cached script by its SHA1 hash. ioredis `defineCommand` handles this for you.
- **Functions (7.0+):** named libraries that are stored in RDB/AOF and replicated. So they survive restarts, unlike the script cache.

**🔍 Internal working:**
1. After `MULTI`, the client gets a flag. Each next command is checked and added to a queue. The reply is `QUEUED`.
2. `WATCH key` adds the client to a per-DB "watched keys" dict. Any change to that key (by any client, also by expiry) marks those clients as `DIRTY_CAS`.
3. On `EXEC`, if the client is `DIRTY_CAS`, Redis returns nil and runs nothing. Else it runs all queued commands one after another on the main thread.
4. The transaction goes to replicas and AOF wrapped in `MULTI`/`EXEC`, so replicas also apply it as one unit.
5. A Lua script runs in an embedded Lua VM on the main thread. All `redis.call()`s happen with no other client in between. Since 5.0, effects are replicated (the write commands, not the script itself).

**🎤 Say this in the interview:** "MULTI/EXEC queues commands and runs them atomically, but there is no rollback for runtime errors. WATCH gives optimistic locking: EXEC returns nil if a watched key changed. When I need read-decide-write logic, I use a Lua script or a 7.0 Function, which is atomic and persisted."

**🧪 Real scenario:** A flash sale oversold stock: 100 items in stock, but 112 orders were accepted. The code does `GET stock`, checks it in Node, then `DECR stock`.

**✅ Scenario answer:**
1. Root cause: a race. Many Node processes read the same value before any of them decrements. Check and update are two separate steps.
2. Confirm: final `GET stock` is negative (e.g. `-12`). App logs show many requests reading the same stock value at the same millisecond.
3. Fix: do the check and decrement in one Lua script (like the `stock:sku1` example above), or use `WATCH` + `MULTI` with retries. Lua is simpler under heavy contention.
4. Prevention: any "read, decide, write" logic must be atomic in Redis. Add a load test with many parallel buyers.

---

### Q10. Pipelining vs transactions.
**🟢 In simple words:** Pipelining means sending many commands at once without waiting for each answer. It saves network round trips, so it is much faster. But it is not atomic: other clients' commands can run in between. A transaction is atomic, but it is a different thing.
**🏠 Real-life example:** Pipelining is posting 10 letters in one trip to the post office instead of 10 trips. A transaction is putting 10 papers in one sealed envelope so they are opened together.

| | Pipeline | MULTI/EXEC |
|---|---|---|
| Goal | Fewer RTTs (round-trip times) | Atomic group |
| Atomic | No | Yes |
| Server-side change | None (it is only client batching) | Queues commands |
| Can combine | Yes: send `MULTI ... EXEC` in one pipeline | |

```js
// 1 RTT instead of 1000
const pipe = redis.pipeline();
for (const id of ids) pipe.get(`user:${id}`);
const results = await pipe.exec();          // [[err, val], ...]

// atomic + 1 RTT
await redis.multi().incr('a').incr('b').exec();
```

- If RTT is 1 ms, 1000 sequential GETs take ≥1 s. A pipeline takes a few ms.
- Keep batches reasonable (e.g. 100–1000). Huge pipelines use a lot of server output-buffer memory.
- ioredis has `enableAutoPipelining: true`. It batches all commands made in the same event-loop tick.
- In Cluster, a pipeline must be split per node. ioredis Cluster does this for you.

**🔍 Internal working:**
1. The client writes many RESP commands into the socket in one go.
2. Redis reads them all into the query buffer in one `read()` call. It runs them one by one.
3. Replies are appended to the output buffer and sent in one or a few `write()` calls. This saves syscalls on both sides too.
4. Between two commands of a pipeline, Redis can serve other clients. That is why it is not atomic.

**🎤 Say this in the interview:** "Pipelining is client-side batching to cut round trips and syscalls. It is not atomic. MULTI/EXEC is atomic but still needs a trip per command unless I pipeline it. In Node I use pipeline() or ioredis auto-pipelining."

**🧪 Real scenario:** A batch job loads 50,000 product prices from Redis one by one. It takes 50 seconds, but Redis CPU is almost idle.

**✅ Scenario answer:**
1. Root cause: each `GET` waits for a full network round trip (~1 ms). 50,000 × 1 ms = 50 s. The time is spent on the network, not in Redis.
2. Confirm: time one `GET` with `redis-cli --latency`. Redis `INFO commandstats` shows very small usec per call.
3. Fix: use `MGET` or a pipeline in batches of 500–1000:
   ```js
   for (const part of chunk(ids, 500)) await redis.mget(part.map(id => `price:${id}`));
   ```
4. Prevention: enable `enableAutoPipelining` in ioredis. Review loops that call Redis with `await` inside.

---

### Q11. How do you build a distributed lock with Redis?
**🟢 In simple words:** Many servers want to do one job, but only one should do it at a time. A server tries to create a lock key only if it does not exist, with a timeout. It saves a random token in the key. When done, it deletes the key only if the token is still its own.
**🏠 Real-life example:** It is like a meeting room with a sign on the door: "Busy — booked by Ravi until 3 pm." Only Ravi can remove his sign. If he forgets, the booking ends at 3 pm on its own.

```js
import { randomUUID } from 'node:crypto';

async function acquire(name, ttlMs) {
  const token = randomUUID();
  const ok = await redis.set(`lock:${name}`, token, 'PX', ttlMs, 'NX');
  return ok === 'OK' ? token : null;
}

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;
async function release(name, token) {
  return redis.eval(RELEASE, 1, `lock:${name}`, token);
}
```

Rules:
- **NX + PX in one command** (not `SETNX` then `EXPIRE`, which can crash in between and leave a lock forever).
- **Unique token** so you never delete someone else's lock.
- **Release with Lua** (compare-and-delete must be atomic).
- **Extend** the lock (also with a Lua check) for long jobs, like a watchdog.
- **Fencing token:** the lock gives an increasing number (e.g. `INCR lock:seq`). The storage rejects writes with an older number. This protects you when a client pauses (GC, network) and its lock expired.

**Redlock:** take the lock on a majority (e.g. 3 of 5) of **independent** Redis masters, within a time limit.
- **Criticism (Martin Kleppmann):** it depends on timing (clock jumps, GC pauses, network delays). It gives no fencing tokens. So it is not safe for **correctness**. It is fine for **efficiency** (avoid doing work twice).
- For strict correctness, use a consensus system (etcd, ZooKeeper) or a DB row lock with fencing.

**🔍 Internal working:**
1. `SET k v NX PX 30000` is one command, so it runs atomically on the main thread. Only one client gets `OK`.
2. The PX value is stored in the `expires` dict. Lazy plus active expiry removes the lock if the holder dies.
3. The release script runs atomically, so no other client can take the lock between `GET` and `DEL`.
4. With one master + async replica: if the master fails after granting a lock but before replicating it, the new master does not have the lock. Two clients can then hold it. This is the gap Redlock tries to close.

```text
Client A: SET NX ok ─── long GC pause ─────────────── write (token 33) ✗ rejected
                       lock expires
Client B:                   SET NX ok ── write (token 34) ✓
```

**🎤 Say this in the interview:** "I use SET key token NX PX ttl and release with a Lua compare-and-delete, so I never free another client's lock. For long jobs I extend the lock. Locks can expire during a GC pause, so for correctness I add fencing tokens. Redlock is fine for efficiency, but for strict correctness I prefer etcd or a DB lock."

**🧪 Real scenario:** A payment reconciliation job runs on 3 servers with a Redis lock. Sometimes two servers run it at the same time and create duplicate records.

**✅ Scenario answer:**
1. Root cause: the job runs longer than the lock TTL (30 s). The lock expires, and another server takes it. Or a long GC pause made the first server lose the lock without knowing.
2. Confirm: log lock acquire time, release result and job duration. You will see job duration > TTL, or the release Lua script returning 0 (lock was already gone).
3. Fix: renew the lock with a watchdog (extend TTL every 10 s with a Lua check of the token). Stop work if renewal fails. Add a fencing token or a DB unique constraint so a duplicate write fails.
4. Prevention: make the job idempotent. For strict correctness use a DB lock or etcd, not only Redis.

---

### Q12. Build a rate limiter with Redis (Node.js).
**🟢 In simple words:** A rate limiter stops a user from sending too many requests, like 100 per minute. Redis is good for this because all app servers share one counter and Redis commands are atomic. There are three common ways: fixed window, sliding window and token bucket.
**🏠 Real-life example:** A water park gives each child 10 tickets per hour for the big slide. The guard counts tickets at the gate. All gates share one list, so a child cannot cheat by using another gate.

**1. Fixed window (INCR + EXPIRE)** — simple, but allows up to 2x burst at the window edge.

```js
async function fixedWindow(userId, limit = 100, windowSec = 60) {
  const key = `rl:${userId}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const [[, count]] = await redis.multi().incr(key).expire(key, windowSec).exec();
  return count <= limit;
}
```

**2. Sliding window log (sorted set)** — exact, but uses memory per request.

```js
const SLIDING = `
local key, now, win, limit = KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, 0, now - win)
if redis.call('ZCARD', key) >= limit then return 0 end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, win)
return 1`;
const allowed = await redis.eval(SLIDING, 1, `rl:${userId}`, Date.now(), 60000, 100, randomUUID());
```

**3. Token bucket (Lua)** — allows small bursts, smooth average rate.

```js
const BUCKET = `
local cap, rate, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or cap
local ts = tonumber(b[2]) or now
tokens = math.min(cap, tokens + (now - ts) / 1000 * rate)   -- refill
local ok = 0
if tokens >= 1 then tokens = tokens - 1; ok = 1 end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate * 1000))
return ok`;
```

| Algorithm | Accuracy | Memory | Burst |
|---|---|---|---|
| Fixed window | Low at edges | 1 counter | Up to 2x at edge |
| Sliding log (ZSET) | Exact | 1 entry per request | No |
| Sliding window counter (2 windows, weighted) | Good | 2 counters | Small |
| Token bucket | Good | 1 small hash | Yes, up to capacity |

Tips: return `429` with `Retry-After` header. In Cluster, keep all keys of one limiter in one slot. Pass the time from the app or use `redis.call('TIME')` so all servers agree.

**🔍 Internal working:**
1. `INCR` is atomic on the main thread, so two servers never read the same old value.
2. A Lua script runs check + update with no other command in between. This removes the race in "read count, then write".
3. `ZREMRANGEBYSCORE` uses the skiplist to find the range in O(log N) and removes M old items.
4. `EXPIRE`/`PEXPIRE` lets idle limiter keys clean themselves.

**🎤 Say this in the interview:** "For a simple limit I use INCR with EXPIRE in a fixed window. For exact limits I use a sorted-set sliding log in a Lua script. For burst-friendly limits I use a token bucket in Lua. Lua makes check-and-update atomic across all app servers."

**🧪 Real scenario:** A client is allowed 100 requests per minute, but your logs show it sent 200 requests in 2 seconds and all were accepted.

**✅ Scenario answer:**
1. Root cause: a fixed window limiter. The client sent 100 requests at 12:00:59 and 100 at 12:01:00. Both windows allowed 100.
2. Confirm: look at the `rl:<user>:<window>` keys in logs. Two different window keys each reached exactly 100 within seconds.
3. Fix: switch to a sliding window (sorted set in Lua) or a token bucket (Lua) as shown above.
4. Prevention: pick the algorithm by business need. Test the edge of the window in unit tests. Add a separate short burst limit (e.g. 20 per second).

---

### Q13. Session store and JWT blacklist with Redis.
**🟢 In simple words:** Redis is a great place to keep login sessions because it is fast and keys can expire on their own. With JWT (a signed token), the server does not store the session. So to log a user out before the token ends, you keep a "blocked list" of token IDs in Redis until they expire.
**🏠 Real-life example:** A session is a hotel keeping your room key record at the desk. A JWT is a festival wristband — it works until its date. If someone loses the wristband, the guards keep a "do not allow" list until the festival ends.

Session store (Express):

```js
import session from 'express-session';
import { RedisStore } from 'connect-redis';
app.use(session({
  store: new RedisStore({ client: redisClient, prefix: 'sess:' }),
  secret: process.env.SESSION_SECRET,
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 86400000 },
}));
```

- Key `sess:<id>` → JSON, TTL = session time. Sliding expiry: refresh TTL on each request.
- "Logout from all devices": keep a set `user:42:sessions` with session IDs, delete them all.

JWT blacklist (denylist):

```js
// on logout: block this token's id until it expires naturally
const { jti, exp } = jwt.decode(token);
const ttl = exp - Math.floor(Date.now() / 1000);
if (ttl > 0) await redis.set(`jwt:deny:${jti}`, '1', 'EX', ttl);

// in auth middleware
if (await redis.exists(`jwt:deny:${payload.jti}`)) return res.sendStatus(401);
```

- Better: **short-lived access token** (5–15 min) + **refresh token** stored in Redis. Revoke by deleting the refresh token.
- Or a **token version** per user: `user:42:tokver`. Increase it to kill all old tokens at once.
- Use `noeviction` (or a separate instance) so sessions are not evicted like cache. Turn on persistence/replication if losing sessions is a problem.

**🔍 Internal working:**
1. The session cookie holds only the signed session id. The data lives in Redis under `sess:<id>`.
2. Each request does one `GET` (O(1)). With `rolling`/`touch`, the store also resets the TTL.
3. The deny-list key has TTL = token's remaining life. So the list never grows forever. Expiry removes old entries.
4. `EXISTS` is O(1). It adds about one network RTT per request. Many teams add a short in-process cache.

**🎤 Say this in the interview:** "I store sessions in Redis with a TTL equal to the session lifetime and a prefix per app. For JWT I keep access tokens short and revoke through refresh tokens in Redis. If I need instant logout, I store the jti in a denylist with TTL equal to the token's remaining life."

**🧪 Real scenario:** After a deploy, all users were logged out at once. Sessions are stored in Redis.

**✅ Scenario answer:**
1. Root cause (common ones): the session `prefix` or the session `secret` changed, so old cookies do not match. Or Redis was restarted with no persistence, or sessions were evicted.
2. Confirm: `redis-cli --scan --pattern 'sess:*' | head` to see if keys exist and which prefix they use. Check `INFO persistence` and `evicted_keys`. Compare config between versions.
3. Fix: keep the secret stable (express-session accepts an array `secret: [newSecret, oldSecret]` for rotation). Restore the old prefix.
4. Prevention: use AOF persistence and `noeviction` for the session Redis. Add a test in CI that a session made by the old version still works after the deploy.

---

### Q14. Pub/Sub vs Streams vs Lists as queues. Scaling Socket.IO.
**🟢 In simple words:** Pub/Sub sends a message to everyone listening right now. If nobody listens, the message is lost. A List is a simple queue: one worker takes each item. A Stream is a saved log: messages stay, many groups can read them, and each message must be confirmed.
**🏠 Real-life example:** Pub/Sub is a radio broadcast — if your radio is off, you miss it. A List is a ticket queue at a bank. A Stream is a WhatsApp group chat — messages are saved and you can read old ones later.

| | Pub/Sub | List (`LPUSH` + `BLMOVE`) | Stream |
|---|---|---|---|
| Persistence | No (fire-and-forget) | Yes | Yes |
| Delivery | All current subscribers | One consumer per item | Consumer groups, each group gets all, one consumer per message in a group |
| Ack / retry | No | Manual (reliable queue pattern) | `XACK`, pending list, `XAUTOCLAIM` |
| Replay history | No | No | Yes (by ID) |
| Use | Live notifications, cache invalidation broadcast, Socket.IO | Simple job queue | Event sourcing, durable queues, many consumers |

Streams example:

```text
XADD orders * userId 42 total 99         -> "1700000000000-0"
XGROUP CREATE orders billing $ MKSTREAM
XREADGROUP GROUP billing w1 COUNT 10 BLOCK 5000 STREAMS orders >
XACK orders billing 1700000000000-0
XAUTOCLAIM orders billing w2 60000 0     (take messages stuck > 60s from dead worker)
```

Scaling **Socket.IO**: with many Node servers, a user on server A cannot get an emit from server B. The `@socket.io/redis-adapter` publishes each broadcast on Redis Pub/Sub. All servers subscribe and send it to their local sockets. You still need **sticky sessions** at the load balancer (for the HTTP long-polling transport). There is also a Redis **Streams** adapter that can recover missed messages after a short disconnect. Redis 7.0 added **sharded pub/sub** (`SPUBLISH`) for Cluster.

**🔍 Internal working:**
1. **Pub/Sub:** Redis keeps a dict channel → list of subscribed clients. `PUBLISH` loops over them and writes into each output buffer. Nothing is stored. A slow subscriber's buffer grows until `client-output-buffer-limit pubsub` disconnects it.
2. A subscribed connection can only run subscribe commands. So in Node you need a **separate connection** for subscribe.
3. **Stream:** stored as a radix tree (rax) keyed by ID (`ms-seq`). Each node holds a listpack of entries. IDs only go up, so appends are cheap.
4. **Consumer group:** stores `last_delivered_id` and a **PEL** (Pending Entries List). `XREADGROUP ... >` gives new messages and adds them to the PEL with the consumer name and delivery count.
5. `XACK` removes from the PEL. Unacked messages stay. `XPENDING` shows them. `XAUTOCLAIM` (6.2+) moves idle ones to a live consumer.
6. Trim with `XADD ... MAXLEN ~ 100000` (the `~` allows cheap, whole-node trimming).

**🎤 Say this in the interview:** "Pub/Sub is fire-and-forget to current subscribers, so I use it for Socket.IO fan-out and cache-invalidation broadcasts. For durable work I use Streams with consumer groups: the PEL tracks unacked messages, XACK confirms, and XAUTOCLAIM takes over from dead consumers. Lists are fine for a simple queue."

**🧪 Real scenario:** Some users do not get chat messages. The app runs 4 Node servers with Socket.IO and the Redis adapter. Messages are lost when a server restarts or is slow.

**✅ Scenario answer:**
1. Root cause: Pub/Sub is fire-and-forget. While a server is restarting or disconnected, it misses messages. A slow server can also be disconnected by `client-output-buffer-limit pubsub`.
2. Confirm: Redis log shows "scheduled to be closed ASAP for overcoming of output buffer limits". `CLIENT LIST` shows big `omem` for subscriber connections. `INFO stats` shows `client_output_buffer_limit_disconnections` (in newer versions).
3. Fix: store chat messages in a DB or a Redis Stream first. The client fetches missed messages by last-seen id on reconnect. Or use the Socket.IO Redis Streams adapter with connection state recovery.
4. Prevention: treat Pub/Sub only as a "live" signal, never as the only copy of data.

---

### Q15. BullMQ / job queues on Redis — how do they work inside?
**🟢 In simple words:** BullMQ is a popular Node.js job queue that stores everything in Redis. You add a job, and a worker process picks it up and runs it. Delayed jobs, retries and priorities are done with Redis lists, sorted sets and hashes. Every state change is a Lua script, so it is atomic.
**🏠 Real-life example:** It is like a restaurant order board. New orders go in "waiting". A cook moves one to "cooking" and holds a timer. If the cook disappears and the timer runs out, the order goes back to "waiting" for another cook.

```js
import { Queue, Worker } from 'bullmq';
const connection = { host: 'redis', port: 6379, maxRetriesPerRequest: null };

const q = new Queue('emails', { connection });
await q.add('welcome', { userId: 42 }, {
  attempts: 5, backoff: { type: 'exponential', delay: 1000 },
  delay: 60000, removeOnComplete: 1000, jobId: 'welcome:42',   // jobId = idempotency
});

new Worker('emails', async job => sendEmail(job.data), { connection, concurrency: 10 });
```

Keys (prefix `bull:emails:`):

| Key | Type | Purpose |
|---|---|---|
| `bull:emails:<id>` | Hash | Job data, opts, attempts, stacktrace |
| `:wait` | List | Ready jobs |
| `:active` | List | Jobs being processed |
| `:delayed` | Sorted Set | Score = time to run |
| `:prioritized` | Sorted Set | Jobs with priority |
| `:completed` / `:failed` | Sorted Set | Finished jobs (score = finish time) |
| `:<id>:lock` | String with TTL | Worker owns this job |
| `:events` | Stream | Events for `QueueEvents` listeners |
| `:id` | String | `INCR` counter for job ids |

**🔍 Internal working:**
1. `add()` runs a Lua script: `INCR` the id, `HSET` the job hash, then push it into `wait`, or `ZADD` into `delayed` / `prioritized`. It also `XADD`s an event. All in one atomic step.
2. The worker blocks on Redis (a blocking command, so no busy polling). Then a `moveToActive` Lua script moves the job to `active` and sets a **lock key** with a token and TTL (`lockDuration`, default 30s).
3. While the job runs, the worker **renews the lock** on a timer. Heavy sync CPU work blocks the Node event loop, so the lock cannot renew. That is a common cause of "stalled" jobs.
4. **Delayed jobs:** jobs whose score ≤ now are moved from the `delayed` sorted set to `wait` by scripts.
5. On finish, a Lua script removes the job from `active`, adds it to `completed`/`failed`, and releases the lock. On failure with attempts left, it goes to `delayed` with a backoff time.
6. **Stalled check:** a periodic script finds jobs in `active` with no lock. It moves them back to `wait` (up to `maxStalledCount`), or to `failed` after that.
7. So delivery is **at-least-once**. Make job handlers **idempotent**. Use `noeviction` on BullMQ's Redis.

**🎤 Say this in the interview:** "BullMQ keeps each job in a hash and its state in lists and sorted sets. Delayed jobs sit in a sorted set by run time. Every transition is an atomic Lua script. A worker holds a renewable lock; if the lock expires, the stalled checker re-queues the job. So it is at-least-once, and handlers must be idempotent. Redis must use noeviction."

**🧪 Real scenario:** BullMQ shows many "job stalled more than allowable limit" errors. Video thumbnail jobs fail and retry again and again.

**✅ Scenario answer:**
1. Root cause: the job does heavy synchronous CPU work (image processing) in the worker. The Node event loop is blocked, so the worker cannot renew the job lock. The lock expires and the stalled checker moves the job back.
2. Confirm: the stalled errors happen only for CPU-heavy job types. Measure event loop delay (`perf_hooks.monitorEventLoopDelay`). Check the lock key TTL: `PTTL bull:videos:<id>:lock`.
3. Fix: use a sandboxed processor (pass a file path to `new Worker`) so the work runs in a separate process, or use worker threads. You can also raise `lockDuration`.
4. Prevention: keep the worker event loop free. Make jobs idempotent, since stalled jobs can run twice.

---

### Q16. Build a leaderboard with sorted sets.
**🟢 In simple words:** A sorted set keeps members ordered by a score automatically. You add points to a player, and Redis keeps the ranking up to date. Getting the top 10 or a player's rank is very fast, even with millions of players.
**🏠 Real-life example:** It is like a live cricket scoreboard. Every time a player scores runs, the board re-orders itself at once. You can always see the top batsmen or find one player's position.

```js
await redis.zincrby('lb:game1:2026-11', 50, 'user:42');               // add points
const top10 = await redis.zrevrange('lb:game1:2026-11', 0, 9, 'WITHSCORES');
const rank = await redis.zrevrank('lb:game1:2026-11', 'user:42');      // 0-based
const score = await redis.zscore('lb:game1:2026-11', 'user:42');
// players around me
const r = rank ?? 0;
const around = await redis.zrevrange('lb:game1:2026-11', Math.max(0, r - 5), r + 5, 'WITHSCORES');
```

- Redis 6.2+: `ZRANGE key 0 9 REV WITHSCORES` replaces `ZREVRANGE`.
- **Ties:** members with the same score are sorted by member name (lexicographic). To make "first to reach wins", encode time in the score, e.g. `score * 1e6 + (MAX_TS - ts)` (watch double precision: about 15–16 safe digits).
- **Time-based boards:** one key per day/week/month with a TTL. Combine with `ZUNIONSTORE`.
- **Huge boards** (100M+ users): shard by score range or show only top-N exact and approximate rank for others.

| Operation | Complexity |
|---|---|
| `ZADD` / `ZINCRBY` | O(log N) |
| `ZRANK` / `ZREVRANK` | O(log N) |
| `ZRANGE` top K | O(log N + K) |
| `ZSCORE` | O(1) |

**🔍 Internal working:**
1. Small sets (≤128 members) are a listpack. Larger sets become **skiplist + hashtable**.
2. The **hashtable** maps member → score, so `ZSCORE` is O(1).
3. The **skiplist** is a sorted linked list with extra "express lanes". Each node gets a random level (p = 1/4, max 32 levels). Search jumps on high levels, then goes down: O(log N) on average.
4. Each forward link stores a **span** (how many nodes it skips). Adding spans on the search path gives the **rank** in O(log N).
5. `ZINCRBY` finds the member in the hash, removes it from the skiplist, and re-inserts it with the new score (or updates in place if order does not change).

```text
L3: head ───────────────────────────> 90 ───────────> nil
L2: head ─────────> 40 ─────────────> 90 ───────────> nil
L1: head ──> 10 ──> 40 ──> 55 ──────> 90 ──> 120 ───> nil
```

**🎤 Say this in the interview:** "I use a sorted set: ZINCRBY to add points, ZREVRANGE for the top N, ZREVRANK for a user's rank, all O(log N). Inside it is a skiplist with spans for rank, plus a hashtable for O(1) score lookup. I use one key per period with a TTL and encode time in the score to break ties."

**🧪 Real scenario:** The leaderboard shows two players with the same score in a random-looking order, and players complain. Also, the board key now has 50 million members and `ZREVRANGE 0 -1` calls are slow.

**✅ Scenario answer:**
1. Root cause: equal scores are sorted by member name, not by who scored first. And reading the full set is O(N), which blocks Redis.
2. Confirm: `ZSCORE` both players shows equal scores. `SLOWLOG GET` shows `ZREVRANGE ... 0 -1` calls. `MEMORY USAGE lb:game1` shows a huge key.
3. Fix: encode time in the score: `score * 1e6 + (MAX_TS - tsSeconds)`, staying inside double precision. Only read the top N with pagination: `ZREVRANGE lb 0 99`.
4. Prevention: use one board per period with TTL. Never call full-range reads on big sorted sets.

---

### Q17. How does Redis replication work?
**🟢 In simple words:** One main Redis server (master) takes all writes. One or more copies (replicas) receive every change and keep the same data. Copying is asynchronous: the master does not wait for the replica. So a replica can be a little behind, and a write can be lost if the master dies.
**🏠 Real-life example:** A teacher writes on the board, and students copy it into notebooks. Students are a few seconds behind. If the teacher erases the board before a student finishes, that student misses the last line.

- Setup: `REPLICAOF host port` on the replica. Replicas are **read-only** by default.
- **Async** by default. `WAIT numreplicas timeout` makes the client wait until N replicas got the write. This reduces loss, but it is still not a strong consistency guarantee.
- `min-replicas-to-write 1` + `min-replicas-max-lag 10`: the master refuses writes if no healthy replica. This limits data loss in split-brain.
- **Reading from replicas** scales reads, but reads can be **stale** (no read-your-writes). Read critical data from the master.

**🔍 Internal working:**
1. Every master has a **replication ID** (random string) and an **offset** (bytes of replication stream sent).
2. The replica connects and sends `PSYNC <replid> <offset>`.
3. **Partial resync:** if the replid matches and the offset is still in the master's **replication backlog** (a ring buffer, `repl-backlog-size`, default 1 MB), the master sends only the missing bytes (`+CONTINUE`).
4. **Full resync** (`+FULLRESYNC`): the master forks and makes an RDB (on disk, or **diskless** straight to the socket). It buffers new writes for this replica. The replica loads the RDB, then gets the buffered writes.
5. After sync, every write command is sent as a RESP stream. The replica acks its offset every second (`REPLCONF ACK`).
6. **PSYNC2 (4.0+):** after failover, the new master keeps the old replid as `replid2`. So other replicas can do a partial resync with it instead of a full one.
7. Tip: set a bigger backlog (e.g. 100+ MB) for busy masters, so short network breaks do not cause a costly full resync.

```text
replica ──PSYNC replid offset──> master
          ├─ offset in backlog? ──> +CONTINUE, send missing bytes
          └─ no ──> +FULLRESYNC: fork → RDB → stream buffered writes
```

**🎤 Say this in the interview:** "Replication is async. The replica sends PSYNC with replication ID and offset. If the offset is still in the backlog ring buffer it gets a partial resync, otherwise a full RDB sync. Because it is async, replica reads can be stale and acknowledged writes can be lost on failover. WAIT and min-replicas-to-write reduce that."

**🧪 Real scenario:** Users update their settings, refresh the page, and see the old settings. Reads go to Redis replicas.

**✅ Scenario answer:**
1. Root cause: replication is async. The read went to a replica that did not yet get the write. There is no read-your-writes on replicas.
2. Confirm: on the master and replica, compare `INFO replication` offsets (`master_repl_offset` vs replica `slave_repl_offset`). Look at lag during peak time.
3. Fix: read data the user just changed from the master. Or keep a short "recently wrote" flag per user (e.g. 2 s) and send those reads to the master.
4. Prevention: only send reads that can be a little stale to replicas. Alert on replication lag. If replicas do full resyncs often, increase `repl-backlog-size`.

---

### Q18. High availability: Redis Sentinel vs Redis Cluster.
**🟢 In simple words:** Sentinel watches a master and its replicas. If the master dies, Sentinels agree and promote a replica to be the new master. Cluster goes further: it splits data across many masters (sharding), and each master has replicas. Use Sentinel for HA with small data. Use Cluster when data or traffic is too big for one machine.
**🏠 Real-life example:** Sentinel is a backup goalkeeper waiting on the bench. Cluster is splitting a big library into many rooms by book number, with a backup librarian in each room.

| | Sentinel | Cluster |
|---|---|---|
| Sharding | No (one master) | Yes, 16384 hash slots across masters |
| Failover | By Sentinel processes (quorum) | Built in (masters vote) |
| Multi-key ops | All allowed | Only if all keys are in the same slot |
| Databases | 0–15 | Only DB 0 |
| Client | Asks Sentinel for master address | Cluster-aware client, follows redirects |

**Sentinel:**
- Run at least **3 Sentinels** on different machines.
- **Quorum** = how many Sentinels must agree the master is down (ODOWN). To actually do the failover, one Sentinel must be elected leader by a **majority** of Sentinels.

**Cluster:**
- `slot = CRC16(key) mod 16384`. Each master owns a range of slots.
- **Hash tags:** only the part inside `{}` is hashed. `{user:42}:cart` and `{user:42}:profile` go to the same slot, so `MULTI`, Lua and `MGET` work on them.
- Multi-key commands across slots → `CROSSSLOT` error.
- Minimum production: 3 masters + 3 replicas.

```js
const cluster = new Redis.Cluster([{ host: 'r1', port: 6379 }, { host: 'r2', port: 6379 }], {
  scaleReads: 'slave',        // optional: read from replicas (stale reads possible)
});
```

**🔍 Internal working:**
1. **Sentinel:** each Sentinel PINGs the master. No valid reply for `down-after-milliseconds` → **SDOWN** (subjectively down). When `quorum` Sentinels agree → **ODOWN**.
2. Sentinels elect a leader (Raft-like vote per epoch). The leader picks the best replica (priority, then replication offset, then run ID). It sends `REPLICAOF NO ONE` to it and points other replicas to it. Clients get the new address from Sentinel (`+switch-master`).
3. **Cluster:** nodes talk on a **cluster bus** (port + 10000) with a gossip protocol. They share slot maps and failure reports.
4. If a client sends a key to the wrong node, it gets `MOVED <slot> <ip:port>`. The client updates its slot map and retries. Smart clients cache the map, so this is rare.
5. During **resharding**, a slot is migrating. If the key already moved, the source replies `ASK <slot> <ip:port>`. The client sends `ASKING` then the command to the target, **one time**, without updating its map.
6. When a master fails (PFAIL → FAIL by majority of masters), its replica asks the other masters for votes. With a majority, it becomes master and takes the slots.

```text
key "{user:42}:cart" ──CRC16("user:42") mod 16384──> slot 8000 ──> master B (slots 5461–10922)
client → A: GET k  ⇒  -MOVED 8000 B   ⇒ client → B: GET k
```

**🎤 Say this in the interview:** "Sentinel gives automatic failover for one master: quorum marks it down and a majority-elected leader promotes a replica. Cluster shards data into 16384 slots by CRC16, with MOVED for a wrong node and ASK during migration. Multi-key ops need the same slot, so I use hash tags like {user:42}."

**🧪 Real scenario:** After moving to Redis Cluster, a feature fails with `CROSSSLOT Keys in request don't hash to the same slot`. It used `MGET cart:42 profile:42` and a Lua script with both keys.

**✅ Scenario answer:**
1. Root cause: in Cluster, the two keys hash to different slots, maybe on different nodes. Multi-key commands and scripts need all keys in one slot.
2. Confirm: `CLUSTER KEYSLOT cart:42` and `CLUSTER KEYSLOT profile:42` return different slots.
3. Fix: use hash tags so they share a slot: `{user:42}:cart` and `{user:42}:profile`. Migrate the old keys to the new names.
4. Prevention: design key names for Cluster from day one. But do not put too much under one tag, or you create a hot or big slot.

---

### Q19. Redis in production: memory, monitoring, Node connections, security.
**🟢 In simple words:** To run Redis well, keep memory small, watch slow commands, and use one shared connection from Node. Never put Redis open on the internet. Use passwords and user permissions. Turn off dangerous commands.
**🏠 Real-life example:** Running Redis is like running a busy kitchen. You keep the fridge tidy (memory), check which dishes take too long (slowlog), use one good delivery line (connection), and lock the back door (security).

**Memory optimization**
- Short key names, but still readable (`u:42:p` vs `user:42:profile` — choose what the team can read).
- Use **hashes** for small objects (listpack encoding is very compact).
- Always set TTLs on cache keys. Avoid big keys.
- Watch `mem_fragmentation_ratio` in `INFO memory`. If high, enable `activedefrag yes` (jemalloc).
- Keep about 30–50% headroom for fork CoW and buffers when persistence is on.

**Monitoring**

| Tool | Shows |
|---|---|
| `INFO` (memory, stats, replication, clients, persistence) | used_memory, hit/miss (`keyspace_hits/misses`), evicted_keys, connected_clients, repl lag |
| `SLOWLOG GET 10` | Commands slower than `slowlog-log-slower-than` (default 10 ms) |
| `LATENCY DOCTOR` / `LATENCY LATEST` | Latency spikes and causes (fork, expire, AOF) |
| `MEMORY USAGE key` / `MEMORY DOCTOR` | Bytes per key, memory issues |
| `redis-cli --bigkeys` / `--memkeys` / `--hotkeys` | Biggest keys / hot keys (hotkeys needs an LFU policy) |
| `CLIENT LIST` | Connections, buffer sizes |
| Prometheus `redis_exporter` + Grafana | Dashboards, alerts |

Never use `MONITOR` for long in production. It slows Redis a lot.

**Connections in Node**
- Redis connections are multiplexed: **one shared client per process** is enough for normal commands. A pool is not usually needed.
- You need **separate** connections for: Pub/Sub subscriber, blocking commands (`BLPOP`, `XREAD BLOCK`, BullMQ workers), and `WATCH`/`MULTI` with many concurrent flows.
- ioredis reconnects automatically (`retryStrategy`). It queues commands while offline (`enableOfflineQueue`). Set `maxRetriesPerRequest` and command timeouts so requests do not hang.
- Close it on shutdown with `redis.quit()`.

```js
const redis = new Redis(process.env.REDIS_URL, {
  retryStrategy: times => Math.min(times * 200, 2000),
  maxRetriesPerRequest: 3,
  enableAutoPipelining: true,
  tls: process.env.NODE_ENV === 'production' ? {} : undefined,
});
redis.on('error', err => logger.error({ err }, 'redis error'));
```

**Security**
- Bind to a private network only. Never expose port 6379 to the internet. `protected-mode yes`.
- **ACL** (6.0+): one user per app with only needed commands and key patterns, e.g. `ACL SETUSER api on >pass ~cache:* +@read +@write -@dangerous`.
- TLS (6.0+) for traffic in transit.
- Disable or rename dangerous commands (`FLUSHALL`, `CONFIG`, `KEYS`, `DEBUG`). ACL is the modern way. `rename-command` is the old way.

**🔍 Internal working:**
1. Redis uses **jemalloc**. It groups allocations into size classes. Deleting many keys can leave holes, which is fragmentation. Active defrag moves values into new memory to fill holes.
2. The slowlog is an in-memory ring buffer (`slowlog-max-len`). It measures only execution time, not network or queue time.
3. Each client has a query buffer and an output buffer. `client-output-buffer-limit` disconnects slow clients (replica, pubsub) that build huge buffers.
4. An ACL check happens before each command: the user's allowed commands and key patterns are checked. A denied command gets a `NOPERM` error.

**🎤 Say this in the interview:** "In production I set maxmemory with a policy, TTLs, and avoid big keys. I watch INFO hit ratio, evictions and replication lag, plus SLOWLOG and LATENCY DOCTOR. In Node I use one shared ioredis client with auto-pipelining and separate connections only for Pub/Sub and blocking commands. Redis stays on a private network with ACL users and TLS."

**🧪 Real scenario:** After a traffic spike, the Node app throws "max number of clients reached", and Redis shows 10,000 connections.

**✅ Scenario answer:**
1. Root cause: the code creates a `new Redis()` client inside the request handler, and never closes it. Each request opens a new connection.
2. Confirm: `INFO clients` shows `connected_clients` growing. `CLIENT LIST` shows thousands of connections from app IPs with `cmd=get` and large idle times.
3. Fix: create one client at startup and share it across the app (a module singleton). Use separate clients only for subscribe and blocking commands.
4. Prevention: alert on `connected_clients`. Set `timeout` in redis.conf to close idle clients. Add a code review rule: no Redis client creation inside handlers.

---

### Q20. Redis vs Memcached. When NOT to use Redis?
**🟢 In simple words:** Memcached is a simple, very fast cache for strings only. Redis has many data types, persistence, replication and scripting. Today most teams choose Redis. But Redis is not a good main database for important relational data, and it is costly when data is bigger than RAM.
**🏠 Real-life example:** Memcached is a simple notepad. Redis is a full notebook app with lists, tables and backup. But neither is a bank vault for your most important papers.

| | Redis | Memcached |
|---|---|---|
| Data types | Many (hash, list, zset, stream...) | Strings only |
| Threads | Single-threaded execution (+ I/O threads) | Multi-threaded |
| Persistence | RDB / AOF | None |
| Replication / HA | Yes (replicas, Sentinel, Cluster) | No built-in (client-side sharding) |
| Scripting, transactions, pub/sub | Yes | No |
| Max value size | 512 MB | 1 MB default |
| Memory | jemalloc + encodings | Slab allocator (can waste memory on mixed sizes) |

Choose Memcached only for a very simple, huge, multi-threaded string cache. Otherwise Redis.

**When NOT to use Redis:**
- **Primary DB for critical relational data** (money, orders): no joins, no foreign keys, no rich queries, async replication can lose acknowledged writes. Use PostgreSQL/MySQL as the source of truth.
- **Data much bigger than RAM:** RAM is costly. Use a disk-based DB.
- **Complex queries / analytics:** no SQL, no secondary indexes by default (Redis Query Engine exists but is not a full SQL DB).
- **Strict durability needs:** even `appendfsync always` is slower and still not like a real DB with replicated commits.
- **Strict-correctness distributed locks:** prefer etcd/ZooKeeper.
- **Heavy, long-term event streaming:** Kafka is better for big retention and replay.

**Licensing note:** Redis 7.4 (2024) moved from BSD to dual RSALv2/SSPLv1 licenses. The Linux Foundation then created **Valkey**, a BSD fork of Redis 7.2.4 (used by AWS, Google Cloud and others). Redis 8.0 (2025) added **AGPLv3** as an open-source option and built the old Redis Stack modules (JSON, search, time series, probabilistic) into the core. For an app using Redis over the network, this usually changes nothing. It matters for companies that sell Redis as a service.

**🔍 Internal working:**
1. Memcached uses many worker threads with locks on the hash table. It stores items in **slabs** (fixed-size chunk classes). A 100-byte item in a 120-byte chunk wastes 20 bytes.
2. Redis uses one execution thread and jemalloc with compact encodings. It scales by running more shards.
3. Memcached has no persistence or replication. A restart empties the cache, and clients shard keys by consistent hashing.
4. Redis async replication means a master can say `OK` and crash before the replica gets the write. That is why it should not be the only store for critical data.

**🎤 Say this in the interview:** "Redis beats Memcached on data types, persistence, replication and scripting. Memcached only wins for a plain multi-threaded string cache. I don't use Redis as the source of truth for critical relational data or for data bigger than RAM. I keep Postgres as the source of truth and Redis as a fast layer."

**🧪 Real scenario:** A team plans to use Redis as the only database for orders and payments "because it is fast". You are asked to review the design.

**✅ Scenario answer:**
1. Root cause of the risk: Redis replication is async, so an acknowledged write can be lost on failover. Data must fit in RAM. There are no joins, foreign keys or rich queries.
2. Confirm the risk: show the team that a failover test (kill the master during writes) loses the last writes. Estimate data size in a year vs RAM cost.
3. Fix: keep PostgreSQL (or MySQL) as the source of truth for orders. Use Redis for cache, sessions, rate limits, queues and idempotency keys.
4. Prevention: write down a rule in the architecture docs: "Redis holds data we can rebuild." Review new uses of Redis against that rule.

---
