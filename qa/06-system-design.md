# 06 — System Design (Senior / Lead)

## The 45-minute framework (use it EVERY time)
1. **Requirements (5 min):** functional (which features) + non-functional (scale, latency, availability, consistency). Ask questions first. Never jump straight into the design.
2. **Estimates (3 min):** DAU (daily active users), requests per second, storage per year, read:write ratio.
   - 1M DAU × 10 req/day ≈ 10M/day ≈ **~115 RPS** average (peak ×3–5).
3. **API design (5 min):** the main endpoints.
4. **Data model (5 min):** entities, SQL vs NoSQL, and why.
5. **High-level design (10 min):** client → CDN → LB → API services → cache → DB → queue → workers.
6. **Deep dive (12 min):** bottlenecks, scaling, failure handling. The interviewer picks the area.
7. **Wrap up (5 min):** trade-offs, monitoring, and what you would do next.

---

## Core concepts (quick answers)

### CAP theorem
**🟢 In simple words:** Data is copied to many servers. Sometimes the network breaks and the servers cannot talk to each other. Then you must choose: refuse requests (stay correct) or answer anyway (maybe with old data). You cannot have both during a network break.
**🏠 Real-life example:** Two bank branches lose their phone line. Branch A can stop giving cash until the line is back (consistent), or keep giving cash and fix the account books later (available).

During a network **P**artition (some servers cannot reach others), you must choose **C**onsistency or **A**vailability. Consistency = reject the request or return an error. Availability = serve data that may be old (stale). Banking → CP. Social feed → AP. **PACELC:** Else (when there is no partition) → you choose Latency vs Consistency.

**🔍 Internal working:**
1. In a replicated store, every write goes to a leader (or to a set of replicas). It is then copied to the other replicas over the network. A **partition** means some replicas cannot talk to the others. But clients can still reach both sides.
2. A **CP** system needs a **majority** of replicas to acknowledge a write. Examples: etcd/ZooKeeper (using Raft/ZAB), or a database with majority quorums. The minority side cannot form a majority. So it rejects writes (and linearizable reads). It is "unavailable" on that side, but it never returns wrong data.
3. An **AP** system lets each side keep accepting reads and writes locally. Examples: Cassandra with consistency level ONE, DynamoDB eventually-consistent reads. The replicas become different for a while.
4. When the partition is fixed, AP systems **reconcile** (bring the copies back in sync). Methods:
   - last-write-wins by timestamp (Cassandra);
   - hinted handoff (a node keeps writes meant for a down node and replays them later);
   - read repair;
   - anti-entropy repair, which compares Merkle trees (hash trees) of data ranges.
5. Quorums make this tunable. With N replicas, write quorum W and read quorum R: if **R + W > N**, the read set and the write set always overlap. So a read always sees the latest acknowledged write (e.g. N=3, W=2, R=2).
6. **PACELC**, no partition: synchronous replication waits for the followers. This is slower but consistent. Asynchronous replication returns fast. But a read from a follower can be old because of **replication lag** (the follower is behind the leader).

```text
N=3 replicas, W=2, R=2  ->  R + W = 4 > 3  -> overlap guaranteed

 write ack'd by:  [A] [B]  C
 read asks:        A  [B] [C]
                       ^ B is in both sets -> read sees newest version
```

**🎤 Say this in the interview:** "CAP only matters during a partition. A CP system refuses requests on the minority side, because it cannot reach a quorum. An AP system keeps serving and fixes the data later with last-write-wins, hinted handoff and read repair. With quorums, I tune this using R + W > N."

**🧪 Real scenario:** Your government portal uses PostgreSQL with the primary in one data center and a replica in another. The network link between the two data centers breaks. Citizen applications must never be lost or saved twice. What should the system do during the break?

**✅ Scenario answer:**
1. This is a network partition. For applications and payments, correct data is more important than uptime. So choose **CP** for writes.
2. Confirm it: monitoring shows the replica is unreachable and replication lag keeps growing. Health checks from each side show which side still has the primary.
3. Accept writes only on the primary side. On the other side, return a clear message like "Service busy, please try again in a few minutes" for submit actions.
4. Do not promote the replica to primary unless the old primary is surely stopped (fenced). Two primaries at the same time = split-brain = conflicting data. Tools like Patroni use a quorum store (etcd) to decide safely.
5. Read-only pages (notices, application status) can still be served from the replica with slightly old data. So read pages behave like **AP**.
6. Trade-off: some users see an error for a short time, but no application is lost or duplicated.

### Caching strategies
**🟢 In simple words:** A cache is a small, very fast store that keeps copies of data you use often. You check the cache first. Only if the data is not there, you go to the slower database. The hard part is keeping the copy fresh.
**🏠 Real-life example:** A shopkeeper keeps the most popular items on the counter. For anything else, he walks to the back storeroom, and then puts that item on the counter for the next customer.

- **Cache-aside (lazy loading):** the app reads the cache. On a miss, it reads the DB and then fills the cache. This is the most common pattern.
- **Write-through:** write to the cache and the DB together. **Write-behind:** write to the cache, and copy to the DB later, asynchronously (risk: data can be lost).
- **Invalidation:** TTL (time to live) + delete the key on update. Problems: **cache stampede** (many requests rebuild the same key at once; fix: lock/single-flight, jittered TTL), stale data, hot keys.
- Eviction: LRU (least recently used) / LFU (least frequently used).

**🔍 Internal working:**
1. **Cache-aside in Node:** `GET user:42` from Redis. On a miss, query the DB, then `SET user:42 <json> EX 300`. On update: write the DB first, then `DEL user:42`. We delete instead of set. This way, two writers running at the same time cannot leave an older value in the cache.
2. **Redis execution model:** one main thread runs an event loop (epoll/kqueue). It executes commands **one at a time**, so every single command is atomic. Since Redis 6, optional **I/O threads** can read and parse requests and write replies on sockets. But the command execution itself stays single-threaded.
3. **Memory layout:** all keys live in an in-memory hash table. It is rehashed step by step (a few buckets per operation), so a resize never blocks for long. Small hashes/sets/sorted sets use a compact **listpack** encoding. Large sorted sets use a **skiplist + hash table**.
4. **Expiry:** keys with a TTL are removed in two ways. **Lazily**: checked when someone accesses the key. **Actively**: a periodic job takes random keys that have a TTL and deletes the expired ones.
5. **Eviction at `maxmemory`:** the policy decides what happens. `noeviction` is the default; others are `allkeys-lru`, `volatile-lru`, `allkeys-lfu`, ... LRU is **approximate**. Redis samples a few keys (`maxmemory-samples`, default 5). It keeps the best candidates in an eviction pool. It evicts the key that has been idle the longest. For this it uses a 24-bit LRU clock stored in each object. LFU uses a small logarithmic access counter that goes down (decays) over time.
6. **Persistence (if the cache must survive restarts):** RDB = a point-in-time snapshot. A forked child process writes it (copy-on-write). AOF = append every write command to a log. `appendfsync everysec` is the usual balance between durability and speed.
7. **Stampede protection:** when a hot key expires, only one request rebuilds it. That request takes a lock with `SET lock:key <id> NX EX 10`. The others wait a little or serve the old value. Random jitter on TTLs stops many keys from expiring in the same second.

```text
App ──GET──► Redis ──miss──► App ──SELECT──► DB
 ▲                                          │
 └──────── SET key val EX ttl ◄─────────────┘
Update path:  UPDATE DB  →  DEL key  (next read repopulates)
```

