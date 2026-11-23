# 01 — JavaScript (Senior Level)

> Answer format to practice: **Definition → How it works → Example → Pitfall / real-world use.** Keep each answer to 60–90 seconds.

---

### Q1. Explain closures. Give a real-world use.
**🟢 In simple words:** A closure is a function that remembers the variables around it. It remembers them even after the outer function has finished. So the inner function can still read and change those variables later.
**🏠 Real-life example:** A child leaves home for school but still carries the house key. Home is "closed", but the child can still open the door anytime with that key.

**Answer:** A closure is a function that remembers the variables of the lexical scope (the place in the code where it was written) where it was *created*. It remembers them even after the outer function has returned. The inner function keeps a reference to the outer scope's environment record. It does not keep a copy.

**Basic example (write this first in the interview):**
```js
function outerFunction() {
    let count = 0;

    function innerFunction() {
        count++;
        console.log(count);
    }

    return innerFunction;
}

const counter = outerFunction();

counter(); // 1
counter(); // 2
counter(); // 3
```
**How it works, step by step:**
1. `outerFunction()` runs. It creates `count = 0` and the function `innerFunction`.
2. It **returns** `innerFunction` (the function itself, not its result). Now `outerFunction` is finished.
3. Normally `count` would be deleted now. But `innerFunction` still uses `count`, so JavaScript **keeps it alive**. This is the closure.
4. `counter` now points to `innerFunction` + its remembered `count`.
5. Each `counter()` call changes the **same** `count` → 1, 2, 3. The value is not reset, because `outerFunction` is not called again.
6. Nobody outside can change `count` directly (`console.log(count)` outside → `ReferenceError`). So `count` is **private** data.

**Interviewer follow-up — "What if I call `outerFunction()` two times?"**
```js
const counterA = outerFunction();
const counterB = outerFunction();

counterA(); // 1
counterA(); // 2
counterB(); // 1  ← new call = new, separate count
```
Each call to `outerFunction()` creates a **new** `count`. So `counterA` and `counterB` have their own memory. They do not share it.

**Advanced example (many functions sharing one private variable):**
```js
function createCounter() {
  let count = 0;                 // private state
  return { inc: () => ++count, get: () => count };
}
const c = createCounter(); c.inc(); c.get(); // 1
```
**Real-world:** data privacy (module pattern), memoization caches, `debounce`/`throttle`, React hooks (`useState` relies on closures), middleware factories in Express (`authorize('admin')`).
**Pitfall:** stale closures (closures that see an old value) in React `useEffect`/`setInterval`. Memory leaks when closures hold large objects (e.g. event listeners that are never removed).

**🔍 Internal working:**
1. **Spec view:** when a function object is created, the engine saves the current Lexical Environment. It stores it in an internal slot called `[[Environment]]`. Later, when the function is called, a new Function Environment Record is created. Its `[[OuterEnv]]` points to that saved `[[Environment]]`. This chain of outer links is the scope chain.
2. **Name lookup:** `ResolveBinding('count')` first checks the current Environment Record. If the name is not there, it follows `[[OuterEnv]]` links outward. It stops when it finds the name. If it reaches the global record without finding it, it throws `ReferenceError`.
3. **V8 parse-time scope analysis:** V8 decides at parse/compile time which variables are used by inner functions ("captured"). Locals that are not captured live in Ignition registers (on the stack). Captured variables are "context-allocated". This means they are put into a heap object called a `Context`.
4. **Runtime:** when `createCounter()` runs, V8 creates a `Context` that holds `count`. Each inner closure (`JSFunction`) gets a pointer to this `Context`. After `createCounter` returns, its stack frame is gone. But the `Context` stays alive on the heap, because the closures still point to it.
5. **Shared context:** all closures created in the same scope share **one** `Context` object. So if one closure captures a large object, that object stays alive as long as **any** sibling closure is alive. This is a common hidden source of leaks.
6. **GC:** the `Context` is freed only when no reachable function points to it anymore.

```text
 c.inc (JSFunction) ──┐
                      ├──► Context { count: 1 } ──► outer Context (module/global)
 c.get (JSFunction) ──┘
```

**🎤 Say this in the interview:** "Every function stores the environment where it was created. In V8, captured variables are moved off the stack into a heap-allocated Context object. The closure points to that Context, so the variables live longer than the outer call. All closures from one scope share that same Context."

**🧪 Real scenario:** In our React dashboard, a `useEffect` with `[]` starts a `setInterval` that logs `count` every second. The user clicks "+" many times, but the log always shows `0`. What is happening and how do you fix it?

**✅ Scenario answer:**
1. **Root cause:** this is a stale closure. The effect runs only once, on the first render. The interval callback closed over `count` from that first render, which is `0`. Later renders create new `count` values, but the old callback never sees them.
2. **Confirm:** the `react-hooks/exhaustive-deps` ESLint rule warns that `count` is missing from the dependency array. Also, a `console.log` inside the render shows the new value, but the interval still shows `0`.
3. **Fix 1:** use the functional updater, so you do not need to read `count` at all: `setCount(c => c + 1)`.
4. **Fix 2:** if you must read the latest value, keep it in a ref:
   ```js
   const countRef = useRef(count);
   countRef.current = count;
   useEffect(() => {
     const id = setInterval(() => console.log(countRef.current), 1000);
     return () => clearInterval(id); // cleanup
   }, []);
   ```
5. **Prevent:** keep `exhaustive-deps` as an error in CI, and always return a cleanup function from effects that start timers or listeners.

---

### Q2. What is `this`? How is it determined?
**🟢 In simple words:** `this` means "who is calling me right now". Its value depends on how you call the function, not where you wrote it. Arrow functions are different: they just borrow `this` from the code around them.
**🏠 Real-life example:** The word "my house" changes meaning depending on who says it. When Ram says it, it is Ram's house. When Sita says it, it is Sita's house. The speaker decides, like the caller decides `this`.

**Answer:** `this` is decided by **how a function is called**, not where it is defined. Arrow functions are the exception. The rules, from highest priority to lowest:
1. `new` binding → the newly created object.
2. Explicit → `call` / `apply` / `bind`.
3. Implicit → `obj.method()` → `obj`.
4. Default → `undefined` in strict mode, `globalThis` otherwise.

**Arrow functions** have no `this` of their own. They take it lexically (from the surrounding code). So `call`/`bind` cannot change it.
**Pitfall:** if you pass `obj.method` as a callback, it loses `this`. Fix it with `.bind(obj)` or wrap it in an arrow function.

**🔍 Internal working:**
1. **Reference Records:** evaluating `obj.method` produces a Reference Record with `[[Base]] = obj`. When this reference is called, `EvaluateCall` uses the base as `thisValue`. If you first copy it (`const f = obj.method`), the reference is lost. Then `thisValue` is `undefined`.
2. **Binding `this`:** on `[[Call]]`, the spec runs `OrdinaryCallBindThis`. It checks the function's `[[ThisMode]]`:
   - `lexical` (arrows) → do nothing.
   - `strict` → use `thisValue` as it is.
   - non-strict → `undefined`/`null` become `globalThis`, and primitives are boxed (wrapped in objects) with `ToObject`.
3. **Storage:** the value is stored in the Function Environment Record (`[[ThisValue]]`, `[[ThisBindingStatus]]`). The environment records of arrow functions have no `this` binding at all.
4. **Resolving `this`:** `ResolveThisBinding` walks up the environment chain. It stops at the nearest record that has a `this` binding. For an arrow, this is the surrounding normal function, or the module/global scope. That is why arrows "capture" `this`.
5. **`new`:** `[[Construct]]` creates the object using `OrdinaryCreateFromConstructor` and binds it as `this`. In a **derived** class constructor (a class that `extends` another), `this` starts uninitialized. It is bound only when `super()` returns. Using it before that throws `ReferenceError`.
6. **V8:** `this` is just the receiver argument, passed in a register. For sloppy-mode (non-strict) functions, V8 adds the receiver conversion (global proxy / boxing) at the call.

**🎤 Say this in the interview:** "`this` is the receiver taken from the Reference Record at the call site. It is bound into the function's environment record based on its `[[ThisMode]]`. Arrows have lexical this-mode, so the lookup just walks up to the surrounding function's binding."

**🧪 Real scenario:** After a refactor to classes, our Express route `router.get('/users', userController.getAll)` throws `TypeError: Cannot read properties of undefined (reading 'userService')`. The same method works in unit tests. Why?

**✅ Scenario answer:**
1. **Root cause:** we passed `userController.getAll` as a callback. Express later calls it as a plain function, not as `userController.getAll()`. So the implicit binding is lost. Class bodies are strict mode, so `this` is `undefined`.
2. **Confirm:** add `console.log(this)` at the top of `getAll` — it prints `undefined`. In the unit test, the method was called as `controller.getAll()`, so `this` was correct there.
3. **Fix:** bind it once, or use an arrow wrapper, or define the method as an arrow class field:
   ```js
   router.get('/users', userController.getAll.bind(userController));
   // or: router.get('/users', (req, res) => userController.getAll(req, res));
   // or in the class: getAll = async (req, res) => { ... };
   ```
