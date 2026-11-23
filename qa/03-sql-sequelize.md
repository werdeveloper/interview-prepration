# 03 — SQL & Sequelize

---

## Part A — SQL

### Q1. How do indexes work? When can they hurt?
**🟢 In simple words:** An index is a sorted list of values that points to the real rows. The database can jump to the right place fast, instead of reading every row. But every index must be updated on each write, so too many indexes slow down writes.
**🏠 Real-life example:** The index at the back of a book. You find "Deadlock — page 212" in seconds, instead of reading the whole book. But if the author adds a new page, the index must be updated too.

Most indexes are **B+ trees** (a balanced tree of sorted keys). The leaves point to the rows. So lookups, range scans and ORDER BY take O(log n) time. Without an index, the DB does a full table scan.
- **Clustered index** (InnoDB primary key): the table rows themselves are stored in PK order. Secondary indexes store the PK value.
- **Composite index (a, b, c):** it follows the **leftmost-prefix rule**. It helps `WHERE a`, `a AND b`, `a AND b AND c`. It does not help `WHERE b` alone.
- **Covering index:** it has all the columns the query needs. So the DB does not need to read the table row.

**Hurts when:**
- The table has many writes. Every INSERT/UPDATE must update every index.
- The column has low cardinality (few different values, e.g. gender).
- There are too many unused indexes.
- You use a function on the column. `WHERE YEAR(created_at)=2024` cannot use the index. Rewrite it as a range.

**🔍 Internal working:**
1. **Pages:** InnoDB stores everything in fixed-size pages (16 KB by default). A B+ tree has a root page, internal pages and leaf pages. Internal pages hold a key + a pointer to a child page. Leaf pages are linked to each other (doubly linked list). So a range scan goes down the tree once to find the first key. Then it just walks the leaves sideways.
2. **Clustered index (InnoDB):** the leaf pages of the PK tree hold the full row. A secondary index leaf holds `(indexed columns + PK)`. So a lookup through a secondary index needs two tree descents. First the secondary tree gives the PK. Then the clustered tree gives the row. A covering index skips the second descent (EXPLAIN shows `Using index`).
3. **PostgreSQL is different:** the table is an unordered **heap**. Every index (also the PK) is a secondary index. It points to a tuple id `(page, offset)`. An "index-only scan" works only when the **visibility map** says the page is all-visible. Otherwise it still visits the heap.
4. **Insert and page split:** the engine goes down to the correct leaf. If the leaf is full, it **splits**. About half of the entries move to a new page. A separator key is pushed into the parent. The parent can split too, up to the root. Auto-increment PKs always add to the right-most leaf. This is cheap, and pages stay full. Random UUID v4 PKs insert everywhere. This gives many splits, half-empty pages and poor cache use.
5. **Why indexes cost writes:** every index is a separate B+ tree. So one INSERT = one tree write per index (plus the redo log). InnoDB reduces this cost for non-unique secondary indexes with the **change buffer**. It keeps changes for pages that are not in memory, and merges them later.
6. **Why they get ignored:** the optimizer is cost-based. Take a low-cardinality column. An index seek + thousands of random row lookups costs more than one sequential scan. So the optimizer picks the full scan. `YEAR(created_at)` cannot use the index. The tree is sorted by the raw value, not by the function result. Fix: rewrite as a range, or use a functional index (MySQL 8.0.13+, Postgres expression index).

```text
                [ root: 50 | 100 ]
               /        |        \
     [10|30]        [60|80]       [120|150]      <- internal pages (keys + child ptrs)
     /  |  \         /  |  \        /   |   \
   leaf<->leaf<->leaf<->leaf<->leaf<->leaf<->leaf  <- leaves (InnoDB PK: full rows;
                                                      secondary: key + PK value)
Secondary lookup (InnoDB):  idx_email tree --(PK=42)--> clustered PK tree --> row
```

**🎤 Say this in the interview:** "An index is a B+ tree of 16 KB pages. In InnoDB the PK tree *is* the table. So a secondary index lookup finds the PK, and then goes down the clustered tree again — unless the index is covering. Every extra index is one more tree to update and split on writes. And the cost-based optimizer will skip an index when a scan is cheaper."

**🧪 Real scenario:** A student-search API on a 20M-row `students` table takes 8 seconds. The query filters by `state_id` and a `created_at` date range, and sorts by `name`. What do you do?

**✅ Scenario answer:**
1. Run `EXPLAIN ANALYZE` on the exact query. You will likely see a full scan (`type: ALL` / `Seq Scan`) or a single-column index, plus a sort (`Using filesort` / `Sort`).
2. Follow the rule "equality columns first, range column last". Create a composite index on `(state_id, created_at)`. Now the DB jumps to one state and reads only the date range.
   ```sql
   CREATE INDEX idx_students_state_created ON students (state_id, created_at);
   ```
3. The sort by `name` still needs a sort step, because the index is ordered by date, not name. This is fine if the filtered rows are few. If the API always pages by name, test `(state_id, name)` instead and compare both plans.
4. Select only the needed columns and use keyset pagination, not a big OFFSET.
5. Prevent it: check EXPLAIN for every new list API in code review, and keep the slow query log (MySQL) or `pg_stat_statements` (Postgres) on, with alerts.

---

### Q2. How do you optimize a slow query?
**🟢 In simple words:** First, ask the database how it runs the query (EXPLAIN). Then find the slow part, like reading the whole table. Fix it with a better index, fewer columns, or a smarter query.
**🏠 Real-life example:** A delivery driver is always late. You look at the GPS route first. You find he drives through every street. Then you give him a shorter route.

1. `EXPLAIN` / `EXPLAIN ANALYZE` → look for full scans (`type: ALL` in MySQL, `Seq Scan` in Postgres). Also look at rows examined, filesort and temporary tables.
2. Add the right (composite/covering) indexes. Base them on the WHERE, JOIN and ORDER BY columns.
3. Select only the columns you need (no `SELECT *`).
4. Avoid functions on indexed columns. Avoid leading-wildcard `LIKE '%x'`.
5. Replace OFFSET pagination with **keyset/cursor** pagination (`WHERE id > ? LIMIT 20`).
6. Break up huge joins, denormalize, or use summary tables / materialized views.
7. Cache hot reads. Use read replicas.

**🔍 Internal working:**
1. **Parser:** the SQL text becomes a parse tree. Then names (tables, columns) and types are checked against the catalog.
2. **Rewrite / transform:** views are expanded. Some subqueries are rewritten into joins. For example, MySQL turns `IN (subquery)` into a semi-join. Postgres pulls up simple subqueries.
3. **Cost-based optimizer:** it builds candidate plans (which index, which join order, which join algorithm). It estimates the cost of each plan using **statistics**: row counts, number of distinct values (cardinality), most-common values and histograms. Postgres keeps them in `pg_statistic` (filled by `ANALYZE` / autovacuum). InnoDB samples index pages for persistent stats (`ANALYZE TABLE`). MySQL 8 also supports histograms. The plan with the lowest estimated cost wins.
4. **Executor:** it runs the plan as a tree of operators. Each node pulls rows from its child nodes one by one ("iterator / Volcano model") — scan → filter → join → sort → limit.
5. **Reading EXPLAIN ANALYZE:** compare *estimated rows* vs *actual rows*. A big difference means bad statistics. Bad statistics give a wrong plan (wrong join order or wrong index). So run `ANALYZE` first, before you add indexes.
6. **Sort (filesort):** if no index already gives the ORDER BY order, rows are sorted in memory (`sort_buffer_size` in MySQL, `work_mem` in Postgres). If they do not fit, the engine writes sorted runs to temp files and merges them (external merge sort). This is slow.
7. **Why OFFSET is slow:** `LIMIT 20 OFFSET 100000` still reads 100,000 rows and throws them away. Keyset (`WHERE id > ?`) goes down the B+ tree straight to the start key. Then it reads only 20 leaf entries.

```text
SQL text -> Parser -> Resolver -> Rewriter -> Optimizer (stats -> cost) -> Plan -> Executor -> rows
                                                ^
                                      pg_statistic / InnoDB index stats / histograms
```

**🎤 Say this in the interview:** "A query goes parser → rewriter → cost-based optimizer → executor. The optimizer picks a plan using statistics like cardinality and histograms. So with EXPLAIN ANALYZE, I first compare estimated vs actual rows. A big gap means stale stats and a wrong plan. Then I look for scans, filesorts and temp tables that a better index can remove."

**🧪 Real scenario:** A dashboard report API was fast (200 ms) at launch. After 6 months it takes 9 seconds. Nobody changed the code. How do you find and fix the problem?

**✅ Scenario answer:**
1. Root cause is usually data growth: the table grew, and a plan that was fine for small data is now a full scan or a big sort. Or the statistics are old, so the optimizer picks a bad plan.
2. Find the query: MySQL slow query log, or `pg_stat_statements` in Postgres (sort by total time). Or turn on Sequelize `logging` + `benchmark: true`.
3. Run `EXPLAIN ANALYZE`. Compare estimated rows vs actual rows. A big gap means stale stats → run `ANALYZE TABLE t` (MySQL) or `ANALYZE t` (Postgres), then check the plan again.
4. If the plan is still a scan or filesort, add the right composite index, remove `SELECT *`, and replace OFFSET with keyset pagination. For heavy totals, use a summary table refreshed by a job.
5. Prevent it: test important queries with production-size data, and alert when query time crosses a limit.

---

### Q3. Types of JOINs.
**🟢 In simple words:** A JOIN puts rows from two tables together using a common column. INNER keeps only rows that match on both sides. LEFT keeps all rows from the left table, even with no match. The database also chooses *how* to do the join internally.
**🏠 Real-life example:** A class list and an exam-result list. INNER JOIN = only students who wrote the exam. LEFT JOIN = all students, with "no result" for students who were absent.