**🎤 Say this in the interview:** "I use cache-aside with a TTL, plus delete-on-write. Redis executes commands on a single thread, so each command is atomic. When it hits maxmemory, it evicts with sampled, approximate LRU or LFU. I protect hot keys from stampedes with a SET NX lock and jittered TTLs."

**🧪 Real scenario:** After you added Redis caching, users sometimes see their old profile photo for 10 minutes after updating it. What went wrong and how do you fix it?

**✅ Scenario answer:**
1. Root cause: the update code writes the new photo URL to the DB, but it does not delete the cache key. So readers get the old value until the 10-minute TTL ends.
2. Confirm it: update a profile, then run `TTL user:42` and `GET user:42` in Redis. You will see the old data still there. Check the update function for a missing `DEL`.
3. Fix: after the DB update succeeds, delete the key: `await db.updateUser(id, data); await redis.del('user:' + id);`. The next read loads fresh data.
4. If the photo itself is served from a CDN or browser cache with the same URL, also change the URL on every update (for example `photo.jpg?v=1700000000`). Then the browser and CDN fetch the new file.
5. Prevention: put all user updates in one service function that always deletes the cache. Keep a short TTL as a safety net. Add a test that reads right after an update.

### Load balancing
**🟢 In simple words:** A load balancer sits in front of many servers. It sends each incoming request to one of them, so no single server is overloaded. It also stops sending traffic to servers that are sick.
**🏠 Real-life example:** At highway toll booths, a person waves each car to the shortest free lane and closes a lane when its booth is broken.

L4 (TCP) vs L7 (HTTP, can route by path). Algorithms: round-robin, least connections, IP hash (sticky). Health checks. Avoid sticky sessions → keep services stateless (no user data kept in server memory).

**🔍 Internal working:**
1. **L4 (TCP/UDP, e.g. AWS NLB, IPVS):** the LB looks only at IP and port. On the first packet of a new connection, it picks a backend (round-robin or a hash of the 5-tuple). It saves that choice in a connection table. Every later packet of that connection goes to the same backend. It never reads HTTP, so it cannot route by path or header. But it is very fast.
2. **L7 (HTTP, e.g. ALB, Nginx, Envoy):** the LB **terminates** (ends) the client's TCP and TLS connection. It parses each HTTP request. It chooses a backend **per request** (by path, host, header, cookie). It sends the request over a separate, pooled keep-alive connection to the backend. It can add `X-Forwarded-For`, retry, compress, and enforce timeouts. The cost is CPU for TLS and parsing.
3. **Why this matters for long-lived connections:** with L4, one HTTP/2 or gRPC connection carries many requests, but it is stuck to one backend → uneven load. An L7 LB balances each request/stream separately.
4. **Algorithms:**
   - round-robin rotates an index;
   - least-connections keeps a counter of active connections per backend and picks the smallest;
   - IP-hash / consistent hashing sends the same client to the same backend (stickiness without cookies).
5. **Health checks:**
   - *active* — the LB calls `/health` every few seconds. It marks a target unhealthy after X failures in a row, and healthy again after Y successes.
   - *passive* (outlier detection) — it removes a backend that returns many 5xx errors or timeouts on real traffic.
6. **Connection draining:** a target is removed (during deploy or scale-in). The LB stops sending new requests, but lets running requests finish (deregistration delay). In Node, on `SIGTERM`: make the readiness check fail, then call `server.close()` so existing requests can complete.

```text
L4:  client ══════ TCP conn (packets forwarded) ══════► backend
L7:  client ══ TCP/TLS #1 ══► [LB parses HTTP] ══ pooled TCP #2 ══► backend (chosen per request)
```

**🎤 Say this in the interview:** "An L4 balancer pins a whole TCP connection to one backend from the first packet and never reads HTTP. An L7 balancer terminates the connection, parses each request and routes it on its own. Health checks remove bad targets, and connection draining lets running requests finish during deploys."

**🧪 Real scenario:** You scaled your Node API from 1 server to 3 servers behind a load balancer. Now users say they get logged out randomly while filling a long form. What is the problem?

**✅ Scenario answer:**
1. Root cause: login sessions are stored in the memory of each Node process (the default `express-session` MemoryStore). A request that reaches another server finds no session, so the user looks logged out.
2. Confirm it: in the logs, add the server name. You will see the "logged out" requests reached a different server than the login request.
3. Fix: keep the servers stateless. Store sessions in Redis (for example with `connect-redis`), or use JWT tokens. Now every server can read every session.
4. Sticky sessions on the load balancer can be a quick temporary fix. But load becomes uneven, and if that server dies, its users still lose their sessions.
5. Prevention: no user data in server memory. Test with at least 2 instances before going to production.

### Message queues
**🟢 In simple words:** A queue is a waiting line for work between two services. One service drops a message and moves on. Another service picks it up when it is ready. This way, a slow or broken service does not block the other one.
**🏠 Real-life example:** In a restaurant, the waiter pins order slips on the kitchen rail and goes back to customers. The cooks take slips one by one at their own speed.

Queues decouple services (they do not need to wait for each other), absorb traffic spikes, and allow retries and async processing.
- **RabbitMQ/SQS/BullMQ** = task queues. A message is consumed once.
- **Kafka** = a distributed log. You can replay it. It has partitions, consumer groups, ordering per partition, high throughput, and is good for event streaming.

Delivery is usually **at-least-once** (a message can come more than once) → consumers must be **idempotent** (running twice gives the same result as once). Use a dead-letter queue (DLQ) for poison messages (messages that always fail).

**🔍 Internal working:**
1. **RabbitMQ:** the producer publishes to an **exchange**. Binding rules route the message into one or more queues. The broker pushes messages to consumers, up to the **prefetch** limit (`basic.qos`). A message stays "unacked" until the consumer acks it. If the consumer's channel or connection dies, unacked messages go back to the queue and are delivered again (with the `redelivered` flag). A `nack` with `requeue=false` sends the message to a dead-letter exchange.
2. **SQS:** the consumer **polls** (`ReceiveMessage`, long polling up to 20 s). A received message becomes invisible for the **visibility timeout** (default 30 s). The consumer must call `DeleteMessage` before the timeout ends. If not, the message becomes visible again and is delivered again → at-least-once. After `maxReceiveCount` receives, the redrive policy moves it to the DLQ. Standard queues can duplicate and reorder messages. FIFO queues keep order per message group and remove duplicates within a 5-minute window.
3. **Kafka storage:** a topic is split into **partitions**. Each partition is an **append-only log** on disk (you only add at the end). It is stored as segment files (`.log` plus offset and time indexes). The producer chooses the partition by hashing the key (murmur2 by default). So the same key always goes to the same partition → ordering per key.
4. **Kafka consumption:** every record has an **offset** (its position number in the partition). In a consumer group, each partition is given to exactly one consumer. The consumer commits its offset to the internal `__consumer_offsets` topic. Reading does **not** delete data. Retention is by time or size (or log compaction). So you can replay by resetting offsets.
5. **Rebalancing:** a consumer joins, leaves, misses heartbeats, or goes over `max.poll.interval.ms`. Then the group coordinator (a broker) gives the partitions out again. This is either stop-the-world (eager) or cooperative incremental rebalancing.
6. **Replication:** each partition has a leader and followers that copy from it. The **ISR** (in-sync replicas) are the followers that are up to date. With `acks=all` + `min.insync.replicas=2`, a write is acknowledged only after all current ISR members have it. Consumers only read up to the **high watermark** (committed data).
7. **Why Kafka is fast:**
   - sequential disk appends;
   - the OS **page cache** instead of an app-level cache;
   - batching + compression;
   - **zero-copy** (`sendfile`) from the page cache to the socket (not possible when the broker does TLS encryption).

