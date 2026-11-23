# 08 — DSA Patterns (JavaScript)

Top product companies **will** ask 1–2 coding questions (LeetCode easy/medium). Learn the **pattern**, not single problems.
How to talk while coding: repeat the problem in your words → ask about edge cases → give the brute force + its complexity → optimize → write the code → dry-run with an example → state the time/space complexity.

---

## 1. Hash map — Two Sum (LC 1)
**🟢 In simple words:** A hash map lets you save a value and find it again almost instantly. In Two Sum, for each number you ask: "Have I already seen the number that completes the target?" If yes, you are done. One pass over the array is enough.
**🏠 Real-life example:** A phone book: instead of reading every page, you jump straight to the name and get the number.

```js
function twoSum(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const need = target - nums[i];
    if (seen.has(need)) return [seen.get(need), i];
    seen.set(nums[i], i);
  }
  return [];
} // O(n) time, O(n) space
```
Similar: Group Anagrams (49), Top K Frequent (347), Contains Duplicate (217), Longest Consecutive Sequence (128).

**🔍 Internal working:**
1. V8 builds `Map`/`Set` as a **deterministic hash table** (OrderedHashMap). It has two parts:
   - an *entries* array that stores `[key, value, nextInChain]` in **insertion order**;
   - a *buckets* array that holds the index of the first entry in each chain.
2. `map.get(k)`: compute the hash of `k` → pick a bucket → follow the chain through the entries array. Keys are compared with **SameValueZero** (so `NaN` matches `NaN`, and `+0` matches `-0`). Average O(1). Many collisions in one chain would make it slower.
3. **Hashes:**
   - a string's hash is computed once and saved inside the string;
   - an object gets a random identity hash the first time it is used as a key (so two different objects with the same content are different keys);
   - numbers are hashed by value.
4. `delete` only marks the entry as a hole. When the table grows, or has many holes, it is **rehashed** into a new, compact table. That is why the average cost stays O(1) (amortized = averaged over many operations).
5. **Map vs plain object:** an object is optimized for a fixed shape (hidden classes). After many dynamic adds/deletes it switches to a slower "dictionary mode". It also turns keys into strings and puts integer-like keys first. A Map takes any key type, keeps insertion order, and is built for frequent add/delete. So it is the right choice for counting and lookups in DSA.

```text
buckets:  [0]→2   [1]→0   [2]→-   [3]→1
entries:  0:{k:"a",v:1,next:-}  1:{k:"b",v:2,next:-}  2:{k:"c",v:3,next:-}
          ^ iteration simply walks entries 0,1,2 → insertion order
```

**🎤 Say this in the interview:** "A V8 Map is a deterministic hash table. It hashes to a bucket, follows the chain in an entries array kept in insertion order, and compares with SameValueZero. So lookups are O(1) on average and the iteration order is guaranteed. That is why I prefer Map over an object for counting."

**🧪 Real scenario:** You import 50,000 student records from a CSV. Before saving, you must find rows with duplicate email addresses inside the file. A teammate's nested loop takes minutes. How do you make it fast?

**✅ Scenario answer:**
1. Key idea: the nested loop compares every row with every other row → O(n²) ≈ 1.25 billion comparisons. A hash map needs only one pass → O(n).
2. Normalize the key first, so "A@x.com " and "a@x.com" match: `const key = row.email.trim().toLowerCase();`.
3. Keep a Map from email to the first row number: `if (seen.has(key)) dups.push([seen.get(key), i]); else seen.set(key, i);`.
4. To check against emails already in the DB, do not run one query per row. Load the existing emails once (or in chunks) into a `Set` and check in O(1).
5. Trade-off: O(n) extra memory for the Map, which is fine for 50,000 rows. Show the duplicate row numbers in the error report.

## 2. Two pointers — Valid Palindrome / 3Sum
**🟢 In simple words:** Put one pointer at the start and one at the end. Compare the two values, then move one or both pointers toward the middle. You check everything in one walk, without extra memory.
**🏠 Real-life example:** Two people check a row of seats from opposite ends of a cinema and walk toward each other until they meet.

```js
function isPalindrome(s) {
  s = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  let l = 0, r = s.length - 1;
  while (l < r) if (s[l++] !== s[r--]) return false;
  return true;
}
```
Similar: 3Sum (15), Container With Most Water (11), Remove Duplicates from Sorted Array (26).

**🔍 Internal working:**
1. **Invariant** (a rule that is always true): everything outside `[l, r]` is already checked and fine. Each loop step moves at least one pointer inward. So the loop runs at most n times → O(n) time, O(1) extra space.
2. **Why it is safe to skip pairs (3Sum / sorted two-sum):** the array is sorted. If `nums[l] + nums[r] < target`, then pairing `nums[l]` with any index left of `r` gives an even smaller sum. So `l` can never be part of an answer in the remaining range. `l++` throws away a whole row of pairs at once. The same logic in reverse for `> target` → `r--`.
3. 3Sum = sort (O(n log n)) + for each `i`, two pointers on the rest (O(n)) → O(n²) total. Skip equal neighbours to avoid duplicate triplets.
4. **JS string details:** strings are immutable (cannot change). So `toLowerCase()` and `replace()` each create a new string (O(n) time and memory). `s[i]` is O(1) on a flat string. V8 may store a string built by `+` as a "cons string" (rope), and flatten it on indexed access.
5. To keep O(1) extra space, skip non-alphanumeric characters with the pointers instead of creating a cleaned copy.