- **INNER** — only rows that match in both tables.
- **LEFT** — all left rows + matches (NULL if no match). **RIGHT** is the mirror.
- **FULL OUTER** — all rows from both tables. MySQL does not have it → use UNION of a LEFT and a RIGHT join.
- **CROSS** — Cartesian product (every row with every row). **SELF JOIN** — a table joined with itself, e.g. employee → manager.

**🔍 Internal working:**
1. The JOIN type (INNER/LEFT/…) is the *logical* result. The engine separately picks a *physical* join algorithm. There are three main ones.
2. **Nested loop join:** for each row of the outer table, find matching rows in the inner table. Very fast when the inner join column has an index (index nested loop: one B+ tree seek per outer row). Without an index it is O(N×M). Before 8.0.18 this was MySQL's only algorithm (with a "block nested loop" buffer as an optimization).
3. **Hash join:** build a hash table on the smaller input (keyed on the join column). Then scan the bigger input and look up each row in the hash table. It works only for equality (`=`) joins. It is good for big joins without indexes. Postgres has had it for a long time. MySQL added it in 8.0.18. If the hash table does not fit in memory (`work_mem` / `join_buffer_size`), it is split into batches on disk.
4. **Merge join (Postgres):** both inputs are sorted on the join key (from an index or an explicit sort). Then the engine walks both lists together, like merging two sorted arrays. MySQL does not have merge join.
5. **LEFT JOIN details:** when the inner side has no match, the executor returns the outer row with NULLs. If your WHERE filters on a right-table column (`WHERE o.status = 'paid'`), the NULL rows are removed. So the optimizer converts it to an INNER JOIN. The `LEFT JOIN … WHERE o.id IS NULL` pattern often runs as an **anti-join** (find rows that have no match).
6. **Join order:** for N tables there are many possible orders. Postgres uses dynamic programming. Above `geqo_threshold` (12 tables by default) it uses a genetic optimizer. MySQL uses a greedy search. Order matters a lot: the small/filtered table should drive the loop.

```text
Nested loop:  for r in outer: idx_seek(inner, r.key)        -> best with index on inner key
Hash join:    build: H = hash(small.key) ; probe: for r in big: H[r.key]
Merge join:   sorted(A) ==walk==> <==walk== sorted(B)       -> Postgres only
```

**🎤 Say this in the interview:** "The JOIN type is logical. Physically, the optimizer picks one of three algorithms. Nested loop is great with an index on the inner side. Hash join is for large equality joins — MySQL has it only since 8.0.18. Merge join works on sorted inputs in Postgres. The optimizer also picks the join order from statistics. So an index on the join column often turns an O(N×M) join into N index seeks."

**🧪 Real scenario:** A "district-wise application count" report should show all 75 districts. But districts with zero applications are missing from the report. What is wrong?

**✅ Scenario answer:**
1. The query uses an INNER JOIN, or a LEFT JOIN with a filter on the right table inside WHERE. Both remove districts that have no matching rows.
2. Confirm: compare the number of districts in the result with the `districts` table. Look for `WHERE a.status = ...` on the applications table.
3. Fix: use LEFT JOIN from `districts`, move the right-table filter into the ON clause, and count a right-table column (not `*`), so empty districts show 0.
   ```sql
   SELECT d.name, COUNT(a.id) AS total
   FROM districts d
   LEFT JOIN applications a ON a.district_id = d.id AND a.status = 'submitted'
   GROUP BY d.id, d.name;
   ```
4. Make sure `applications.district_id` has an index, so the join is fast.
5. Prevent it: for "show all X" reports, always start the query from the master table, and add a test that checks a district with zero rows.

---

### Q4. Write common queries (practice on paper).
**🟢 In simple words:** These are the classic SQL questions interviewers ask you to write by hand. Most use GROUP BY, subqueries, LEFT JOIN, or window functions. Window functions give each row a number or total without merging rows together.
**🏠 Real-life example:** A school marks register. "Who is the 2nd topper?", "Who is the topper in each class?", "Which students wrote their name twice?" — the same questions, but on a database table.

```sql
-- 2nd highest salary
SELECT MAX(salary) FROM employees WHERE salary < (SELECT MAX(salary) FROM employees);
-- Nth highest (generic)
SELECT salary FROM (
  SELECT salary, DENSE_RANK() OVER (ORDER BY salary DESC) rnk FROM employees
) t WHERE rnk = 3;

-- Highest-paid employee per department
SELECT * FROM (
  SELECT e.*, ROW_NUMBER() OVER (PARTITION BY dept_id ORDER BY salary DESC) rn FROM employees e
) t WHERE rn = 1;

-- Duplicate emails
SELECT email, COUNT(*) FROM users GROUP BY email HAVING COUNT(*) > 1;

-- Delete duplicates, keep the lowest id (MySQL)
DELETE u1 FROM users u1 JOIN users u2 ON u1.email = u2.email AND u1.id > u2.id;

-- Customers with no orders
SELECT c.* FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE o.id IS NULL;

-- Running total
SELECT order_date, amount, SUM(amount) OVER (ORDER BY order_date) AS running_total FROM orders;
```

**🔍 Internal working:**
1. **Window functions run late:** they run after FROM/WHERE/GROUP BY/HAVING, but before the final ORDER BY/LIMIT. So you cannot write `WHERE rn = 1` at the same level. You must wrap the query in a derived table (or CTE).
2. **How a window runs:** the executor sorts rows by the `PARTITION BY` keys and then the `ORDER BY` keys. (Or it reads them from an index that already has this order.) Then a window-aggregate operator (Postgres: `WindowAgg`) streams through the sorted rows. It keeps a running state, and resets the state at each new partition. An index on `(dept_id, salary DESC)` can remove the sort.
3. **Running total gotcha:** with `ORDER BY` and no frame clause, the default frame is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. With RANGE, rows with the same `order_date` (peers) get the **same** total. Use `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` if you want a strict per-row total.
4. **MAX(salary) with an index:** with a B+ tree index on `salary`, MAX/MIN reads only one end of the tree (O(log n)). So the "2nd highest" subquery is cheap with an index.
5. **Duplicates / anti-join:** `GROUP BY email` works by sorting or hashing on email. The "customers with no orders" query usually runs as an **anti-join** (Postgres shows `Hash Anti Join` or `Nested Loop Anti Join`). It needs an index on `orders.customer_id` to be fast.
6. **Self-join DELETE (MySQL):** the engine joins the table with itself on `email`. Without an index on `email` this is very expensive. In REPEATABLE READ it also locks every row it scans.

**🎤 Say this in the interview:** "Window functions run after WHERE and GROUP BY. The engine sorts by PARTITION BY plus ORDER BY. Then one streaming operator keeps a running state and resets it at each partition. So a matching composite index removes the sort. I also remember that the default RANGE frame gives tied rows the same running total."

**🧪 Real scenario:** A bulk Excel upload ran twice by mistake. Now the `beneficiaries` table has duplicate rows with the same Aadhaar number. You must clean it up in production and stop it from happening again.

**✅ Scenario answer:**
1. Find the duplicates first: `SELECT aadhaar_no, COUNT(*) FROM beneficiaries GROUP BY aadhaar_no HAVING COUNT(*) > 1;`
2. Decide which row to keep (usually the lowest id). Check child tables (payments, documents) that point to the extra rows, and move them to the kept row first.
3. Take a backup of the affected rows. Then delete the extra rows in small batches inside a transaction:
   ```sql
   DELETE FROM beneficiaries WHERE id IN (
     SELECT id FROM (
       SELECT id, ROW_NUMBER() OVER (PARTITION BY aadhaar_no ORDER BY id) AS rn
       FROM beneficiaries) t
     WHERE rn > 1);
   ```
   (The extra derived table is needed in MySQL, which does not allow a direct subquery on the same table you delete from.)
4. Add a UNIQUE index on `aadhaar_no`, and make the upload use upsert (`bulkCreate` with `updateOnDuplicate` or `ignoreDuplicates`).
5. Prevent it: make uploads idempotent (store a file hash or batch id), and check for duplicates inside the file before insert.

---

### Q5. `ROW_NUMBER` vs `RANK` vs `DENSE_RANK`.
**🟢 In simple words:** All three give a position number to each row after sorting. They only differ when two rows have the same value (a tie). ROW_NUMBER never repeats a number. RANK repeats and then skips. DENSE_RANK repeats but never skips.
**🏠 Real-life example:** A race where two runners finish at the same time. ROW_NUMBER: 1, 2, 3, 4 (just the order they crossed). RANK: 1, 2, 2, 4 (like the Olympics, no 3rd place). DENSE_RANK: 1, 2, 2, 3 (next runner still gets 3rd).

For salaries 100, 90, 90, 80:
- ROW_NUMBER → 1, 2, 3, 4 (always unique)
- RANK → 1, 2, 2, 4 (gaps)
- DENSE_RANK → 1, 2, 2, 3 (no gaps)

**🔍 Internal working:**
1. All three need the rows sorted by the window's ORDER BY (inside each partition). After the sort, one pass over the rows computes the value. The sort is O(n log n). The pass is O(n).
2. **ROW_NUMBER:** a counter that goes up by 1 on every row. For tied values the order is not deterministic (it can change between runs). Add a tie-breaker column to fix it (e.g. `ORDER BY salary DESC, id`).
3. **RANK:** it compares the current row with the previous row on the ORDER BY keys ("peer" check). If they are equal, it repeats the previous rank. If not, rank = current row number. That is how gaps appear.
4. **DENSE_RANK:** it also does the peer check. But it increases the rank by exactly 1, and only when the value changes. So there are no gaps.
5. If several window functions use the same `OVER (...)` clause, the engine sorts once. It computes all of them in the same pass.