```text
Topic "orders" (3 partitions)          Consumer group "billing"
P0: [0][1][2][3][4][5] ──► consumer A  (committed offset 4)
P1: [0][1][2][3]       ──► consumer B
P2: [0][1][2][3][4]    ──► consumer B
key "user42" → hash % 3 → always P1 → ordered for that user
```

**🎤 Say this in the interview:** "RabbitMQ and SQS remove a message only after an ack or delete. They deliver it again if the consumer dies or the visibility timeout expires. Kafka is a partitioned, append-only log where consumers just move an offset. So ordering is per partition, replay is free, and durability comes from acks=all with the in-sync replica set."

**🧪 Real scenario:** A worker reads "payment success" messages from a queue and sends an SMS to the citizen. Some citizens get the same SMS 2 or 3 times. Why, and how do you stop it?

**✅ Scenario answer:**
1. Root cause: the queue gives **at-least-once** delivery. If the worker crashes, or takes longer than the visibility timeout (SQS) before it acks or deletes the message, the message is delivered again.
2. Confirm it: log the message ID. You will see the same ID processed more than once. Compare the job processing time with the visibility timeout.
3. Fix: make the consumer **idempotent**. Before sending, save the message ID in a table with a unique constraint: `INSERT INTO processed_messages(id) VALUES ($1) ON CONFLICT DO NOTHING`. If 0 rows were inserted, skip the message.
4. Also set the visibility timeout longer than the normal processing time, and ack/delete only after the work is done.
5. Prevention: send messages that keep failing to a DLQ, and add an alert on the DLQ size.

### Database scaling
**🟢 In simple words:** When one database gets too slow, you fix it step by step. First make lookups faster, then reduce how often you hit it, then add copies for reading. Only at the end do you split the data across many machines.
**🏠 Real-life example:** A growing library first adds a good catalogue (index), then a "popular books" shelf at the door (cache), then copies of books in branch libraries (replicas), and finally splits books by subject into different buildings (shards).

Indexes → caching → read replicas → vertical partitioning → sharding. For sharding, choose the shard key carefully: even spread of data, no hot spots. Use consistent hashing.

**🔍 Internal working:**
1. **Indexes** are B+trees. A lookup walks from the root to a leaf in O(log n) page reads. Leaf pages are linked to each other, so range scans are fast. In MySQL InnoDB, the table itself is clustered (stored in order) on the primary key. So a secondary-index lookup finds the PK first, then does a second lookup. Postgres stores rows in a heap, and indexes point to row locations.
2. **Read replicas:** the primary streams its write-ahead log (Postgres WAL / MySQL binlog) to the replicas, which replay it. This is usually **asynchronous**, so replicas lag behind. A user may not see their own write. Fix: read from the primary right after a write, or send that user's reads to the primary for a few seconds.
3. **Connections:** each Postgres connection is a separate OS process. Many Node instances × a big pool can use up all DB connections. Use a small pool per instance and a pooler such as PgBouncer.
4. **Sharding:** a routing layer finds the shard from the shard key — by hash, by range, or through a lookup directory. A query without the shard key must go to all shards and collect the results (scatter-gather). Cross-shard joins and transactions are hard. So choose a key that keeps related data together (e.g. `tenant_id`).
5. **Resharding:** with `hash(key) % N`, changing N moves almost every key. Instead, use consistent hashing, or many fixed logical shards (e.g. 1024) mapped to fewer physical servers. Then you move whole logical shards.
6. **Hot spots:** range sharding on a key that always grows (timestamp, auto-increment ID) sends all new writes to the last shard. Hash the key or add a prefix to spread the writes.

**🎤 Say this in the interview:** "I scale step by step. First B+tree indexes, then caching, then async read replicas fed by the WAL, with read-your-writes handling. Only then sharding, with a carefully chosen key and logical shards, so resharding moves whole chunks instead of every key."

**🧪 Real scenario:** Your MIS dashboard page takes 12 seconds to load, and the database CPU is at 90% during office hours. Your manager asks, "Should we shard the database?" What do you do?

**✅ Scenario answer:**
1. Do not shard first. Most slow dashboards are caused by a few bad queries, not by too much data.
2. Find them: use `pg_stat_statements` (or the MySQL slow query log) to list the slowest and most frequent queries. Run `EXPLAIN ANALYZE` on them. A "Seq Scan" on a big table is a common sign.
3. Add the right index, for example `CREATE INDEX CONCURRENTLY idx_app_district_status ON applications(district_id, status);`. `CONCURRENTLY` avoids blocking writes while the index is built.
4. Dashboard counts do not need to be live to the second. Cache them in Redis for a few minutes, or use a materialized view refreshed by a job.
5. Send heavy reports to a read replica, so they do not slow down form submissions on the primary.
6. Shard only if, after all this, a single primary still cannot handle the writes.

### Consistent hashing
**🟢 In simple words:** Put the servers and the keys on a circle using a hash. Each key belongs to the next server going clockwise. If you add or remove a server, only the keys next to it move. All other keys stay where they are.
**🏠 Real-life example:** Houses on a round street get their post from the nearest post office going clockwise. If a new post office opens, only the houses just before it switch; everyone else keeps their old post office.

Nodes and keys are placed on a hash ring. A key goes to the next node clockwise. Adding or removing a node moves only ~1/N of the keys. Virtual nodes give an even spread. Used in caches, DynamoDB, Cassandra.

**🔍 Internal working:**
1. Hash every node — or better, every **virtual node** (`"nodeA#0"` … `"nodeA#149"`) — into a fixed space such as 0 … 2^32−1. Store the positions in a **sorted array**, together with the owner of each position.
2. **Lookup:** compute `h = hash(key)`. Then **binary search** for the first position ≥ h. If there is none, wrap around to index 0. Cost: O(log V), where V = number of virtual nodes.
3. **Adding a node:** its virtual nodes take over only the arcs between each new position and the position before it. Only those keys move — about 1/N of all keys. Every other key keeps its owner.
4. **Removing a node:** its arcs go to the next positions clockwise. Again, only its own keys move.
5. **Virtual nodes** spread each server over many small arcs. This evens out the load. It also lets a bigger machine get more vnodes (weighting).
6. **Replication (Dynamo/Cassandra style):** walk clockwise from the key's position. Pick the next R **distinct physical** nodes as replicas.
7. Compare with `hash(key) % N`: changing N from 4 to 5 moves about 80% of the keys. For a cache cluster, that means a huge wave of cache misses.

```text
sorted ring positions: [ 120:A, 900:B, 2100:C, 3400:A, 3900:B ]   (space 0..4095)
hash(key) = 2500  → binary search → first pos ≥ 2500 = 3400 → node A
hash(key) = 4000  → none ≥ 4000   → wrap to index 0   → 120  → node A
```

**🎤 Say this in the interview:** "Consistent hashing keeps virtual-node positions in a sorted array. I hash the key and binary-search for the next position clockwise. So adding or removing a node only moves the keys on its own arcs — about 1/N — instead of moving almost everything like hash mod N."

**🧪 Real scenario:** You run 4 Redis cache nodes and choose the node with `hash(key) % 4`. Before exam result day, you add a 5th node. Right after that, the database gets overloaded and the site becomes slow. What happened?

**✅ Scenario answer:**
1. Root cause: with `hash % N`, changing N from 4 to 5 moves about 80% of the keys to a different node. Those keys are not on the new node yet, so almost every read is a cache miss and goes to the database.
2. Confirm it: the cache hit rate graph drops sharply at the exact time the node was added, and DB queries per second jump.
3. Fix: use consistent hashing with virtual nodes, so adding a node moves only about 1/N of the keys. Or use Redis Cluster, which maps keys to 16384 fixed hash slots and moves only some slots to the new node.
4. Prevention: add capacity before the peak day, not on it. Warm the cache for hot keys (such as result pages) before traffic arrives.