```text
"racecar"
 l →         ← r
 r a c e c a r      compare s[l] and s[r], then l++, r--
     l     r
       l r
         lr  stop (l >= r)
```

**🎤 Say this in the interview:** "Two pointers works because of an invariant: everything outside [l, r] is already decided. On sorted data, moving a pointer safely throws away a whole group of pairs. So I make at most n moves — O(n) instead of the O(n²) brute force."

**🧪 Real scenario:** Two different systems give you sorted lists of student IDs: one from the fee system and one from the attendance system, each with about 1 lakh IDs. You must find the students that appear in both. How?

**✅ Scenario answer:**
1. Key idea: both lists are already sorted, so you can walk them together with two pointers, like merging. O(n + m) time, O(1) extra space.
2. Start `i = 0` on list A and `j = 0` on list B.
3. Compare: if `a[i] === b[j]`, save it and move both. If `a[i] < b[j]`, move `i++`. Otherwise move `j++`.
4. Code: `while (i < a.length && j < b.length) { if (a[i] === b[j]) { res.push(a[i]); i++; j++; } else if (a[i] < b[j]) i++; else j++; }`.
5. If the lists are not sorted, put one list in a `Set` and check the other (O(n + m) time, O(n) memory). If both are in the same DB, a SQL `JOIN` is simpler.

## 3. Sliding window — Longest substring without repeating characters (LC 3)
**🟢 In simple words:** Look at a "window" — a part of the string between a left edge and a right edge. Grow the window to the right. When it breaks the rule (a repeated letter), move the left edge forward until it is valid again. Both edges only move forward, so it is fast.
**🏠 Real-life example:** A train window: as the train moves, new houses appear on the right and old houses disappear on the left — you never go back.

```js
function lengthOfLongestSubstring(s) {
  const last = new Map(); let start = 0, best = 0;
  for (let i = 0; i < s.length; i++) {
    if (last.has(s[i]) && last.get(s[i]) >= start) start = last.get(s[i]) + 1;
    last.set(s[i], i);
    best = Math.max(best, i - start + 1);
  }
  return best;
} // O(n)
```
Similar: Best Time to Buy and Sell Stock (121), Minimum Window Substring (76), Max sum subarray of size k.

**🔍 Internal working:**
1. The window is `[start, i]`. **Invariant:** it never contains a repeated character.
2. `i` moves right once per loop. `start` also only moves right (it jumps forward, never back). So both pointers together make at most 2n moves → **amortized O(n)**, even though the movement looks "nested".
3. `last` stores the last index of every character. Old entries to the left of the window are **not deleted** (lazy deletion). That is why we need the check `last.get(s[i]) >= start`. An index before `start` is outside the window and must be ignored.
4. When a repeat is inside the window, jump `start` to `last + 1` in O(1). No need to shrink one step at a time.
5. Space is O(min(n, alphabet size)). For pure ASCII you could use `new Int32Array(128).fill(-1)` instead of a Map — less hashing, same logic.
6. **General template:** expand right → while the window is invalid, shrink left → update the answer. It works for "longest/shortest subarray with property X" when the property is monotonic (shrinking a valid window keeps it valid).

```text
s = a b c a b c b b
    0 1 2 3 4 5 6 7
i=3 ('a' seen at 0 ≥ start 0) → start = 1   window "bca"
i=4 ('b' seen at 1 ≥ start 1) → start = 2   window "cab"
best = 3
```

**🎤 Say this in the interview:** "The window keeps an invariant — no duplicates inside — and both pointers only move forward, so the total work is at most 2n steps. The map of last-seen indexes lets me jump the left edge in O(1) instead of shrinking it one by one."

**🧪 Real scenario:** You must find, from API logs, the 5-minute window with the most errors in a day. How would you do it efficiently?

**✅ Scenario answer:**
1. Key idea: take only the error timestamps and sort them (logs are usually already in time order). Then use a sliding window over the timestamps.
2. Move `right` forward one error at a time. While `ts[right] - ts[left] >= 5 * 60 * 1000`, move `left` forward. The window `[left, right]` now holds all errors within 5 minutes.
3. The window size is `right - left + 1`. Keep the biggest size and its start time.
4. Both pointers only move forward, so it is O(n) after sorting, with O(1) extra memory.
5. In production, a log tool (ELK, CloudWatch) can group errors per minute. You can also count errors per minute first, then slide a fixed window of 5 buckets.

## 4. Stack — Valid Parentheses (LC 20)
**🟢 In simple words:** A stack is a pile: the last thing you put on is the first thing you take off. For brackets, push every opening bracket. When a closing bracket comes, the top of the pile must be its matching opener. At the end the pile must be empty.
**🏠 Real-life example:** A stack of plates in a kitchen: you always add and take plates from the top.

```js
function isValid(s) {
  const pair = { ')': '(', ']': '[', '}': '{' }, st = [];
  for (const c of s) {
    if (!pair[c]) st.push(c);
    else if (st.pop() !== pair[c]) return false;
  }
  return st.length === 0;
}
```
Similar: Min Stack (155), Daily Temperatures (739, monotonic stack), Evaluate RPN (150).

