# 04 — React (Senior Level)

---

### Q1. What is the Virtual DOM and reconciliation? How does React Fiber help?
**🟢 In simple words:** React keeps a light copy of the page in memory. When data changes, it makes a new copy and compares it with the old one. Then it changes only the parts of the real page that are different. Fiber lets React split this work into small pieces, so it can pause and continue.
**🏠 Real-life example:** A teacher checks a corrected essay against the first draft and only rewrites the changed lines, not the whole page. If the bell rings, she puts a bookmark and continues later.

React builds a light tree of elements. When state changes, it creates a new tree. It **diffs** (compares) the new tree with the old one. This is called reconciliation. Then it applies only the smallest needed DOM updates.
Diffing rules (O(n)): if an element has a different type → React rebuilds that subtree. If it has the same type → React only updates the props. Lists are matched using **keys**.
**Fiber** (React 16+) splits rendering into small units of work. These units can be **paused, prioritized, and resumed**. This makes concurrent features possible (transitions, Suspense). Rendering has two phases: **render** (pure, can be interrupted) and **commit** (DOM changes, synchronous).

**🔍 Internal working:**
1. JSX compiles to `jsx()` / `React.createElement()` calls. These return plain, immutable element objects (`{ $$typeof, type, key, ref, props }`). React throws these objects away after every render. They are only a "description" of the UI.
2. The structure that lives long is the **Fiber tree**. Each fiber is a mutable object for one component or host node (DOM element). It has `tag`, `type`, `key`, `stateNode` (DOM node or class instance), `pendingProps`/`memoizedProps`, `memoizedState`, `updateQueue`, `lanes`/`childLanes`, `flags`/`subtreeFlags`. It also has three pointers: `child` (first child), `sibling` (next sibling), `return` (parent). Because of this linked-list shape, React walks the tree with a loop, not recursion. So it can stop at any fiber and continue later.
3. **Double buffering:** there are two trees. `root.current` points to the tree on screen. React builds a second tree called **workInProgress**. Each fiber is linked to its twin through `alternate`. React reuses (clones) fibers between the two trees. It does not create new ones each time.
4. **Render phase** (`performUnitOfWork` loop): `beginWork(fiber)` calls the component or compares props. Then it reconciles the new child elements with the old child fibers (this is the "diff"). It returns the first child. When a fiber has no child, `completeWork` runs. For host components it creates or prepares DOM nodes (`createInstance`, `prepareUpdate`/`diffProperties`). It also bubbles `flags` up into the parent's `subtreeFlags`. Then it moves to the `sibling`, or goes back up through `return`.
5. In concurrent mode the loop is `while (workInProgress !== null && !shouldYield())`. So the **Scheduler** can give the main thread back to the browser about every 5 ms. Sync work uses `workLoopSync`, which has no yield checks.
6. **Commit phase** (synchronous, cannot be interrupted): before-mutation (`getSnapshotBeforeUpdate`) → mutation (DOM inserts/updates/deletes, ref detach) → `root.current = finishedWork` (the two trees swap) → layout (`useLayoutEffect`, `componentDidMount/Update`, ref attach). After that, passive `useEffect`s run.

```text
          App (return=null)
           |  child
           v
          div ----------------------+
           |  child                 |
           v                        |
          h1 --sibling--> ul        | return pointers go back up
                          | child   |
                          v         |
                          li --sibling--> li
current tree  <== alternate ==>  workInProgress tree
```

**🎤 Say this in the interview:** "Fiber is a linked-list tree with child, sibling and return pointers. React walks it in a loop with beginWork and completeWork. It builds a workInProgress copy of the current tree. Each fiber is a unit of work, so the render phase can yield about every 5 ms. Only the commit phase touches the DOM. It runs synchronously, and then the two trees swap."

**🧪 Real scenario:** A dashboard has a search box and a big chart with 5,000 points below it. When the user types, the letters appear late and the page feels frozen. How do you explain this with Fiber, and how do you fix it?

**✅ Scenario answer:**
1. Each keystroke updates state that the chart also uses. So React must re-render the big chart in the same urgent (sync) render. The main thread is busy, and the input cannot paint.
2. Confirm it with the React DevTools Profiler: record while typing. You will see long commits where the chart takes most of the time. The Chrome Performance tab shows long tasks (over 50 ms).
3. Keep the input urgent and make the chart update non-urgent. Then Fiber can pause the chart render and let typing go first:
   ```js
   const [text, setText] = useState('');
   const deferredText = useDeferredValue(text);
   <input value={text} onChange={e => setText(e.target.value)} />
   <BigChart filter={deferredText} />  // wrap BigChart in memo
   ```
4. Also reduce the work itself: wrap the chart in `memo` and draw fewer points if possible. Remember, the commit phase cannot pause, so a huge DOM update still blocks.
5. To prevent it: check INP in Web Vitals, and profile new heavy screens before release.

---

### Q2. Why are keys important? Why not use the index as the key?
**🟢 In simple words:** A key is a name tag for each item in a list. React uses it to know which item is which after the list changes. If you use the position number as the key, items can get mixed up when you add, remove or reorder them.
**🏠 Real-life example:** In a classroom, students have roll numbers. If the teacher calls students by "first seat, second seat" and someone changes seats, marks go to the wrong student. Calling by roll number avoids this.

Keys tell React which item is which between renders. Suppose you use the index as the key, and the list is reordered, filtered, or gets new items. Then React reuses the wrong component instances. This causes wrong state in inputs, extra re-renders, and bugs. Use stable unique IDs. The index is OK only for static lists that never change.

**🔍 Internal working:**
1. When children are an array, `reconcileChildrenArray` runs. React reuses a fiber only if **both `key` and `type` match**. If not, it creates a new fiber. The old fiber gets a `Deletion` mark and loses its state.
2. **Pass 1:** React walks old fibers and new elements together, index by index, while keys match. Most updates (with no reorder) finish here.
3. If the new list ends first → delete the remaining old fibers. If the old list ends first → create the remaining new fibers (insertions).
4. **Pass 2 (reorder case):** React puts the remaining old fibers into a `Map`. The map key is the `key` (or the index if there is no key). For each new element, React looks it up in the map. If found, it reuses that fiber.
5. React detects moves with `lastPlacedIndex`. If a reused fiber's old index is lower than `lastPlacedIndex`, it is marked `Placement` (it must move). If not, it stays, and `lastPlacedIndex` becomes its old index. Fibers still left in the map are deleted. Note: React only scans left to right (no search from both ends). So moving the last item to the front moves every other item.
6. With **index keys**, key `0` always matches the fiber at position 0. Suppose you insert a new item at the top. The fiber at position 0 (with its `useState` and its uncontrolled DOM input value) is now reused for a different data item. That is the "wrong state" bug.

```text
old: [A:0, B:1, C:2]     new: [C, A, B]
C -> old 2, lastPlaced=2 (stays)
A -> old 0 < 2  -> Placement (move)
B -> old 1 < 2  -> Placement (move)
```

**🎤 Say this in the interview:** "React reuses a fiber only when key and type both match. For the common case it diffs lists in one pass. For reorders it uses a Map from key to fiber, plus a lastPlacedIndex rule to find moves. With index keys, the position becomes the identity. So state stays at a position instead of following the item."