### Microservices vs monolith
**🟢 In simple words:** A monolith is one big app. Microservices are many small apps that talk over the network. Small apps can be deployed and scaled separately, but network calls are slower and can fail. So start with one well-organized app and split it only when you really need to.
**🏠 Real-life example:** One big restaurant kitchen where everyone shouts to each other, versus separate food trucks that must phone each other for every order — more freedom, but calls get lost.

Start with a **modular monolith** (one app, split into clean modules). Split it when team size or scale really needs it.
- Microservices give independent deploys and scaling.
- But they also bring network failures, distributed transactions (**Saga** pattern), more need for observability, and data consistency problems.
- Communication: REST/gRPC (sync) or events (async).
- An API Gateway handles auth, rate limiting, and routing.

**🔍 Internal working:**
1. **Monolith call:** a normal in-process function call. It takes nanoseconds, needs no serialization, and one DB transaction can cover the whole operation.
2. **Microservice call:** serialize (JSON or Protobuf) → service discovery/DNS → reuse a pooled keep-alive TCP/TLS connection → network → the other service deserializes → the response comes back the same way. Each hop adds milliseconds. It also adds new failure types: timeouts, partial failure, unknown outcome.
3. **gRPC** sends Protobuf binary messages over **HTTP/2**. HTTP/2 multiplexes many streams at the same time over one TCP connection. REST/JSON is easier to debug, but larger and slower to parse.
4. **Resilience in the client:**
   - a timeout on every call;
   - retries with exponential backoff + jitter (only for idempotent operations);
   - a **circuit breaker**: closed → open (fail fast after many errors) → half-open (let a few test requests through) → closed.
5. **API gateway:** terminates TLS, checks the JWT, applies rate limits, and routes by path to the right service. It also adds/passes on a trace context (W3C `traceparent` header), so distributed tracing can join the spans together.
6. **Data:** each service owns its own database, so there are no cross-service joins. Other services keep a local copy of the data they need, updated through events. This is eventual consistency.

**🎤 Say this in the interview:** "Splitting a monolith turns function calls into network calls, with serialization, latency and partial failure. So every call needs timeouts, retries with backoff for idempotent operations, circuit breakers and tracing. That is why I start modular and split only on clear team or scaling boundaries."

**🧪 Real scenario:** Your team of 5 developers wants to split the MIS portal (one database) into 12 microservices "because it is modern". Many reports join students, fees and attendance tables. What is your advice?

**✅ Scenario answer:**
1. First ask: what real problem are we solving? Slow deploys, team conflicts, or one part that needs to scale? "Modern" is not a reason.
2. With 12 services and 5 people, each person owns many services. You add network failures, distributed tracing, and many deploy pipelines.
3. The reports need joins across students, fees and attendance. If each service owns its own DB, these joins become API calls or data copies. Reports get slower and harder.
4. Better plan: a **modular monolith**. Make clear modules (students, fees, attendance) with their own folders and interfaces, in one app and one DB.
5. Extract only one part with a clear need, for example a heavy PDF/certificate generator or a notification service that should scale on its own.
6. Trade-off: one deploy unit for now, but much less complexity. You can split more later when the team or traffic grows.

### Saga pattern
**🟢 In simple words:** In microservices, one business action touches many databases, so you cannot use one transaction. A saga does it as a chain of small steps. If a later step fails, you run "undo" steps for the earlier ones.
**🏠 Real-life example:** Booking a trip: you book the flight, then the hotel. If the hotel booking fails, you cancel the flight to undo the first step.

A saga runs a distributed transaction as a sequence of local transactions. Each step has a **compensating action** (an undo) for failures. Two styles: choreography (services react to events) or orchestration (a central coordinator gives commands). Use it with the **outbox pattern**: write the event into an outbox table in the same DB transaction, and a relay publishes it later. This avoids dual-write problems (updating the DB but failing to send the event, or the other way around).

**🔍 Internal working:**
1. **Orchestration:** the orchestrator stores the saga state (`saga_id`, current step, status) in its DB. It sends a command to service A and waits for the reply event. Then it moves to the next step. On a failure, it runs the **compensations of the finished steps in reverse order**.
2. **Each step = local transaction + outbox row, in one commit:** `BEGIN; UPDATE orders SET status='PENDING' ...; INSERT INTO outbox(id, topic, payload) ...; COMMIT;`. Either both happen or neither happens, so there is no dual-write problem.
3. **Outbox relay (polling):** a worker reads unpublished outbox rows in id order. It publishes them to the broker, then marks them as sent.
4. **Outbox relay (CDC — change data capture):** a tool such as Debezium reads the DB's change log (Postgres WAL via logical replication, or the MySQL binlog). It streams the outbox inserts to Kafka. No polling is needed, and order is kept.
5. The relay can crash after publishing but before marking the row as sent. Then the event is published again. So consumers must be **idempotent**: store processed message IDs in a table with a unique constraint, and skip duplicates.
6. Sagas have no isolation: other transactions can see the in-between state. So use **semantic locks** such as `status='PENDING'`. Also make compensations (refund, release stock) idempotent and safe to retry.

```text
Order svc:  BEGIN → UPDATE orders → INSERT outbox → COMMIT
                                        │
                     relay / CDC (reads outbox or WAL)
                                        ▼
                                  Kafka "order-events" → Payment svc (dedupe by event id)
```

**🎤 Say this in the interview:** "Each saga step is a local transaction that also inserts an outbox row in the same commit. A relay, or CDC from the WAL, publishes it. The relay gives at-least-once delivery, so consumers dedupe by event ID. Failures trigger idempotent compensations in reverse order."

**🧪 Real scenario:** An admission flow has 3 steps: create the application, take the payment, generate the admission letter. The payment succeeded, but the letter service crashed. Now the application stays "PENDING" forever. How do you fix this design?

**✅ Scenario answer:**
1. Root cause: there is no saga state tracking, no retry and no timeout. When one step fails, nobody continues or undoes the flow.
2. Confirm it: in the DB, find applications with `status = 'PENDING'` that are older than, for example, 30 minutes and have a successful payment.
3. Fix: use an orchestrator that saves the saga state (`saga_id`, current step, status). It retries the letter step with backoff. Letter generation must be idempotent (same application ID = same letter, never two).
4. If the step still fails after all retries, mark the saga as failed and run the compensation (for example, refund the payment) or send it to a manual-review queue.
5. Publish step events with the **outbox pattern**, so an event is not lost if the service crashes right after the DB commit.
6. Prevention: a reaper job that finds stuck sagas, plus an alert on how many sagas are stuck.

### Real-time communication
**🟢 In simple words:** Normally the browser must ask the server for news. For real-time apps, we keep a connection open so the server can push updates at once. SSE pushes only from server to browser. WebSockets let both sides send at any time.
**🏠 Real-life example:** Polling is a child asking "are we there yet?" every minute. SSE is a radio station that keeps broadcasting to you. A WebSocket is a phone call where both people can talk.

Polling → long polling → **SSE** (Server-Sent Events: server → client only, simple) → **WebSockets** (both directions). To scale WebSockets across many nodes, use Redis pub/sub or a message broker, plus sticky sessions or a connection gateway.