**🔍 Internal working:**
1. A JS array used as a stack keeps its elements in one continuous backing store, with **extra capacity**. `push` writes into the next free slot. `pop` reads the last slot and decreases `length`. Both are O(1).
2. When the backing store is full, V8 allocates a bigger one (about 1.5× the old capacity plus 16) and copies the elements. Growth is proportional, so the copy cost averages out → **amortized O(1)** push.
3. Only push/pop at the **end** are cheap. `unshift`/`shift` at the front must move every element → O(n).
4. For LC 20, each character is pushed at most once and popped at most once → O(n) time, O(n) worst-case space.
5. **Monotonic stack** (Daily Temperatures): keep indexes whose values are decreasing. A new, bigger value pops all smaller ones (their answer is found). Each index is pushed and popped once → O(n) total, even with the inner `while`.
6. Detail: `for (const c of s)` walks the string by Unicode **code points** (the string iterator). `s[i]` uses UTF-16 code units. This matters only for emojis/surrogate pairs.

**🎤 Say this in the interview:** "A JS array works as a stack because push and pop at the end are amortized O(1). V8 over-allocates the backing store and copies only when it grows. In a monotonic stack every element is pushed and popped once, so the whole scan is O(n)."

**🧪 Real scenario:** In an admin "form builder" page (React), users want Undo and Redo buttons for changes like adding, moving or deleting fields. How would you build it?

**✅ Scenario answer:**
1. Key idea: use two stacks — an undo stack and a redo stack. The last change is always the first one to undo (LIFO).
2. On every new change: push the previous state (or the action) onto the undo stack, and clear the redo stack.
3. Undo: pop from the undo stack, push the current state onto the redo stack, and show the popped state.
4. Redo: pop from the redo stack, push the current state onto the undo stack, and show the popped state.
5. Keep a size limit (for example the last 50 steps) so memory does not grow forever. Storing small actions with their inverse uses less memory than full snapshots.

## 5. Binary search (LC 704, 33)
**🟢 In simple words:** In a sorted list, look at the middle item. If the target is bigger, throw away the left half; if smaller, throw away the right half. Repeat. Each step cuts the work in half, so even a million items need only about 20 steps.
**🏠 Real-life example:** Finding a word in a paper dictionary: you open the middle, see if your word comes before or after, and keep halving.

```js
function search(nums, target) {
  let lo = 0, hi = nums.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (nums[mid] === target) return mid;
    nums[mid] < target ? (lo = mid + 1) : (hi = mid - 1);
  }
  return -1;
} // O(log n)
```
Similar: Search in Rotated Sorted Array (33), Find Minimum in Rotated Array (153), Koko Eating Bananas (875).

**🔍 Internal working:**
1. **Invariant:** if the target exists, it is inside `[lo, hi]`. Each loop compares with `mid` and throws away half of the range. After about log2(n) steps the range is empty (`lo > hi`) → O(log n).
2. `(lo + hi) >> 1`: the `>>` operator turns the number into a 32-bit signed integer and shifts it. This is a fast floor-divide by 2. It is correct for indexes below 2^31. For bigger numbers (e.g. binary search on an answer range up to 10^12), use `Math.floor((lo + hi) / 2)` or `lo + Math.floor((hi - lo) / 2)`.
3. In Java/C++, `lo + (hi - lo) / 2` prevents integer overflow. JS numbers are 64-bit doubles, so `lo + hi` does not overflow. But `>>` cuts to 32 bits — that is the JS-specific trap.
4. **Rotated array (LC 33):** at least one half (`[lo, mid]` or `[mid, hi]`) is always sorted. Check `nums[lo] <= nums[mid]` to see which half is sorted. Test whether the target is inside that sorted range. Then throw away the other half.
5. **"Binary search on the answer"** (Koko, LC 875): the check "can finish with speed k" is monotonic (false…false, true…true). So you search for the first `true`, with `lo < hi` and `hi = mid`.

**🎤 Say this in the interview:** "Binary search keeps the invariant that the answer is inside [lo, hi], and halves the range each step. In JS I watch out for `>> 1`, which cuts to 32 bits. For rotated arrays I use the fact that one half is always sorted."

**🧪 Real scenario:** A bug appeared in production. You know the release from 200 commits ago was fine, and the latest commit is broken. How do you find the commit that caused it quickly?

**✅ Scenario answer:**
1. Key idea: the commits are in order, and once the bug appears it stays (good…good, bad…bad). That is a sorted, monotonic search → binary search.
2. Use `git bisect`: `git bisect start`, `git bisect bad` (current commit), `git bisect good <old-tag>`.
3. Git checks out the middle commit. You test it and mark it `good` or `bad`. Each answer throws away half of the commits.
4. 200 commits need only about 8 tests (log2 200 ≈ 7.6), instead of testing 200 commits one by one.
5. If you have a test script that shows the bug, run it automatically: `git bisect run npm test`. Finish with `git bisect reset`.

## 6. Linked list — Reverse (LC 206), detect a cycle (141)
**🟢 In simple words:** A linked list is a chain of nodes, where each node points to the next one. To reverse it, walk once and turn each arrow around. To find a loop, send a slow runner (1 step) and a fast runner (2 steps); if there is a loop, the fast one will catch the slow one.
**🏠 Real-life example:** Two people jog on a track: if the track is a circle, the faster jogger will lap and meet the slower one; if it is a straight road, the fast one just reaches the end.