**🧪 Real scenario:** Users report that when they delete a row in an editable table, the text in the next row's input box shows the wrong value. The data in the API is correct. What is the bug and how do you fix it?

**✅ Scenario answer:**
1. The list most likely uses `key={index}`. After a delete, every row below moves up one position. React matches rows by key, so the component at index 2 is reused for a different item. Its local state and its uncontrolled input value stay at that position.
2. Confirm it: search the code for `.map((item, index) =>` with `key={index}`. In React DevTools, check the row component's state before and after the delete — the state does not follow the item.
3. Fix: use a stable unique id from the data:
   ```js
   {rows.map(row => <Row key={row.id} row={row} />)}
   ```
4. If the data has no id, create one when the item is created (for example `crypto.randomUUID()`). Never create it during render, or the key changes every render.
5. To prevent it: add a lint rule like `react/no-array-index-key`, and check keys in code review.

---

### Q3. Explain `useEffect` in depth. Common bugs?
**🟢 In simple words:** `useEffect` lets you run code after React has shown the screen. You use it for side jobs like fetching data, timers, or subscriptions. You tell React which values to watch. When one changes, React first cleans up the old job and then runs the new one.
**🏠 Real-life example:** A waiter serves your food first. After that, he refills water only when your glass changes from full to empty. When you leave, he clears the table (cleanup).

It runs **after paint** (after commit), when its dependencies change. The cleanup runs before the next effect and on unmount.
- `[]` → runs on mount only. No array → runs after every render. `[a, b]` → runs when a or b changes (compared with `Object.is`).

**Bugs:**
- Missing deps → **stale closures** (the effect sees old state values).
- Objects or functions as deps → they get a new reference every render → infinite loops. Fix: use `useMemo`/`useCallback`, or move them inside the effect.
- Not cleaning up subscriptions, timers, or fetch → memory leaks, plus "setState on an unmounted component". Use `AbortController` for fetch. (Note: React 18 removed that warning, but the leak and the wasted work are still real.)
- Using effects for derived state → instead, calculate it during render.
- In StrictMode (dev only), effects run **twice** on mount. This helps you find missing cleanup.

`useLayoutEffect` runs synchronously **before paint**. Use it to measure the DOM and avoid flicker.

**🔍 Internal working:**
1. During render, `useEffect` creates an effect object `{ tag, create, deps, inst: { destroy }, next }`. React adds it to a circular list on `fiber.updateQueue.lastEffect`. The hook's `memoizedState` also stores this effect.
2. On update, React compares each dep with the old deps using `Object.is` (`areHookInputsEqual`). Only if something changed does the effect get the `HookHasEffect` tag. Then the fiber gets the `Passive` flag. Unchanged effects are still pushed (to keep the order), but they are skipped at commit.
3. After the commit's layout phase, React schedules `flushPassiveEffects` as a normal-priority Scheduler task. This usually runs after the browser paints. It first runs **all cleanups** (`destroy`) of changed or unmounted effects in the tree. Then it runs **all new `create`** functions.
4. Exception (React 18+): if the render came from a discrete input (click, keypress → SyncLane), passive effects run synchronously at the end of commit, before paint. Also, before React starts any new render, it first runs pending passive effects. So effects never "get lost".
5. `useLayoutEffect` uses the `Layout` tag. Its create runs in the commit **layout** sub-phase (sync, after DOM changes, before paint). Its cleanup runs in the mutation phase. A `setState` inside it is processed synchronously. So the user never sees the in-between frame.
6. StrictMode (React 18+, dev only) pretends to unmount and remount. After mount, it runs destroy and then create again for every effect. This proves the cleanup is correct.
7. Stale closures happen because `create` is the closure from the render where it was made. If deps did not change, React keeps the old effect and its old captured values.

```text
render -> commit[ before-mutation | mutation (DOM + layout cleanups) | layout (useLayoutEffect) ]
       -> browser paint -> flushPassiveEffects (all useEffect cleanups, then all creates)
```

**🎤 Say this in the interview:** "Each useEffect is an effect object in a circular list on the fiber's updateQueue. If its deps differ by Object.is, it gets a HasEffect flag. After commit, React runs all passive cleanups and then all creates in a scheduled task, normally after paint. useLayoutEffect is different: it runs synchronously in the layout sub-phase, before paint."

**🧪 Real scenario:** After a code change, the network tab shows the same `/api/orders` request firing again and again, without stopping. The page also feels slow. The effect has `[filters]` in its dependency array. What is wrong?

**✅ Scenario answer:**
1. `filters` is probably an object created during render, like `const filters = { status, page }`. Every render makes a new object, so `Object.is` says the dep changed. The effect runs, calls `setState` with the result, which causes a render, which makes a new object again. This is an infinite loop.
2. Confirm it: put a `console.log` in the effect, or see the endless requests in the network tab. The Profiler shows commits happening again and again.
3. Fix: depend on primitive values, or memoize the object:
   ```js
   useEffect(() => { fetchOrders({ status, page }); }, [status, page]);
   // or
   const filters = useMemo(() => ({ status, page }), [status, page]);
   ```
4. Also add cleanup with `AbortController`, so old requests are cancelled when deps change.
5. To prevent it: keep the `react-hooks/exhaustive-deps` lint rule on, and for server data use TanStack Query, which handles caching and dedup.

---

### Q4. `useMemo` vs `useCallback` vs `React.memo`.
**🟢 In simple words:** All three help React avoid doing the same work again. `useMemo` remembers a calculated value. `useCallback` remembers a function. `React.memo` skips re-drawing a component if its inputs did not change.
**🏠 Real-life example:** A shopkeeper writes the total of a regular order on a card, so he does not add it up again each time (`useMemo`). A cook does not re-cook a dish if the order is exactly the same as before (`React.memo`).

- `useMemo(() => compute(a), [a])` → memoizes (caches) a **value**. Use it for expensive calculations or to keep an object reference stable.
- `useCallback(fn, [deps])` → memoizes a **function reference** (same as `useMemo(() => fn)`).
- `React.memo(Component)` → skips re-rendering if the props are shallowly equal.
They only help when used together. If you pass an inline function to a `memo` child, memoization breaks. So wrap that function in `useCallback`. Don't memoize everything — memoization also has a cost. **React Compiler** (React 19 era) memoizes automatically, so you need these less.

**🔍 Internal working:**
1. `useMemo` stores `[value, deps]` in its hook's `memoizedState`. On update, `updateMemo` compares new deps with old deps using `Object.is`. If they are equal, it returns the cached value and does not call the factory.
2. `useCallback` stores `[fn, deps]` in the same way. The only difference: it caches the function you passed instead of calling it. A new inline function is still created every render; React just throws it away.
3. `React.memo` creates a fiber with tag `MemoComponent` (or `SimpleMemoComponent` for a plain function component without a custom compare). In `beginWork`, if the fiber has no pending update of its own, React runs `shallowEqual(prevProps, nextProps)` (or your `arePropsEqual`). It also checks `ref` identity. If equal, it **bails out** (skips work) and reuses the old child fibers.
4. `shallowEqual` checks that both objects have the same keys and that each value is `Object.is` equal. So one new object or function prop breaks it.
5. `memo` does not block re-renders caused by the component's own state or by a context it reads. Those set lanes directly on that fiber.
6. **React Compiler** (stable 1.0 in late 2025, works best with React 19; React 17/18 need `react-compiler-runtime`) is a Babel plugin. It rewrites components to use a per-component cache array (`const $ = _c(n)`, i.e. the `useMemoCache` hook). It groups code into "reactive scopes". It reuses cached values and JSX when inputs are unchanged by `!==`. It is more fine-grained than manual `useMemo`, and it even works after early returns.