**🎤 Say this in the interview:** "After one sort on the window ORDER BY, the engine makes a single pass. ROW_NUMBER is a plain counter. RANK reuses the rank for peers and then jumps to the row number. DENSE_RANK goes up by one only when the value changes. I add a tie-breaker if ROW_NUMBER must be deterministic."

**🧪 Real scenario:** A merit-list page shows a different order for candidates with the same marks every time it is refreshed. Two candidates with equal marks also got different ranks. Users complain. What do you do?

**✅ Scenario answer:**
1. Root cause: the query uses `ROW_NUMBER()` and orders only by marks. For ties, the order is not deterministic, so it can change between runs.
2. Confirm: find two candidates with the same marks and run the query a few times. Their order and rank change.
3. Fix based on the business rule. If ties must share a rank, use `RANK()` (1, 2, 2, 4) or `DENSE_RANK()` (1, 2, 2, 3). If the rule has a tie-breaker (e.g. older candidate first), add it to ORDER BY, and end with `id` for a stable display order:
   ```sql
   RANK() OVER (ORDER BY marks DESC, dob ASC) AS merit_rank
   ...
   ORDER BY marks DESC, dob ASC, id ASC
   ```
4. Store the final published rank in a column, so the official list never changes after it is published.
5. Prevent it: get the tie-break rule written in the requirement, and always end ORDER BY with a unique column.

---

### Q6. WHERE vs HAVING; the order of SQL execution.
**🟢 In simple words:** WHERE removes single rows *before* they are grouped. HAVING removes whole groups *after* totals like COUNT or SUM are calculated. SQL runs the clauses in a fixed logical order, which is different from the order you write them.
**🏠 Real-life example:** Sorting exam papers. WHERE = throw away blank papers first. GROUP BY = put papers into piles by class. HAVING = keep only the classes where the average mark is above 60.

Logical order: **FROM/JOIN → WHERE → GROUP BY → HAVING → SELECT → DISTINCT → ORDER BY → LIMIT**.
- WHERE filters rows before grouping.
- HAVING filters groups after aggregation.
- That is why you cannot use a SELECT alias in WHERE.

**🔍 Internal working:**
1. The logical order defines the *meaning* of the query. The physical plan can be different. The optimizer **pushes predicates down**: WHERE filters run as early as possible (even inside an index seek, or below a join). Postgres even moves a HAVING condition that has no aggregate into WHERE.
2. **GROUP BY runs in one of two ways:**
   (a) Sort by the group key, then aggregate consecutive equal rows (stream/group aggregate).
   (b) Use a hash table keyed by the group key (Postgres `HashAggregate`; MySQL uses an internal temporary table — EXPLAIN shows `Using temporary`).
   If an index already has the group key order, the sort is skipped.
3. **HAVING** is just a filter operator on top of the aggregate output. It sees one row per group.
4. **SELECT aliases** are created at the projection step. That step comes after WHERE, so WHERE cannot see them. Postgres allows output aliases in ORDER BY and GROUP BY. MySQL also allows them in HAVING (a MySQL extension).
5. **ORDER BY + LIMIT:** when LIMIT is small, engines use a top-N heap instead of a full sort. Postgres shows `top-N heapsort`. MySQL filesort uses a priority queue. Only N rows are kept in memory.

**🎤 Say this in the interview:** "The logical order is FROM, WHERE, GROUP BY, HAVING, SELECT, ORDER BY, LIMIT. But the optimizer pushes filters down as early as it can. GROUP BY runs as a sort-based or hash-based aggregate. HAVING is just a filter on its output. So a filter that can go in WHERE should go there."

**🧪 Real scenario:** A report "blocks with more than 100 pending applications in one district" is slow. The developer wrote `GROUP BY block_id HAVING district_id = 12 AND COUNT(*) > 100`. How do you improve it?

**✅ Scenario answer:**
1. Root cause: the district filter is in HAVING. Logically HAVING runs after GROUP BY, so the DB may group rows from all districts first, and only then throw most groups away.
2. Confirm with `EXPLAIN ANALYZE`: it reads many more rows than one district has. Postgres can sometimes move such a condition down by itself, but do not depend on it.
3. Fix: put row filters in WHERE, and keep only aggregate conditions in HAVING.
   ```sql
   SELECT block_id, COUNT(*) AS pending
   FROM applications
   WHERE district_id = 12 AND status = 'pending'
   GROUP BY block_id
   HAVING COUNT(*) > 100;
   ```
4. Add an index on `(district_id, status, block_id)`, so both the filter and the grouping can use the index.
5. Prevent it: in code review, check that HAVING has only aggregate conditions (COUNT, SUM, ...).

---

### Q7. ACID and transaction isolation levels.
**🟢 In simple words:** ACID is a set of four promises a database gives for a transaction. Either all changes happen or none, rules are always kept, users don't disturb each other, and saved data is never lost. Isolation levels decide how much one running transaction can see of another one's changes.
**🏠 Real-life example:** A bank transfer of ₹500 from you to a friend. Money must leave your account AND reach your friend — never only one side. Even if the power goes off right after "Success", the transfer must still be there.

**ACID:**
- **Atomicity** — all or nothing.
- **Consistency** — constraints always hold.
- **Isolation** — transactions running at the same time do not disturb each other.
- **Durability** — committed data survives a crash (WAL/redo log).

| Level | Dirty read | Non-repeatable read | Phantom |
|---|---|---|---|
| READ UNCOMMITTED | ✔ | ✔ | ✔ |
| READ COMMITTED (Postgres default) | ✘ | ✔ | ✔ |
| REPEATABLE READ (MySQL InnoDB default) | ✘ | ✘ | mostly ✘ (gap locks) |
| SERIALIZABLE | ✘ | ✘ | ✘ |