```js
function reverseList(head) {
  let prev = null;
  while (head) [head.next, prev, head] = [prev, head, head.next];
  return prev;
}
function hasCycle(head) {
  let slow = head, fast = head;
  while (fast && fast.next) { slow = slow.next; fast = fast.next.next; if (slow === fast) return true; }
  return false;
}
```
Similar: Merge Two Sorted Lists (21), Remove Nth From End (19), LRU Cache (146 — **very common**, see below).

**🔍 Internal working:**
1. Each node is an object on the heap. `node.next` holds a reference (pointer) to another object. Reversing only changes where references point. No data is copied, O(1) extra space.
2. **The destructuring swap** `[head.next, prev, head] = [prev, head, head.next]`:
   - the right-side array is built **first**, using the old values (`prev`, `head`, `head.next`);
   - then the targets are assigned **left to right**: `head.next = prev` (head is still the old node), then `prev = old head`, then `head = old next`;
   - if you change the target order, it breaks.
   It also creates a small temporary array in each loop. The three-variable version with `const next = head.next` is clearer in an interview.
3. **Floyd's cycle detection:** `fast` moves 2 steps, `slow` moves 1. Once both are inside the cycle, the distance between them shrinks by 1 each step. So they must meet within one lap → O(n) time, O(1) space.
4. **Finding the cycle start (LC 142):** after they meet, move one pointer back to `head`. Step both by 1. They meet at the cycle entry. (This comes from distance math: head→entry equals meet→entry, modulo the cycle length.)
5. **Memory:** V8's garbage collector is tracing (mark-and-sweep/compaction), not reference counting. So cyclic lists are freed correctly once nothing reachable points to them.

```text
before:  null ← prev   head → 2 → 3
step:    null ← 1       2 → 3        (prev=1, head=2)
end:     null ← 1 ← 2 ← 3            return prev (3)
```

**🎤 Say this in the interview:** "Reversal only re-points the next references while walking once. Floyd's algorithm works because, inside a cycle, the fast pointer closes the gap by one node per step, so they must meet. Both are O(n) time and O(1) space."

**🧪 Real scenario:** Your approval workflow stores steps in the DB, and each step has a `next_step_id`. An admin made a mistake, and step C points back to step A. Now the worker that walks the workflow runs forever. How do you detect this?

**✅ Scenario answer:**
1. Key idea: the steps form a linked list. A wrong `next_step_id` creates a cycle, so walking "until next is null" never ends.
2. Simple fix: keep a `Set` of visited step IDs while walking. If you see an ID again, stop and report a cycle. O(n) time, O(n) memory.
3. O(1) memory option: Floyd's slow/fast pointers. Slow moves 1 step, fast moves 2. If they meet, there is a cycle.
4. Best place to check is when the admin **saves** the workflow. Walk the chain and reject the save if a cycle is found.
5. Also add a safety limit in the worker (for example max 100 steps), so bad data can never cause an endless loop.

## 7. LRU Cache (LC 146) — asked VERY often for backend roles
**🟢 In simple words:** An LRU cache has a fixed size. Every time you use an item, it becomes "most recent". When the cache is full and a new item comes, you remove the item that was not used for the longest time. Both reading and writing must be O(1).
**🏠 Real-life example:** A small bookshelf with room for 5 books: every book you read goes to the right end; when the shelf is full, you remove the book at the left end, the one you have not touched for longest.

```js
class LRUCache {
  constructor(capacity) { this.cap = capacity; this.map = new Map(); }
  get(key) {
    if (!this.map.has(key)) return -1;
    const v = this.map.get(key);
    this.map.delete(key); this.map.set(key, v);   // move to most-recent
    return v;
  }
  put(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.cap) this.map.delete(this.map.keys().next().value); // evict LRU
  }
} // O(1) — Map keeps insertion order. Be ready to explain the hashmap + doubly-linked-list version too.
```

**🔍 Internal working:**
1. V8's `Map` is a deterministic hash table. Its entries array keeps **insertion order**. Iteration walks that array, starting from the oldest entry.
2. `map.set(key, v)` on a key that **already exists only updates the value — it does NOT move the key**. That is why `get`/`put` first `delete` the key and then `set` it. Delete leaves a hole in the old slot. Set adds a new entry at the end. So the key becomes "most recent".
3. `this.map.keys().next().value` creates an iterator. It returns the **first live entry** = the least recently used key. We evict it in O(1) amortized (holes are removed when the table is rehashed/compacted).
4. So all operations are amortized O(1). But this depends on the Map ordering guarantee in the language spec, so say it out loud.
5. **Classic version (works in any language):** a hash map `key → node` plus a **doubly linked list** with dummy `head` and `tail` nodes.
   - `get`: find the node in O(1), unlink it (`node.prev.next = node.next; node.next.prev = node.prev`) and insert it right after `head`.
   - Eviction: remove `tail.prev`.
   - Every step is O(1), because each node knows both neighbours.
6. Real systems: Redis does **not** use an exact LRU list. It samples a few keys and evicts the oldest of the sample. This saves memory per key.

```text
Map entries (oldest → newest):   a   b   c
get(a):  delete a → [hole] b c   set a → b c a
put(d), cap=3:                    b c a d → evict first live key "b" → c a d
```