**🔍 Internal working:**
1. **WebSocket handshake:** the client sends a normal HTTP/1.1 `GET` with `Upgrade: websocket`, `Connection: Upgrade`, `Sec-WebSocket-Version: 13` and `Sec-WebSocket-Key` (16 random bytes, base64).
2. The server replies **`HTTP/1.1 101 Switching Protocols`** with `Sec-WebSocket-Accept = base64(SHA-1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))`. This proves the server really understands WebSocket. After this, the same TCP connection no longer carries HTTP.
3. **Frames:** each message is sent as frames. A frame has a FIN bit, an opcode (`0x1` text, `0x2` binary, `0x8` close, `0x9` ping, `0xA` pong), a mask bit and the payload length. Frames from client to server **must be masked** with a 4-byte key. This protects proxies in the middle from cache-poisoning attacks.
4. **Keep-alive:** ping/pong frames find dead connections. LB and proxy idle timeouts must be longer than the ping interval. If not, connections are cut silently.
5. **SSE:** a normal HTTP response with `Content-Type: text/event-stream` that never ends. The server writes `data: ...\n\n` blocks. The browser's `EventSource` reconnects automatically. It sends `Last-Event-ID`, so the server can continue from where it stopped.
6. **Scaling:** each Node process keeps its sockets in memory. To reach a user connected to another process, publish to a Redis channel. Every node is subscribed and delivers the message to its own local sockets (this is what the Socket.IO Redis adapter does). Socket.IO needs sticky sessions when HTTP long-polling is allowed, because all polling requests of one session must reach the same node.

```text
GET /chat  Upgrade: websocket, Sec-WebSocket-Key: dGhl...  ─────►
◄───── 101 Switching Protocols, Sec-WebSocket-Accept: s3pP...
◄════════ frames (text/binary/ping/pong/close) both ways ════════►
```

**🎤 Say this in the interview:** "A WebSocket starts as an HTTP request with an Upgrade header. The server answers 101 with a Sec-WebSocket-Accept made from the key. After that, the TCP connection carries framed messages both ways. To scale out, each node sends messages through Redis pub/sub to the sockets it holds."

**🧪 Real scenario:** You added live notifications with Socket.IO. It works on your laptop. In production with 3 Node instances behind a load balancer, users get only some notifications, and connections drop every 60 seconds. Why?

**✅ Scenario answer:**
1. Problem 1: the event is emitted on instance A, but the user's socket is on instance B. Instance A does not know about that socket, so the message is lost.
2. Fix 1: use the Socket.IO Redis adapter: `io.adapter(createAdapter(pubClient, subClient))`. Every instance gets the event through Redis pub/sub and sends it to its own sockets.
3. Problem 2: the load balancer has an idle timeout (AWS ALB default is 60 seconds). A quiet connection is closed silently.
4. Fix 2: keep the ping interval shorter than the LB idle timeout, or raise the idle timeout. Also turn on sticky sessions if HTTP long-polling is allowed.
5. Prevention: always test real-time features with 2+ instances behind the same LB setup as production.

---

## Practice problems — answer outlines

### 1. URL shortener (TinyURL)
**🟢 In simple words:** The service turns a long web address into a short code. When someone opens the short link, the server looks up the code and sends the browser to the long address. Most traffic is reading (redirects), so caching is very important.
**🏠 Real-life example:** A coat check: you hand over your big coat and get a small numbered token; later the token is used to find your coat quickly.

- APIs: `POST /shorten {longUrl}` → shortCode; `GET /:code` → 301/302 redirect.
- Scale: 100M URLs/month, read-heavy (100:1).
- Code generation: base62 of an auto-increment ID, a distributed ID generator (Snowflake), or a pre-generated key service. 7 chars = 62^7 ≈ 3.5 trillion.
- Storage: a KV store or SQL `(code PK, long_url, created_at, expiry, user_id)`.
- **Cache** hot codes in Redis; use a CDN. Use 302 if you need analytics (browsers cache 301).
- Analytics run asynchronously: queue → click events → an analytics DB.

**🔍 Internal working:**
1. **Snowflake ID (64 bits):** 1 unused sign bit + **41 bits** of milliseconds since a custom epoch (~69 years) + **10 bits** machine ID (1024 machines) + **12 bits** sequence (4096 IDs per ms per machine). IDs are unique without any coordination, and roughly sorted by time.
2. **Base62 encoding:** divide the number by 62 again and again, and map each remainder to `0-9a-zA-Z`. Note: 62^7 ≈ 3.5 × 10^12, which is less than 2^42. So a full 64-bit Snowflake ID becomes up to **11** characters. For 7-character codes, use a counter with **range allocation**: each app server reserves a block of IDs (e.g. 1,000,000 at a time) from the DB/ZooKeeper. Or use a pre-generated key service.
3. **Redirect path:** `GET /aZ3kQ9x` → Redis `GET` → on a miss, read the DB and fill the cache → respond with a `Location` header.
4. **301 vs 302:**
   - A **301 Moved Permanently** is cacheable by default. The browser (and CDN) may store it and send the next click directly to the long URL. Your server never sees that click. So you lose analytics and cannot change the target.
   - A **302 Found** is not cached unless you add `Cache-Control`/`Expires`. So every click reaches you.
   - Middle ground: 301/302 with an explicit `Cache-Control: max-age=...`.
5. **CDN edge:** the CDN's edge location (PoP) caches the redirect response based on `Cache-Control` (`s-maxage` for shared caches). A cache hit is answered at the edge, close to the user. A miss goes to your origin server.
6. **Analytics:** the redirect handler sends a click event to Kafka/a queue without waiting (fire-and-forget). So the redirect stays fast. Consumers add up the counts in batches.

```text
Snowflake: | 0 | 41-bit timestamp (ms) | 10-bit machine | 12-bit sequence |
```

**🎤 Say this in the interview:** "I generate IDs without coordination — Snowflake or per-server ID ranges — and base62-encode them. Reads hit Redis first. When analytics matter, I return 302, or a redirect with a short Cache-Control, because browsers and CDNs cache a 301 and the clicks never reach my server."

**🧪 Real scenario:** The marketing team says your short links show far fewer clicks than the visits their website analytics show. Your service returns 301 redirects. What is wrong?

**✅ Scenario answer:**
1. Root cause: a 301 is cached by browsers (and maybe the CDN). After the first click, the browser goes straight to the long URL. Your server never sees the later clicks.
2. Confirm it: open the short link twice in Chrome DevTools. The second time, the Network tab shows the 301 came from cache.
3. Fix: return a **302** for links that need analytics. Or send a short `Cache-Control: max-age=...` if you want some caching.
4. Keep the redirect fast: send the click event to a queue (fire-and-forget) and count it in a background worker.
5. Trade-off: 302 means more requests reach your servers, so cache the code → URL mapping in Redis.

### 2. Rate limiter (distributed)
**🟢 In simple words:** A rate limiter stops one user from sending too many requests. Each user gets a bucket of tokens that refills slowly. Every request uses one token; with no tokens left, the request is rejected. The bucket is kept in Redis so all servers share the same count.
**🏠 Real-life example:** An amusement park gives you 10 ride tickets per hour. When your tickets are gone, you must wait for the next hour's tickets.

A token bucket per user/API key in Redis, with a Lua script for an atomic read+update. Put it in the API gateway or middleware. Return 429 + `Retry-After`. Keep a rules config per tier. Decide fail-open vs fail-closed if Redis is down. At very high scale, use a local in-memory limiter plus a global sync.

**🔍 Internal working:**
1. Each user/API key has a token bucket stored in a Redis hash: `{ tokens, last_refill_ms }`.
2. On every request, the middleware runs a **Lua script** (`EVALSHA`):
   - refill = `(now − last) × rate`;
   - `tokens = min(capacity, tokens + refill)`;
   - if `tokens ≥ 1`, decrement and allow; else deny;
   - write back with `HSET` and set an expiry with `PEXPIRE`.