**🎤 Say this in the interview:** "useMemo and useCallback store [value, deps] on the hook and compare deps with Object.is. React.memo makes beginWork run a shallowEqual on props and bail out, reusing the old child fibers. The React Compiler does this automatically with a per-component memo cache array."

**🧪 Real scenario:** A teammate wrapped a heavy `ProductRow` component in `React.memo`, but the Profiler still shows all 500 rows re-rendering when the parent's search text changes. Why did `memo` not help?

**✅ Scenario answer:**
1. The parent probably passes a new reference on every render, like `onSelect={() => select(p.id)}` or `style={{ color: 'red' }}`. The shallow compare sees a new function or object, so `memo` cannot skip the render.
2. Confirm it: in React DevTools settings, turn on "Record why each component rendered". The Profiler will say "Props changed: onSelect".
3. Fix: make the props stable. Pass the id and a stable handler:
   ```js
   const handleSelect = useCallback(id => select(id), [select]);
   <ProductRow product={p} onSelect={handleSelect} />
   ```
   Move constant objects outside the component, or use `useMemo` for objects built from props.
4. If the project uses React Compiler, it can do this memoization for you. Still check the Profiler.
5. To prevent it: only add `memo` where the Profiler shows a real cost, and check all props, not just the data props.

---

### Q5. Why does a component re-render?
**🟢 In simple words:** A component draws itself again when something it depends on changes. This can be its own state, its parent, a context it reads, or a hook it uses. Most extra re-renders come from the parent re-rendering and creating new props.
**🏠 Real-life example:** When the head chef changes the menu, every cook in the kitchen re-checks their station, even if their dish did not change. A cook with a "only tell me if my dish changes" note (`memo`) can ignore it.

1. Its own state changed. 2. Its parent re-rendered (even if the props are the same, unless the child is `memo`). 3. A context it reads changed. 4. A hook it uses changed.
**Optimizations:** move state down (keep it close to where it is used), lift content up (pass it as `children`), split contexts, use `memo`, virtualize long lists (`react-window`), and use the React DevTools Profiler to find slow parts.

**🔍 Internal working:**
1. `setState` creates an update with a **lane** (priority) and calls `scheduleUpdateOnFiber`. React marks `fiber.lanes` (and its `alternate`). Then it walks up the `return` pointers and adds the lane to every ancestor's `childLanes`. So React knows the path to the changed fiber.
2. Rendering always starts at the root. But `beginWork` **bails out** fast for fibers that are not on that path. Bailout happens if `oldProps === newProps` (same object), no legacy context changed, and there is no work in `fiber.lanes` → `bailoutOnAlreadyFinishedWork`. If `childLanes` also does not include the render lanes, the **whole subtree is skipped**.
3. When a parent function runs again, its JSX creates **new props objects** for every child. So `oldProps !== newProps`, and the children re-render. This is why "parent re-renders" spreads down. The exception is a `memo` child (it uses a shallow compare instead of identity).
4. Context: when a Provider's `value` changes (by `Object.is`), `propagateContextChange` walks the subtree. It finds fibers whose `dependencies` list contains that context. It schedules work on them (sets their lanes and their parents' `childLanes`). So consumers re-render even below a `memo` component.
5. Eager bailout: if the fiber has no pending updates and the new state is `Object.is` equal to the current one, `setState` does not schedule a render at all. Otherwise React may render the component, and then skip its children if the state ended up the same.
6. "Lift content up" works because the grandparent creates the `children` elements. When the middle component re-renders, the `children` element object is the same. So its props are identical, and React bails out.

**🎤 Say this in the interview:** "setState marks lanes on the fiber and childLanes up to the root. beginWork bails out on any fiber whose props object is identical and has no pending lanes. So re-renders spread only because parents create new props objects. memo swaps identity for a shallow compare, and context propagation marks consumers directly."

**🧪 Real scenario:** In an admin app, a small clock in the header updates every second. After it was added, the whole page (sidebar, table, forms) feels slow. What is happening and how do you fix it?

**✅ Scenario answer:**
1. The clock state (`useState(new Date())`) was probably placed in the top `App` or `Layout` component. Every second that component re-renders. All its children re-render too, because they get new props objects.
2. Confirm it: turn on "Highlight updates when components render" in React DevTools. The whole page flashes every second. The Profiler shows a commit every second with many components.
3. Fix: move the state down into its own small component:
   ```js
   function Clock() {
     const [now, setNow] = useState(new Date());
     useEffect(() => {
       const id = setInterval(() => setNow(new Date()), 1000);
       return () => clearInterval(id);
     }, []);
     return <span>{now.toLocaleTimeString()}</span>;
   }
   ```
   Now only `Clock` re-renders.
4. To prevent it: keep state as close as possible to where it is used, and profile after adding any timer or often-changing state.

---

### Q6. Controlled vs uncontrolled components.
**🟢 In simple words:** In a controlled input, React holds the value and the input just shows it. In an uncontrolled input, the browser holds the value, and React reads it only when needed. Controlled is easier to validate. Uncontrolled is faster for big forms.
**🏠 Real-life example:** Controlled is like a bank teller who writes every amount in the official book as you speak. Uncontrolled is like filling a paper form yourself and handing it over only at the end.

Controlled: React state is the source of truth (`value` + `onChange`). Validation is easy, but it re-renders on every keystroke. Uncontrolled: the DOM holds the value (`ref`, `defaultValue`). This gives better performance for large forms. React Hook Form uses uncontrolled inputs for performance.

**🔍 Internal working:**
1. React's `onChange` for inputs is not the native `change` event. React listens to `input` (and related) native events at the root. It fires `onChange` on every keystroke.
2. React keeps a **value tracker** on each input node. It wraps the `value` property setter to remember the last value React set. So it fires `onChange` only when the value really changed.
3. Controlled: after the event handler runs, React calls `restoreControlledState`. If your handler did not update state (or rejected the change), React writes the `value` prop back to the DOM node. That is why a controlled input "refuses" typing.
4. A keystroke is a discrete event, so it gets SyncLane. This makes the re-render synchronous. This is needed to keep the cursor in the right place (an async update could make the caret jump).
5. Uncontrolled: `defaultValue` is applied only when the DOM node is created (in `completeWork`/initial props). After that React never writes the value. So typing causes zero React renders. You read the value through a ref or `FormData`.

**🎤 Say this in the interview:** "For a controlled input, React fires onChange from the native input event and re-renders synchronously. Then restoreControlledState forces the DOM value back to the prop. An uncontrolled input only gets defaultValue at creation, so typing never touches the fiber tree."