**🎤 Say this in the interview:** "Map iterates in insertion order, and set on an existing key does not reorder it. So I delete and re-insert to mark a key as recent, and evict keys().next() — the oldest entry. In other languages I'd build the same thing with a hash map plus a doubly linked list with sentinel nodes."

**🧪 Real scenario:** Your Node API calls a slow external API to convert a PIN code into district details. You want an in-memory cache, but memory must not grow forever. How do you build it?

**✅ Scenario answer:**
1. Key idea: an LRU cache with a fixed size (for example 10,000 entries). When it is full, remove the entry that was not used for the longest time.
2. Use the Map trick: on `get`, delete and set the key again to make it "most recent". On `put`, if the size is over the limit, delete `map.keys().next().value` (the oldest).
3. Add a TTL to each entry (store `{ value, expiresAt }`), because district data can change sometimes.
4. In production, use a tested package such as `lru-cache`, which already has max size and TTL.
5. Trade-off: this cache is per process. With 3 instances there are 3 caches. If all instances must share data, use Redis instead.

## 8. Trees — DFS/BFS
**🟢 In simple words:** DFS (depth-first search) goes deep down one branch before trying the next. BFS (breadth-first search) visits the tree level by level. DFS is usually written with recursion; BFS uses a queue.
**🏠 Real-life example:** Exploring a family tree: DFS follows one family line down to the youngest child first; BFS meets all grandparents, then all parents, then all children.

```js
const maxDepth = root => root ? 1 + Math.max(maxDepth(root.left), maxDepth(root.right)) : 0;

function levelOrder(root) {
  if (!root) return [];
  const res = [], q = [root];
  while (q.length) {
    const size = q.length, level = [];
    for (let i = 0; i < size; i++) {
      const n = q.shift(); level.push(n.val);
      n.left && q.push(n.left); n.right && q.push(n.right);
    }
    res.push(level);
  }
  return res;
}
```
Similar: Invert Tree (226), Validate BST (98), Lowest Common Ancestor (235/236), Diameter (543).

**🔍 Internal working:**
1. **Recursion uses the call stack:** each `maxDepth` call pushes a stack frame (return address, arguments, local variables). The frame is removed when the call returns. Depth of recursion = height of the tree.
2. V8's stack is limited (about 1 MB by default on 64-bit). `node --stack-size` changes it (value in KB). Depending on the frame size, this is roughly ten thousand frames. Beyond that you get **`RangeError: Maximum call stack size exceeded`**.
3. A balanced tree with 1M nodes has height ~20 — fine. A **skewed tree** (basically a linked list) of 100k nodes will overflow. V8 does **not** do tail-call optimization, so rewriting as a tail call does not help. Use an explicit stack (an array on the heap) instead.
4. **BFS and `queue.shift()`:** `shift` removes index 0. The spec requires every remaining element to move one place to the left → treat it as **O(n)**. This makes BFS O(n²) in the worst case. Use a read pointer instead: `let head = 0; while (head < q.length) { const n = q[head++]; ... }` → O(1) dequeue.
5. **Level grouping:** `const size = q.length` is a snapshot of how many nodes belong to the current level. The children pushed during the loop belong to the next level.
6. **Iterative DFS (pre-order):** `stack = [root]; while (stack.length) { n = stack.pop(); visit(n); push(n.right); push(n.left); }`. Push right first, so left is processed first.

```text
q = [A, B, C, D, E]         shift(): moves B..E one slot left → O(n)
     ^head                  head++:  nothing moves             → O(1)
```

**🎤 Say this in the interview:** "Recursive DFS uses one stack frame per level, so a skewed tree can throw 'Maximum call stack size exceeded'. V8 has no tail-call optimization, so I switch to an explicit stack. For BFS I avoid array.shift(), which is O(n), by using a head index."

**🧪 Real scenario:** Your MIS stores the office hierarchy State → District → Block → School as rows with a `parent_id`. You must show it as a tree in React and show the total number of students under each district. How?

**✅ Scenario answer:**
1. Build the tree in one pass: make a Map from `parent_id` to a list of children. This is O(n), not one DB query per node.
2. Totals need children first, so use DFS post-order: `total(node) = node.students + sum of total(child)`.
3. The tree is only 4 levels deep, so recursion is safe here. For very deep data, use an explicit stack.
4. Use BFS (level by level) when you need one level at a time, for example "show all districts first, then load blocks on click".
5. The DB can also do it: Postgres `WITH RECURSIVE` walks the hierarchy in SQL. Cache the totals if the dashboard is opened often.

## 9. Graphs — Number of Islands (LC 200)
**🟢 In simple words:** The grid is a map of land ('1') and water ('0'). Every time you find new land, count one island, then "flood" it — mark all connected land as visited. At the end, the count is the number of islands.
**🏠 Real-life example:** Pouring paint on one piece of land on a map: the paint spreads to all connected land, and each new paint colour you need is one more island.

```js
function numIslands(grid) {
  let count = 0;
  const dfs = (r, c) => {
    if (r < 0 || c < 0 || r >= grid.length || c >= grid[0].length || grid[r][c] !== '1') return;
    grid[r][c] = '0';
    dfs(r + 1, c); dfs(r - 1, c); dfs(r, c + 1); dfs(r, c - 1);
  };
  for (let r = 0; r < grid.length; r++)
    for (let c = 0; c < grid[0].length; c++)
      if (grid[r][c] === '1') { count++; dfs(r, c); }
  return count;
}
```
Similar: Course Schedule (207 — topological sort), Clone Graph (133), Rotting Oranges (994).