3. **Why Lua:** Redis runs the whole script on its single command thread. No other client's command can run in the middle. So the read-modify-write is atomic across all Node instances, without any locks. Keep scripts short, because a running script blocks the whole server.
4. Use one source of time — for example the timestamp from Redis `TIME`, or well-synced app servers. Then clock differences (skew) between app servers cannot give extra tokens.
5. **Redis Cluster:** all keys used by one script must be in the same hash slot. Use hash tags such as `rl:{user42}`.
6. **Alternatives:**
   - fixed window = `INCR` + `EXPIRE` (cheap, but allows bursts at the window edges);
   - sliding-window log = a sorted set of timestamps with `ZREMRANGEBYSCORE` + `ZCARD` + `ZADD` (exact, but uses memory for every request).
7. On deny, return `429 Too Many Requests` with `Retry-After` (seconds until the next token).

**🎤 Say this in the interview:** "The token bucket lives in a Redis hash and is updated by a Lua script. Redis runs the script atomically on its single thread, so every API instance sees a consistent bucket without distributed locks. When the bucket is empty, the client gets 429 with Retry-After."

**🧪 Real scenario:** Your login API allows 5 attempts per minute per user. You have 4 API servers. Attackers still make about 20 attempts per minute on one account. Why?

**✅ Scenario answer:**
1. Root cause: the counter is kept in each server's memory. Each of the 4 servers allows 5 attempts, so the real limit is 4 × 5 = 20.
2. Confirm it: logs show the attempts spread across all 4 servers, with each server allowing 5.
3. Fix: keep the counter in Redis, shared by all servers. Simple version: `const n = await redis.incr(key); if (n === 1) await redis.expire(key, 60); if (n > 5) return res.status(429).end();`.
4. `INCR` and `EXPIRE` are two commands. For full safety (no key left without expiry), run them together in a Lua script, or use a token bucket script.
5. Limit by username and also by IP address. Return `429` with `Retry-After`. Decide what happens if Redis is down (for login, fail-closed is safer).

### 3. Notification service (email/SMS/push)
**🟢 In simple words:** The app asks to send a message, and the service puts it in a queue for the right channel (email, SMS or push). Workers take jobs from the queue and call outside providers. If sending fails, they try again later. A unique key makes sure the user never gets the same message twice.
**🏠 Real-life example:** A post office sorts letters into separate bags for air mail, local mail and parcels; if delivery fails, the letter goes back to try again tomorrow.

API → validate + check user preferences + templates → **queue per channel** (priority queues) → workers → third-party providers (SES, Twilio, FCM). Add: retries with exponential backoff, DLQ, an idempotency key to avoid duplicates, rate limiting per provider, delivery status tracking, scheduling, and opt-out compliance.

**🔍 Internal working:**
1. The API inserts a notification row with an **idempotency key** under a unique constraint. A retried request hits the constraint and returns the existing result, instead of sending twice.
2. **BullMQ internals:** jobs are stored in Redis: a hash per job, plus lists/sorted sets for waiting, active, delayed, completed and failed. All state changes run as Lua scripts, so they are atomic.
3. A worker moves a job from *waiting* to *active* and holds a **lock** that it keeps renewing. If the worker process dies, the lock expires. The job is then detected as **stalled** and moved back for another try.
4. **Retries with backoff:** a failed job goes into the **delayed sorted set**. Its score = the time it should run again (e.g. `now + base × 2^attempt`). When that time comes, it moves back to waiting. After the maximum number of attempts, it stays in *failed* (your DLQ) so you can inspect or retry it by hand.
5. **Provider limits:** a per-queue rate limiter (max N jobs per duration) keeps you under the SES/Twilio/FCM quotas. Separate queues per channel and priority mean a slow SMS provider cannot block emails.
6. Provider callbacks/webhooks update the delivery status. For push, an "invalid/unregistered token" response means you delete that device token.

**🎤 Say this in the interview:** "I keep one queue per channel in BullMQ. Jobs live in Redis and move between states through atomic Lua scripts. A worker holds a renewable lock, so crashed jobs are detected as stalled and retried. Retries use a delayed sorted set for exponential backoff, and an idempotency key stops duplicate sends."

**🧪 Real scenario:** On result day you must send an SMS to 2 lakh students. The SMS provider allows 100 SMS per second. It starts returning 429 errors, and many students never get their SMS. How do you fix this?

**✅ Scenario answer:**
1. Root cause: the workers send as fast as they can, with no rate limit. Failed sends are not retried.
2. Confirm it: provider logs and your job logs show many 429 responses at the start of the batch.
3. Fix: put every SMS as a job in a BullMQ queue. Set a rate limit on the worker: `limiter: { max: 100, duration: 1000 }`.
4. Retry failed jobs with backoff: `attempts: 5, backoff: { type: 'exponential', delay: 2000 }`. Jobs that still fail go to the failed list for review.
5. Use a stable job ID like `result-sms:${studentId}` as the idempotency key, so a student does not get the same SMS twice if the batch is started again.
6. Track delivery status from the provider's callback, and show a progress count to the admin.

### 4. Chat application (WhatsApp-like)
**🟢 In simple words:** Each user keeps an open WebSocket connection to a gateway server. When A sends a message, it is saved in the database and then pushed to the server where B is connected. If B is offline, B gets a push notification and downloads missed messages when back online.
**🏠 Real-life example:** A hotel switchboard: the operator writes every message in a logbook, checks which room the guest is in, and connects the call; if the guest is out, a note is left at reception.

- WebSocket gateway servers (they hold stateful connections).
- A session registry in Redis (user → server).
- Message service → store in Cassandra/Mongo (partitioned by conversation_id, sorted by time) → route to the recipient's server via pub/sub or Kafka.
- Offline users → push notification + fetch on reconnect.
- Also: delivery receipts (sent/delivered/read), message order per conversation, group fan-out, media in S3 + CDN, presence with heartbeats.

**🔍 Internal working:**
1. The client opens a WebSocket to a gateway server (through an LB that supports the HTTP Upgrade). The gateway registers the session: `SET session:user42 gw-7 EX 60`. Heartbeats refresh it. This is also the presence (online) signal.
2. **Send:** A → gw-3 → the message service gives the message an ID (Snowflake or a per-conversation sequence number). It writes the message to Cassandra, partitioned by `conversation_id` and clustered by message ID. Then it acks "sent" to A.
3. **Cassandra write path:** append to the commit log + write to the in-memory memtable. Later, the memtable is flushed to immutable SSTables on disk (LSM tree). That is why writes are very fast.
4. **Route:** look up B's gateway in Redis → publish to that gateway's channel (Redis pub/sub or a Kafka topic) → gw-7 writes a frame to B's socket → B's client acks → a "delivered" receipt goes back to A the same way.
5. **Offline:** no session → send a push notification (APNs/FCM). On reconnect, the client sends its last received message ID and fetches everything newer from Cassandra.
6. **Ordering:** use `conversation_id` as the Kafka partition key (one partition = ordered), plus a sequence number per conversation. The client sorts by it and detects gaps.

```text
A ──ws──► gw-3 ──► message svc ──► Cassandra (partition = conversation_id)
                        │
                        └─ Redis: session:B → gw-7 ─► pub/sub "gw-7" ─► gw-7 ──ws──► B
```

**🎤 Say this in the interview:** "Gateways hold the WebSocket connections and register user-to-server mappings in Redis. The message service saves to Cassandra, partitioned by conversation, then routes to the recipient's gateway through pub/sub. Offline users get a push, and on reconnect they sync from their last message ID."