**🧪 Real scenario:** A console warning says "A component is changing an uncontrolled input to be controlled". Users also say the "Edit profile" form sometimes does not show the saved name. What is the cause?

**✅ Scenario answer:**
1. The input gets `value={user.name}`, but on the first render `user.name` is `undefined` (data not loaded yet). React treats `value={undefined}` as uncontrolled. When the data arrives, it becomes controlled. React warns about this switch.
2. Confirm it: log the value on the first render, or check the warning's component stack in the console.
3. Fix: always pass a defined value, so it is controlled from the start:
   ```js
   <input value={form.name ?? ''} onChange={e => setForm({ ...form, name: e.target.value })} />
   ```
4. Another option: render the form only after the data is loaded, and use `defaultValue` (uncontrolled). Add `key={user.id}` so the form resets when the user changes.
5. To prevent it: pick one mode per form. For big forms, use a library like React Hook Form with clear default values.

---

### Q7. State management — Context vs Redux vs Zustand vs React Query.
**🟢 In simple words:** Keep data inside one component when you can. Use Context for small global things that rarely change, like theme or logged-in user. Use Redux or Zustand for big, often-changing app data. Use React Query for data that comes from the server.
**🏠 Real-life example:** A school notice board (Context) is fine for rare announcements, but everyone reads it each time. For daily changing timetables, each class gets only its own sheet (Zustand/Redux selectors). Library books borrowed from outside (server data) are tracked by the librarian (React Query).

- **Local state** first (`useState`/`useReducer`).
- **Context:** for global values that change rarely (theme, auth user, locale). Every consumer re-renders when the value changes. So it is not ideal for state that changes often.
- **Redux Toolkit:** large apps, complex client state, devtools, middleware, predictable data flow.
- **Zustand/Jotai:** lightweight, selector-based subscriptions, less boilerplate code.
- **Server state** (API data) → **TanStack Query / RTK Query**. They give caching, deduplication, background refetch, retries, and pagination. Putting server state into Redux is a common anti-pattern (bad practice).

**🔍 Internal working:**
1. **Context:** in `beginWork`, a Provider pushes its value onto an internal stack (`pushProvider`). It pops it in `completeWork`. `useContext` reads the current value and adds the context to `fiber.dependencies`.
2. When the Provider's `value` changes by `Object.is`, React walks the subtree. It schedules a render on every fiber that depends on that context. There is no selector — any change re-renders all consumers. A new object literal as `value` changes on every Provider render.
3. **Redux (react-redux v8+), Zustand, TanStack Query** keep state **outside React**. They connect through `useSyncExternalStore(subscribe, getSnapshot)`. The store calls subscribers when it changes. React then calls `getSnapshot` (your selector result). It re-renders only if the result is not `Object.is` equal to the last snapshot.
4. `useSyncExternalStore` prevents **tearing** (different components showing different versions of the same data) in concurrent rendering. It checks snapshots again before commit. Also, store updates are rendered with SyncLane (they cannot be time-sliced). So all components see the same store version.
5. TanStack Query keeps a `QueryCache` (a Map keyed by a hashed query key) outside React. Each `useQuery` creates an observer that subscribes to one query. So dedup and caching happen in that cache, not in React state.

**🎤 Say this in the interview:** "Context is a value stack read during render, and on change it re-renders every consumer. Redux, Zustand and React Query keep state outside React and subscribe via useSyncExternalStore. It re-renders only when the selected snapshot changes, and it renders synchronously to avoid tearing."

**🧪 Real scenario:** A team put the cart, user, theme, and notifications into one big `AppContext`. Now every time a notification arrives, the whole app re-renders, including the product list. How do you fix this design?

**✅ Scenario answer:**
1. Context has no selectors. When any part of the value changes, every component that reads `AppContext` re-renders. Also, a new object as `value` on each Provider render makes it worse.
2. Confirm it: in the Profiler, see that consumers like the product list re-render with "Context changed" when only notifications change.
3. Fix step 1: split contexts by how often they change (`ThemeContext`, `AuthContext`), and memoize each `value` with `useMemo`.
4. Fix step 2: move often-changing client state (cart, notifications) to a store with selectors, like Zustand:
   ```js
   const count = useCartStore(s => s.items.length); // re-renders only when count changes
   ```
   Move server data (products, orders) to TanStack Query.
5. To prevent it: in design reviews, ask "is this server state or client state?" and "how often does it change?" before choosing where to keep it.

---

### Q8. Explain the rules of hooks and why they exist.
**🟢 In simple words:** Always call hooks in the same order, at the top of your component. Never put them inside `if` or loops. React does not know hooks by name. It only knows them by their order: first, second, third.
**🏠 Real-life example:** In a cloakroom, coats are kept on numbered hooks in the order people arrive. If one person skips the line one day, everyone after gets the wrong coat back.

Only call hooks at the top level (not in loops or conditions). Only call them from React function components or custom hooks. React stores hook state in a **linked list ordered by call order** on the fiber. A conditional call would shift the order, and state would be matched to the wrong hook.