**🔍 Internal working:**
1. Each `'1'` cell is visited once. Marking it `'0'` works as the "visited set", stored inside the grid itself. (This changes the input — mention it, or copy the grid first.) Each cell checks 4 neighbours → **O(R × C)** time.
2. **Stack risk:** the recursion depth can reach the size of the largest island. A 1000 × 1000 grid full of `'1'` means up to 10^6 nested calls → `RangeError: Maximum call stack size exceeded` in V8.
3. **Safe version:** use an explicit stack (array `push`/`pop`) for DFS, or BFS with a head-index queue. Mark a cell visited **when you push it**, not when you pop it. Then the same cell is not added many times.
4. **Course Schedule (Kahn's topological sort):**
   - build an adjacency list and an `indegree` array (number of incoming edges per node);
   - put all nodes with indegree 0 into a queue;
   - pop a node, decrease the indegree of its neighbours, and enqueue any that reach 0;
   - if the number of processed nodes < n, there is a **cycle**. O(V + E).
5. **Cycle detection with DFS:** three colours — white (not visited), gray (on the current recursion path), black (finished). Reaching a gray node means a back edge → cycle.

```text
iterative flood fill:
stack = [[r,c]]; grid[r][c]='0'
while stack: pop (r,c) → for each neighbour that is '1': mark '0', push
```

**🎤 Say this in the interview:** "Flood fill visits every cell once, so it is O(R×C). But recursive DFS can go a million frames deep on a big island and overflow the V8 stack. So in production I use an explicit stack or BFS, and mark cells when I push them."

**🧪 Real scenario:** Your training portal has courses with prerequisites (for example "Advanced Node" needs "Core JavaScript"). When an admin adds a new prerequisite, you must reject it if it creates a circular dependency, and show students a valid course order. How?

**✅ Scenario answer:**
1. Key idea: courses are nodes and prerequisites are directed edges. A circular dependency is a cycle in the graph.
2. Use Kahn's topological sort: count the incoming edges (indegree) of each course, and start with courses that have 0.
3. Take a course from the queue, add it to the order, and reduce the indegree of the courses that depend on it. Add any course that reaches 0.
4. If the order has fewer courses than the total, there is a cycle → reject the new rule. Otherwise the order is a valid study plan. O(V + E).
5. The same pattern is used for job pipelines and package dependency order.

## 10. Intervals — Merge Intervals (LC 56)
**🟢 In simple words:** First sort the intervals by their start time. Then go through them in order. If the next interval starts before the current one ends, join them; if not, start a new group. Only the last joined interval can overlap with the next one.
**🏠 Real-life example:** Merging meetings in a calendar: put them in time order, and when one meeting starts before the previous one ends, treat them as one long busy block.

```js
function merge(intervals) {
  intervals.sort((a, b) => a[0] - b[0]);
  const res = [intervals[0]];
  for (const [s, e] of intervals.slice(1)) {
    const last = res[res.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e); else res.push([s, e]);
  }
  return res;
}
```

**🔍 Internal working:**
1. `Array.prototype.sort` in V8 uses **TimSort** (since V8 7.0 / Chrome 70 / Node 11). It is **stable** — the spec requires this since ES2019. Equal elements keep their original order.
2. **TimSort steps:**
   - scan the array for natural *runs* (parts that are already ascending, or strictly descending parts that it reverses);
   - extend short runs to a minimum length (minrun, usually 32–64) with binary insertion sort;
   - merge the runs. The merge uses **galloping** when one run "wins" many times in a row.
   Worst case O(n log n). Already sorted input is O(n).
3. **Comparator rules:** it must return a number (negative / 0 / positive). Returning a boolean (`a[0] > b[0]`) is a bug. `false` and `true` become 0 and 1, never negative, so the result is not reliably sorted. Without a comparator, `sort` converts elements to **strings** (`[10, 9, 1].sort()` → `[1, 10, 9]`).
4. **Merge invariant:** after sorting by start, the last interval in `res` is the merged union of everything processed so far. A new interval can overlap only with that last one (its start is ≥ every earlier start). So one comparison per interval is enough → O(n) after the O(n log n) sort.
5. `sort` works **in place** and changes the caller's array. Use `[...intervals].sort(...)` (or `toSorted` in newer runtimes) if the input must stay unchanged. Edge case: add `if (!intervals.length) return [];` — otherwise `res` starts as `[undefined]`.

**🎤 Say this in the interview:** "V8 sorts with TimSort, which is stable and finds existing runs. So it is O(n log n) worst case and O(n) on sorted data. After sorting by start, only the last merged interval can overlap the next one, so the merge pass is linear."

**🧪 Real scenario:** In an exam-hall booking system, you must stop new bookings that overlap with existing ones for the same hall, and show the free time slots for a day. How?

**✅ Scenario answer:**
1. Overlap check for two slots: `newStart < oldEnd && newEnd > oldStart`. If true for any booking of that hall, reject.
2. Free slots: sort the day's bookings by start time, then merge overlapping ones (the Merge Intervals pattern).
3. The gaps between the merged intervals (and before the first / after the last, inside opening hours) are the free slots.
4. Two users can book at the same moment, so the app check is not enough. In Postgres, an exclusion constraint can block overlaps in the DB: `EXCLUDE USING gist (hall_id WITH =, slot WITH &&)` (needs the `btree_gist` extension).
5. Cost: O(n log n) for the sort, then O(n) for merging and finding gaps.

## 11. Heap / Top-K — Kth Largest (LC 215), Top K Frequent (347)
**🟢 In simple words:** "Top K" means finding the K biggest or most common items. A heap is a structure that always gives you the smallest (or biggest) item quickly. When counts are small numbers, you can skip the heap and just group items by their count in "buckets".
**🏠 Real-life example:** Sorting exam papers into boxes labelled by score (100, 99, 98 …) and then taking papers from the highest boxes until you have K.

JS has no built-in heap → for Top K Frequent use **bucket sort**, O(n):
```js
function topKFrequent(nums, k) {
  const freq = new Map();
  nums.forEach(n => freq.set(n, (freq.get(n) || 0) + 1));
  const buckets = Array.from({ length: nums.length + 1 }, () => []);
  for (const [n, f] of freq) buckets[f].push(n);
  const res = [];
  for (let i = buckets.length - 1; i >= 0 && res.length < k; i--) res.push(...buckets[i]);
  return res.slice(0, k);
}
```

**🔍 Internal working:**
1. **Bucket sort works** because a frequency can never be bigger than `n`. So `buckets[freq]` has a fixed, limited size. Counting is O(n), filling buckets is O(n), reading from the top is O(n) → O(n) total.
2. **Binary heap in an array** (when you must build one): node `i` has children `2i+1` and `2i+2`, and parent `(i-1) >> 1`. No pointers are needed, because the tree is always complete.
3. **push:** add at the end, then *sift up* (swap with the parent while the heap order is broken) → O(log n). **pop:** take the root, move the last element to the root, then *sift down* (swap with the smaller child, for a min-heap) → O(log n).
4. **Kth largest:** keep a **min-heap of size k**. If a new number is bigger than the root, replace the root. The root is the answer → O(n log k) time, O(k) space. **Quickselect** is O(n) on average but O(n²) in the worst case — use a random pivot.
5. JS trap: `res.push(...buckets[i])` passes every element as a separate function argument. With very large arrays (hundreds of thousands of items) this can throw a `RangeError`, because arguments use stack space. A `for...of` loop with `push` is safe.

```text
array: [1, 3, 5, 7, 9, 8]          tree:        1
index:  0  1  2  3  4  5                      /   \
children of i=1 → 3 and 4                    3     5
                                            / \   /
                                           7   9 8
```

**🎤 Say this in the interview:** "For Top-K frequent I bucket by frequency, because frequency is limited by n, which gives O(n). For Kth largest I keep a size-k min-heap stored in an array, where children are at 2i+1 and 2i+2, so each push or pop is O(log k)."

**🧪 Real scenario:** From 1 crore API log lines, you must show the top 10 most-called endpoints on an admin dashboard. How do you do it without running out of memory?

**✅ Scenario answer:**
1. Read the log file as a stream, line by line (for example with `readline`). Do not load the whole file into memory.
2. Count with a Map: `count.set(endpoint, (count.get(endpoint) || 0) + 1)`. There are only a few hundred unique endpoints, so the Map stays small.
3. For the top 10: keep a min-heap of size 10 (O(m log 10)). With only a few hundred endpoints, simply sorting the Map entries is also fine.
4. Normalize URLs first (`/users/42` → `/users/:id`), or every ID becomes its own "endpoint".
5. If the logs are in a database, let it do the work: `GROUP BY endpoint ORDER BY COUNT(*) DESC LIMIT 10`.

## 12. Dynamic programming — Climbing Stairs (70), Coin Change (322)
**🟢 In simple words:** Break a big problem into smaller versions of the same problem. Solve the small ones first and save their answers in a table. Then build the big answer from the saved small answers, so nothing is computed twice.
**🏠 Real-life example:** To know how many coins make 6 rupees, you reuse what you already wrote down for 5, 4 and 1 rupees — like using notes from earlier pages of your notebook.

```js
function coinChange(coins, amount) {
  const dp = Array(amount + 1).fill(Infinity); dp[0] = 0;
  for (let a = 1; a <= amount; a++)
    for (const c of coins) if (c <= a) dp[a] = Math.min(dp[a], dp[a - c] + 1);
  return dp[amount] === Infinity ? -1 : dp[amount];
}
```
Similar: House Robber (198), Longest Increasing Subsequence (300), Word Break (139).

**🔍 Internal working:**
1. **State:** `dp[a]` = minimum coins needed to make amount `a`. **Transition:** `dp[a] = min(dp[a - c] + 1)` for every coin `c ≤ a`. **Base:** `dp[0] = 0`.
2. **Filling order matters:** `dp[a]` depends only on smaller amounts. So filling `a = 1, 2, 3, …` makes sure every dependency is already computed. (This is a topological order of the subproblems.)
3. Each cell is computed once, with `coins.length` work → **O(amount × coins)** time, O(amount) space.
4. `Infinity` is the "unreachable" sentinel (special marker value). `Infinity + 1` is still `Infinity`, so `Math.min` naturally ignores impossible states. No special checks are needed.
5. **Top-down (memoization)** solves the same recurrence with recursion + a cache. But the recursion depth can reach `amount` (e.g. 10^4 with coin 1) and overflow the call stack. Bottom-up uses a loop and has no stack risk.
6. **Space optimization:** sometimes a state needs only the last few states. Climbing Stairs needs only `dp[i-1]` and `dp[i-2]` (House Robber is the same). Then keep two variables instead of the full array → O(1) space.

```text
coins = [1,2,5], amount = 6
a  : 0 1 2 3 4 5 6
dp : 0 1 1 2 2 1 2     dp[6] = min(dp[5]+1, dp[4]+1, dp[1]+1) = 2
```

**🎤 Say this in the interview:** "I define the state and the transition. Then I fill the table in an order where every dependency is already computed — for coin change, from 0 up to amount. This gives O(amount × coins) without the stack-overflow risk of deep memoized recursion."

**🧪 Real scenario:** Your admin panel must show "what changed" between two versions of a long notice or config file, line by line, like `git diff`. Which pattern helps?

**✅ Scenario answer:**
1. Key idea: this is the Longest Common Subsequence (LCS) problem. Lines in the LCS are "unchanged". Other lines are "removed" (old file) or "added" (new file).
2. State: `dp[i][j]` = LCS length of the first `i` old lines and the first `j` new lines. If the lines are equal, `dp[i][j] = dp[i-1][j-1] + 1`; else `max(dp[i-1][j], dp[i][j-1])`.
3. Walk back from `dp[n][m]` to build the list of added, removed and unchanged lines.
4. Cost: O(n × m) time and memory. For two files of 10,000 lines this is 10⁸ cells — too big.
5. In production, use a tested library such as the `diff` npm package, which uses the faster Myers algorithm. Explain the DP to show you understand the idea.

---

## JS-specific machine-coding questions (frequent in Indian product companies)
**🟢 In simple words:** In these rounds you write small, real utilities instead of puzzles. A common one is a concurrency limiter: run many async tasks, but never more than N at the same time. Workers share one counter and each takes the next task as soon as it is free.
**🏠 Real-life example:** A bank with 3 counters and a long queue: only 3 customers are served at once, and when a counter is free, the next person in line goes there.

- Implement `Promise.all`, `Promise.race`, `Promise.allSettled` (see 01-javascript.md)
- Implement debounce, throttle, curry, deep clone, `flatten(array, depth)`, memoize
- Implement an EventEmitter (`on`, `off`, `once`, `emit`)
- A retry wrapper with exponential backoff
- A promise pool / concurrency limiter (run max N async tasks at a time)

```js
// Concurrency limiter — frequently asked
async function runWithLimit(tasks, limit) {
  const results = []; let i = 0;
  async function worker() {
    while (i < tasks.length) { const idx = i++; results[idx] = await tasks[idx](); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}
```

**🔍 Internal working:**
1. `runWithLimit` calls `worker` `limit` times **synchronously**. Each worker runs until its first `await`. So exactly `limit` tasks start at once.
2. `const idx = i++` needs no lock. JS runs your code on **one thread**, and a function is never interrupted between two `await`s. So taking an index is atomic compared to the other workers.
3. When a task's promise settles, the code after `await` is scheduled as a **microtask** (a promise reaction job). The event loop runs all queued microtasks after the current task finishes. So the worker resumes, saves the result, and at once takes the next index. A free worker never sits idle.
4. Results are written to `results[idx]`. So the output order matches the input order, even though tasks finish in a different order.
5. `Promise.all` over the workers rejects as soon as one task throws. But the **other workers keep running** and keep starting new tasks in the background. If you need "collect all errors" behaviour, wrap each task in `try/catch` and store `{status, value|reason}` (like `allSettled`).
6. Tasks must be **functions** that return promises (`() => fetch(url)`). An array of promises would already be running, because a promise starts its work when it is created. Then the limit would mean nothing.
7. Related internals:
   - `setTimeout` (used in debounce/throttle/retry backoff) schedules a **macrotask** in the timers phase. It runs only after the microtask queue is empty.
   - `EventEmitter.emit` calls the listeners **synchronously**, in the order they were registered.

```text
limit = 2, tasks T0..T3
worker1: T0 ─────── await ──► (microtask) T2 ── await ──► done
worker2: T1 ── await ──► (microtask) T3 ── await ──► done
i:       0 → 1 → 2 → 3 → 4  (each i++ happens synchronously, no race)
```

**🎤 Say this in the interview:** "The pool starts N async workers that share one index. JavaScript is single-threaded and never interrupts code between awaits, so i++ is race-free. Each await continuation runs as a microtask, so a worker picks the next task as soon as its current one settles. Results keep the input order because they are stored by index."

**🧪 Real scenario:** You must call an external API to verify 5,000 records. The provider allows only 10 parallel requests. Running `Promise.all` on all 5,000 calls at once gives 429 errors and the job fails. How do you fix it?

**✅ Scenario answer:**
1. Root cause: `Promise.all(records.map(r => verify(r)))` starts all 5,000 requests at once, because a promise starts when it is created.
2. Fix: use a concurrency limiter like `runWithLimit`, with tasks as functions: `runWithLimit(records.map(r => () => verify(r)), 10)`.
3. Wrap each task in `try/catch` with a retry and exponential backoff for 429/5xx errors. Then one failure does not stop the whole job.
4. Store `{ status, value | reason }` for each record, so you can report which records failed.
5. In production, the `p-limit` package does the same. Results stay in input order because each result is saved by its index.