**🧪 Real scenario:** Users complain that when they open the chat app after being offline, some messages are missing or shown in the wrong order. What is your fix?

**✅ Scenario answer:**
1. Root cause: the client depends only on live push messages, and sorts by the sender's device time. Messages sent while the user was offline are never fetched, and device clocks can be wrong.
2. Confirm it: compare the messages in the DB for one conversation with what the client shows. Look for gaps and wrong order.
3. Fix ordering: the server gives each message a sequence number per conversation. The client sorts by this number, not by device time.
4. Fix missing messages: on reconnect, the client sends its last received sequence number. The server returns all newer messages from the DB.
5. If the client sees a gap (it has 10 and 12 but not 11), it asks the server for the missing range.
6. Prevention: delivery acks from the client, and tests that turn the network off and on.

### 5. News feed (Twitter/LinkedIn-like)
**🟢 In simple words:** Each user has a ready-made list of post IDs from the people they follow. When someone posts, we add the post ID to all followers' lists (push). For celebrities with millions of followers, this is too expensive, so we fetch their posts at read time instead (pull).
**🏠 Real-life example:** A newspaper is delivered to every subscriber's door each morning (push); but for a huge magazine, people go to the shop and pick it up when they want it (pull).

**Fan-out on write** = push the post into followers' feed caches (fast reads, but costly for celebrities). **Fan-out on read** = pull posts when the user opens the feed. Hybrid: push for normal users, pull for celebrities. Feed cache in Redis (sorted sets), a ranking service, cursor-based pagination.

**🔍 Internal working:**
1. **Fan-out on write:** a new post sends an event. Fan-out workers go through the follower list page by page. For each follower: `ZADD feed:{uid} <timestamp> <postId>`, then trim with `ZREMRANGEBYRANK feed:{uid} 0 -801` to keep only the newest 800 IDs.
2. **Redis sorted set internals:** small sets use a compact listpack. Large ones use a **skiplist + hash table**. The hash table gives O(1) "score of this member". The skiplist keeps members ordered by score, so insert, delete and range-by-rank/score are O(log n).
3. **Read:** `ZREVRANGE feed:{uid} 0 19` (or `ZRANGE ... REV`) → 20 post IDs → load the post bodies with `MGET`/a pipeline → merge posts pulled at read time from followed celebrities → ranking → response.
4. **Cursor pagination:** the client sends the score (timestamp) of the last item it saw. The next page is `ZREVRANGEBYSCORE feed:{uid} (<lastScore> -inf LIMIT 0 20`. New posts at the top do not shift the page. Offset pagination has this problem.
5. Store only IDs in the feed, not the post content. Then an edit or delete updates only one place.

```text
Skiplist (ordered by score):
L3: head ───────────────────────► 50 ─────────► nil
L2: head ─────────► 20 ─────────► 50 ─────────► nil
L1: head ──► 10 ──► 20 ──► 35 ──► 50 ──► 70 ──► nil
search 35: go right on high levels, drop down when the next node is too big → O(log n)
```

**🎤 Say this in the interview:** "Feeds are Redis sorted sets of post IDs, scored by time. Inside, a skiplist plus a hash table gives O(log n) inserts and range reads. I fan out on write for normal users, pull celebrity posts at read time, and paginate with a score cursor."

**🧪 Real scenario:** A state education department account with 5 million followers posts an important notice. Your fan-out workers take 40 minutes to finish, and posts from normal users are also delayed. How do you fix it?

**✅ Scenario answer:**
1. Root cause: pure fan-out on write. One post means 5 million `ZADD` writes, and this big job blocks the same queue used by everyone else.
2. Confirm it: queue metrics show a huge backlog right after the big account posts.
3. Fix: use the hybrid model. Mark accounts with very many followers as "celebrity". Do not fan out their posts. At read time, fetch their recent posts and merge them into the user's feed.
4. Use a separate queue (or lower priority) for big fan-out jobs, so normal users' posts are not stuck behind them.
5. Trade-off: reading the feed becomes a little slower (an extra merge), but writing becomes fast and stable. Cache the celebrity's recent posts in Redis.

### 6. File upload service / large CSV import (very relevant for MIS portals)
**🟢 In simple words:** The server gives the browser a special signed link. The browser uploads the file directly to S3 with it, so the big file never passes through our API. Then a background worker reads the file piece by piece, checks the rows, and saves them in batches. The user can watch the progress.
**🏠 Real-life example:** A warehouse gives a supplier a gate pass; the truck unloads straight into the warehouse (not through the office), and workers then unpack the boxes one pallet at a time.

Client gets a **pre-signed S3 URL** → uploads directly (multipart for large files) → an S3 event → queue → a worker **streams** and parses the CSV in batches → validates → `bulkCreate` in chunks inside transactions → progress saved in Redis/DB → the client polls or gets SSE updates for status → an error report file.

**🔍 Internal working:**
1. **Creating a pre-signed URL needs no call to S3.** The server signs it locally with its credentials using **SigV4**. It builds a *canonical request*: method, path, sorted query params (such as `X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Date`, `X-Amz-Expires`, `X-Amz-SignedHeaders`), the signed headers, and `UNSIGNED-PAYLOAD`.
2. Then it builds a *string to sign*: algorithm, timestamp, scope `date/region/s3/aws4_request`, and the SHA-256 of the canonical request. It makes a signing key with a chain of HMAC-SHA256 calls (secret → date → region → service → `aws4_request`). It adds the final HMAC as `X-Amz-Signature`.
3. **S3 verifies** by computing the same signature again with the secret of that access key. It checks that the URL has not expired (SigV4 maximum is 7 days; with temporary STS credentials it also stops working when the session ends). It also checks that the signer has permission. Any change to a signed part → `403 SignatureDoesNotMatch`.
4. **Multipart upload:**
   - `CreateMultipartUpload` returns an `uploadId`.
   - Each part (5 MB–5 GB, the last part may be smaller, up to 10,000 parts) is uploaded — in parallel, each with its own pre-signed URL — and returns an ETag.
   - `CompleteMultipartUpload` sends the list of part numbers + ETags, and S3 joins them into one object.
5. S3 sends an `ObjectCreated` event → SQS → a worker. The worker calls `GetObject`, gets a **readable stream**, and pipes it through a CSV parser.
6. **Backpressure keeps memory flat:** if the consumer is slower, the stream's internal buffer reaches `highWaterMark` and the source is paused. With `for await (const row of parser)`, you collect 1,000 rows, `await` the bulk insert, then continue.
7. Progress is updated with `HINCRBY import:{id} processed 1000`. Bad rows are written to an error-report file that the user downloads at the end.

**🎤 Say this in the interview:** "The server signs a SigV4 pre-signed URL locally with an HMAC chain. The browser uploads straight to S3, so my API never carries the bytes. The worker then streams the object through a CSV parser, and Node stream backpressure keeps memory constant while I insert in batches."

**🧪 Real scenario:** A district officer uploads a 200 MB CSV file with 10 lakh rows. The Node API crashes with "JavaScript heap out of memory". How do you redesign the import?

**✅ Scenario answer:**
1. Root cause: the whole file is loaded into memory (for example multer memory storage or `fs.readFile`), and then parsed into one huge array of rows.
2. Confirm it: memory graphs show the process memory rising quickly during the upload until it crashes.
3. Fix the upload: give the browser a pre-signed S3 URL. The file goes straight to S3, not through the API.
4. Fix the processing: a background worker **streams** the file and inserts in batches: `for await (const row of stream.pipe(parse({ columns: true }))) { batch.push(row); if (batch.length === 1000) { await Model.bulkCreate(batch); batch = []; } }`. Insert the last small batch after the loop.
5. Validate each row. Write bad rows to an error-report file. Save progress (rows done) so the user can see a progress bar.
6. Prevention: set a file size limit, and run imports in a queue so many imports at the same time do not overload the DB.