**🔍 Internal working:**
1. `renderWithHooks` sets module-level variables: `currentlyRenderingFiber`, plus the pointers `currentHook` (in the current tree's list) and `workInProgressHook` (in the new list).
2. It also swaps the **dispatcher** (the object that holds the real hook functions). `ReactCurrentDispatcher.current` (in React 19: `ReactSharedInternals.H`) is set to `HooksDispatcherOnMount` on the first render. On later renders it is `HooksDispatcherOnUpdate`. `useState` from `react` just calls `dispatcher.useState`. That is why the same function does "create" on mount and "read" on update.
3. On mount, each hook call creates a hook object `{ memoizedState, baseState, baseQueue, queue, next }`. React adds it to the list that starts at `fiber.memoizedState`.
4. On update, each hook call does `currentHook = currentHook.next` and clones it. There are **no names or IDs** — only position. If an `if` skips a hook, every later hook reads the wrong node (for example, the state of a `useMemo` is read as a `useState`). If the count changes, React throws "Rendered more/fewer hooks than expected".
5. After render, the dispatcher is set to `ContextOnlyDispatcher`. Its hooks throw "Invalid hook call". This is how React detects a hook called outside a component. In dev, React also records the hook types per render, to warn about order changes.
6. The new `use()` hook (React 19) is the exception. You may call it inside conditions, because it is not stored as a node in the hook list. A promise is tracked in separate per-render thenable state. A context is read like `useContext`.

```text
fiber.memoizedState -> [useState] -> [useEffect] -> [useMemo] -> null
                          queue.pending -> update3 -> update1 -> update2 -> (circular)
```

**🎤 Say this in the interview:** "Hooks are a linked list on fiber.memoizedState. They are matched only by call order. React swaps the dispatcher between the mount and update versions. A conditional hook shifts every later node, so state is read from the wrong slot."

**🧪 Real scenario:** A page crashes with the error "Rendered more hooks than during the previous render" only after the user logs in. In code review you see an early `return` near the top of the component. What is the problem?

**✅ Scenario answer:**
1. The code looks like this: `if (!user) return <Login />;` and then `useState`/`useEffect` calls below it. Before login, fewer hooks run. After login, more hooks run. The hook order and count change, so React throws.
2. Confirm it: the error message and the component stack in the console point to this component. The `react-hooks/rules-of-hooks` lint rule also shows it.
3. Fix: move all hooks above any early return or condition:
   ```js
   const [tab, setTab] = useState('home');
   useEffect(() => { /* ... */ }, []);
   if (!user) return <Login />;
   ```
   Or split it into two components: one that checks login, and one that has the hooks.
4. If a hook should only work in some cases, put the condition inside the hook (for example, inside the effect), not around it.
5. To prevent it: enable `eslint-plugin-react-hooks` as an error in CI.

---

### Q9. Write a custom hook — `useFetch` with abort.
**🟢 In simple words:** A custom hook is a normal function that uses other hooks, so you can reuse logic. `useFetch` loads data from a URL and tracks loading and error. If the URL changes or the component closes, it cancels the old request.
**🏠 Real-life example:** You order a pizza, then change your mind and order a burger. You call the shop to cancel the pizza, so the wrong food does not arrive after the burger.

```js
function useFetch(url) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  useEffect(() => {
    const ctrl = new AbortController();
    setState(s => ({ ...s, loading: true }));
    fetch(url, { signal: ctrl.signal })
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then(data => setState({ data, loading: false, error: null }))
      .catch(err => { if (err.name !== 'AbortError') setState({ data: null, loading: false, error: err }); });
    return () => ctrl.abort();
  }, [url]);
  return state;
}
```
(In production, say that you would use TanStack Query.)

**🔍 Internal working:**
1. A custom hook is just a function. React does not know it exists. Its `useState` and `useEffect` calls add nodes to the **calling component's** hook list. So each component that uses `useFetch` gets its own separate state.
2. `setState` (the `dispatch` function) is bound to the fiber and the hook's queue. Its identity stays the same for the component's whole life. That is why it does not need to be in the deps array.
3. Calling `setState` pushes an update `{ lane, action, next }` into the hook's circular `queue.pending` list. Then it schedules a render. The functional form `s => ({ ...s })` is applied in order during the next render. So it is safe even with batching.
4. When `url` changes, React renders and sees the dep changed. In the next passive-effect flush, it runs the **old cleanup first** (`ctrl.abort()` for the old request). Then it runs the new effect. This prevents a race where an old slow response overwrites a newer one.
5. On unmount, the cleanup runs in the passive unmount phase. Abort rejects the fetch promise with `AbortError`, and the code ignores it.
6. In StrictMode dev, mount → cleanup → mount runs once. So you will see one aborted request in the network tab. This is expected.

**🎤 Say this in the interview:** "A custom hook's hooks live on the calling component's fiber. When url changes, React runs the old effect's cleanup before the new effect. So AbortController cancels the stale request and prevents out-of-order responses."

**🧪 Real scenario:** On a search page, the user types "react" quickly. Sometimes the results shown are for "rea", not for "react". The API is correct. What is the bug in the custom fetch hook?

**✅ Scenario answer:**
1. This is a race condition. Each keystroke starts a new request. The request for "rea" is slower and finishes after the request for "react". The old response overwrites the new one, because the hook has no cleanup.
2. Confirm it: in the network tab, use slow throttling. You will see responses come back out of order, and the last one to finish wins on screen.
3. Fix: cancel the old request in the effect cleanup:
   ```js
   useEffect(() => {
     const ctrl = new AbortController();
     fetch(`/api/search?q=${q}`, { signal: ctrl.signal })
       .then(r => r.json()).then(setResults)
       .catch(e => { if (e.name !== 'AbortError') setError(e); });
     return () => ctrl.abort();
   }, [q]);
   ```
4. Also debounce the input (for example 300 ms) to send fewer requests.
5. To prevent it: use TanStack Query, where each query key has its own cache entry, so the screen shows the data for the current key.

---

### Q10. What's new in React 18 / 19?
**🟢 In simple words:** React 18 lets React work on urgent and non-urgent updates separately, and pause the non-urgent ones. It also groups many state changes into one render. React 19 adds easier tools for forms, async actions, server components, and automatic memoization.
**🏠 Real-life example:** In a hospital, emergency patients are seen first and routine check-ups wait. React 18 is this triage system. React 19 adds a faster form desk and a helper who files papers automatically.

- **React 18:** concurrent rendering, **automatic batching** (also inside promises and timeouts), `useTransition` / `startTransition` (mark updates as non-urgent), `useDeferredValue`, Suspense for data fetching, `createRoot`, streaming SSR.
- **React 19:** **Actions** (async functions in transitions, `useActionState`, `useFormStatus`), `useOptimistic`, the `use()` hook (read promises/context), **Server Components** & Server Actions, `ref` as a prop (no `forwardRef`), document metadata support, React Compiler.

**🔍 Internal working:**
1. **Lanes:** every update gets a priority lane from `requestUpdateLane`. A lane is a bit in a 31-bit mask (SyncLane, InputContinuousLane, DefaultLane, several TransitionLanes, RetryLanes, IdleLane, OffscreenLane). Bitmasks make "batch these together" and "is this lane included?" into cheap bit operations.
2. **`createRoot`** creates a `ConcurrentRoot`. The old `ReactDOM.render` created a `LegacyRoot` (removed in React 19). Only concurrent roots use the yielding work loop and the new features.
3. **Automatic batching:** each `setState` only adds to a queue and calls `ensureRootIsScheduled`. If a task for the same priority is already scheduled, React reuses it. So many `setState` calls in a timeout or promise produce one render. In React 17, batching depended on the `BatchedContext` execution flag. Only React event handlers set that flag, so updates in `setTimeout` rendered one by one. In 18, sync work is flushed in a microtask.
4. **Transitions:** `startTransition` sets a global transition flag (`ReactCurrentBatchConfig.transition`; `ReactSharedInternals.T` in 19). So updates inside it get a TransitionLane. A transition render can yield and can be **interrupted**. If an urgent update arrives, React throws away the workInProgress tree and restarts with the higher lane. `isPending` is a separate urgent update.
5. **`use(promise)`** (19): if the promise is pending, React throws a special Suspense exception and tracks the thenable. It replays the component when the promise resolves. Resolved values are read synchronously from the thenable's status field.
6. **Actions / `useOptimistic`** (19): if you pass an async function to `startTransition`, the transition stays pending until the promise settles. Optimistic state is shown at an urgent lane. It automatically goes back to the real state when the transition finishes.
7. **`ref` as a prop** (19): for function components, React no longer removes `ref` from props. So `forwardRef` is not needed.

**🎤 Say this in the interview:** "React 18 is built on lanes — a bitmask priority per update — plus a concurrent root whose render can yield and restart. Batching works because setState only adds to a queue and reuses the already-scheduled root task. Transitions are just updates in a lower lane that can be interrupted. React 19 builds Actions, use() and useOptimistic on top of the same transition system."

**🧪 Real scenario:** You upgrade an app from React 17 to React 18 and switch to `createRoot`. QA reports that some API calls now run twice in development, and one old test that checked the DOM between two `setState` calls inside a `setTimeout` now fails. Is this a bug?

**✅ Scenario answer:**
1. The double calls come from StrictMode in development. React 18 mounts, unmounts, and mounts again to check cleanup. This does not happen in production.
2. Confirm it: check that `<React.StrictMode>` wraps the app, and test a production build — the call happens only once there.
3. Fix the double calls the right way: add cleanup (`AbortController`, unsubscribe) to the effects. Do not remove StrictMode just to hide it.
4. The failing test is caused by **automatic batching**. In React 18, two `setState` calls inside a `setTimeout` are grouped into one render. If code really needs the DOM updated in between, use `flushSync` (rarely needed):
   ```js
   import { flushSync } from 'react-dom';
   flushSync(() => setStep(1));
   ```
   Usually it is better to update the test to check the final result.
5. To prevent surprises: read the upgrade guide and run the app in StrictMode before release.

---

### Q11. CSR vs SSR vs SSG vs ISR vs RSC.
**🟢 In simple words:** These are different places and times to build the HTML page. CSR builds it in the browser. SSR builds it on the server for each request. SSG builds it once at build time, and ISR rebuilds it now and then. RSC runs some components only on the server and sends no JS for them.
**🏠 Real-life example:** CSR is a meal kit you cook at home. SSR is a dish cooked fresh when you order. SSG is ready-made food on a shelf. ISR is shelf food that is replaced with fresh food every few hours. RSC is the kitchen doing the hard cooking, so you only get the plate.

- **CSR:** the browser renders everything. First load is slow, and SEO is weak.
- **SSR:** the server renders HTML for each request → fast first paint and good SEO. Then **hydration** happens (attaching event handlers to server-made HTML).
- **SSG:** HTML is built at build time → fastest, served from a CDN, but it can be stale (old).
- **ISR (Next.js):** SSG + regeneration in the background after `revalidate`.
- **RSC:** components that run only on the server. They send zero JS to the client and can access the DB directly. Client components are marked `'use client'`.

**🔍 Internal working:**
1. **SSR (React 18+):** the server renderer (Fizz) streams HTML with `renderToPipeableStream` / `renderToReadableStream`. If a `<Suspense>` boundary is not ready, React sends its fallback first (between `<!--$?-->` comment markers). When the data resolves, React streams the real HTML in a hidden element. It also sends a small inline script that swaps it in. No JS bundle is needed for that swap.
2. **Hydration:** `hydrateRoot` renders the same component tree, but `beginWork` does not create DOM. It walks the existing DOM in order (`nextHydratableInstance`) and tries to **claim** each node. If the tag/text matches the fiber, the node becomes the fiber's `stateNode`. Event listeners already work through root delegation.
3. On a **mismatch**, React 18+ does not fix it silently. It throws away the server HTML up to the nearest Suspense boundary (or the root). Then it client-renders that part and reports a recoverable error. React 16/17 tried to patch the differences.
4. **Selective hydration** (18+): each Suspense boundary hydrates on its own. If the user clicks inside a boundary that is not hydrated yet, React raises that boundary's priority and hydrates it first. Then it replays the event.
5. **RSC:** server components render on the server into the **Flight** format. This is a stream of rows like `1:I[...]` (a reference to a client module: id, chunks, export name) and `0:["$","div",null,{...}]` (a serialized element tree). Server component code is never sent to the browser. Client components appear only as module references, and their props must be serializable.
6. On the client, `createFromFetch`/`createFromReadableStream` decodes the rows into React elements. It loads the referenced client chunks. Then React reconciles that tree like any other. So a server refetch can update the UI **without losing client state**. RSC output can also be fed into Fizz to produce the first HTML.
7. SSG/ISR are framework-level features (Next.js). The same SSR render runs at build time, or in the background after `revalidate`. The result is cached.

```text
Server: RSC render --Flight rows--> SSR (Fizz) --HTML stream--> Browser
                         \______ Flight rows inlined in HTML ______/ -> hydrateRoot
```

**🎤 Say this in the interview:** "SSR streams HTML with Suspense boundaries, which inline scripts swap in later. Hydration walks the existing DOM and claims nodes for fibers. On mismatch it falls back to client render. RSC is different: it serializes the server component tree into the Flight row format. There, client components are just module references that the client loads and reconciles."

**🧪 Real scenario:** A Next.js product page is server-rendered. In production, the console shows "Hydration failed because the server rendered HTML didn't match the client", and the "Last updated" time flickers after load. What is the cause and the fix?

**✅ Scenario answer:**
1. Something in the render gives a different result on the server and in the browser. Common causes: `new Date()` or `Date.now()`, `Math.random()`, `window`/`localStorage` checks, or timezone/locale formatting.
2. Confirm it: open the error in the console — React shows which part did not match. Compare "View page source" (server HTML) with the DOM after load.
3. Fix: render the same thing on both sides first, then change it on the client after mount:
   ```js
   const [time, setTime] = useState(null);
   useEffect(() => setTime(new Date().toLocaleTimeString()), []);
   return <span>{time ?? ''}</span>;
   ```
   Or pass the time from the server as a prop, so both sides use the same value.
4. For browser-only widgets, load them only on the client (for example `next/dynamic` with `ssr: false`).
5. To prevent it: in code review, watch for `Date`, random values, and `window` used directly in render.

---

### Q12. How do you optimize a slow React app?
**🟢 In simple words:** First measure, to find what is really slow. Then do less work: load less code, draw fewer items, and skip re-renders that are not needed. Let urgent things like typing go first, and heavy updates wait.
**🏠 Real-life example:** A busy restaurant first watches where the delay is. Then it prepares only the dishes ordered, serves the table near the door first, and does not lay out all 100 tables when only 10 guests are inside (virtualization).

Measure with the Profiler + Lighthouse/Web Vitals (LCP, INP, CLS). Then:
code splitting (`React.lazy` + Suspense, route-based), memoization where the Profiler shows wasted renders, list virtualization, debounce inputs, `useTransition` for heavy updates, image optimization/lazy loading, smaller bundles (analyze them, tree-shake, replace heavy libs), and caching API data.

**🔍 Internal working:**
1. **Profiler:** in profiling builds, React records `actualDuration` (time spent rendering this fiber and its subtree) and `treeBaseDuration` on each fiber. DevTools reads them for each commit. "Why did this render?" comes from comparing the fiber's props/state/hooks with its alternate.
2. **`React.lazy`:** creates a `LazyComponent` fiber. On first render it calls your `import()`. While the promise is pending, it throws it. The nearest `<Suspense>` catches it and shows the fallback. A ping retries the render when the chunk loads. The bundler made a separate chunk because of the dynamic `import()`.
3. **Virtualization:** cost grows with the number of fibers. Every visible fiber goes through beginWork/completeWork and DOM work. Rendering 30 rows instead of 10,000 reduces both render time and commit time.
4. **`useTransition` / `useDeferredValue`:** the heavy render gets a TransitionLane and runs in the yielding work loop. The Scheduler checks `shouldYield` about every 5 ms, using a `MessageChannel` macrotask loop. So typing (SyncLane) can interrupt it. This directly improves **INP**. Debouncing reduces the work; transitions make the remaining work interruptible.
5. **Memoization** works through beginWork bailouts (see Q4/Q5). A bailed-out subtree skips both rendering and reconciliation.
6. The **commit phase can never be interrupted**. So very large DOM updates still block the main thread. That is a case for virtualization, not transitions.

**🎤 Say this in the interview:** "I measure with the Profiler, which reads actualDuration per fiber. Then I reduce the number of fibers: virtualization, and code splitting with lazy, which suspends on the import promise. I increase bailouts with memo. And I move heavy updates to transition lanes, so the Scheduler can yield every ~5 ms and keep INP low."

**🧪 Real scenario:** Users on low-end mobile phones complain that the home page of your React app takes 8 seconds to become usable. Lighthouse shows a poor LCP and a 2.5 MB JavaScript bundle. What do you do?

**✅ Scenario answer:**
1. Measure first: run Lighthouse with mobile throttling, and check real user data (Web Vitals). Find out if the problem is download size, JS run time, or slow APIs.
2. Look inside the bundle with a bundle analyzer (for example `rollup-plugin-visualizer` or `webpack-bundle-analyzer`). Often you find big libraries (charts, date libs, editors) loaded on the home page but used only on other pages.
3. Fix: split code by route and load heavy parts only when needed:
   ```js
   const Reports = React.lazy(() => import('./Reports'));
   <Suspense fallback={<Spinner />}><Reports /></Suspense>
   ```
   Replace heavy libraries with smaller ones, and import only what you use.
4. Optimize the LCP element: compress and correctly size the main image, and do not lazy-load it. Consider SSR or SSG for the first page.
5. To prevent it: add a bundle size budget in CI, and track Web Vitals in production.

---

### Q13. Error boundaries.
**🟢 In simple words:** An error boundary is a safety net around part of your UI. If a component inside it crashes while rendering, the boundary shows a backup message instead of a blank page. It does not catch errors in click handlers or async code.
**🏠 Real-life example:** In a building, a fire door stops a fire in one room from spreading to the whole floor. Each room (widget) can fail alone while the rest of the building works.

Error boundaries are class components with `static getDerivedStateFromError` / `componentDidCatch`. They catch errors **during rendering** in their child tree and show a fallback UI. They do **not** catch event-handler errors, async errors, or SSR errors. Use the `react-error-boundary` library. Place them per route or per widget, so one crash doesn't blank the whole app.

**🔍 Internal working:**
1. The work loop wraps `performUnitOfWork` in a try/catch. When a component throws during render, React calls `throwException(root, returnFiber, sourceFiber, value)`.
2. The fiber that threw is marked `Incomplete`. React then walks **up the `return` pointers**. It looks for the nearest class fiber with `getDerivedStateFromError` or `componentDidCatch` (that is not already in a failed state). If the thrown value is a promise, it looks for a Suspense boundary instead — it is the same mechanism.
3. React marks that boundary with `ShouldCapture`. It adds a special **capture update** whose payload calls `getDerivedStateFromError(error)`. `componentDidCatch` is saved as a callback for the commit.
4. **Unwinding:** `completeUnitOfWork` sees the `Incomplete` fibers. It calls `unwindWork` on each ancestor (popping context/provider stacks) until it reaches the boundary. There it turns `ShouldCapture` into `DidCapture` and restarts `beginWork` on the boundary. The boundary now renders the fallback with the new state.
5. In concurrent rendering (18+), React first retries the render once synchronously before showing the error UI. This is in case the error came from a concurrent data race.
6. `componentDidCatch` runs in the commit **layout** phase. If no boundary is found, the whole root is unmounted (React 16+). React 19 adds root options `onCaughtError` / `onUncaughtError` / `onRecoverableError` for reporting.
7. Event handlers and async code are not caught, because they run **outside the render/commit work loop**. No fiber is on the stack at that time. A common trick is `setState(() => { throw err; })`. It throws the error again inside the next render, so the boundary catches it.

```text
throw in <Chart>  -> mark Incomplete
  return -> <Card>  (no boundary)   unwindWork
  return -> <ErrorBoundary> ShouldCapture -> DidCapture -> re-render with fallback
```

**🎤 Say this in the interview:** "When render throws, React walks up the return pointers to the nearest boundary and marks it ShouldCapture. It adds an update that calls getDerivedStateFromError. Then it unwinds the incomplete fibers and re-renders the boundary with the fallback. Event handlers are not covered because they run outside that work loop."

**🧪 Real scenario:** In production, one bad API response (a field is `null`) makes a small "Recent activity" widget crash. The whole dashboard becomes a white screen. Your error boundary is only at the top of the app. How do you improve this?

**✅ Scenario answer:**
1. The widget throws during render (for example `item.user.name` when `user` is `null`). The error goes up to the nearest boundary. That is the top-level one, so the whole app is replaced by the fallback (or unmounted if there is no boundary).
2. Confirm it: check your error tracking tool (for example Sentry) for the stack trace, and reproduce it with the same API response.
3. Fix: add a boundary around each widget, so only that widget shows an error:
   ```js
   <ErrorBoundary fallback={<p>Could not load activity.</p>}>
     <RecentActivity />
   </ErrorBoundary>
   ```
   Also fix the code with safe access (`item.user?.name`) and validate API data.
4. Remember: errors in click handlers or async code are not caught by boundaries. Use try/catch there, or pass the error to the boundary (for example `showBoundary` from `react-error-boundary`).
5. To prevent it: report boundary errors to your monitoring tool in `onError`, and place boundaries per route and per widget.

---

### Q14. How do you handle authentication in a React SPA?
**🟢 In simple words:** Keep the short-lived login token only in memory, not in localStorage, so bad scripts cannot steal it easily. Keep the long-lived refresh token in a special cookie that JavaScript cannot read. When the token expires, get a new one automatically and retry the request.
**🏠 Real-life example:** At an office, you carry a day visitor pass in your pocket (access token). Your ID card stays locked with security at the gate (httpOnly cookie). When the day pass expires, security gives you a new one, and you continue your work.

Store the access token in memory. Store the refresh token in an **httpOnly secure cookie** (not localStorage — XSS risk). Use an Axios interceptor: on a 401 → call refresh → retry the original request. While refresh is running, queue the other requests. Protect routes with a wrapper component. When using cookies, also add CSRF protection (SameSite + CSRF token).

**🔍 Internal working:**
1. **In-memory token** = a variable in a JS module closure (or React state/context). It is lost when the page reloads. So on app start you call the refresh endpoint. The browser attaches the httpOnly cookie automatically (with `withCredentials: true` for cross-origin). JS can never read that cookie, so XSS cannot steal the long-lived token.
2. **Interceptor queue:** the first 401 sets `isRefreshing = true` and creates one refresh promise. Every other failed request waits for that same promise (single-flight). When it resolves, each request is retried with the new token. If it fails, all requests are rejected and the user is logged out.
3. **Protected route:** the wrapper reads auth state with `useContext`. While auth status is "unknown" (refresh in progress), it renders a loader. If the user is not logged in, it renders `<Navigate to="/login" replace />`, which calls `navigate` in an effect. Showing a loader first avoids a quick wrong redirect.
4. Context value changes (login/logout) re-render all consumers (see Q7). So keep the auth context value memoized and small.
5. `SameSite=Lax/Strict` stops the browser from sending the cookie on most cross-site requests. A CSRF token (double-submit) covers the rest. Remember: frontend route guards are only for UX. The API must enforce authorization.

**🎤 Say this in the interview:** "The access token lives only in a JS closure. The refresh token is in an httpOnly cookie that the browser sends automatically. An interceptor makes refresh single-flight by sharing one promise across all 401s. Route guards show a loader until auth status is known. The server does the real authorization."

**🧪 Real scenario:** When the access token expires, the dashboard sends 6 API calls at the same time. All get 401. The app then calls `/refresh` 6 times, some calls fail, and users are logged out randomly. How do you fix it?

**✅ Scenario answer:**
1. Each failed request starts its own refresh. If the server rotates refresh tokens, the first refresh makes the old refresh token invalid. The other 5 refresh calls then fail, and the app logs the user out.
2. Confirm it: in the network tab, you see many `/refresh` calls at the same time, with some returning 401.
3. Fix: make refresh single-flight — share one promise for all 401s:
   ```js
   let refreshPromise = null;
   async function getNewToken() {
     if (!refreshPromise) {
       refreshPromise = api.post('/refresh').finally(() => { refreshPromise = null; });
     }
     return refreshPromise;
   }
   ```
   In the response interceptor, wait for `getNewToken()`, then retry the original request once (mark it, to avoid an endless loop).
4. If refresh really fails, reject all waiting requests and log out once.
5. To prevent it: write a test that sends many requests with an expired token, and check that only one refresh call happens.

---

### Q15. Lifting state, prop drilling, and composition.
**🟢 In simple words:** Prop drilling means passing data down through many components that do not need it. Composition fixes this: you pass the finished child component in from the top, so the middle components just place it. This also stops extra re-renders for free.
**🏠 Real-life example:** Instead of a letter being handed from person to person in a long line, the post office puts it directly in the right mailbox. The people in the middle never touch it.

Prop drilling = passing props through many middle levels. Fixes: **composition** (pass components as `children` or slots), Context, or a state library. Try composition first — people often forget it.

**🔍 Internal working:**
1. JSX elements are created by the component that **writes** the JSX (the owner). They are not created by the component that renders them. `<Layout><Profile user={user} /></Layout>` creates the `Profile` element inside the top component.
2. When `Layout` re-renders because of its own state, it returns `props.children`. This is the **same element object** as before. In `beginWork`, `oldProps === newProps` for the `Profile` fiber. So React bails out, even without `memo`.
3. With prop drilling, every middle component receives the value and creates new child elements. So each level re-renders when the value changes, even if it only passes it down.
4. Lifting state up moves the hook node to a higher fiber. A `setState` there marks lanes on that fiber. The re-render covers its whole subtree (except bailouts). So lift state only as high as needed.
5. Context skips the middle levels. `propagateContextChange` schedules only the fibers that read the context. The middle components do not re-render if their props did not change.

**🎤 Say this in the interview:** "Composition works because elements are created by their owner. When the middle component re-renders, the children element is the same object. So beginWork sees identical props and bails out. You get memo-like behavior for free, without drilling."

**🧪 Real scenario:** In code review you see a `currentUser` prop passed through 5 components (`Page → Layout → Sidebar → Menu → Avatar`). Only `Avatar` uses it. The teammate wants to fix it by creating a new global Context. What do you suggest?

**✅ Scenario answer:**
1. This is prop drilling. The middle components do not need `currentUser`, but they must accept and pass it. Each one also re-renders when it changes.
2. Before adding Context, try composition. Let the top component create `Avatar` and pass it down as a slot:
   ```js
   <Layout sidebar={<Sidebar menu={<Menu avatar={<Avatar user={currentUser} />} />} />} />
   ```
   Or use `children`. Now the middle components only place the element. They do not know about `currentUser`.
3. Check the result with the React DevTools Profiler: when `currentUser` changes, the middle components should not re-render because of it.
4. Use Context only if many components across the app need the value (for example auth user, theme). Then keep the value small and memoized.
5. To prevent it: in reviews, ask "does this middle component use this prop?" If not, prefer composition.

---

### Q16. How do you test React apps?
**🟢 In simple words:** Test your app the way a user uses it: find buttons and text on the screen, click them, and check what appears. Do not test hidden internal details. Fake the server with MSW, and use Playwright or Cypress for full browser tests.
**🏠 Real-life example:** A restaurant inspector orders food and tastes it like a normal customer. He does not open the chef's notebook to check how each step was written.

Use **React Testing Library** + Jest/Vitest. Test behavior as the user sees it (`getByRole`, `userEvent`), not implementation details. Mock the network with **MSW**. Do E2E tests with Playwright/Cypress. Use snapshot tests only a little.

**🔍 Internal working:**
1. RTL's `render` creates a container in **jsdom** (a DOM written in JS, with no layout or paint). It mounts with `createRoot` inside `act()`.
2. `act()` (React 18+, when `IS_REACT_ACT_ENVIRONMENT` is true) makes React put scheduled work into an internal act queue, instead of the real Scheduler/microtasks. It runs all of it — renders, layout effects and passive effects — before `act` returns. So assertions see the final DOM. RTL wraps `render`, `fireEvent` and `userEvent` calls in `act` for you.
3. `userEvent` sends a realistic sequence of **real DOM events** (pointerdown, mousedown, focus, keydown, input, keyup, click…). They bubble up to the React root. There, React's root-level listener maps them to fibers and calls your `onClick`/`onChange`. This is the same path as in the browser.
4. `getByRole` uses the accessibility tree, built from DOM roles and accessible names. This is why it tests "what the user sees", not component internals or fiber state.
5. `findBy*` / `waitFor` check the DOM again and again until a timeout. This handles async updates (for example, after a fetch). **MSW** catches requests at the network layer (a Service Worker in the browser, request interception in Node). So your real `fetch`/Axios code runs unchanged.
6. jsdom has no layout, so `getBoundingClientRect` returns zeros. Logic that depends on layout (virtualization, measuring) needs mocks or a real browser (Playwright, or Vitest browser mode).

**🎤 Say this in the interview:** "RTL mounts into jsdom inside act(). act() runs all of React's queued renders and effects before the assertions. userEvent fires real DOM events that go through React's root-level event delegation. MSW mocks at the network layer. So the code under test is the real code path."

**🧪 Real scenario:** A test for a "Load orders" page passes on your laptop but fails randomly in CI with "Unable to find text: Order #123". There is also an "act(...)" warning in the logs. What is wrong with the test?

**✅ Scenario answer:**
1. The data loads asynchronously (fetch, then setState). The test checks the screen right away with `getByText`, before the data arrives. On a slow CI machine, the timing is different, so it fails sometimes.
2. Confirm it: the "act(...)" warning means a state update happened after the test finished checking. Run the test many times in a loop locally, or slow the mock response, and it fails too.
3. Fix: wait for the result with `findBy*` (it retries until a timeout), and mock the API with MSW:
   ```js
   render(<Orders />);
   expect(await screen.findByText('Order #123')).toBeInTheDocument();
   ```
4. Do not use fixed `setTimeout` waits in tests. Reset MSW handlers between tests so one test does not affect another.
5. To prevent it: use the `eslint-plugin-testing-library` rules, and treat "act" warnings as errors to fix.