4. **Prevent:** pick one team pattern (for example, arrow class fields for handlers). Write route tests with `supertest` so the real Express call style is tested, not only direct method calls.

---

### Q3. `call` vs `apply` vs `bind`?
**🟢 In simple words:** All three let you choose what `this` will be. `call` and `apply` run the function right now. `call` takes arguments one by one, `apply` takes them as an array. `bind` does not run it — it gives you a new function with `this` fixed forever.
**🏠 Real-life example:** `call` is phoning a friend and telling the items one by one. `apply` is phoning and reading from a shopping list. `bind` is saving a speed-dial button for later — pressing it always calls the same person.

- `fn.call(ctx, a, b)` — runs immediately, arguments given one by one.
- `fn.apply(ctx, [a, b])` — runs immediately, arguments given as an array.
- `fn.bind(ctx, a)` — returns a **new function** with `this` fixed forever (and optionally some arguments pre-filled).

**Polyfill bind (common ask):**
```js
Function.prototype.myBind = function (ctx, ...pre) {
  const fn = this;
  return function (...args) { return fn.apply(ctx, [...pre, ...args]); };
};
```

**🔍 Internal working:**
1. **`call`:** directly does `Call(F, thisArg, argsList)`. The arguments are pushed as normal call arguments. No extra memory is allocated.
2. **`apply`:** runs `CreateListFromArrayLike(argArray)`. This reads `length` and each index. Then it calls the function. Very large arrays can go over the engine's argument/stack limit and throw `RangeError`. This is why `Math.max.apply(null, hugeArray)` can fail.
3. **`bind`:** creates a **Bound Function Exotic Object**. It has internal slots `[[BoundTargetFunction]]`, `[[BoundThis]]` and `[[BoundArguments]]`. Its `[[Call]]` ignores the incoming `this`. It calls the target with `[[BoundThis]]` and `[[BoundArguments]] + args`.
4. **`new` on a bound function:** its `[[Construct]]` **ignores `[[BoundThis]]`**. It constructs the target with the bound arguments. The simple polyfill above does not support this (with `new`, it would still use `ctx`). It also does not set `name` (`"bound fn"`) or `length`.
5. **Re-binding:** `bound.bind(other)` creates another bound function. Its target is the first bound function. So the first `[[BoundThis]]` still wins. That is why `this` is "permanent".
6. **V8:** TurboFan (V8's optimizing compiler) recognizes `Function.prototype.call/apply` (including `apply` with `arguments`). It can inline them into a direct call. So in hot code they are usually as fast as a normal call.

**🎤 Say this in the interview:** "`call` and `apply` just do the internal `[[Call]]` with a chosen receiver. `bind` creates a bound function exotic object. It stores the target, `this` and partial arguments in internal slots. And `new` ignores the bound `this` — a simple polyfill gets this wrong."

**🧪 Real scenario:** A pricing report works in staging. In production, with 500,000 prices, `Math.max.apply(null, prices)` throws `RangeError: Maximum call stack size exceeded`. What is wrong and how do you fix it?

**✅ Scenario answer:**
1. **Root cause:** `apply` turns every array item into a separate function argument. Arguments go on the stack, and the engine has a limit. A very large array goes over that limit. Spread (`Math.max(...prices)`) has the same problem.
2. **Confirm:** reproduce with a big array in a quick script: `Math.max.apply(null, new Array(1e6).fill(1))`. It throws, while a small array works.
3. **Fix:** use a simple loop or `reduce`. It uses no extra stack:
   ```js
   let max = -Infinity;
   for (const p of prices) if (p > max) max = p;
   ```
4. **Prevent:** in code review, flag `apply`/spread on data whose size is not under your control (DB results, user uploads). Add a test with production-size data.

---

### Q4. Explain the event loop (browser/JS level).
**🟢 In simple words:** JavaScript can do only one thing at a time. Slow work (timers, network) is given to the browser or Node. When that work is done, its callback waits in a queue. The event loop picks callbacks from the queues when JS is free — first all small "urgent" jobs (microtasks), then one normal job (macrotask).
**🏠 Real-life example:** A restaurant with one chef. Waiters bring orders to a queue. VIP orders (microtasks) are all cooked first, then one normal order (macrotask), then VIP orders again. Between rounds, the chef cleans the counter (rendering).

**Answer:** JS is single-threaded. It has one call stack. Async work (timers, I/O, network) is handed to the host (browser/libuv). When that work finishes, its callback is put in a queue.
- **Microtask queue:** Promise callbacks (`.then`), `queueMicrotask`, `MutationObserver`. (Node also has `process.nextTick`, which runs even before them.)
- **Macrotask (task) queue:** `setTimeout`, `setInterval`, I/O, UI events.

**Order:** Run sync code → empty the stack → **run ALL microtasks** → take ONE macrotask → run all microtasks again → render (browser) → repeat.

```js
console.log(1);
setTimeout(() => console.log(2));
Promise.resolve().then(() => console.log(3));
console.log(4);
// 1 4 3 2
```
**Pitfall:** an endless chain of microtasks blocks macrotasks and rendering forever ("starves" them).

**🔍 Internal working:**
1. **Who owns what:** the event loop is defined by the **host** (HTML spec in browsers, libuv in Node), not by ECMAScript. ECMAScript only defines *Jobs*. The host adds them to a queue using `HostEnqueuePromiseJob`. V8 keeps the microtask queue (`MicrotaskQueue`). Blink/Node own the task queues.
2. **Task selection:** the browser has **several task queues** (task sources: timers, user input, networking, etc.). In each loop round, it chooses one queue and picks the oldest runnable task from it. Browsers may give user input higher priority. The task runs to completion.
3. **Microtask checkpoint:** after the task, the JS stack becomes empty. Then the host runs a checkpoint. (This also happens after each callback — for example, between the event listeners of a real user click.) The checkpoint empties the microtask queue completely. This includes microtasks added while it is emptying.
4. **Rendering step:** sometimes there is a rendering opportunity (usually tied to screen refresh, ~16.7 ms at 60 Hz). Then the browser runs resize/scroll steps, then `requestAnimationFrame` callbacks, then style → layout → paint. If time is left before the next frame, `requestIdleCallback` callbacks can run.
5. **Timers:** `setTimeout` is a *minimum* delay, not an exact one. The HTML spec forces nested timers (nesting level > 5) to wait at least 4 ms. Background tabs are slowed down even more.
6. **Node difference:** libuv runs in phases (timers → pending → poll → check → close). After each callback, Node first empties the `process.nextTick` queue. Then it empties the V8 promise microtask queue.

```text
 ┌──────────── one event-loop iteration (browser) ─────────────┐
 │ pick 1 task ──► run to completion ──► drain ALL microtasks  │
 │      ▲                                     │                │
 │      │                       render? (rAF → style → layout → paint)
 │      └─────────────────────────────────────┘                │
 └──────────────────────────────────────────────────────────────┘
```

**🎤 Say this in the interview:** "The event loop belongs to the host, not V8. Each round runs one task from a task source. Then it does a microtask checkpoint that fully empties V8's microtask queue. Only after that can it run rAF and render. That is why an endless microtask loop freezes the page."

**🧪 Real scenario:** Our Node.js API usually answers in 20 ms. A few times every hour, all requests become slow (2–3 s), and Kubernetes health checks fail. CPU is high at the same moments. What is happening?

**✅ Scenario answer:**
1. **Root cause:** some synchronous CPU-heavy work is blocking the event loop. For example, `JSON.parse` of a huge payload, a big sort, a sync crypto call, or a bad regex. While it runs, no other callback (including the health check) can run.
2. **Confirm:** measure event-loop delay with `perf_hooks`:
   ```js
   const { monitorEventLoopDelay } = require('perf_hooks');
   const h = monitorEventLoopDelay(); h.enable();
   setInterval(() => console.log('p99 lag ms', h.percentile(99) / 1e6), 10000);
   ```
   Then take a CPU profile (`node --cpu-prof` or Chrome DevTools via `--inspect`) to find the hot function.
3. **Fix:** move heavy work to `worker_threads` (or a job queue). Or split it into small chunks and yield with `setImmediate` between chunks. Use async APIs instead of `*Sync` ones.
4. **Prevent:** export event-loop lag as a metric with an alert. Put size limits on request bodies. Load-test with real data sizes.

---

### Q5. `var` vs `let` vs `const`, hoisting and TDZ.
**🟢 In simple words:** `var` belongs to the whole function and starts as `undefined`. `let` and `const` belong only to their `{ }` block. They exist from the start of the block, but you cannot touch them before their line — that "no-touch" zone is the TDZ. `const` means you cannot point the name to a new value, but the object inside can still change.
**🏠 Real-life example:** A hotel room is booked in your name before you arrive (hoisting). With `var`, staff let anyone in and the room is empty (`undefined`). With `let`/`const`, the door stays locked until you check in (TDZ).

- `var`: function-scoped. Hoisted and set to `undefined`. Can be declared again. At global level it becomes a property of `window`.
- `let`/`const`: block-scoped. Hoisted but **not initialized**. If you access them before the declaration line, you get `ReferenceError`. This zone is the **Temporal Dead Zone**.
- `const` stops **rebinding** (giving the name a new value). It does not stop mutation (`const o = {}; o.a = 1` is fine). Use `Object.freeze` for shallow immutability.

Classic loop bug: `for (var i=0;i<3;i++) setTimeout(()=>console.log(i))` → `3 3 3`. With `let` → `0 1 2` (a new binding for each loop round).

**🔍 Internal working:**
1. **"Hoisting" is really instantiation:** before any code of a function runs, `FunctionDeclarationInstantiation` scans all declarations. For each `var`, it calls `CreateMutableBinding` + `InitializeBinding(undefined)`. Function declarations are created and set to the function object.
2. **`let`/`const`/`class`:** when a block (or function body) starts, a new Declarative Environment Record is created. Their bindings are created but **left uninitialized**. Any read or write of an uninitialized binding throws `ReferenceError`. That time window is the TDZ. The binding is initialized only when the declaration line runs.
3. **Global scope:** the Global Environment Record has two parts:
   - an **Object Record** (backed by the global object). `var` and function declarations go here, so they appear on `window`.
   - a **Declarative Record**. `let`/`const`/`class` go here, so they do *not* appear on `window`.
4. **Loops:** for `for (let i ...)`, the spec runs `CreatePerIterationEnvironment`. It creates a fresh environment for each loop round and copies the current value of `i` into it. Each closure captures a different environment, so you get `0 1 2`. With `var`, there is only one binding in the function's environment.
5. **`const`:** created with `CreateImmutableBinding`. Assigning to it throws `TypeError`. The object it points to is not affected.
6. **V8:** an uninitialized `let` holds a special marker value (`the_hole`). V8 adds a "hole check" on access and throws if it sees the hole. The optimizer removes the check when it can prove the variable is already initialized.

**🎤 Say this in the interview:** "All declarations are instantiated before code runs. `var` bindings are created and set to `undefined`. `let`/`const` bindings are created uninitialized — V8 stores a 'hole' marker there and throws on access, which is the TDZ. And `for-let` gets a copied environment for each loop round."

**🧪 Real scenario:** After moving our Node project to ES modules, the app crashes on startup with `ReferenceError: Cannot access 'db' before initialization`. Nothing changed in the `db` file. What is going on?

**✅ Scenario answer:**
1. **Root cause:** this is the TDZ plus a circular import. Module A imports B, and B imports A. B runs first and reads A's `const db` at the top level. A has not run that line yet, so `db` is still uninitialized.
2. **Confirm:** the stack trace shows the top-level line in B. Find cycles with a tool such as `npx madge --circular src/`.
3. **Fix:** break the cycle. Move the shared thing (`db`) into its own small module that both A and B import. Or read `db` lazily inside a function instead of at the top level:
   ```js
   // bad (top level):  const users = db.collection('users');
   export function getUsers() { return db.collection('users'); } // read at call time
   ```
4. **Prevent:** run `madge --circular` (or ESLint `import/no-cycle`) in CI. Keep modules layered: config → db → services → routes.

---

### Q6. Prototypal inheritance — how does it work?
**🟢 In simple words:** Every object has a hidden link to a "parent" object (its prototype). If you ask an object for something it does not have, JS asks the parent, then the grandparent, and so on. This chain ends at `null`. `class` is just a nicer way to write this.
**🏠 Real-life example:** A family tree. If you do not know a family recipe, you ask your mother. If she does not know, she asks grandmother. You keep going up until someone knows it — or there is nobody left.

Every object has an internal `[[Prototype]]` (read it with `Object.getPrototypeOf` / `__proto__`). When you look up a property, JS walks the **prototype chain**. It stops when it finds the property or reaches `null`. Functions have a `.prototype` object. This object becomes the `[[Prototype]]` of instances created with `new`. ES6 `class` is syntactic sugar (a nicer syntax) over this.

`new Foo()` does 4 things:
1. creates an empty object
2. links its prototype to `Foo.prototype`
3. calls `Foo` with `this` = the new object
4. returns the object (unless the constructor returns another object).

**🔍 Internal working:**
1. **Spec lookup:** `obj.x` calls `[[Get]]` → `OrdinaryGet`. It checks `[[GetOwnProperty]]` on the object. If not found, it calls `[[Get]]` on `[[Prototype]]`. This repeats until `null` (then it returns `undefined`). If it finds a getter, the getter is called with the **original** object as receiver.
2. **Writes are different:** `obj.x = 1` (`OrdinarySet`) also walks the chain. It looks for a setter or a non-writable property. But a normal assignment always creates/updates an **own** property on `obj` (this is "shadowing"). It never changes the prototype.
3. **V8 hidden classes (Maps):** every object has a hidden class that describes its shape (property names → offsets). Objects created the same way (same properties, same order) share a Map. Adding a property moves the object along a **transition tree** to a new Map.
4. **Inline caches (ICs):** each place in code that reads a property keeps a small cache: "for Map M, the property is at offset K (or on prototype P)".
   - One Map seen = monomorphic (fastest).
   - 2–4 Maps = polymorphic.
   - More = megamorphic (falls back to a global stub cache / slow lookup).
5. **Prototype lookups:** when a property is found on a prototype, V8 caches the object that holds it. It protects this cache with a **prototype validity cell**. Changing a prototype object (adding methods later, `Object.setPrototypeOf`) invalidates those cells. Then ICs miss and optimized code may deoptimize (fall back to slower code). That is why changing prototypes at runtime is slow.
6. **`delete` and many dynamic keys** can switch an object to "dictionary mode" (properties stored in a hash table). This turns off the fast Map-based path.

```text
 dog ──[[Prototype]]──► Dog.prototype ──► Animal.prototype ──► Object.prototype ──► null
 (own: name)            (bark)            (eat)                (toString)
```

**🎤 Say this in the interview:** "By the spec, lookup walks `[[Prototype]]` links. V8 makes it fast with hidden classes and inline caches that remember where a property lives. These caches are guarded by prototype validity cells. So changing prototypes at runtime invalidates caches and can deoptimize code."

**🧪 Real scenario:** A teammate added a helper `Object.prototype.isEmpty = function () {...}`. Now a `for...in` loop in our code shows an extra key `isEmpty`, and a third-party library breaks. How do you explain and fix this in code review?

**✅ Scenario answer:**
1. **Root cause:** every object inherits from `Object.prototype`. A property added by normal assignment is **enumerable**. `for...in` walks the whole prototype chain, so every object now "has" `isEmpty`. Libraries that use `for...in` or check keys see it too.
2. **Confirm:** `for (const k in {}) console.log(k)` prints `isEmpty`. `Object.getOwnPropertyDescriptor(Object.prototype, 'isEmpty')` shows `enumerable: true`.
3. **Fix:** remove it. Use a normal utility function instead:
   ```js
   export const isEmpty = obj => Object.keys(obj).length === 0;
   ```
   Also prefer `Object.keys`/`Object.entries` over `for...in` (they return own keys only).
4. **Extra point:** changing built-in prototypes at runtime also invalidates V8's prototype caches, which can slow down hot code.
5. **Prevent:** turn on ESLint `no-extend-native` and `guard-for-in`.

---

### Q7. Promises — states, chaining, and the combinators.
**🟢 In simple words:** A promise is a box for a value that will come later. It starts "pending". Then it becomes either "fulfilled" (success) or "rejected" (failure), only once, and never changes again. `.then` lets you say "when it is ready, do this next".
**🏠 Real-life example:** An order token at a food court. You get the token now (pending). Later your food is ready (fulfilled) or they say it is sold out (rejected). `Promise.all` is like waiting for the whole family's orders before sitting down.

States: `pending` → `fulfilled` | `rejected` (settled only once, then it cannot change).
- `Promise.all` — all fulfill → array. **Fails fast** on the first rejection.
- `Promise.allSettled` — waits for all. Returns `{status, value|reason}` for each.
- `Promise.race` — the first one to *settle* (finish in any way) wins.
- `Promise.any` — the first one to *fulfill*. Gives `AggregateError` if all reject.

**Implement `Promise.all` (very common):**
```js
function promiseAll(items) {
  return new Promise((resolve, reject) => {
    const results = []; let done = 0;
    if (items.length === 0) return resolve(results);
    items.forEach((p, i) => {
      Promise.resolve(p).then(v => {
        results[i] = v;
        if (++done === items.length) resolve(results);
      }, reject);
    });
  });
}
```

**🔍 Internal working:**
1. **Internal slots:** a promise has `[[PromiseState]]`, `[[PromiseResult]]`, `[[PromiseFulfillReactions]]`, `[[PromiseRejectReactions]]` and `[[PromiseIsHandled]]`.
2. **Constructor:** `new Promise(executor)` creates a pair of **resolving functions** (`resolve`, `reject`). They share an `alreadyResolved` flag, so only the first call has any effect. The executor runs **synchronously** (right away).
3. **`.then(onF, onR)`:** creates a new **PromiseCapability** (`{promise, resolve, reject}`) using `NewPromiseCapability(SpeciesConstructor)`. It wraps the handlers into **PromiseReaction** records.
   - If the promise is pending, the reactions are added to the lists.
   - If it is already settled, a **PromiseReactionJob** is queued immediately (`HostEnqueuePromiseJob`).
   - Handlers are never called synchronously.
4. **Settling:** `resolve(value)` → `FulfillPromise` sets state/result. Then `TriggerPromiseReactions` queues one PromiseReactionJob per reaction. The job runs the handler. Then it resolves/rejects the next promise's capability with the result. That is how chaining works.
5. **Resolving with a thenable:** if `resolve(x)` gets a thenable (an object with a `.then` method), it queues a **PromiseResolveThenableJob**. That job calls `x.then(resolve, reject)` in a later microtask. This costs extra ticks. That is why returning a promise from `.then` delays the chain by about 2 microtasks.
6. **Unhandled rejections:** when a promise is rejected and has no handler, the engine calls `HostPromiseRejectionTracker`. The host uses it for `unhandledrejection` (browser) or the `unhandledRejection` event / process crash (Node ≥15).
7. **Spec `Promise.all`:** uses a separate resolve function per element, with `[[AlreadyCalled]]` and `[[Index]]` slots. It keeps a `remainingElementsCount` that starts at 1 and is reduced by one after the loop. So it works for any iterable, not only arrays. (The polyfill above needs `Array.from(items)` for iterables.)

```text
 p (pending) ── reactions: [R1 → cap1, R2 → cap2]
 resolve(v) ──► state=fulfilled ──► enqueue Job(R1,v), Job(R2,v) ──► microtask queue
 Job(R1,v): r = onF(v); cap1.resolve(r)   // drives the next promise in the chain
```

**🎤 Say this in the interview:** "A promise is a state machine with reaction lists. `then` creates a new PromiseCapability plus reaction records. When the promise settles, each reaction becomes a PromiseReactionJob on the microtask queue. Its result resolves the next capability — that is the whole chaining mechanism."

**🧪 Real scenario:** Our home page loads data from 3 services with `Promise.all`: profile, orders, and recommendations. When only the recommendation service is down, the whole page shows an error. Product wants the page to load anyway. What do you change?

**✅ Scenario answer:**
1. **Root cause:** `Promise.all` fails fast. One rejection rejects the whole result, even if the other two succeeded.
2. **Confirm:** logs show the error came from the recommendations call. Profile and orders returned 200 at the same time.
3. **Fix:** use `Promise.allSettled` and handle each result. Required data can still fail the page; optional data gets a fallback:
   ```js
   const [profile, orders, recs] = await Promise.allSettled([getProfile(), getOrders(), getRecs()]);
   if (profile.status === 'rejected') throw profile.reason; // required
   const recommendations = recs.status === 'fulfilled' ? recs.value : []; // optional
   ```
4. **Also add a timeout** for the slow optional call (for example `AbortSignal.timeout(2000)` with `fetch`), so a hanging service does not slow the page.
5. **Prevent:** decide for each dependency if it is "required" or "optional", and test with that service down (mock it returning 500 or timing out).

---

### Q8. `async/await` — what happens under the hood? Common mistakes?
**🟢 In simple words:** An `async` function always gives back a promise. `await` pauses the function until a promise is ready, and lets other code run meanwhile. When the promise is ready, the function continues from the same line. It is promises plus a "pause and resume" trick.
**🏠 Real-life example:** You put clothes in the washing machine and go cook (`await` the wash). When the machine beeps, you come back and continue hanging the clothes exactly where you left off.

`async` functions always return a Promise. `await` pauses the function. When the awaited promise settles, the rest of the function is scheduled as a microtask. (Inside, it is generator + promise machinery.)
**Mistakes:**
- Awaiting independent calls one after another → use `Promise.all([a(), b()])`.
- `await` inside `forEach` does not wait → use `for...of` or `Promise.all(arr.map(...))`.
- Missing `try/catch` → unhandled rejections (which crash Node ≥15).
- Wrapping in `new Promise` when not needed (the "promise constructor anti-pattern").

**🔍 Internal working:**
1. **Call:** calling an async function creates a PromiseCapability (the promise you get back). Then it runs the body **synchronously** until the first `await`.
2. **`await v`:** the spec does `promise = PromiseResolve(%Promise%, v)`. If `v` is already a native promise, it is reused (no wrapper). Then it does `PerformPromiseThen(promise, onFulfilled, onRejected)`; these handlers resume this function. The current execution context is **suspended** and removed from the stack. Control goes back to the caller.
3. **Resume:** when `promise` settles, a PromiseReactionJob runs the handler. The handler restores the saved execution context and continues after the `await` with the value. If it was rejected, it throws the reason at that point, so `try/catch` works.
4. **Finish:** `return x` resolves the capability. An uncaught throw rejects it.
5. **V8 implementation:** async functions are compiled like generators. Ignition emits `SuspendGenerator`/`ResumeGenerator` bytecodes. The live registers are saved in a heap-allocated generator-like object and restored on resume.
6. **Version note:** before V8 7.2 / Node 12, `await` always wrapped the value in an extra promise and cost 3 microtask ticks. The ES2019 spec change ("await optimization") reduced `await nativePromise` to 1 tick. V8 7.3+ also gives "zero-cost async stack traces" across awaits.

```text
 asyncFn() ──► run sync ──► await p ──► suspend, return promise to caller
                                     └─ p.then(resume) … microtask … resume(value) ──► next await / return → resolve(result)
```

**🎤 Say this in the interview:** "An async function is a resumable generator plus a PromiseCapability. Each `await` does `PromiseResolve` on the value. Then it attaches a reaction that resumes the suspended execution context. V8 implements the suspension with generator bytecodes. Since ES2019, an await on a native promise costs just one microtask tick."

**🧪 Real scenario:** A CSV import job does `rows.forEach(async row => { await db.insert(row); })` and then logs "Import done". The log appears in less than a second, but rows keep arriving in the DB later. Sometimes the process crashes with an unhandled rejection. Why?

**✅ Scenario answer:**
1. **Root cause:** `forEach` ignores the promise returned by the async callback. So nothing waits for the inserts. "Import done" runs right away. If an insert fails, nobody catches that promise, so it becomes an unhandled rejection (which crashes Node 15+).
2. **Confirm:** add timestamps to logs: "done" is printed before the insert logs. The crash message names `unhandledRejection`.
3. **Fix:** use `for...of` for one-by-one, or `Promise.all` with a concurrency limit for speed:
   ```js
   for (const row of rows) await db.insert(row);            // sequential
   // or limited parallel (p-limit):
   const limit = pLimit(10);
   await Promise.all(rows.map(r => limit(() => db.insert(r))));
   ```
   Wrap it in `try/catch` and log which row failed. Better still, use a bulk insert API if the DB has one.
4. **Prevent:** turn on the ESLint rules `@typescript-eslint/no-floating-promises` / `no-misused-promises` (TypeScript) to catch promises that nobody awaits.

---

### Q9. Implement debounce and throttle. When to use which?
**🟢 In simple words:** Debounce waits until the user stops doing something, then runs once. Throttle runs at most once in a fixed time gap, no matter how many times the event fires. Both reduce how often a heavy function runs.
**🏠 Real-life example:** Debounce is a lift door: it closes only when people stop coming in for a few seconds. Throttle is a bus that leaves every 15 minutes, no matter how many people arrive.

```js
function debounce(fn, wait) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}
function throttle(fn, wait) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last >= wait) { last = now; fn.apply(this, args); }
  };
}
```
- **Debounce:** run after the activity *stops* — search-as-you-type, auto-save, end of window resize.
- **Throttle:** run at most once per interval — scroll handlers, mouse move, rate-limiting API calls.

**🔍 Internal working:**
1. **State lives in a closure:** V8 puts `t` and `last` in a heap `Context` (see Q1). So every call of the returned wrapper reads/writes the same `Context`. Each `debounce(...)` call creates a separate `Context`, so each wrapper has its own state.
2. **`this` forwarding:** the wrapper is a normal `function`, so it receives the caller's `this`. The inner arrow passed to `setTimeout` captures it lexically. Then `fn.apply(this, args)` passes it on.
3. **`setTimeout`:** registers a timer with the host and returns an ID. In browsers, when the timer ends, a task is queued on the timer task source. `clearTimeout(t)` removes the pending timer, so its callback never becomes a task. Debounce = "cancel the old timer and register a new one" on each event.
4. **Node timers:** Node groups timers into linked lists by duration. It keeps those lists in a priority queue. It uses a single libuv timer handle for the nearest expiry. Callbacks run in the **timers phase**. `setTimeout(fn, 0)` is treated as 1 ms in Node.
5. **Throttle uses no timer:** it only compares timestamps in the calling task.
   - Note: `Date.now()` is wall-clock time and can jump (NTP/clock change). `performance.now()` is monotonic (always moves forward), so it is safer for intervals.
   - This simple throttle also drops the last call (no "trailing" call). lodash's version supports leading/trailing options.
6. **Event-loop effect:** in modern browsers, scroll/resize events are already aligned to rendering frames. For visual updates, throttling with `requestAnimationFrame` is often better than a fixed interval.

**🎤 Say this in the interview:** "Both are closures over a small heap Context. Debounce keeps cancelling and re-registering a host timer, so only the last one becomes a task. Throttle just compares timestamps synchronously — ideally with a monotonic clock like `performance.now()`."

**🧪 Real scenario:** We added `debounce` to a React search box, but the Network tab still shows one API call per key press. Also, sometimes old results replace newer ones. What is wrong?

**✅ Scenario answer:**
1. **Root cause 1:** `const search = debounce(callApi, 300)` is written inside the component body. Every render creates a **new** debounced function with a new timer. So nothing is ever cancelled.
2. **Root cause 2:** responses can come back in a different order. A slow old request finishes after a fast new one and overwrites the results.
3. **Confirm:** the Network tab shows one request per key. Add a log inside `debounce` — it runs on every render.
4. **Fix:** create the debounced function once, cancel the old request, and clean up on unmount:
   ```js
   const search = useMemo(() => debounce(q => {
     controllerRef.current?.abort();
     controllerRef.current = new AbortController();
     fetch(`/api/search?q=${q}`, { signal: controllerRef.current.signal }).then(...);
   }, 300), []);
   useEffect(() => () => search.cancel?.(), [search]); // lodash debounce has cancel()
   ```
5. **Prevent:** use a tested library (lodash `debounce`) or a `useDebounce` hook, and always handle request cancellation for search.

---

### Q10. Deep copy vs shallow copy.
**🟢 In simple words:** A shallow copy copies only the top level. Inner objects are still shared, so changing them changes both copies. A deep copy copies everything, all the way down, so the two are fully separate.
**🏠 Real-life example:** Shallow copy is photocopying a page that says "the key is in drawer 3" — both copies point to the same drawer. Deep copy is building a second cupboard with its own drawers and its own key.

- Shallow: `{...obj}`, `Object.assign`, `arr.slice()`. Nested objects are still shared references.
- Deep: `structuredClone(obj)` (modern). It handles Date, Map, Set, and cycles. It does NOT handle functions, DOM nodes, or class prototypes.
- `JSON.parse(JSON.stringify())` loses `undefined`, functions, Dates (they become strings), Map/Set, and breaks on cycles.

**🔍 Internal working:**
1. **Shallow copy:** spread / `Object.assign` use `CopyDataProperties` / `[[Get]]` + `[[Set]]` for each own enumerable property. Values are copied as they are. For objects, the "value" is a pointer (reference), so nested objects are shared. Note: `Object.assign` triggers setters on the target. Spread uses define semantics (no setters).
2. **`structuredClone` = serialize + deserialize:** it runs the HTML **StructuredSerialize** algorithm. In V8-based hosts, this is V8's `ValueSerializer`/`ValueDeserializer`. It writes the value graph into an internal format, then rebuilds it as new objects.
3. **Cycles:** the serializer keeps a **memory map** (object → id). When it meets an object it has already seen, it writes a back-reference instead of going deeper. So cycles and shared references are kept.
4. **What is lost/throws:**
   - Functions, symbols-as-values and DOM nodes throw `DataCloneError`.
   - Plain objects copy only own enumerable string-keyed data (getters are called and their values copied). So class instances come back as plain objects (prototype lost).
   - Supported built-ins (Date, RegExp, Map, Set, ArrayBuffer, typed arrays, Error types) are recreated.
   - It is available in Node ≥17.
5. **JSON round-trip:** `JSON.stringify`:
   - calls `toJSON` if present (Date has one → ISO string),
   - skips `undefined`/functions/symbols in objects (turns them into `null` in arrays),
   - turns `NaN`/`Infinity` into `null`,
   - throws on `BigInt`,
   - keeps a stack of objects being serialized to detect cycles → `TypeError`.
6. **Performance:** both are O(size of graph). V8 has a fast path for `JSON.stringify` on simple objects. So JSON can be faster for plain data, but it loses information.

**🎤 Say this in the interview:** "Shallow copy copies pointers for nested objects. `structuredClone` runs the structured-serialize algorithm — V8's ValueSerializer, with a memory map for cycles. So it keeps graphs and built-ins, but rejects functions and drops prototypes. JSON is a lossy string round-trip."

**🧪 Real scenario:** In our Node API client, each request does `const opts = { ...DEFAULT_OPTS }; opts.headers['X-User-Id'] = userId;`. Logs show that some requests are sent with **another user's** ID. How is this possible?

**✅ Scenario answer:**
1. **Root cause:** the spread is a shallow copy. `opts.headers` is the **same object** as `DEFAULT_OPTS.headers`. Each request writes into the shared defaults, so one user's header leaks into later requests. This is a security bug.
2. **Confirm:** log `DEFAULT_OPTS.headers` after one request — it now contains `X-User-Id`. A unit test with two users in a row shows the second request carries the first ID when the header is not set.
3. **Fix:** copy the nested level too, or deep copy:
   ```js
   const opts = { ...DEFAULT_OPTS, headers: { ...DEFAULT_OPTS.headers, 'X-User-Id': userId } };
   // or: const opts = structuredClone(DEFAULT_OPTS); (no functions inside)
   ```
4. **Prevent:** deep-freeze shared defaults in dev/test so any write throws in strict mode (`Object.freeze` is shallow, so freeze the nested objects too). Prefer building new objects instead of mutating.

---

### Q11. `==` vs `===`, and `Object.is`.
**🟢 In simple words:** `===` checks if two values are the same type and same value. `==` first tries to convert the types to match, which gives surprising results. `Object.is` is like `===` but fixes two odd cases: `NaN` and `-0`. Always use `===`.
**🏠 Real-life example:** `===` is a passport check: name and photo must both match. `==` is a lazy guard who says "the name sounds similar, come in".

`===` compares without type coercion (automatic type conversion). `==` does coercion (`'1' == 1` → true, `null == undefined` → true). `Object.is` is like `===`, but `Object.is(NaN, NaN)` → true and `Object.is(0, -0)` → false. Rule: always use `===`. The only exception is `x == null`, to check null and undefined together.

**🔍 Internal working:**
1. **`===` → `IsStrictlyEqual`:** different types → `false`. Numbers use `Number::equal`: `NaN` is not equal to anything, and `+0 === -0`. Objects are equal only if they are the same reference.
2. **`==` → `IsLooselyEqual`** (in this order):
   - same type → strict compare;
   - `null == undefined` → true;
   - Number vs String → `ToNumber(string)`;
   - BigInt vs String → `StringToBigInt`;
   - Boolean on either side → `ToNumber(boolean)` and try again;
   - Object vs primitive → `ToPrimitive(object)` and try again;
   - otherwise false.
3. **`ToPrimitive`:** first checks `obj[Symbol.toPrimitive]`. Otherwise it calls `valueOf`, then `toString` (hint `"default"` behaves like `"number"` for most objects). That is why `[] == false` → `'' == false` → `0 == 0` → true.
4. **`Object.is` → `SameValue`:** like strict equality, but `NaN` equals `NaN` and `+0` ≠ `-0`. A fourth algorithm, **`SameValueZero`** (`NaN` equal, `+0 == -0`), is used by `Array.prototype.includes`, `Map` and `Set`.
5. **V8:** small integers (Smis) and same-object checks are a single pointer/word compare. Internalized (deduplicated) strings compare by pointer. Other strings may need a content comparison. `==` with mixed types goes through slower generic stubs because of the conversions.

**🎤 Say this in the interview:** "The spec has four equality algorithms: IsLooselyEqual with its ToNumber/ToPrimitive coercion steps, IsStrictlyEqual, SameValue for `Object.is`, and SameValueZero for `includes`/Map/Set. In V8, strict equality on Smis or internalized strings is just a pointer compare."

**🧪 Real scenario:** We set `FEATURE_NEW_CHECKOUT=true` in the environment, but the code `if (process.env.FEATURE_NEW_CHECKOUT == true)` never enables the feature. Why?

**✅ Scenario answer:**
1. **Root cause:** environment variables are always **strings**. With `==`, a boolean is converted to a number first: `true` → `1`. Then the string `'true'` is converted to a number → `NaN`. `NaN == 1` is false.
2. **Confirm:** `console.log(typeof process.env.FEATURE_NEW_CHECKOUT)` prints `"string"`. In a REPL, `'true' == true` returns `false`.
3. **Fix:** compare with the string, using `===`:
   ```js
   const isNewCheckout = process.env.FEATURE_NEW_CHECKOUT === 'true';
   ```
4. **Prevent:** parse and validate all env vars once at startup into a typed config object (for example with `zod` or `envalid`). Turn on ESLint `eqeqeq`.

---

### Q12. Map vs Object, Set vs Array, WeakMap.
**🟢 In simple words:** A Map is a key-value store where keys can be anything and order is kept. A Set holds only unique values and checks "is it there?" very fast. A WeakMap holds keys "loosely": if nobody else uses the key object, it is thrown away automatically, so there is no memory leak.
**🏠 Real-life example:** A Map is a cloakroom: any item can get a token, in order. A Set is a guest list with no duplicate names. A WeakMap is a sticky note on a guest's coat — when the guest leaves for good, the note goes with them.

- **Map:** keys of any type. Keeps insertion order. Has `.size`. Better for frequent add/delete. No collisions with prototype keys.
- **Set:** unique values, O(1) `has`.
- **WeakMap/WeakSet:** keys must be objects. They are held **weakly** — they are garbage-collected when no other references exist. Not iterable. Use cases: caching extra data per object, private data, avoiding memory leaks.

**🔍 Internal working:**
1. **Object in V8:** named properties are stored using **hidden classes** (fast mode: fixed offsets, either inside the object or in a separate properties store). Integer-like keys go to a separate **elements** store. Many adds/deletes of different keys push the object into **dictionary mode** (a hash table). Then it loses inline-cache speed.
2. **Object key order (spec `OrdinaryOwnPropertyKeys`):** first integer-like keys in ascending number order, then string keys in insertion order, then symbols. So objects are *not* purely insertion-ordered.
3. **Map/Set in V8:** implemented as an **OrderedHashMap / OrderedHashSet**. This is a deterministic hash table: a bucket array plus an entries array in insertion order (chaining through entries).
   - Iteration walks the entries array, so order = insertion order.
   - Deletes leave holes. The holes are cleaned when the table is rehashed (grow/shrink).
   - Keys are compared with **SameValueZero**.
4. **Object keys in a Map:** V8 gives each object a random **identity hash**. It is created lazily (only when needed) and stored on the object. So lookup is O(1) on average, without converting the key to a string.
5. **WeakMap/WeakSet:** backed by an **EphemeronHashTable**. The GC treats each entry as an *ephemeron*: the value stays alive only if the key is reachable from somewhere else. When the key dies, the entry is cleared during GC. Entries can disappear at any GC. So iteration and `.size` are not allowed — they would expose GC timing.
6. **Set vs Array:** `array.includes` is a linear scan, O(n). `set.has` is a hash lookup, O(1) on average.

**🎤 Say this in the interview:** "Plain objects are optimized for fixed shapes using hidden classes. Under heavy add/delete, they fall into dictionary mode. Map/Set are deterministic ordered hash tables built for frequent add/delete. WeakMap is an ephemeron table: the GC keeps a value alive only while its key is reachable."

**🧪 Real scenario:** A word-count feature uses `counts[word] = (counts[word] || 0) + 1` on a plain object. For a text that contains the word "constructor", the result shows `"function Object() { [native code] }1"`. What is going on?

**✅ Scenario answer:**
1. **Root cause:** a plain `{}` inherits from `Object.prototype`. `counts['constructor']` is not missing — it finds the inherited `Object` function. Then `function + 1` becomes string joining. Keys like `__proto__` are even worse: they can change the prototype (a prototype pollution risk with user input).
2. **Confirm:** `({})['constructor']` returns a function. Test with words like `toString`, `constructor`, `__proto__`.
3. **Fix:** use a `Map` for dynamic, user-controlled keys:
   ```js
   const counts = new Map();
   for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
   ```
   (`Object.create(null)` also works — it has no prototype.)
4. **Prevent:** team rule: user data as keys → `Map`; fixed-shape records → object. Add these special words to unit tests.

---

### Q13. What are generators and iterators?
**🟢 In simple words:** An iterator gives you items one at a time when you call `next()`. A generator (`function*`) is an easy way to make an iterator: it pauses at each `yield` and continues when you ask for the next item. Values are made only when needed, so it saves memory.
**🏠 Real-life example:** A storyteller who reads one page and then stops. Each time you say "next", they read one more page from where they stopped. They do not read the whole book at once.

An iterator is an object with a `next()` method that returns `{value, done}`. An iterable implements `[Symbol.iterator]`. Generators (`function*`) create iterators lazily with `yield`. They are useful for lazy sequences, pagination, and streaming large datasets. Async generators (`async function*` + `for await...of`) are great for reading paginated APIs or streams in Node.

**🔍 Internal working:**
1. **Calling a generator function** does not run its body. It creates a generator object with `[[GeneratorState]] = suspended-start` and a saved execution context. Then it returns that object.
2. **`next(v)`:** `GeneratorResume` puts the saved execution context back on the call stack. It runs until the next `yield`.
   - At `yield x`, the context is suspended (removed from the stack, state `suspended-yield`) and `{value: x, done: false}` is returned.
   - The `v` passed to the next `next(v)` becomes the result of that `yield` expression.
   - On `return`, the state becomes `completed` and `done: true`.
3. **`return()` / `throw()`:** resume the generator at the paused `yield` with a return or throw completion. So `finally` blocks run.
4. **V8:** generators are compiled into bytecode with `SuspendGenerator` / `ResumeGenerator` and a jump table of resume points. On suspend, live interpreter registers are copied into the generator object (a heap array). On resume they are copied back. No OS thread or real stack is kept — it is a frame saved on the heap.
5. **`for...of`:** calls `GetIterator(obj)` (`obj[Symbol.iterator]()`), then keeps calling `IteratorStep` → `next()`. On `break`, `return` or an exception, it calls **`IteratorClose`** (the iterator's `return()`). This is how resources get cleaned up.
6. **Async generators:** keep an internal **`[[AsyncGeneratorQueue]]`** of pending `next` requests. Each `next()` returns a promise immediately. Requests are processed one at a time. `for await...of` awaits each result.

**🎤 Say this in the interview:** "A generator is a suspended execution context stored on the heap. `next()` resumes it until the next `yield`. V8 implements this with Suspend/ResumeGenerator bytecodes that save registers into the generator object. `for...of` drives it through the iterator protocol and calls `return()` on early exit."

**🧪 Real scenario:** Our "Export all orders to CSV" job loads all 2 million rows into one array and then writes the file. In production, it crashes with `FATAL ERROR: ... JavaScript heap out of memory`. How do you redesign it?

**✅ Scenario answer:**
1. **Root cause:** the whole result set plus the full CSV string is kept in memory at the same time. Memory grows with data size until it hits the heap limit.
2. **Confirm:** log `process.memoryUsage().heapUsed` during the job, or watch the container memory graph. It climbs until the crash.
3. **Fix:** read in pages with an async generator and stream the output, so only one page is in memory at a time:
   ```js
   async function* fetchOrders() {
     let lastId = 0;
     while (true) {
       const rows = await db.query('SELECT * FROM orders WHERE id > $1 ORDER BY id LIMIT 1000', [lastId]);
       if (rows.length === 0) return;
       yield* rows;
       lastId = rows[rows.length - 1].id;
     }
   }
   await pipeline(Readable.from(toCsvLines(fetchOrders())), fs.createWriteStream('orders.csv'));
   ```
   `pipeline` (from `stream/promises`) handles backpressure and errors.
4. **Prevent:** do not "load everything" for unbounded data. Use keyset pagination or DB cursors, and test jobs with production-size data.

---

### Q14. How does garbage collection work in V8? What causes memory leaks?
**🟢 In simple words:** The garbage collector (GC) frees memory that your program can no longer reach. V8 keeps new objects in a small "young" area and cleans it often, because most objects die quickly. Objects that live long move to an "old" area that is cleaned less often. A memory leak means something you do not need is still reachable, so GC cannot free it.
**🏠 Real-life example:** A house cleaner throws away anything not connected to the family. A leak is an old box still tied to a family member with a string — the cleaner is not allowed to throw it away, even if nobody uses it.

V8 uses **generational GC**:
- the *young generation* (Scavenger, fast copying of short-lived objects),
- the *old generation* (Mark-Sweep-Compact, incremental/concurrent).

Objects reachable from roots (global, stack) stay. Unreachable objects are collected.
**Leaks:** global variables, timers/intervals never cleared, event listeners never removed, in-memory caches with no size limit, closures holding big objects, detached DOM nodes (removed from the page but still referenced in JS).

**🔍 Internal working:**
1. **Generational hypothesis:** most objects die young. New objects are allocated in the **young generation** by just moving a pointer forward ("bump-pointer"). This is very cheap.
2. **Scavenger (minor GC):** the young generation is split into two halves called semi-spaces (*from* and *to*). During a scavenge, V8 copies live objects from *from-space* to *to-space* (or to the old generation). Then it swaps the two spaces. The cost depends only on **live** objects, so dead objects cost nothing. In V8's Orinoco project, the scavenger is **parallel** (it uses multiple helper threads).
3. **Promotion:** an object that survives one scavenge moves to an in-between state. If it survives a second one, it is **promoted** to the old generation.
4. **Write barrier + remembered set:** V8 wants to scavenge without scanning the whole old generation. So it must know all old→young pointers. Every pointer store in JIT code goes through a **write barrier**. The barrier records such slots in a **remembered set**. During a scavenge, this set is used as extra roots.
5. **Major GC (Mark-Compact):**
   - Marking starts from roots (stack, globals, handles) using tri-color marking.
   - Orinoco does it **concurrently** on background threads and **incrementally** on the main thread (in small steps).
   - The write barrier also keeps marking correct while JS changes objects.
   - A short final pause finishes marking.
   - Then **sweeping** (concurrent) adds dead space to free lists.
   - **Compaction** moves objects out of fragmented pages.
6. **Scheduling:** V8 also uses idle time (e.g. between frames in Chrome) to do GC work. In Node, tune it with `--max-old-space-size` and `--max-semi-space-size`.
7. **Leak = still reachable:** GC only frees unreachable objects. A leak is always an unwanted path from a root (a global cache, a listener list, a timer, a shared closure Context). Find it with heap snapshots → "Retainers" view.

```text
 Young gen:  [ from-space ] --copy live--> [ to-space ]   (swap after scavenge)
                    │ survived twice
                    ▼
 Old gen:    mark (concurrent) → sweep (concurrent) → compact (evacuate pages)
 old→young pointers tracked by write barrier → remembered set
```

**🎤 Say this in the interview:** "V8 uses a parallel semi-space Scavenger for the young generation. Write barriers record old-to-young pointers in a remembered set. For the old generation it uses a mostly concurrent and incremental mark-sweep-compact. So a leak is simply an object that is still reachable from a root."

**🧪 Real scenario:** Our Node.js service's memory grows every hour until the pod is killed (OOMKilled). A heap snapshot shows thousands of closures from an event listener, and a big `Map` used as a cache. What is happening and how do you fix it?

**✅ Scenario answer:**
1. **Root cause:** objects stay reachable, so GC cannot free them. Common causes here: a listener added on every request to a long-lived emitter (`emitter.on(...)`) and never removed, and a cache `Map` with no size limit or TTL.
2. **Confirm:** run with `--inspect`, take 3 heap snapshots over time in Chrome DevTools, and use the "Comparison" view. Look at "Retainers" to see who holds the objects. Node may also print `MaxListenersExceededWarning`.
3. **Fix the listener:** remove it when the work is done, or use `once`:
   ```js
   const onData = d => handle(d, req);
   emitter.on('data', onData);
   res.on('close', () => emitter.off('data', onData));
   ```
4. **Fix the cache:** use an LRU cache with `max` and `ttl` (for example the `lru-cache` package), or a `WeakMap` when the key is an object.
5. **Prevent:** add heap usage to dashboards with alerts, run a soak test (long load test) before release, and review every `on(`, `setInterval` and global cache in code review.

---

### Q15. ES modules vs CommonJS.
**🟢 In simple words:** CommonJS (`require`) is Node's old module system. It loads files one by one while the code runs. ES modules (`import`) are the modern standard. They know all imports before running any code, so tools can remove unused code (tree-shaking). ESM imports are "live": if the exporter changes a value, you see the new value.
**🏠 Real-life example:** CommonJS is borrowing a photocopy of a notice — later changes do not reach you. ESM is looking at the live notice board — you always see the latest version.

| | CommonJS | ESM |
|---|---|---|
| Syntax | `require` / `module.exports` | `import` / `export` |
| Loading | synchronous, runtime | async, statically analyzable |
| Tree-shaking | no | yes |
| Bindings | copy of exported value | **live bindings** |
| Top-level await | no | yes |

In Node: use `"type": "module"` or the `.mjs` extension. ESM can import CJS. CJS needs dynamic `import()` to load ESM (newer Node versions support `require(esm)` for sync graphs).

**🔍 Internal working:**
1. **ESM phase 1 — Parse/Load:** each file is parsed into a **Source Text Module Record**. It lists the file's import entries and export entries. These are known without running code — that is why ESM is statically analyzable. The host loads all dependencies recursively to build the full module graph.
2. **ESM phase 2 — Link (instantiate):** `Link()` creates a Module Environment Record for every module. It resolves each import to the exporting module's binding (`ResolveExport`).
   - Imports become **indirect bindings** that point at the exporter's variable. This is what "live binding" means, and why imports are read-only.
   - Missing exports fail here, before any code runs.
   - Function declarations are initialized now. `let/const/class` exports stay in TDZ.
3. **ESM phase 3 — Evaluate:** modules run in **post-order DFS** (dependencies first), each exactly once.
   - Cycles are handled with Tarjan-style strongly-connected-component bookkeeping (`[[DFSIndex]]`, `[[DFSAncestorIndex]]`).
   - With **top-level await**, a module becomes async. Its dependents wait for it (async evaluation), while independent siblings can continue.
4. **CommonJS (`Module._load`)**: resolve the path → check `require.cache` → create a `Module` object and **put it in the cache before running** → wrap the source in a function `(exports, require, module, __filename, __dirname)` → compile and run it synchronously → return `module.exports`.
5. **CJS values:** `require` returns the `module.exports` object. Destructuring/assigning a primitive copies it at that moment (no live update). In cycles, you get a **partially filled** `exports`, because the module was cached before it finished.
6. **Interop in Node:**
   - Importing CJS from ESM: Node runs the CJS module and exposes `module.exports` as the default export. Named exports are detected by static analysis with `cjs-module-lexer`.
   - `require(esm)` (no flag needed in Node 22.12+ / 20.19+) works only if the ESM graph has no top-level await.

```text
 ESM:  Parse+Load graph ──► Link (create envs, wire bindings) ──► Evaluate (post-order DFS)
 CJS:  resolve ──► cache ──► wrap in function ──► run sync ──► return module.exports
```

**🎤 Say this in the interview:** "ESM runs in three phases. First it parses and loads the whole graph. Then it links, wiring imports as indirect bindings into the exporters' environment records. Then it evaluates in post-order. CommonJS is just a synchronous function wrapper. Its `module.exports` object is cached before execution, which explains partial exports in cycles."

**🧪 Real scenario:** We switched our Node service to `"type": "module"`. Now we get `ReferenceError: __dirname is not defined`, and an old CommonJS tool that does `require('our-lib')` fails with `ERR_REQUIRE_ESM`. How do you fix this migration?

**✅ Scenario answer:**
1. **Root cause:** `__dirname`, `__filename` and `require` come from the CommonJS function wrapper. ES modules do not have that wrapper. And older Node versions cannot `require()` an ES module.
2. **Confirm:** check the Node version (`node -v`) and the `"type"` field / file extension (`.mjs`/`.cjs`) of the failing file.
3. **Fix `__dirname`:**
   ```js
   import { fileURLToPath } from 'node:url';
   import path from 'node:path';
   const __dirname = path.dirname(fileURLToPath(import.meta.url));
   // Node 20.11+: import.meta.dirname
   ```
   If you still need `require` (e.g. for JSON), use `createRequire(import.meta.url)`.
4. **Fix the CJS consumer:** use `await import('our-lib')` there, or upgrade to a Node version that supports `require(esm)`, or publish both formats using the `"exports"` field in `package.json` (`"import"` and `"require"` entries).
5. **Prevent:** migrate one package at a time, run the full test suite in CI on the real Node version, and keep ESM graphs without top-level await if CJS users must `require` them.

---

### Q16. Output-based questions (practice these fast)
**🟢 In simple words:** These are small tricky snippets where you must guess the output. Each strange result has a clear rule behind it: type conversion with `+`, floating-point math, arrow `this`, and `await` always pausing at least once.
**🏠 Real-life example:** Like a riddle at school — the answer looks strange, but once you know the rule, it is obvious every time.

```js
// a
console.log(typeof null);          // "object"
console.log([] + []);              // ""
console.log([] + {});              // "[object Object]"
console.log(0.1 + 0.2 === 0.3);    // false → use Math.abs(a-b) < Number.EPSILON

// b
const obj = { name: 'A', greet() { return () => this.name; } };
console.log(obj.greet()());        // "A" (arrow captures greet's this)

// c
async function f() { console.log(1); await null; console.log(2); }
f(); console.log(3);               // 1 3 2
```

**🔍 Internal working:**
1. **`typeof null`:** an old bug from the first JS implementation. Values had a type tag. Objects used tag 0. `null` was the null pointer (all zeros). So it was reported as `"object"`. The spec keeps this so old websites do not break.
2. **`[] + []` / `[] + {}`:** the `+` operator calls `ToPrimitive` (hint `"default"`) on both sides.
   - For arrays/objects, `valueOf()` returns the object itself (not a primitive), so `toString()` is used: `[]` → `""`, `{}` → `"[object Object]"`.
   - If either primitive is a string, `+` joins strings.
   - (Note: `{} + []` typed at the start of a console line is parsed as an empty block plus `+[]` → `0`.)
3. **`0.1 + 0.2`:** numbers are IEEE-754 binary64 doubles. 0.1 and 0.2 have no exact binary form, so the sum is `0.30000000000000004`. `Number.EPSILON` (2^-52) is a good tolerance only for values near 1. For larger values, scale the tolerance (or use integers like cents).
4. **Arrow `this`:** `obj.greet()` binds `this = obj` in greet's Function Environment Record. The arrow has no `this` binding. So `ResolveThisBinding` walks up to greet's record and finds `obj`.
5. **`await null`:** `f()` runs synchronously and logs `1`. `await null` does `PromiseResolve(null)` → an already-fulfilled promise. It attaches a reaction (queued as a microtask immediately) and suspends `f`. Control returns and `3` is logged. The stack becomes empty. The microtask resumes `f` → `2`.

**🎤 Say this in the interview:** "These outputs come straight from spec algorithms. `+` uses ToPrimitive and switches to string joining when either side is a string. Numbers are IEEE-754 doubles. Arrows resolve `this` from the surrounding environment record. And `await` always suspends for at least one microtask."

**🧪 Real scenario:** Finance reports that some invoices fail the check `if (subtotal + tax === total)`, even though the numbers look correct on screen. For example, 0.1 + 0.2 is not equal to 0.3. How do you fix money handling?

**✅ Scenario answer:**
1. **Root cause:** JS numbers are IEEE-754 doubles. Many decimal values (like 0.1) cannot be stored exactly, so small errors appear (`0.30000000000000004`). The UI rounds them, so they look correct.
2. **Confirm:** log the raw values without formatting. Write a test with known bad values like `0.1 + 0.2`.
3. **Fix:** store and calculate money in the smallest unit (integer cents/paise), and format only for display:
   ```js
   const totalCents = subtotalCents + taxCents; // integers → exact
   const label = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
     .format(totalCents / 100);
   ```
   For complex rates or division, use a decimal library (for example `decimal.js`) with a clear rounding rule.
4. **Prevent:** store money as integer or `DECIMAL` columns in the DB, never `FLOAT`. Never use `===` on computed float values.

---

### Q17. Currying — implement `curry`.
**🟢 In simple words:** Currying turns a function that takes many arguments into a chain of functions that take them a few at a time. It keeps collecting arguments until it has enough, then runs the real function. This lets you make ready-made "partial" functions.
**🏠 Real-life example:** Making a sandwich at a counter. First you pick bread, then filling, then sauce. The sandwich is made only when all choices are given. You can also stop after "bread = brown" and reuse that half-order for many sandwiches.

```js
const curry = fn => function curried(...args) {
  return args.length >= fn.length
    ? fn.apply(this, args)
    : (...more) => curried.apply(this, [...args, ...more]);
};
const add = curry((a, b, c) => a + b + c);
add(1)(2)(3); add(1, 2)(3); // 6
```

**🔍 Internal working:**
1. **`fn.length`:** set when the function object is created. It is the number of parameters **before the first default value or rest parameter** (`(a, b = 1, ...c) => {}` has `length` 1). So currying based on `length` breaks for such functions. It also breaks for functions that use `arguments`.
2. **Named function expression:** `curried` is visible inside its own body. This is because the spec creates a small extra environment record that binds the name to the function. This makes the recursion possible.
3. **Each partial call creates a new closure:** the returned arrow captures the current `args` array and `this` (lexically). In V8, `args` becomes context-allocated. So every partial call allocates a new `Context`, a new arrow `JSFunction`, and a new array (`[...args, ...more]`).
4. **Accumulation:** arguments are never changed in place. Each step builds a fresh array. So partial functions can be reused safely (`const add1 = add(1); add1(2)(3); add1(5)(6);`).
5. **Performance:** the rest/spread and closure allocations are cheap young-generation garbage (collected by the Scavenger). But in very hot paths, currying adds allocation and call overhead. Some calls may become polymorphic, because each partial is a different closure object (same code, different context).

**🎤 Say this in the interview:** "Currying works by building a chain of closures. Each partial call allocates a new context that holds the collected arguments. The decision to call the real function uses `fn.length`, which counts only the parameters before the first default or rest parameter."

**🧪 Real scenario:** In code review, a teammate wrote `const fetchPage = curry((url, page = 1) => api.get(url, { page }))`. They expected `fetchPage('/orders')` to return a function waiting for `page`. Instead, it sends the request right away. Why?

**✅ Scenario answer:**
1. **Root cause:** our `curry` decides "enough arguments" using `fn.length`. A parameter with a default value is not counted, so `fn.length` is `1`. One argument is "enough", and the real function runs immediately with `page = 1`.
2. **Confirm:** `console.log(((url, page = 1) => {}).length)` prints `1`.
3. **Fix:** let the caller pass the arity explicitly, or remove the default:
   ```js
   const curry = (fn, arity = fn.length) => function curried(...args) {
     return args.length >= arity ? fn.apply(this, args)
       : (...more) => curried.apply(this, [...args, ...more]);
   };
   const fetchPage = curry((url, page = 1) => api.get(url, { page }), 2);
   ```
   (lodash `_.curry(fn, arity)` also accepts an arity.)
4. **Prevent:** add a unit test for each curried helper, and prefer simple explicit factories (`const forUrl = url => page => ...`) when it is clearer for the team.

---

### Q18. Event delegation, bubbling vs capturing.
**🟢 In simple words:** When you click an element, the event travels down from the top of the page to that element (capturing), then back up to the top (bubbling). Event delegation means putting one listener on a parent instead of many on each child. The parent catches the bubbling event and checks which child was clicked.
**🏠 Real-life example:** In a school, instead of every student having their own phone, there is one phone at the class teacher's desk. Any message for a student reaches the teacher, who checks the name and passes it on.

Events travel in 3 phases: capture (window → target), target, then bubble (target → window). **Delegation** = attach one listener to a parent and use `event.target` to handle the children. This means fewer listeners. It also works for elements added later. `stopPropagation` stops the event from travelling further. `preventDefault` stops the default browser action.

**🔍 Internal working:**
1. **Path is fixed at dispatch:** when an event is dispatched (DOM spec "dispatch" algorithm), the browser first builds the **event path**: target, its ancestors, document, window (adjusted for Shadow DOM). If listeners change the DOM during dispatch, this path does **not** change.
2. **Invocation:**
   - It walks the path in reverse for the **capture** phase (`eventPhase = 1`, only listeners with `capture: true`).
   - Then the target (`eventPhase = 2`).
   - Then forward for the **bubble** phase (`eventPhase = 3`, only if `event.bubbles` is true).
   - `event.currentTarget` is updated at each node.
3. **Listener storage:** each EventTarget has an ordered **event listener list** (type, callback, capture, passive, once, signal). Listeners run in the order they were added. `once` listeners are removed before being called.
4. **Flags:**
   - `stopPropagation()` sets a flag that is checked **between nodes**. Other listeners on the current node still run.
   - `stopImmediatePropagation()` also stops the remaining listeners on the same node.
   - `preventDefault()` sets the canceled flag. The browser checks it after dispatch and skips the default action. It is ignored for `passive: true` listeners. That is why passive scroll/touch listeners let scrolling start without waiting for JS.
5. **Non-bubbling events:** `focus`, `blur`, `mouseenter`, `mouseleave` do not bubble. For delegation, use `focusin`/`focusout` or `mouseover`/`mouseout` (or a capture listener). With Shadow DOM, `event.target` is **retargeted** to the shadow host for outside listeners. Use `event.composedPath()` to see the real path.
6. **Microtasks:** for real user events, the browser runs a microtask checkpoint after **each** listener callback. For `el.dispatchEvent()` from script, the dispatch is synchronous. Microtasks run only after the whole calling script finishes.

```text
 window → document → html → body → ul → li(target)     capture (phase 1)
                                         li            target  (phase 2)
 window ← document ← html ← body ← ul ← li             bubble  (phase 3)
 delegation: one listener on <ul>, check event.target.closest('li')
```

**🎤 Say this in the interview:** "Dispatch builds a fixed event path. Then it calls capture listeners top-down, then target listeners, then bubble listeners bottom-up, from each node's listener list. Delegation works because one ancestor listener sees every bubbling event. It uses `event.target` (or `closest`) to find the real child."

**🧪 Real scenario:** We open a dropdown when a button is clicked. In the same click handler we add `document.addEventListener('click', closeDropdown)` for "click outside to close". But the dropdown closes immediately after it opens. Why?

**✅ Scenario answer:**
1. **Root cause:** the same click event is still bubbling. It goes from the button up to `document`. The new listener on `document` was added before the event reached `document`, so it runs for this same click and closes the dropdown.
2. **Confirm:** put a breakpoint (or log) in `closeDropdown` and check `event.target` — it is the open button itself.
3. **Fix:** ignore clicks that come from inside the dropdown or the button:
   ```js
   function closeDropdown(e) {
     if (menu.contains(e.target) || button.contains(e.target)) return;
     hideMenu();
     document.removeEventListener('click', closeDropdown);
   }
   ```
   Another option: register the document listener once, outside the open handler (for example, in a `useEffect` while the menu is open).
4. **Prevent:** avoid `stopPropagation` as a quick fix — it breaks other delegated listeners (analytics, other menus). Use a shared, tested "click outside" hook for all popups.