### 7. E-commerce checkout / inventory
**🟢 In simple words:** The main danger is selling more items than you have when many people buy at the same time. We reduce the stock with one safe database command that only works if stock is above zero. Checkout is a saga: reserve stock, take payment, confirm — and give the stock back if payment fails.
**🏠 Real-life example:** A concert ticket counter with one last ticket: only the first person whose hand reaches the counter gets it; everyone after hears "sold out".

Prevent overselling with a reserve-inventory step: `SELECT ... FOR UPDATE`, or an atomic `UPDATE stock SET qty = qty-1 WHERE id=? AND qty>0`, or Redis `DECR` for flash sales. Order saga: reserve stock → payment (idempotency key) → confirm. On failure, compensate (release the stock). Reservations expire through delayed jobs.

**🔍 Internal working:**
1. **Atomic conditional update:** `UPDATE stock SET qty = qty - 1 WHERE id = ? AND qty > 0` takes a row lock. A second UPDATE on the same row, at the same time, waits. In Postgres (READ COMMITTED), when the first one commits, the waiting UPDATE checks its `WHERE` again on the newest row version. If `qty` is now 0, it updates **0 rows**. Always check the affected-row count.
2. **`SELECT ... FOR UPDATE`:** locks the selected rows until the transaction ends. Other `FOR UPDATE`/`UPDATE`/`DELETE` on those rows wait. But plain `SELECT`s are not blocked (with MVCC, readers see the last committed version). Keep the transaction short.
3. **Deadlocks:** two transactions lock items in different orders, so they can wait for each other forever. Postgres detects this (after `deadlock_timeout`, default 1 s) and aborts one of them. Fix: always lock rows in the same order (e.g. sort by `product_id`).
4. **Flash sale with Redis:** `DECR stock:sku1` is atomic because of the single command thread. If the result is < 0, `INCR` it back and reject. Write the real order to the DB asynchronously and reconcile (match up) the counts afterwards.
5. **Reservation expiry:** a reservation row with `expires_at`, plus a delayed job. If payment has not succeeded by then, the job releases the stock (idempotently — check the status first).
6. **Payment idempotency key:** the payment provider stores key → result. A retry with the same key returns the stored result instead of charging again.

**🎤 Say this in the interview:** "I prevent overselling with a conditional UPDATE. The row lock serializes buyers, and Postgres re-checks qty > 0 on the latest version, so the loser updates zero rows. For flash sales I use atomic Redis DECR. Reservations expire through delayed jobs, and payments are idempotent."

**🧪 Real scenario:** During seat allotment, only 50 seats were left in a course, but 53 students got confirmed seats. How did this happen, and how do you stop it?

**✅ Scenario answer:**
1. Root cause: a read-then-write race. The code does `SELECT seats_left`, checks `> 0` in Node, then runs `UPDATE`. Two requests read the same value at the same time, and both think a seat is free.
2. Confirm it: logs show several confirmations in the same few milliseconds for the last seats.
3. Fix: do the check and the update in one atomic statement: `UPDATE courses SET seats_left = seats_left - 1 WHERE id = $1 AND seats_left > 0`. If the affected row count is 0, the seat is gone. Tell the student.
4. Also add a unique constraint on `(student_id, course_id)`, so the same student cannot get two seats from double-clicks.
5. Prevention: load test the allotment API with many parallel requests before the real day.

### 8. Design a job scheduler / background processing system
**🟢 In simple words:** Jobs are saved in a database table with the time they should run. Many workers keep asking "which jobs are due now?" and each takes different jobs, without fighting over the same one. If a job fails, it is scheduled again for later; if a worker crashes, its job is given back.
**🏠 Real-life example:** A to-do board in a bank: each clerk takes the top cards that nobody is holding, puts their name on them, and if a clerk goes home sick, the manager puts their cards back on the board.

API to create jobs → store in a DB with `run_at` → a scheduler polls due jobs (`SELECT ... FOR UPDATE SKIP LOCKED`) → pushes them to a queue → workers run them. Add: retries/backoff, timeouts, DLQ, idempotency, cron support, and a monitoring dashboard (e.g. BullMQ + Bull Board).

**🔍 Internal working:**
1. Table `jobs(id, type, payload, run_at, status, attempts, locked_by, locked_at)` with an index on `(status, run_at)`.
2. Each worker claims jobs in a short transaction: `SELECT id FROM jobs WHERE status='pending' AND run_at <= now() ORDER BY run_at LIMIT 10 FOR UPDATE SKIP LOCKED;` then `UPDATE ... SET status='running', locked_by=$me, locked_at=now()` and `COMMIT`.
3. **`SKIP LOCKED`** makes the query skip rows that another transaction has already locked, instead of waiting for them. So 20 workers can poll at the same time, each gets different jobs, and nobody blocks (Postgres 9.5+, MySQL 8.0+).
4. **Crash recovery:** a reaper (cleanup job) finds jobs stuck in `running` with an old `locked_at` and resets them to `pending`. This means a job can run twice → handlers must be idempotent.
5. **Retry:** on failure, `attempts = attempts + 1`, `run_at = now() + backoff(attempts)`. After the maximum, `status = 'dead'` (DLQ) and send an alert.
6. **Cron jobs:** after a run, compute the next `run_at` from the cron expression (in the correct time zone) and insert it. A unique constraint on `(job_name, run_at)` stops two scheduler instances from creating duplicates.
7. To avoid constant polling, Postgres `LISTEN/NOTIFY` can wake the workers when a new job is inserted.

```text
worker-1: SELECT ... FOR UPDATE SKIP LOCKED  → gets jobs 1,2,3 (locks them)
worker-2: SELECT ... FOR UPDATE SKIP LOCKED  → skips 1,2,3 → gets 4,5,6
```

**🎤 Say this in the interview:** "Workers claim due jobs with SELECT ... FOR UPDATE SKIP LOCKED. So many workers can poll the same table at the same time, without claiming the same job twice and without blocking. A reaper re-queues jobs whose lock is old. That makes delivery at-least-once, so handlers are idempotent, and retries use backoff through run_at."

**🧪 Real scenario:** You run a daily "fee reminder" job with node-cron inside the API code. After scaling to 3 API instances, every student gets 3 reminder emails each day. How do you fix it?

**✅ Scenario answer:**
1. Root cause: every instance runs its own copy of node-cron, so the job runs 3 times.
2. Confirm it: job logs show 3 runs at the same time, each with a different host name.
3. Fix: let only one runner create the job. Options: a BullMQ repeatable job (Redis keeps one repeat schedule for all instances), or a Postgres advisory lock (`SELECT pg_try_advisory_lock(12345)` — only the instance that gets the lock runs the job), or a unique constraint on `(job_name, run_at)`.
4. Make the job idempotent too: save `reminder_sent(student_id, date)` with a unique constraint, and skip students already reminded today.
5. Prevention: keep scheduled jobs in a separate worker process, not inside the web API that you scale for traffic.

---

## Senior-level talking points to drop in
- "I'd make this **idempotent**, because the queue gives at-least-once delivery."
- "Let's add **observability** from day one: structured logs with a correlation ID, RED metrics (rate, errors, duration), and tracing."
- "The trade-off here is consistency vs latency. For this feature, eventual consistency is fine because…"
- "I'd start simple (a modular monolith + Postgres + Redis) and change it when the metrics show the need."