These are built with **MVCC** (Multi-Version Concurrency Control: the DB keeps old versions of rows, so each transaction sees a snapshot and readers don't block writers) plus locks.

**🔍 Internal working:**
1. **Durability = write-ahead log.** Before a data page changes on disk, the change is first written to a log. It is the **redo log** in InnoDB and the **WAL** in Postgres. At COMMIT, the log is flushed to disk with `fsync` (InnoDB `innodb_flush_log_at_trx_commit=1`, Postgres `synchronous_commit=on`). The data pages are written later by checkpoints. After a crash, the engine replays the log from the last checkpoint. **Group commit** puts many transactions into one fsync.
2. **Atomicity in InnoDB = undo log.** Before InnoDB changes a row in place, it writes the old version into the undo log. ROLLBACK applies the undo records. In Postgres, an UPDATE writes a *new* tuple version. On abort, the transaction is just marked aborted in the commit log (`pg_xact`). So its versions are never visible.
3. **MVCC in InnoDB:** every row has hidden fields: `DB_TRX_ID` (last writer) and `DB_ROLL_PTR` (pointer into the undo chain). A **read view** records which transaction ids were active when the snapshot was taken. A reader checks the row's trx id. If the version is not visible, it follows the undo chain back to an older visible version. READ COMMITTED makes a new read view for each statement. REPEATABLE READ makes one at the first read and reuses it for the whole transaction. A **purge** thread deletes undo records that no read view needs. Long-running transactions make the undo history grow.
4. **MVCC in Postgres:** each tuple has `xmin` (transaction that created it) and `xmax` (transaction that deleted/updated it). UPDATE = insert a new tuple + set `xmax` on the old one. A snapshot (xmin, xmax, list of in-progress xids) decides visibility for each tuple. Dead tuples stay in the table until **VACUUM** (autovacuum) removes them. VACUUM also "freezes" old tuples to avoid transaction-id wraparound.
5. **Phantoms in InnoDB REPEATABLE READ:** plain SELECTs read from the snapshot, so they do not see new rows. Locking reads (`SELECT … FOR UPDATE`, UPDATE, DELETE) read the *latest* version. They take **next-key locks** (the row + the gap before it). This blocks inserts into that range. That is the "mostly" in the table.
6. **Postgres levels:** REPEATABLE READ is snapshot isolation. It does not show phantoms either. But suppose you update a row that another transaction changed and committed. Then you get a serialization error and must retry. SERIALIZABLE uses **SSI** (Serializable Snapshot Isolation). It tracks read/write dependencies with predicate locks, and aborts one transaction in a dangerous pattern. InnoDB SERIALIZABLE works differently: it turns plain SELECTs into locking `FOR SHARE` reads (when autocommit is off).

```text
InnoDB row (current)  ->  undo v2  ->  undo v1        (DB_ROLL_PTR chain)
 trx_id=105              trx_id=98    trx_id=90
Read view of T(100): active={99,105}  => skip 105, read v2 (98 committed, visible)

Postgres heap:  (xmin=90, xmax=98) old tuple  |  (xmin=98, xmax=0) new tuple  -> VACUUM removes old
```

**🎤 Say this in the interview:** "Durability comes from the redo log / WAL. It is fsynced at commit and replayed after a crash. Isolation comes from MVCC. InnoDB rebuilds old row versions from undo logs using a read view. Postgres keeps multiple tuple versions with xmin/xmax and cleans them with VACUUM. In InnoDB REPEATABLE READ, locking reads also take next-key locks to stop phantoms."

**🧪 Real scenario:** In a fee module, the server crashed during a payment. The `payments` row says "SUCCESS", but there is no row in `receipts`, and the student's fee status is still "unpaid". How did this happen and how do you fix it?

**✅ Scenario answer:**
1. Root cause: the three writes ran as separate auto-commit queries, not in one transaction. The first one was committed, then the process died. So our code broke Atomicity, not the DB.
2. Confirm: check the code — the queries do not share a `transaction`. In logs you see the first INSERT, then the crash.
3. Fix the code: put all writes in one transaction. Either all commit or all roll back.
   ```js
   await sequelize.transaction(async (t) => {
     await Payment.create(data, { transaction: t });
     await Receipt.create(rc, { transaction: t });
     await Fee.update({ status: 'paid' }, { where: { studentId }, transaction: t });
   });
   ```
4. Fix old data: write a one-time script that finds successful payments without receipts and repairs them.
5. Prevent it: add a daily reconciliation job (payments vs receipts vs gateway report), and put a unique key on the gateway transaction id, so a retry cannot record the same payment twice.

---

### Q8. What is a deadlock? How do you prevent it?
**🟢 In simple words:** A deadlock is when two transactions wait for each other forever. Each one holds a lock the other one needs. The database notices this circle and cancels one of them, so the other can continue.
**🏠 Real-life example:** Two cars meet on a narrow one-lane bridge from opposite sides. Neither can move forward. One car must reverse (be "rolled back") so the other can pass.

Two transactions each hold a lock the other needs. The DB detects it and kills one (`ER_LOCK_DEADLOCK`).

Prevention:
- Take locks in a **consistent order**.
- Keep transactions short.
- Index the columns in WHERE (otherwise locks cover more rows).
- Use the lowest isolation level you can.
- **Retry** on deadlock errors.

**🔍 Internal working:**
1. **What InnoDB locks:** locks are placed on **index records**, not directly on "rows". Types:
   - **Record lock** — one index record.
   - **Gap lock** — the gap between records. It blocks inserts.
   - **Next-key lock** — record + the gap before it. This is the default for locking reads in REPEATABLE READ.
   - **Insert intention lock** — taken by INSERT. It waits on gap locks.
   Modes are shared (S) and exclusive (X).
2. **Why a missing index means more locks:** InnoDB locks every index record it *scans*, not only the ones that match. Without an index on the WHERE column, an UPDATE scans the whole clustered index. In REPEATABLE READ it locks every row (and gap). So deadlocks become very likely.
3. **Detection in InnoDB:** when a transaction must wait, InnoDB adds an edge to a **wait-for graph**. (T1 → T2 means "T1 waits for a lock that T2 holds".) It searches for a cycle right away (`innodb_deadlock_detect=ON`). If it finds one, it picks a victim — usually the "smaller" transaction (fewer rows changed / undo records). It rolls the victim back completely and returns error 1213. If detection is off, waits end with `innodb_lock_wait_timeout` (50 s default).
4. **Detection in Postgres:** a waiting backend first waits `deadlock_timeout` (1 s default). Only then does it run the cycle check on the lock graph. If there is a cycle, usually the transaction that ran the check is aborted with error `40P01`.
5. The victim's whole transaction is rolled back, not just the last statement. So the application must **retry the whole transaction**, not one query.

```text
T1: UPDATE accounts WHERE id=1  (X lock on 1)      T2: UPDATE accounts WHERE id=2 (X lock on 2)
T1: UPDATE accounts WHERE id=2  -> waits for T2    T2: UPDATE accounts WHERE id=1 -> waits for T1

wait-for graph:   T1 ───► T2
                   ▲       │
                   └───────┘   cycle => roll back victim (error 1213 / 40P01)
```

**🎤 Say this in the interview:** "InnoDB locks the index records it scans — record, gap and next-key locks. On every wait, it checks a wait-for graph for a cycle and rolls back the cheaper transaction. Postgres runs the check after deadlock_timeout. So I lock rows in a fixed order, I index my WHERE columns so fewer records get locked, and I retry the whole transaction."

**🧪 Real scenario:** Production logs show `Deadlock found when trying to get lock` (MySQL error 1213) a few times every day. It happens when a nightly status-update job runs while officers approve applications from the UI. What do you do?

**✅ Scenario answer:**
1. Root cause: the job and the API lock the same rows in a different order. Or the job's UPDATE has no index on its WHERE column, so it scans and locks many rows.
2. Confirm: in MySQL run `SHOW ENGINE INNODB STATUS` and read the "LATEST DETECTED DEADLOCK" section (it shows both queries and their locks). Turn on `innodb_print_all_deadlocks` to log every deadlock. In Postgres, the details are in the server log.
3. Fix: index the WHERE columns of the job. Update in small batches (e.g. 500 ids per transaction). Always touch rows in the same order (e.g. `ORDER BY id`) in both places.
4. Add retry logic: on error 1213 (MySQL) or `40P01` (Postgres), retry the whole transaction 2–3 times with a small random delay.
5. Prevent it: keep transactions short (no API calls inside them), and run heavy jobs at low-traffic hours.

---

### Q9. Optimistic vs pessimistic locking.
**🟢 In simple words:** Pessimistic locking locks the row first, so nobody else can change it while you work. Optimistic locking does not lock; it checks at save time if someone else changed the row, and if yes, you retry. Use pessimistic when conflicts are common, optimistic when they are rare.
**🏠 Real-life example:** Pessimistic = locking the bathroom door while you use it. Optimistic = editing a shared Google Doc; if someone else saved a newer version first, you get a "conflict" message and redo your change.

- **Pessimistic:** `SELECT ... FOR UPDATE` locks the row until commit. Use it when many users fight for the same row (high contention), e.g. inventory or wallet balance.
- **Optimistic:** add a `version` column. Run `UPDATE ... SET version = version+1 WHERE id=? AND version=?`. If 0 rows are affected = conflict → retry. Better for low contention. Sequelize supports it with `version: true`.

**🔍 Internal working:**
1. **FOR UPDATE in InnoDB:** it reads the latest committed version (a "current read", not the snapshot). It puts an X lock on the index record (plus gap locks for ranges in REPEATABLE READ). Other `FOR UPDATE`/UPDATE statements on that row join the lock wait queue. Plain SELECTs are **not** blocked — they read the MVCC snapshot.
2. **FOR UPDATE in Postgres:** the row lock is written into the tuple header itself (`xmax` + flag bits). It is not stored in a shared-memory lock table. So locking millions of rows does not use up memory. A waiter waits on the locking transaction's id.
3. Locks are held until COMMIT/ROLLBACK (two-phase locking). `NOWAIT` (fail fast) and `SKIP LOCKED` (skip locked rows — great for job queues) are supported in MySQL 8.0+ and Postgres 9.5+.
4. **Why optimistic works:** the `UPDATE … WHERE version = ?` is atomic. The engine locks the row for the update. It checks the WHERE against the *latest* version. (Postgres in READ COMMITTED re-checks the condition on the newest row version after the other writer commits.) So only one writer matches. The other one sees 0 affected rows.
5. **Sequelize `version: true`:** it adds a `version` attribute. On `instance.save()` it adds `AND version = <old>` to the WHERE and sets `version = old + 1`. If the affected-row count is 0, it throws `OptimisticLockError`. You catch it and retry.

**🎤 Say this in the interview:** "FOR UPDATE takes an exclusive row lock. It blocks other writers until commit, but normal MVCC readers are not blocked. Optimistic locking takes no lock while reading. The atomic UPDATE with `WHERE version = ?` lets only one writer win. Sequelize's `version: true` turns 0 affected rows into an OptimisticLockError, and I retry."

**🧪 Real scenario:** A training centre has 30 seats. On the last day, 2 candidates got the 30th seat at the same time, so 31 students were enrolled. How do you fix this?

**✅ Scenario answer:**
1. Root cause: a "check, then write" race. Both requests read `filled = 29`, both saw a free seat, and both inserted.
2. Confirm: two enrollment rows with almost the same `createdAt`, and more enrollments than `capacity`.
3. Fix with a single atomic UPDATE (simple and fast), and check the affected rows:
   ```sql
   UPDATE centres SET filled = filled + 1
   WHERE id = ? AND filled < capacity;   -- 0 rows affected = no seat left
   ```
   Or use a pessimistic lock in a transaction: `Centre.findByPk(id, { lock: t.LOCK.UPDATE, transaction: t })`, then check and insert.
4. For low-conflict edits (e.g. two officers editing the same profile), use optimistic locking with `version: true` and show "data changed, please reload".
5. Prevent it: add a DB-level safety net, like a CHECK constraint `filled <= capacity` (enforced in MySQL 8.0.16+ and Postgres), and test with parallel requests.

---

### Q10. Normalization vs denormalization.
**🟢 In simple words:** Normalization means storing each fact only once, in its own table, so data stays correct. Denormalization means copying some data into more places so reads are faster. You trade clean, safe writes for fast reads.
**🏠 Real-life example:** Keeping a customer's address only in one address book (normalized) vs writing it on every bill too (denormalized). Bills print faster, but if the customer moves, you must fix every bill.

- **1NF:** atomic values (one value per cell).
- **2NF:** no partial dependency on a composite key.
- **3NF:** no transitive dependency (a non-key column must not depend on another non-key column).

Normalize for data integrity in OLTP systems (day-to-day transaction systems). Denormalize (duplicate data, summary columns) for read speed and reporting. You accept the extra write complexity.

**🔍 Internal working:**
1. **Normalized reads** pay at query time. Each join is one more join operator and more index seeks (more page reads). **Normalized writes** are cheap. One fact is stored in one row, so there is one row lock and one set of index updates.
2. **Denormalized rows are wider.** Fewer rows fit in a 16 KB (InnoDB) / 8 KB (Postgres) page, so scans read more pages. Updating a duplicated value means touching many rows. That means more redo/undo (or WAL), more index updates and more locks.
3. **Summary/counter columns create hot rows.** Say every new post runs `UPDATE users SET posts_count = posts_count + 1`. All those transactions queue for the same row lock. That is why high-traffic counters are often buffered (e.g. in Redis) and written in batches.
4. **Materialized views:** Postgres stores the query result as a real table. `REFRESH MATERIALIZED VIEW` recomputes it. `CONCURRENTLY` needs a unique index and does not block readers. MySQL has no materialized views. You build summary tables with jobs or triggers.
5. **Foreign keys enforce normalization integrity.** InnoDB needs an index on the FK column (it creates one automatically if missing). It takes a shared lock on the parent row while checking. Postgres does **not** auto-create an index on the referencing column. Add it yourself, or deletes on the parent become slow.

**🎤 Say this in the interview:** "Normalization moves the cost to read time, as joins and index seeks. Denormalization moves the cost to write time: wider pages, more redo and index updates, and hot-row lock contention on summary columns. I normalize the OLTP core, and denormalize only where needed with summary tables or materialized views."

**🧪 Real scenario:** A district was renamed by the government. After the change, some reports show the new name and some show the old name. You find that `district_name` is copied as text into the `applications` table. What do you do?

**✅ Scenario answer:**
1. Root cause: denormalized data. The name is stored in many rows, and the rename updated only the `districts` master table.
2. Confirm: join `applications` with `districts` on `district_id` and count rows where the two names are different.
3. Fix: store only `district_id` (a foreign key) in transaction tables, and get the name with a join. Then a rename is one UPDATE in one place.
4. If a copy is really needed for speed, keep it in a summary table that a job rebuilds. If the old name must be kept for legal reasons (e.g. on an issued certificate), store it on purpose as a "name at that time" snapshot.
5. Prevent it: normalize master data (state, district, block, scheme) with FKs; denormalize only with a clear sync plan.

---

### Q11. SQL vs NoSQL — when to choose which?
**🟢 In simple words:** SQL databases store data in strict tables with relations, and they are great for joins and safe transactions. NoSQL databases have a flexible structure and spread data across many machines easily. You pick based on your data shape and how you will read it.
**🏠 Real-life example:** SQL is like a bank's ledger with fixed columns and strict rules. NoSQL is like a big warehouse with labelled boxes — very fast to drop items in by box label, but hard to answer questions that cut across many boxes.

- **SQL:** structured relations, complex joins, strong consistency, transactions (finance, ERP, MIS).
- **NoSQL:** flexible schema, huge scale-out writes, simple access patterns. Types: document stores like MongoDB, key-value like Redis/DynamoDB, wide-column like Cassandra.
- Many systems use both (polyglot persistence).

**🔍 Internal working:**
1. **Relational engines** (InnoDB, Postgres) use B+ tree storage, a WAL/redo log, MVCC and a lock manager. Usually all writes go to a single primary. The engine does joins and enforces constraints for you.
2. **Many write-heavy NoSQL stores (Cassandra, RocksDB-based systems) use LSM trees** (Log-Structured Merge trees). A write goes to a commit log + an in-memory table (memtable). Later the memtable is flushed to disk as an immutable sorted file (SSTable). Background **compaction** merges these files. Writes are sequential and very fast. Reads may need to check several files; bloom filters help here. (MongoDB's WiredTiger, by contrast, uses B-trees by default.)
3. **Scale-out:** NoSQL systems split data by key (e.g. consistent hashing in Cassandra/DynamoDB). Each partition is replicated. Consistency is often tunable: with N replicas, if read quorum + write quorum > N, a read sees the latest write.
4. **Data modeling:** in SQL you normalize, and later you can query in any shape. In NoSQL you design for known access patterns. You duplicate data and avoid joins, because a query should hit only one partition.
5. **Transactions:** MongoDB supports multi-document transactions (since 4.0). DynamoDB has `TransactWriteItems`. But they cost more and have limits. These systems are optimized for single-key/single-document operations.

**🎤 Say this in the interview:** "Relational engines are B+ trees plus WAL, MVCC and a single write primary. This gives joins and strong transactions. Many NoSQL stores use LSM trees and key-based partitioning with tunable quorum consistency. This gives huge write throughput and scale-out — but you must model your data around your access patterns."

**🧪 Real scenario:** Your team wants to move a government scheme portal from MySQL to MongoDB, because each scheme has different form fields. Do you agree?

**✅ Scenario answer:**
1. The real problem is only the "dynamic form fields". The core data (applicants, payments, approvals, audit) is relational and needs joins, transactions and strong consistency.
2. Check the access patterns: reports by district, scheme and status, and money flows. These fit SQL well.
3. Suggest a middle path: keep SQL, and store the scheme-specific fields in a JSON column (MySQL `JSON`, Postgres `JSONB`). Index the few JSON fields you search on (MySQL: generated column + index; Postgres: GIN or expression index).
4. Use NoSQL only where it really fits, e.g. large logs, or cache/session data in Redis.
5. Prevent wrong choices: choose the DB by access patterns and consistency needs, not only by "the schema is flexible".

---

### Q12. How do you scale a relational database?
**🟢 In simple words:** First make one database faster (bigger machine, better indexes, caching). Then add copies for reading (replicas). Finally, split the data across many databases (sharding) — which is powerful but hard.
**🏠 Real-life example:** A busy shop. First you hire a faster cashier. Then you open extra counters only for price enquiries (read replicas). Finally you open new branches in other cities, each serving its own customers (sharding).

Steps, in order:
1. Vertical scaling (bigger machine).
2. Indexing / query tuning.
3. Caching.
4. **Read replicas** (watch for replication lag).
5. Connection pooling (PgBouncer/ProxySQL).
6. **Partitioning** (by date/range, inside one DB).
7. **Sharding** (by tenant/user id, across many DBs; cross-shard joins/transactions are hard).
8. CQRS / separate stores for analytics.

**🔍 Internal working:**
1. **MySQL replication:** at commit, the primary writes the change to the **binlog** (ROW format is the default in 8.0). The replica's I/O thread pulls binlog events into its **relay log**. Applier (SQL) threads replay them — multi-threaded in modern versions. It is asynchronous by default. **Semi-sync** makes the commit wait until at least one replica confirms it *received* the event.
2. **Postgres replication:** a **WAL sender** process streams WAL records to a **WAL receiver** on the standby. The standby's startup process replays them (physical, byte-level replication). With `hot_standby` the standby serves reads. `synchronous_standby_names` makes commits wait for a standby. Logical replication (publications/subscriptions) decodes WAL into row changes.
3. **Replication lag** happens when the replica applies changes more slowly than the primary writes them (big transactions, slow apply, network). Read-after-write problem fix: read from the primary right after a write. Or wait until the replica has reached the write's GTID (MySQL) / LSN (Postgres).
4. **Partitioning:** one logical table becomes many child tables. Each has its own smaller B+ trees. The planner does **partition pruning**: it only touches partitions that match the partition key in WHERE. Dropping an old partition is instant, compared to a huge DELETE. In both MySQL and Postgres, unique keys (including the PK) must include the partition key.
5. **Sharding:** the app or a proxy layer (e.g. Vitess for MySQL, Citus for Postgres) sends each query to a shard using the shard key. Queries without the shard key become scatter-gather (sent to all shards). Cross-shard writes need 2PC or sagas.
6. **Why pooling matters:** Postgres forks one OS process per connection (several MB each). MySQL uses one thread per connection. PgBouncer in transaction mode lets thousands of client connections share a few server connections.

```text
MySQL:     Primary --binlog--> [Replica IO thread] -> relay log -> [applier threads] -> data
Postgres:  Primary WAL --> walsender ===stream===> walreceiver -> startup (replay) -> data
```

**🎤 Say this in the interview:** "Replicas replay the primary's log. In MySQL it is the binlog, through relay logs and applier threads. In Postgres it is streamed WAL. It is usually asynchronous, so I design for replication lag on read-after-write. After that, partitioning gives smaller trees and partition pruning. Sharding routes by a shard key, but costs us cross-shard joins and transactions."

**🧪 Real scenario:** On exam-result day, traffic is 50× normal. The single MySQL server goes to 100% CPU and the portal is down. Most requests are "view result". How do you handle it now and next time?

**✅ Scenario answer:**
1. Root cause: a read-heavy spike on one server. The same result data is read again and again.
2. Confirm: the slow query log / `SHOW PROCESSLIST` (or `pg_stat_activity`) shows the same result query many times. CPU is high, and connections are near `max_connections`.
3. Quick fix: make sure the result lookup uses an index (roll number), and cache results in Redis (results do not change after they are published).
4. Next time: add read replicas for result reads, use a connection pooler (ProxySQL / PgBouncer), and load-test before result day. For pages that read right after a write, read from the primary, because replicas can lag.
5. Prevent it: for very large events, pre-generate the results as static files on a CDN, so the DB is not hit at all.

---

## Part B — Sequelize

### Q13. What is the N+1 problem? How do you fix it in Sequelize?
**🟢 In simple words:** N+1 means you run 1 query to get a list, then 1 more query for every item in that list. With 100 items, that is 101 trips to the database. The fix is to load the related data together in one go (eager loading with `include`).
**🏠 Real-life example:** A shopkeeper goes to the warehouse once to get a list of 100 orders, then walks back 100 times to fetch each item. Smarter: take the full list once and bring all items in one trip.

You fetch N parents. Then you run 1 query per parent for its children. Total = N+1 queries.
```js
// BAD — 1 + N queries
const users = await User.findAll();
for (const u of users) u.posts = await u.getPosts();

// GOOD — eager loading, 1 query with a JOIN
const users = await User.findAll({ include: [{ model: Post, as: 'posts' }] });
```
For `hasMany` + `limit`, use `separate: true`. It runs 2 queries in total, with `WHERE IN`. This avoids row explosion and broken limits.

**🔍 Internal working:**
1. **Why N+1 hurts:** each `getPosts()` is a separate round trip. Sequelize takes a pool connection, sends the SQL, the DB parses/plans/runs it, and the result comes back. With 100 users that is 101 network round trips, one after another.
2. **How `include` builds SQL:** Sequelize's query generator reads the association metadata (FK `userId`, alias `posts`). It generates `LEFT OUTER JOIN posts AS posts ON posts.userId = users.id`. It becomes `INNER JOIN` with `required: true`, or when you put a `where` on the include. Joined columns get aliases like `"posts.id"`, `"posts.title"`.
3. **De-duplication into nested objects:** the DB returns flat rows. The user columns are repeated once per post. Sequelize groups rows by the parent's primary key and builds `user.posts = [...]`. That is why the PK must be selected. It is also why huge joins cost CPU and memory in Node.
4. **`limit` with a hasMany include:** a plain LIMIT would cut joined rows, not users. So Sequelize puts the parent query in a subquery — `SELECT … FROM (SELECT … FROM users LIMIT 10) AS users LEFT JOIN posts …`. Now the limit applies to parents.
5. **`separate: true`:** Sequelize first runs the parent query and collects the parent ids. Then it runs a second query, `SELECT … FROM posts WHERE userId IN (…)`, with the include's own `order`/`attributes`. It attaches the children to the parents in JavaScript. Two queries, and no cartesian explosion.

```text
SQL rows (flat):                       Sequelize result (nested):
users.id | users.name | posts.id       [{ id:1, name:'A', posts:[{id:10},{id:11}] },
   1     |    A       |   10      ==>   { id:2, name:'B', posts:[] }]
   1     |    A       |   11
   2     |    B       |  NULL
```

**🎤 Say this in the interview:** "`include` makes Sequelize generate a LEFT OUTER JOIN with aliased columns. The DB returns flat, repeated rows. Sequelize groups them by the parent PK into nested objects. With `separate: true` it runs a second `WHERE fk IN (…)` query and joins the results in JS. This avoids row explosion and broken limits."

**🧪 Real scenario:** An "applications list" API returns 50 rows but takes 3 seconds. In the Sequelize logs you see more than 150 queries for one request. What is going on and how do you fix it?

**✅ Scenario answer:**
1. Root cause: N+1. The code loads 50 applications, then calls `getApplicant()`, `getDistrict()` and `getDocuments()` inside a loop. That is 1 + 50×3 queries.
2. Confirm: turn on `logging` and count the "Executing" lines for one request. Or use APM tracing to see the many small queries.
3. Fix with eager loading, and select only the needed columns:
   ```js
   Application.findAll({
     attributes: ['id', 'status'],
     include: [
       { model: Applicant, attributes: ['name'] },
       { model: District, attributes: ['name'] },
       { model: Document, separate: true, attributes: ['id', 'type'] },
     ],
     limit: 50,
   });
   ```
4. Use `separate: true` for hasMany includes, so the limit works and rows do not explode.
5. Prevent it: add a test or middleware that counts queries per request and warns above a limit.

---

### Q14. Associations in Sequelize.
**🟢 In simple words:** Associations tell Sequelize how your tables are related: one-to-one, one-to-many, or many-to-many. Sequelize then adds the foreign key and gives you ready-made helper methods like `user.getPosts()`. It also uses this info to build JOINs for you.
**🏠 Real-life example:** A family tree. A person has one passport (1:1), a mother has many children (1:N), and students join many clubs while each club has many students (M:N — needs a separate membership register).

- `hasOne` / `belongsTo` — 1:1. The FK lives on the `belongsTo` side.
- `hasMany` / `belongsTo` — 1:N.
- `belongsToMany` with `through` — M:N, using a junction table.

Define both sides to get the helper methods (`getX`, `setX`, `addX`). Use `as` aliases the same way everywhere. Use `onDelete: 'CASCADE'` where it makes sense.

**🔍 Internal working:**
1. **Associations are metadata.** `User.hasMany(Post)` adds a foreign key attribute to the *target* model. By default it is `Post.userId` (source model name + its PK). It also stores the association in `User.associations` under its alias.
2. **Mixin methods:** Sequelize adds methods to the model prototype. For hasMany: `getPosts`, `setPosts`, `addPost`, `removePost`, `countPosts`, `createPost`, `hasPost`. Each one just builds a query with `WHERE userId = this.id`.
3. **DDL:** with `sync()` or a migration, the FK attribute becomes a `REFERENCES` constraint. Defaults: `ON DELETE SET NULL` / `ON UPDATE CASCADE` for hasOne/hasMany/belongsTo. `CASCADE` for belongsToMany.
4. **belongsToMany:** creates/uses the through model with two FKs. An include becomes two joins: `users → user_roles → roles`. The junction columns appear on each result under the through model's name.
5. **`onDelete: 'CASCADE'` runs in the database.** The DB engine deletes the children itself. So **Sequelize hooks on the children do not fire**. (In MySQL, cascaded FK actions do not fire triggers either.) With `hooks: true` on the association, Sequelize loads the children and destroys them one by one, so their hooks run. This is slower.
6. **The `as` alias** is the key Sequelize uses to find the association. It is also the SQL alias of the joined table. That is why a different alias in `include` throws an error.

**🎤 Say this in the interview:** "An association call just records metadata. It adds the FK attribute to the right model, registers the alias, and adds helpers like getPosts that run `WHERE userId = ?`. The include uses this metadata to build JOINs. onDelete becomes a DB-level FK action, so cascaded deletes skip Sequelize hooks unless `hooks: true` is set."

**🧪 Real scenario:** An admin deleted one wrong institute record. All 5,000 student records of that institute were also deleted, and no audit log was written. What happened and what do you change?

**✅ Scenario answer:**
1. Root cause: the association had `onDelete: 'CASCADE'`, so the DB foreign key deleted the children by itself. Sequelize hooks did not run for the children, so the audit hook was skipped.
2. Confirm: `SHOW CREATE TABLE students` (MySQL) or `\d students` (Postgres) shows `ON DELETE CASCADE` on the FK.
3. Recover: restore the rows from a backup or with point-in-time recovery (binlog / WAL).
4. Fix: change the FK to `RESTRICT` for important data, so the DB blocks deleting an institute that still has students. Use soft delete (`paranoid: true`) for master records.
   ```js
   Institute.hasMany(Student, { foreignKey: 'instituteId', onDelete: 'RESTRICT' });
   ```
5. Prevent it: choose `onDelete` on purpose for every association (and write it in the migration), and add a confirmation + role check for delete actions.

---

### Q15. Transactions in Sequelize — managed vs unmanaged.
**🟢 In simple words:** A transaction groups many queries so they all succeed or all fail together. In managed mode, Sequelize commits or rolls back for you. In unmanaged mode, you must call commit/rollback yourself. Every query must carry the transaction object, or it runs outside the transaction.
**🏠 Real-life example:** Booking a train ticket: seat reservation and payment must both happen, or neither. Managed mode is like an agent who handles everything for you. Unmanaged mode is doing it yourself — if you forget the last step, the seat stays blocked.

```js
// Managed: auto commit / rollback
await sequelize.transaction(async (t) => {
  const order = await Order.create({ ... }, { transaction: t });
  await Stock.decrement('qty', { by: 1, where: { id }, transaction: t });
});

// Unmanaged
const t = await sequelize.transaction();
try { /* ... { transaction: t } */ await t.commit(); } catch (e) { await t.rollback(); throw e; }
```
**Pitfall:** you forget to pass `{ transaction: t }` to one query → it runs outside the transaction. Fix: use CLS (`Sequelize.useCLS(namespace)`) to pass it automatically. For row locks: `lock: t.LOCK.UPDATE`.

**🔍 Internal working:**
1. **A transaction is bound to one connection.** `sequelize.transaction()` takes a connection from the pool. It sends `START TRANSACTION` (MySQL) or `BEGIN` (Postgres), plus a `SET … ISOLATION LEVEL` if you gave one. It stores that connection inside the Transaction object.
2. **Routing:** when a query gets `{ transaction: t }`, Sequelize sends it on `t`'s connection. It does not take a new one. A query *without* it takes a different pool connection, and runs in its own autocommit transaction. It does not see your uncommitted changes, and it is not rolled back. It can even block on a row lock held by your own transaction (a self-made lock wait). It also uses up an extra pool connection.
3. **Managed mode:** Sequelize awaits your callback. If the promise resolves, it sends `COMMIT`. If it rejects, it sends `ROLLBACK` and re-throws the error. Then the connection goes back to the pool. Unmanaged mode leaves commit/rollback to you. If you forget it, the connection stays checked out (pool leak), and the locks are still held.
4. **CLS:** in v6, `Sequelize.useCLS(ns)` uses the `cls-hooked` library (built on Node `async_hooks`). A managed transaction stores itself in the namespace. Every query looks there if no `transaction` option is passed. Only managed transactions are stored this way. Sequelize v7 uses Node's built-in `AsyncLocalStorage` for the same thing.
5. **`lock: t.LOCK.UPDATE`** adds `FOR UPDATE` to the SELECT. It only makes sense inside a transaction. In autocommit mode, the lock is released as soon as the statement ends.

```text
pool: [c1][c2][c3]
sequelize.transaction() --acquire--> c2 --BEGIN-->
  Order.create({transaction:t})  ----> c2
  Stock.decrement({transaction:t}) --> c2
  User.findOne()   (no t!)  --acquire--> c3   (outside the transaction)
commit -> c2 COMMIT -> release c2 to pool
```

**🎤 Say this in the interview:** "A Sequelize transaction pins one pooled connection and sends BEGIN on it. Only queries that get that Transaction object use that connection. Any other query gets a different connection, outside the transaction. Managed mode commits or rolls back based on the callback's promise. CLS/AsyncLocalStorage passes `t` to every query automatically."

**🧪 Real scenario:** An "approve application" API works locally, but in production it sometimes hangs for about 50 seconds and then fails with `Lock wait timeout exceeded`. The code uses a Sequelize transaction. What do you check?

**✅ Scenario answer:**
1. Likely root cause: inside the transaction, one query was called without `{ transaction: t }`. It runs on another connection and waits for a row lock held by our own transaction. Our transaction waits for that query. So it hangs until the lock wait timeout (50 s by default in MySQL).
2. Confirm: in Sequelize logs, queries in a transaction show `Executing (<transaction id>)`, and the bad one shows `Executing (default)`. In the DB, check `information_schema.innodb_trx` (MySQL) or `pg_stat_activity` + `pg_locks` (Postgres).
3. Fix: pass `{ transaction: t }` to every query, also inside hooks and helper functions.
4. Better: use managed transactions with CLS (`Sequelize.useCLS`), so `t` is passed automatically. If you use unmanaged transactions, always commit or roll back in `try/catch`, or the connection leaks.
5. Prevent it: add a code review check for this, and keep transactions short (no HTTP calls inside them).

---

### Q16. Migrations vs `sync()`.
**🟢 In simple words:** `sync()` makes the database tables match your models automatically, but it can delete data, so use it only in development. Migrations are small numbered script files that change the schema step by step. They are tracked, reviewed, and can be undone, so they are safe for production.
**🏠 Real-life example:** `sync()` is like knocking down a house and rebuilding it to match a new drawing. Migrations are like a list of renovation jobs ("add a window", "move a door"), each ticked off in a register once done.

`sync({ alter/force })` is for dev/prototyping only. It can drop or change data in ways you don't expect. In production use **migrations** (`sequelize-cli db:migrate`). They are versioned, reviewable, reversible (`up`/`down`), and run in CI/CD. Seeders are for reference/test data.

**🔍 Internal working:**
1. **`sync()`** runs `CREATE TABLE IF NOT EXISTS` for each model. `force: true` runs `DROP TABLE` first. `alter: true` reads the current table structure from the DB, compares it with the model, and runs `ALTER TABLE` statements. It cannot detect a rename. So a renamed attribute becomes drop column + add column → data loss.
2. **Migration tracking:** `sequelize-cli` (using the Umzug library) lists the migration files sorted by name. The timestamp prefix gives the order. It reads the **`SequelizeMeta`** table. This table has one `name` column, with every migration already run. It runs the pending `up` functions in order. After each one succeeds, it inserts the file name into `SequelizeMeta`.
3. **Undo:** `db:migrate:undo` runs the `down` of the last executed migration. It deletes that row from `SequelizeMeta`.
4. **Transactions:** a migration is not wrapped in a transaction automatically. Use `queryInterface.sequelize.transaction()` yourself. In MySQL, DDL statements cause an implicit commit. So a failed multi-step migration can be half-applied. In Postgres, DDL is transactional and rolls back cleanly.
5. **Production DDL:** in MySQL, ALTER needs a metadata lock. InnoDB online DDL (`ALGORITHM=INSTANT/INPLACE`) or tools like gh-ost/pt-online-schema-change avoid long blocking on big tables. In Postgres, `CREATE INDEX CONCURRENTLY` does not block writes (but it cannot run inside a transaction block).
6. **Seeders** are not tracked by default (`seederStorage` defaults to `none`). So running them twice inserts the data twice, unless you configure storage.

**🎤 Say this in the interview:** "sync() compares models with the live schema and can drop or recreate columns, so it is dev-only. Migrations are ordered files. Their names are stored in the SequelizeMeta table after they run. So each environment runs only the pending `up`s, exactly once. I wrap them in transactions myself. I remember that MySQL DDL auto-commits, while Postgres DDL is transactional."

**🧪 Real scenario:** A migration that adds a column and then a unique index failed in production (MySQL) because of duplicate data. Now `db:migrate` fails again with "Duplicate column name". What happened and how do you fix it?

**✅ Scenario answer:**
1. Root cause: in MySQL each DDL statement auto-commits. So the column was added, the index failed, and the migration was never recorded in `SequelizeMeta`. The DB is half-migrated. (In Postgres, a migration wrapped in one transaction would roll back cleanly.)
2. Confirm: `SHOW CREATE TABLE` shows the new column but no index. `SELECT * FROM SequelizeMeta` does not have this migration name.
3. Fix: clean the duplicate data first. Then either drop the half-added column by hand, or make the migration safe to re-run (check `describeTable` before `addColumn`). Then run `db:migrate` again.
4. For big tables, add indexes with online DDL (MySQL `ALGORITHM=INPLACE`) or `CREATE INDEX CONCURRENTLY` (Postgres, outside a transaction), to avoid long locks.
5. Prevent it: keep one DDL change per migration, run migrations on a copy of production data in staging first, and never use `sync({ alter: true })` in production.

---

### Q17. Paranoid, hooks, scopes, and validations.
**🟢 In simple words:** Paranoid mode hides deleted rows instead of really deleting them. Hooks are functions that run automatically before or after saving. Scopes are saved, reusable filters. Validations check data before it is saved.
**🏠 Real-life example:** Paranoid = moving a file to the Recycle Bin, not deleting it forever. Hooks = a security guard who stamps every parcel before it enters. Scopes = a saved filter in your email like "Unread". Validations = a form that refuses an email address without "@".

- **paranoid: true** → soft delete using a `deletedAt` column. Queries skip soft-deleted rows automatically. Use `paranoid: false` to include them.
- **Hooks:** `beforeCreate` (e.g. hashing passwords), `afterUpdate` (audit logs). Bulk operations need `individualHooks: true`.
- **Scopes:** reusable query parts (`defaultScope` to hide the password; `User.scope('active')`).
- **Validations:** model-level (`isEmail`, custom) vs DB constraints (`allowNull`, `unique`). Use both.

**🔍 Internal working:**
1. **Paranoid:** for every find on a paranoid model, Sequelize adds `deletedAt IS NULL` to the SQL. (For paranoid models in `include`, it goes inside the JOIN's ON clause.) `destroy()` becomes `UPDATE … SET deletedAt = NOW()`. `destroy({ force: true })` runs a real DELETE. `restore()` sets it back to NULL. Watch out: unique indexes still include soft-deleted rows, and the table keeps growing. Index `deletedAt`, or use a Postgres partial index.
2. **Hook order for a single create/save:** `beforeValidate` → validation → `afterValidate` (or `validationFailed`) → `beforeCreate`/`beforeUpdate` → `beforeSave` → **SQL INSERT/UPDATE** → `afterCreate`/`afterUpdate` → `afterSave`. Hooks are async JS functions, awaited one by one.
3. **Hooks and transactions:** the hook receives `options`, including `options.transaction`. Any query inside the hook must pass it on. Otherwise it runs on a different connection, outside the transaction.
4. **Bulk operations:** `Model.update(values, { where })` is one SQL UPDATE. So only `beforeBulkUpdate`/`afterBulkUpdate` run. With `individualHooks: true`, Sequelize first SELECTs all matching rows into memory. Then it runs the per-instance hooks for each row. This is correct but expensive on big sets.
5. **Scopes** are stored option objects. Sequelize merges them into your query options (where conditions are combined with AND). `defaultScope` applies to every query, unless you call `.unscoped()`.
6. **Validations:** model validators run in Node, before any SQL is sent. `allowNull: false` is checked by Sequelize *and* becomes `NOT NULL` in the DDL. `unique` is enforced only by the DB index. Sequelize turns the DB error (MySQL 1062 `ER_DUP_ENTRY`, Postgres `23505`) into a `UniqueConstraintError`.

**🎤 Say this in the interview:** "Paranoid simply adds `deletedAt IS NULL` to every query and turns destroy into an UPDATE. Hooks run in a fixed order — validate, beforeCreate, beforeSave, the SQL, then the after-hooks — and they must forward `options.transaction`. Bulk methods skip per-row hooks, unless individualHooks loads every row first. And unique is enforced by the DB, not by Sequelize."

**🧪 Real scenario:** The `users` model is `paranoid: true` and `email` is unique. A user deleted their account. When they try to register again with the same email, they get "email already exists", but the admin panel says "user not found". How do you fix it?

**✅ Scenario answer:**
1. Root cause: soft delete only sets `deletedAt`. The row is still in the table, and the unique index still includes it. Sequelize queries hide the row, but the DB index does not.
2. Confirm: `User.findOne({ where: { email }, paranoid: false })` returns the old row with `deletedAt` set.
3. Option A (business choice): restore the old account with `user.restore()` instead of creating a new one.
4. Option B (Postgres): use a partial unique index, so only active rows must be unique:
   ```sql
   CREATE UNIQUE INDEX users_email_active ON users (email) WHERE deleted_at IS NULL;
   ```
   MySQL has no partial indexes. Use a generated column, e.g. `is_active = IF(deleted_at IS NULL, 1, NULL)`, with a unique index on `(email, is_active)`. Deleted rows have NULL there, and NULLs do not clash in a unique index.
5. Prevent it: when you turn on paranoid, review every unique constraint on that table.

---

### Q18. When would you use raw queries instead of the ORM?
**🟢 In simple words:** Use raw SQL when the ORM cannot write the query well — for complex reports, window functions, CTEs or bulk upserts. Always pass user values as parameters, never by joining strings, to stop SQL injection. Remember that raw queries skip ORM features like hooks and soft-delete filters.
**🏠 Real-life example:** Ordering from a fixed restaurant menu (ORM) vs telling the chef your own recipe (raw SQL). The custom dish can be better, but the restaurant's usual checks (hooks, scopes) are not applied — you must take care of them yourself.

Use raw queries for complex reporting queries, window functions, CTEs, bulk upserts, or performance-critical paths where the ORM-generated SQL is slow. Use `sequelize.query(sql, { replacements, type: QueryTypes.SELECT })`. **Always use replacements/bind parameters.** Never use string concatenation (risk of SQL injection).

**🔍 Internal working:**
1. **`replacements`:** Sequelize escapes each value (quotes strings, escapes special characters). It puts the value into the SQL text in JavaScript, before sending it. This is safe when used correctly, but the final SQL is one string.
2. **`bind`:** the SQL is sent with placeholders (`$1`, `$2`). The values are sent separately to the driver/database (in Postgres via the extended query protocol). The DB parses the SQL *before* it sees the values. So a value can never change the query structure.
3. **Placeholders work only for values.** Table names, column names and `ORDER BY` directions cannot be parameters. Check them against a whitelist.
4. **`type: QueryTypes.SELECT`** makes Sequelize return just the rows array, instead of `[results, metadata]`. With `model` + `mapToModel: true`, it builds model instances from the rows.
5. **What you lose:** a raw query skips the model layer. No hooks, no paranoid `deletedAt IS NULL`, no scopes, no validation, no attribute-to-column mapping (e.g. `underscored`). You must add those conditions yourself.

**🎤 Say this in the interview:** "`replacements` are escaped and put into the SQL string by Sequelize. `bind` sends the values separately, so the DB parses the SQL before it ever sees them — that is the strongest protection. Raw queries also skip hooks, scopes and paranoid filters, so I add those conditions myself."

**🧪 Real scenario:** A security audit finds SQL injection in a report API. The code builds a raw query like `ORDER BY ${req.query.sort}` and `WHERE name LIKE '%${q}%'`. The report also shows deleted records. How do you fix it?

**✅ Scenario answer:**
1. Root cause: user input is joined into the SQL string. Also, a raw query skips the paranoid filter, so `deleted_at IS NULL` is missing.
2. Confirm: in a test environment, send input like `' OR '1'='1` and see extra rows. Compare the report count with the ORM count.
3. Fix values with bind parameters (or replacements), and fix the sort column with a whitelist (column names cannot be parameters):
   ```js
   const cols = { name: 'name', date: 'created_at' };
   const sort = cols[req.query.sort] || 'created_at';
   await sequelize.query(
     `SELECT id, name FROM applicants
      WHERE deleted_at IS NULL AND name LIKE $1 ORDER BY ${sort}`,
     { bind: [`%${q}%`], type: QueryTypes.SELECT });
   ```
4. Add the missing filters (`deleted_at IS NULL`, district/role access checks) by hand in every raw query.
5. Prevent it: keep raw SQL in one reviewed module, flag string-built SQL in code review, and run SAST tools in CI.

---

### Q19. How do you optimize Sequelize performance?
**🟢 In simple words:** Most of Sequelize's slowness happens inside Node, not in the database. So fetch only the columns you need, skip building heavy model objects when you only read, insert many rows in one query, and keep the connection pool sized well.
**🏠 Real-life example:** Packing for a trip. Take only what you need (fewer columns), use simple bags instead of fancy suitcases (`raw: true`), and load the car in one trip instead of ten (`bulkCreate`).

- `attributes: [...]` — select only the columns you need.
- `raw: true` — skip building model instances, for read-heavy endpoints.
- Eager loading with care — avoid huge cartesian joins; use `separate`.
- `bulkCreate` with `updateOnDuplicate`.
- Proper indexes in migrations.
- Tune the pool (`pool: { max, min, acquire, idle }`).
- Log slow queries (`benchmark: true`, `logging`).

**🔍 Internal working:**
1. **Instantiation cost:** for every row, Sequelize creates a model instance with `dataValues`, `_previousDataValues` (for change tracking), getters/setters and include building. For thousands of rows, this is real CPU and memory on the event loop. `raw: true` returns plain objects. (Joined fields come as `'posts.title'` keys, unless you add `nest: true`.)
2. **`attributes`:** a smaller SELECT sends fewer bytes over the network. If all selected columns are in an index, the DB can do an index-only (covering) read, with no row lookup.
3. **`bulkCreate`:** it builds one multi-row `INSERT … VALUES (…), (…)` instead of N inserts. That is one round trip and one commit. `updateOnDuplicate` becomes `ON DUPLICATE KEY UPDATE` in MySQL and `ON CONFLICT (…) DO UPDATE` in Postgres (needs a unique/PK conflict target). By default bulkCreate does not run per-row validation (`validate: false`).
4. **Large result sets block Node:** the driver parses every row in JavaScript, on the main thread. Use keyset pagination or streaming, instead of loading 100k rows.
5. **The pool limits concurrency:** at most `pool.max` queries run at the same time per process. Extra queries wait in a queue in Node. `benchmark: true` passes the measured query time to your `logging` function. So you can log only the slow queries.

**🎤 Say this in the interview:** "Most Sequelize overhead is in Node, not the DB. It comes from building model instances with change tracking, de-duplicating joined rows, and parsing big result sets on the event loop. So I select fewer attributes, use `raw: true` on hot reads, and use one multi-row bulkCreate/upsert. I also remember that the pool size limits how many queries run in parallel."

**🧪 Real scenario:** An "export to Excel" API for 2 lakh rows uses `findAll` with 3 includes. While it runs, Node memory goes above 1.5 GB and all other APIs on the same server become slow. What do you do?

**✅ Scenario answer:**
1. Root cause: Sequelize builds 2 lakh model instances with joined data in memory, and building them blocks the event loop. So every other request waits.
2. Confirm: `benchmark: true` shows the SQL time is small, but the total API time is large. Node heap and event-loop lag go up during the export.
3. Fix: select only needed columns, use `raw: true`, and read in batches with keyset pagination. Write each batch to the file as a stream, not all at once.
   ```js
   const rows = await Application.findAll({
     attributes: ['id', 'name', 'status'],
     where: { id: { [Op.gt]: lastId } },
     order: [['id', 'ASC']], limit: 5000, raw: true });
   ```
4. Move big exports to a background job (queue + worker), and show a download link when the file is ready.
5. Prevent it: set a max row limit on normal list APIs, and monitor event-loop lag.

---

### Q20. Connection pooling — why, and how do you size it?
**🟢 In simple words:** Opening a new database connection is slow, so a pool keeps a few connections open and reuses them. The pool must not be too big, because the database slows down with too many connections. The total across all app servers must stay below the database's limit.
**🏠 Real-life example:** A taxi stand. Taxis wait ready at the stand (idle connections), so you don't wait for a new car to be built. But if 500 taxis crowd one small road, traffic stops — so you keep the right number.

Opening a DB connection is expensive (TCP, authentication). A pool reuses connections.

Sizing:
- Total connections across all app instances must stay below the DB's `max_connections`. E.g. 10 pods × pool max 10 = 100 connections.
- Too large → the DB thrashes (wastes time switching between work).
- Too small → requests wait (`SequelizeConnectionAcquireTimeoutError`).
- With many instances, use PgBouncer/RDS Proxy.

**🔍 Internal working:**
1. **Acquire:** for each query (or transaction), Sequelize's connection manager calls `pool.acquire()` (v6 uses the `sequelize-pool` library).
   - If an idle connection exists, it is reused.
   - If not, and the pool is below `max`, a new one is opened (TCP handshake, optional TLS, authentication, session setup).
   - If the pool is full, the request waits in a queue. If it is not served within `acquire` ms → `ConnectionAcquireTimeoutError`.
2. **Release:** after a normal query, the connection goes back to the pool right away. Inside a transaction, it is released only after COMMIT/ROLLBACK.
3. **Idle and evict:** a timer runs every `evict` ms. It closes connections that were idle longer than `idle` ms. But it keeps at least `min` connections open.
4. **Validation:** before giving out a connection, the pool can check that it is still alive. This matters because the DB (MySQL `wait_timeout`) or a firewall/load balancer can silently close idle connections.
5. **Why bigger is not better (DB side):** Postgres forks one backend process per connection (several MB each). MySQL uses one thread per connection. Hundreds of active connections cause context switching, memory pressure and lock contention. So throughput goes *down*. A small pool, near the number of DB CPU cores (x2), is usually the sweet spot for active queries.
6. **PgBouncer transaction mode:** a server connection is given to a client only for one transaction. So thousands of app connections share a few DB connections. The cost: session-level state does not work reliably — `SET`, session advisory locks, `LISTEN`, and session prepared statements on older versions.

```text
request -> pool.acquire()
            |-- idle conn available? --> use it
            |-- size < max?          --> open new (TCP+auth) --> use it
            '-- else wait in queue --(acquire ms)--> ConnectionAcquireTimeoutError
query done -> release -> idle list --(idle ms, every evict ms, keep >= min)--> close
```

**🎤 Say this in the interview:** "The pool gives out an idle connection, or opens a new one if it is under max, or queues the request until the `acquire` timeout. An evict timer closes connections idle longer than `idle`, but keeps `min`. I size it so pods × max stays under max_connections, because Postgres runs one process per connection. With many instances, I put PgBouncer in transaction mode in front."

**🧪 Real scenario:** During admission season, you scale the API from 4 pods to 20 pods. Right away the DB starts rejecting connections: "Too many connections" in MySQL ("sorry, too many clients already" in Postgres). What happened and how do you fix it?

**✅ Scenario answer:**
1. Root cause: each pod has its own pool. 20 pods × pool `max: 20` = 400 possible connections, which is more than the DB's `max_connections`.
2. Confirm: count the connections in the DB (`SHOW STATUS LIKE 'Threads_connected'` in MySQL, `pg_stat_activity` in Postgres) and compare with `max_connections`.
3. Quick fix: reduce `pool.max` per pod, so that pods × max stays below the limit (leave room for admin tools and migrations).
   ```js
   pool: { max: 8, min: 0, acquire: 30000, idle: 10000 }
   ```
4. Long-term fix: put a pooler in front of the DB (PgBouncer in transaction mode, RDS Proxy, or ProxySQL), so many app connections share a few DB connections.
5. Prevent it: write the formula (max pods × pool.max) into the autoscaling plan, and alert at 80% of `max_connections`.
