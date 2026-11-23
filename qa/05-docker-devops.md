# 05 — Docker, DevOps & Cloud

---

### Q1. Container vs virtual machine.
**🟢 In simple words:** A virtual machine (VM) is a full fake computer with its own operating system inside. A container is just a normal program on your computer, but it is put in a "box" so it cannot see other programs. All containers share the same Linux kernel, so they are small and start very fast. The price: the walls between containers are thinner than the walls between VMs.
**🏠 Real-life example:** VMs are separate houses — each has its own foundation, water and electricity. Containers are apartments in one building — they share the foundation and pipes (the kernel), but each has its own locked door.

A VM virtualizes the hardware. It runs a full guest OS. It is big (GBs) and takes minutes to boot. A container virtualizes at the OS level. It shares the host kernel. It is isolated with **namespaces** (Linux feature that gives a process its own view of pid, net, mnt, user). It is limited with **cgroups** (Linux feature that limits CPU and memory). A container is small (MBs) and starts in seconds. But containers give weaker isolation than VMs.

**🔍 Internal working:**
1. `docker run` → the docker CLI sends a REST call over `/var/run/docker.sock` to **dockerd**. dockerd pulls and prepares the image. Then it asks **containerd** (over gRPC) to create the container.
2. containerd writes an **OCI bundle** (a `config.json` + a root filesystem). It starts a small **containerd-shim** process. The shim calls **runc**.
3. runc calls `clone()` / `unshare()` with flags like `CLONE_NEWPID`, `CLONE_NEWNET`, `CLONE_NEWNS`, `CLONE_NEWUTS`, `CLONE_NEWIPC` (and optionally `CLONE_NEWUSER`). The new process gets its own view of PIDs, network, mounts and hostname. It is still a normal Linux process on the host kernel.
4. runc puts the process into a **cgroup** (e.g. `/sys/fs/cgroup/.../memory.max`, `cpu.max`). So the kernel enforces the CPU, memory and PID limits. If memory goes above the limit, the kernel OOM killer kills the process (exit code 137).
5. runc does `pivot_root` into the image rootfs. It drops capabilities and applies seccomp/AppArmor profiles. Then it calls `execve()` to start your command. After that, runc exits. The shim stays as the parent. It keeps stdio and the exit code.
6. A VM is different. It runs a hypervisor (KVM, Hyper-V) that emulates virtual CPUs and devices. It boots a separate kernel. That is why a VM is heavier but has a stronger isolation boundary. A kernel bug in a container affects the host. In a VM, it usually does not.

```text
docker CLI ──REST──> dockerd ──gRPC──> containerd ──> containerd-shim ──> runc
                                                                          │ clone(NEW*) + cgroups + pivot_root
                                                                          ▼
                                                             your process (PID 1 inside the namespace)
```

**🎤 Say this in the interview:** "A container is just a Linux process. runc starts it with clone() in new namespaces for isolation, and puts it in a cgroup for limits. It runs on the same host kernel. A VM boots its own kernel on a hypervisor. So a VM is heavier, but it is more strongly isolated."

**🧪 Real scenario:** Your security team says: "We want to run code uploaded by customers (untrusted code) on our servers. Can we just run each job in a normal Docker container?" What do you answer?

**✅ Scenario answer:**
1. Explain the risk: all containers share the same host kernel. If the customer code uses a kernel bug to escape, it can reach the host and other customers' containers.
2. Normal containers are fine for our own trusted code. For untrusted code, we need a stronger wall.
3. Options: run each job in a small VM (for example AWS Fargate or Firecracker micro-VMs), or use a sandbox runtime like gVisor or Kata Containers.
4. If we still use containers, harden them: run as non-root, use `--cap-drop=ALL`, `--read-only`, `--security-opt no-new-privileges`, keep the default seccomp profile, and set CPU, memory and PID limits (`--memory`, `--cpus`, `--pids-limit`).
5. Never mount `/var/run/docker.sock` into such a container. It gives full control of the host.

---

### Q2. Image vs container; what are layers?
**🟢 In simple words:** An image is a read-only recipe or template. A container is that image actually running, with a small notebook on top where it can write changes. The image is built from layers — each layer is a small set of file changes stacked on the one below. Layers are reused between images, so they save disk space and download time.
**🏠 Real-life example:** An image is like a stack of transparent sheets on a projector. Each sheet adds a little drawing. A container puts one more blank sheet on top where you can draw. If you throw away the top sheet, your drawings are gone, but the sheets below stay the same.

An image is a read-only template made of **stacked layers**. Each Dockerfile instruction that changes the filesystem — `RUN`, `COPY`, `ADD` — creates one layer. Other instructions like `ENV`/`CMD` only change the image metadata. Layers are cached and content-addressed (named by a hash of their content). A container = an image + a thin writable layer + a running process. Layer caching: if one layer changes, all the layers **after** it rebuild. So put the instructions that change least first, and the ones that change most last.

**🔍 Internal working:**
1. An image is described by a **manifest** (JSON). The manifest lists one **config** blob and a list of **layer** blobs. Each blob is identified by a `sha256:` digest. The config holds env, cmd, entrypoint, and the `diff_ids` (hashes of the uncompressed layers). For multi-arch images, an **index** (manifest list) points to one manifest per platform.
2. `docker pull` → first it resolves the tag to a manifest digest from the registry (`GET /v2/<name>/manifests/<tag>`). Then it downloads only the layer blobs that are not already on the machine (`GET /v2/<name>/blobs/<digest>`). Same digest = same content. So layers are shared between images.
3. Each layer is a tar of file changes. Deleted files are stored as **whiteout** files (`.wh.<name>`). So deleting a file in a later layer does not make the image smaller.
4. When a container starts, the overlay2 driver mounts **OverlayFS** (a Linux filesystem that stacks folders on top of each other). The image layers become read-only `lowerdir`s. A new empty `upperdir` is the container's writable layer. `merged` is the view the process sees.
5. **Copy-on-write:** a read gets the file from the top-most layer that has it. The first write to a file from a lower layer copies the whole file up into `upperdir` (copy_up). Then it changes the copy. `docker rm` deletes the upperdir. So data written there is lost.

```text
merged/   (what the container sees)
  ▲
upperdir  (container writable layer, CoW)   <- deleted on docker rm
lowerdir3 (COPY . .)                         read-only, shared
lowerdir2 (RUN npm ci)                       read-only, shared
lowerdir1 (FROM node:22-alpine)              read-only, shared
```

**🎤 Say this in the interview:** "An image is a manifest that points to a config and to content-addressed layer tarballs. At run time, overlay2 stacks those layers as read-only lowerdirs with one writable upperdir. The first write to a file copies it up — that is copy-on-write. This is why many containers can share one image cheaply."

**🧪 Real scenario:** A teammate fixed a config file inside a running production container with `docker exec` and `vi`. It worked. But after the next restart (a new container from the image), the bug came back. Why?

**✅ Scenario answer:**
1. Root cause: the change was written only to the container's thin writable layer (the upperdir). The image layers are read-only and did not change.
2. When the container is removed and created again from the image, it gets a new, empty writable layer. So the fix is gone.
3. Confirm it: `docker diff <container>` shows the files changed in the writable layer (`C /app/config.json`).
4. Fix: put the change in the source code or config, rebuild the image, push it with a new tag, and redeploy. If it is environment config, pass it with env vars or a mounted ConfigMap / volume instead.
5. Prevent it: treat containers as immutable. Block manual edits in production (for example, run with `--read-only`), and make every change go through CI/CD.

---

### Q3. Write a production Dockerfile for a Node app.
**🟢 In simple words:** A good production Dockerfile builds the app in one "workshop" stage and then copies only the finished result into a small, clean final image. It installs dependencies before copying the code, so Docker can reuse that slow step. It runs the app as a normal user, not as root, for safety.
**🏠 Real-life example:** It is like a restaurant kitchen. You cook in the messy kitchen (build stage) with all the knives and pans. But you only send the finished plate to the customer (final image) — not the pans, not the knives.

```dockerfile
# ---- deps ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---- build (if TS / frontend) ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# don't run as root
USER node
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://localhost:3000/health || exit 1
# exec form → receives SIGTERM directly
CMD ["node", "dist/server.js"]
```
Key points:
- **multi-stage** build
- `npm ci`
- copy `package.json` before the source code (for the cache)
- `.dockerignore` (node_modules, .git, .env)
- non-root user
- small base image
- exec-form CMD

Note: Dockerfile comments must be on their **own line** (a line that starts with `#`). A `# ...` at the end of an instruction is not a comment. It becomes part of the arguments. After a JSON `CMD`, it breaks the JSON. Then Docker silently falls back to the shell form.

**🔍 Internal working:**
1. `docker build` sends the **build context** (the files, filtered by `.dockerignore`) to **BuildKit**. BuildKit turns the Dockerfile into an **LLB DAG**. This is a graph of operations (source, exec, file copy) for each stage.
2. Because it is a DAG, independent stages (`deps` and `build`) run **in parallel**. Stages that the final target does not need are skipped.
3. Each step has a **cache key**. For `RUN`, the key is the parent layer + the command string. For `COPY`, the key is the parent + a checksum of the copied files' content and metadata. If the key matches the cache, the step is reused. That is why `COPY package*.json` + `npm ci` comes before `COPY . .`. Code changes do not change the key for `npm ci`.
4. `COPY --from=deps` copies only the chosen files from another stage's filesystem. So compilers, dev deps and source code never reach the final image.
5. `USER node` sets the UID in the image config. Later, runc calls `setuid/setgid` before `execve`. So the process is not root inside the container.
6. `HEALTHCHECK` is stored in the image config. dockerd runs the command inside the container on an interval (it execs into the container's namespaces). It marks the container `healthy` or `unhealthy`. Kubernetes ignores it and uses its own probes.

```text
context ─> BuildKit LLB DAG
   [deps]  npm ci --omit=dev ─┐
   [build] npm ci → build ────┼─> [runtime] COPY --from=... ─> image (manifest + layers)
   (deps and build run in parallel; each step cached by key)
```

**🎤 Say this in the interview:** "BuildKit turns the Dockerfile into a DAG. It runs independent stages in parallel. It caches each step by a key: the parent layer plus the command or the file checksums. So copying package.json first keeps the npm ci layer cached. Multi-stage copying keeps only the runtime files in the final image."

**🧪 Real scenario:** Your CI pipeline takes 12 minutes to build the Docker image, even when a developer changes only one line in a `.ts` file. Most of the time is spent in `npm install`. How do you fix it?

**✅ Scenario answer:**
1. Root cause: the Dockerfile probably does `COPY . .` before `RUN npm install`. Any code change changes the cache key of the COPY, so the npm step runs again every time.
2. Confirm it: look at the build log. The `npm install` step does not show `CACHED`. Also check if the CI runner starts empty with no Docker cache.
3. Fix the order: copy only `package*.json` first, run `npm ci`, and then `COPY . .`.
```dockerfile
COPY package*.json ./
RUN npm ci
COPY . .
```
4. Add a `.dockerignore` (node_modules, .git, dist, .env), so useless files do not break the cache.
5. In CI, use a remote BuildKit cache, for example `docker buildx build --cache-from type=gha --cache-to type=gha,mode=max`. You can also use `RUN --mount=type=cache,target=/root/.npm npm ci` to reuse the npm download cache.

---

### Q4. How do you reduce Docker image size?
**🟢 In simple words:** A smaller image downloads faster, starts faster and has fewer security holes. You make it small by starting from a tiny base image and copying in only what the app needs to run. Deleting files later does not help, because old layers still keep them.
**🏠 Real-life example:** It is like packing a suitcase for a trip. Take a small suitcase and pack only what you need. If you put in a heavy coat and then cover it with a T-shirt, the suitcase is still heavy — the coat is still inside.

Ways to reduce size:
- Use Alpine / distroless / slim base images.
- Use multi-stage builds.
- Install production deps only.
- Use `.dockerignore`.
- Combine RUN commands and clean caches in the same layer.
- Don't copy build tools into the final stage.

Tools: `docker history`, `dive`.

**🔍 Internal working:**
1. Image size = the sum of all layer tarballs. Layers are **additive** (they only add). A file deleted in a later layer is only hidden by a whiteout file. Its bytes still exist in the earlier layer.
2. So write `RUN apt-get install ... && rm -rf /var/lib/apt/lists/*` in **one** `RUN`. This keeps the cache out of the layer. Doing `rm` in a separate `RUN` saves nothing.
3. Multi-stage builds solve the problem fully. The final stage starts from a fresh base. Only the files you `COPY --from` are added as new layers.
4. The base image choice matters most: `node:22` (Debian, large) vs `-slim` vs `-alpine` (musl libc, small) vs **distroless** (no shell, no package manager). Distroless is smaller and has a smaller attack surface, but it is harder to debug.
5. `.dockerignore` makes the build context sent to BuildKit smaller. It also stops `COPY . .` from adding `node_modules`, `.git` or `.env` into a layer (and from breaking the cache).
6. `docker history <img>` shows the size of each layer. `dive` shows the file tree of each layer. It also shows "wasted space" from overwritten or deleted files.

**🎤 Say this in the interview:** "Layers are additive tarballs. So deleting a file in a later layer doesn't shrink anything. You clean up in the same RUN. Or better, you use multi-stage builds. Then the final image only has the files you explicitly copy onto a small base like alpine or distroless."

**🧪 Real scenario:** Your Node API image is 1.8 GB. Kubernetes takes more than 2 minutes to pull it on new nodes, so autoscaling is slow during traffic spikes. Also, the security scanner shows 300+ vulnerabilities. What do you do?

**✅ Scenario answer:**
1. Find what is big: run `docker history <image>` to see the size of each layer, or use `dive` to see the files in each layer.
2. Common causes: a full `node:22` (Debian) base image, dev dependencies, the `.git` folder, a local `node_modules` copied in, or build tools left in the final image.
3. Fix with a multi-stage build: build in one stage, then copy only `dist` and production `node_modules` into a `node:22-alpine` or distroless final stage. Use `npm ci --omit=dev`.
4. Add a `.dockerignore` with `node_modules`, `.git`, `.env`, test files.
5. Check the result: image size and scanner results (e.g. Trivy) should drop a lot. Add an image-size check or scan step in CI so the image does not grow again.

---

### Q5. CMD vs ENTRYPOINT; exec vs shell form.
**🟢 In simple words:** ENTRYPOINT is the program that always runs. CMD gives the default arguments, and you can change them when you start the container. Write them in "exec form" (a JSON list) so your app is the main process and directly hears the "please stop" signal. Otherwise a shell sits in the middle and the app gets killed hard instead of closing nicely.
**🏠 Real-life example:** Think of a manager who must tell workers "closing time, finish your work". If a receptionist (the shell) sits in between and does not pass the message, the workers get no warning — then security (SIGKILL) throws everyone out mid-task.

`ENTRYPOINT` = the fixed program to run. `CMD` = the default arguments. You can override CMD with `docker run img args`. The **exec form** `["node","app.js"]` runs node as PID 1, so node gets the signals. The **shell form** wraps the command in `/bin/sh -c`. The shell may not pass SIGTERM on → no graceful shutdown. Also think about `tini` / `--init` to clean up zombie processes.

**🔍 Internal working:**
1. In the image config, `Entrypoint` and `Cmd` are two string arrays. The final process argv = `Entrypoint + Cmd`. `docker run img args` replaces `Cmd`. `--entrypoint` replaces `Entrypoint`.
2. Shell form `CMD node app.js` is stored as `["/bin/sh","-c","node app.js"]`. Then `sh` is PID 1 and node is its child. `docker stop` sends SIGTERM to PID 1 only. `sh` usually does not pass it on. So after the timeout (10s by default), Docker sends **SIGKILL** → no graceful shutdown.
3. PID 1 in a PID namespace is special. For signals that have no handler (e.g. SIGTERM, SIGINT), the kernel does **not** apply the default action. So even with exec form, node as PID 1 only stops on SIGTERM if your code has a `process.on('SIGTERM', ...)` handler.
4. PID 1 must also **reap zombies**. When a child exits, its parent must call `wait()`. If PID 1 does not do that (node does not reap random grandchildren), zombie processes pile up.
5. `docker run --init` (or `tini` as ENTRYPOINT) puts a tiny init program as PID 1. It passes signals on to your app and reaps zombies.
6. In Kubernetes, the kubelet does the same thing: SIGTERM to PID 1, wait `terminationGracePeriodSeconds` (30s default), then SIGKILL.

```text
shell form:  PID1 /bin/sh -c ──> node   (SIGTERM stops at sh → SIGKILL after 10s)
exec form:   PID1 node                   (gets SIGTERM; needs a handler)
with --init: PID1 tini ──> node          (forwards signals + reaps zombies)
```

**🎤 Say this in the interview:** "Docker sends SIGTERM only to PID 1, and sends SIGKILL after the grace period. With shell form, PID 1 is sh, and sh doesn't forward the signal. Also, the kernel ignores unhandled signals for PID 1. So I use exec form plus a SIGTERM handler, and tini or --init for signal forwarding and zombie reaping."

**🧪 Real scenario:** Every deploy, users get 502 errors for about 10–30 seconds. The logs show the Node app never prints "SIGTERM received". Each old pod takes exactly 30 seconds to stop. What is wrong?

**✅ Scenario answer:**
1. Root cause: the app does not receive SIGTERM. Most likely the Dockerfile uses shell form (`CMD npm start` or `CMD node server.js`), so `sh` (or `npm`) is PID 1 and does not pass the signal to node. After 30s, Kubernetes sends SIGKILL and open requests are cut.
2. Confirm it: `docker inspect <image> --format '{{.Config.Cmd}}'` shows `[/bin/sh -c ...]`. Or run `ps` inside the container (`kubectl exec <pod> -- ps`) and see that PID 1 is `sh` or `npm`, not `node`.
3. Fix the Dockerfile: use exec form and run node directly (not through `npm start`).
```dockerfile
CMD ["node", "dist/server.js"]
```
4. Add a SIGTERM handler in the app: call `server.close()`, finish in-flight requests, close DB pools, then `process.exit(0)`.
5. Add a short `preStop` sleep (e.g. 5s) so the pod is removed from the Service before shutdown starts. Use `tini` or `--init` if the app starts child processes.

---

### Q6. COPY vs ADD; ARG vs ENV.
**🟢 In simple words:** COPY simply copies files into the image — use it almost always. ADD does extra "magic" (unpacks archives, downloads URLs), which can surprise you. ARG is a variable only while building; ENV stays inside the image when it runs. Never put passwords in either one — anyone with the image can read them.
**🏠 Real-life example:** Putting a password in ENV is like writing your house key code on the front door. Use a BuildKit secret instead — like a guard who shows you the code for one minute and then takes the paper back.

`COPY` copies files (this is preferred). `ADD` also extracts tarballs and downloads URLs. Avoid ADD unless you need that. `ARG` exists only at build time. `ENV` stays in the image and is there at runtime. Never put secrets in ARG/ENV in an image. Use BuildKit secrets (`--mount=type=secret`) and runtime env / secret managers instead.

**🔍 Internal working:**
1. `COPY` creates a layer from files in the build context. BuildKit checksums the files to compute the cache key. `ADD` does the same, but it also auto-extracts local tar archives and can download a remote URL. This hidden behavior makes builds less predictable.
2. `ENV` is written into the image **config** (`Env` array). So every container started from the image gets it. Anyone can read it with `docker inspect`.
3. `ARG` values exist only during the build, but they can still leak. A `RUN` that uses an ARG is recorded in the image **history**. `docker history` shows the command and the build-arg values used there.
4. `RUN --mount=type=secret,id=npmrc` makes BuildKit mount the secret as a temporary file (by default under `/run/secrets/<id>`). It exists only for that one `RUN` step. It is not written into any layer. It is not part of the cache key.
5. At runtime, Kubernetes Secrets or AWS Secrets Manager inject values as env vars or mounted files when the container starts. So the image has no secrets and can be reused in every environment.

**🎤 Say this in the interview:** "ENV is baked into the image config, and ARG values can still show up in image history. So neither is safe for secrets. A BuildKit secret mount gives a file only during one RUN step and never writes it to a layer. Runtime secrets are injected when the container starts."

**🧪 Real scenario:** Your company's Docker image is pushed to a public registry by mistake. A security researcher emails you: "I found your private npm token inside your image." The Dockerfile has `ARG NPM_TOKEN` and `RUN echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" > .npmrc && npm ci`. How did it leak, and what do you do?

**✅ Scenario answer:**
1. Root cause: build-arg values used in a `RUN` step are saved in the image history. Also, the `.npmrc` file may be saved in a layer if it is not deleted in the same `RUN`.
2. Confirm it: `docker history --no-trunc <image>` shows the token in the command. You can also check the layers with `dive`.
3. First, act now: revoke and rotate the token at once. Make the image private or delete it. Check the npm audit logs for misuse.
4. Fix the Dockerfile: use a BuildKit secret mount, so the token is never written to a layer or history.
```dockerfile
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci
```
Build with: `docker build --secret id=npmrc,src=$HOME/.npmrc .`
5. Prevent it: add a secret scanner (e.g. Trivy secret scan, gitleaks) in CI, and keep runtime secrets in Kubernetes Secrets or AWS Secrets Manager.

---

### Q7. Docker networking and volumes.
**🟢 In simple words:** Docker networking decides how containers talk to each other and to the outside world. On a user-defined network, containers can find each other by name. Volumes are folders that live outside the container, so data is kept even when the container is deleted.
**🏠 Real-life example:** A bridge network is like an office with its own phone system — each desk (container) has an extension, and the receptionist (Docker DNS) knows everyone by name. A volume is like a locker outside your desk: if you leave the company (container deleted), the locker still has your things.

- Networks:
  - **bridge** — the default. On a user-defined bridge, containers find each other by service name.
  - **host** — the container shares the host's network stack.
  - **none** — no network.
  - **overlay** — for multi-host / Swarm.
- Storage:
  - **volumes** — managed by Docker, best for DB data.
  - **bind mounts** — a host path; good for dev hot-reload.
  - **tmpfs** — in memory.
- Containers are short-lived → keep state in volumes.

**🔍 Internal working:**
1. Bridge mode: Docker creates a Linux bridge (a virtual network switch). It is `docker0` for the default network, and `br-<id>` for user-defined ones. For each container, Docker creates a **veth pair** (a virtual cable with two ends). One end goes into the container's network namespace as `eth0`. The other end is attached to the bridge.
2. The container gets an IP from the network's subnet (e.g. 172.17.0.0/16). Its default gateway is the bridge IP. Outgoing traffic is **SNAT/MASQUERADE**d by iptables to the host IP.
3. `-p 8080:3000` adds an iptables **DNAT** rule (in the `DOCKER` chain of the `nat` table): host:8080 → containerIP:3000. docker-proxy may also run as a userland fallback.
4. On **user-defined** networks, dockerd runs an **embedded DNS server** at `127.0.0.11` inside each container (`/etc/resolv.conf` points to it). It answers container names and aliases with container IPs. It forwards other names to the host's DNS. The default `docker0` bridge has no name resolution like this.
5. `--network host` skips the network namespace fully. Overlay uses VXLAN tunnels between hosts.
6. Volumes live under `/var/lib/docker/volumes/<name>/_data`. They are **bind-mounted** into the container's mount namespace. They are outside the OverlayFS upperdir. So they survive `docker rm` and have no copy-on-write overhead. tmpfs is a mount backed by RAM.

```text
 container A (netns)        container B (netns)
   eth0 172.18.0.2            eth0 172.18.0.3
     │ veth                     │ veth
 ────┴────── br-xxxx (172.18.0.1) ──────┴────
                 │ iptables: MASQUERADE out, DNAT for -p
              host eth0
```

**🎤 Say this in the interview:** "Each container gets its own network namespace. A veth pair connects it to a Linux bridge. iptables does NAT for outgoing traffic and DNAT for published ports. On user-defined networks, Docker's embedded DNS at 127.0.0.11 resolves container names. Volumes are bind mounts outside the overlay writable layer, so they survive the container."

**🧪 Real scenario:** Your Node API container fails to connect to Postgres with `ECONNREFUSED 127.0.0.1:5432`. On your laptop (without Docker), the same code works. Postgres is running in another container. What is wrong?

**✅ Scenario answer:**
1. Root cause: inside a container, `localhost` (127.0.0.1) means the container itself, not the host and not the DB container. There is no Postgres inside the API container.
2. Confirm it: `docker network inspect <network>` to check both containers are on the same user-defined network. Then `docker exec -it api sh` and try `nc -zv db 5432` (if `nc` is installed).
3. Fix: put both containers on the same user-defined network, and use the container or service name as the host.
```bash
docker network create appnet
docker run -d --name db --network appnet postgres:16
docker run -d --name api --network appnet -e DB_HOST=db my-api
```
4. Note: the default `bridge` network has no name-based DNS. Use a user-defined network or Docker Compose.
5. Prevent it: read the DB host from env vars (`DB_HOST`), never hard-code `localhost`.

---

### Q8. Docker Compose — what is it for? Example?
**🟢 In simple words:** Docker Compose lets you describe many containers (API, database, cache) in one YAML file and start them all with one command. It puts them on one network so they can call each other by name. It is mainly used for local development and testing.
**🏠 Real-life example:** It is like a band leader with a song sheet. Instead of telling each musician separately when to start, the leader reads one sheet and everyone starts in the right order — the drummer (database) first, then the singer (API) once the drummer is ready.

It defines apps with many containers in one YAML file. It is used for local dev and testing.
```yaml
services:
  api:
    build: .
    ports: ["3000:3000"]
    env_file: .env
    depends_on:
      db: { condition: service_healthy }
  db:
    image: postgres:16
    environment: { POSTGRES_PASSWORD: secret }
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD","pg_isready"], interval: 5s }
  redis:
    image: redis:7-alpine
volumes: { pgdata: {} }
```

**🔍 Internal working:**
1. Compose is a client. It reads the YAML into a project model. Then it calls the same Docker Engine API as the CLI. The **project name** (by default the folder name) is added as a prefix to resources. It is also saved as labels (`com.docker.compose.project`, `com.docker.compose.service`) on every container.
2. It creates a user-defined bridge network `<project>_default`. It attaches all services to it, with the **service name as a DNS alias**. So `api` connects to `db:5432` through the embedded DNS at 127.0.0.11. No IPs are needed.
3. Named volumes become `<project>_pgdata`. `docker compose down` does not remove them unless you add `-v`.
4. `depends_on` with `condition: service_healthy` works like this: Compose starts `db`, then checks its health status again and again. (dockerd runs `pg_isready` on the interval to get this status.) Compose starts `api` only after `db` reports `healthy`. Without a condition, it only orders the container **start**, not readiness.
5. When you run `up` again, Compose compares a hash of each service's config (stored as a label) with the running container. Only the changed services are recreated.

**🎤 Say this in the interview:** "Compose is just an Engine API client. It creates a bridge network for the project, where service names are DNS aliases on the embedded resolver. It prefixes volumes with the project name. It uses healthchecks to control depends_on. And it recreates only the services whose config hash changed."

**🧪 Real scenario:** A new developer runs `docker compose up`. The API crashes at start with "connection refused" to the database, but after a manual restart it works. Another developer ran `docker compose down -v` and lost all local test data. How do you explain and fix both?

**✅ Scenario answer:**
1. Crash at start: `depends_on` without a condition only waits for the DB container to **start**, not to be **ready**. Postgres needs a few seconds before it accepts connections.
2. Confirm it: `docker compose logs db api` shows the API error before Postgres prints "ready to accept connections". `docker compose ps` shows the health status.
3. Fix: add a healthcheck on `db` and use `condition: service_healthy` (like the example above). Also add retry logic in the app for DB connections, because the DB can restart later too.
4. Lost data: `-v` removes the named volumes (like `pgdata`). Plain `docker compose down` keeps them.
5. Prevent it: write in the README to use `docker compose down` (without `-v`) normally, and add a seed script so test data can be created again easily.

---

### Q9. Kubernetes basics you must know.
**🟢 In simple words:** Kubernetes runs your containers on many machines for you. You tell it what you want ("3 copies of my API"), and it keeps working all the time to make reality match that wish. If a container dies, it starts a new one; if traffic grows, it can add more copies.
**🏠 Real-life example:** It is like a restaurant manager. You say "always have 3 waiters on the floor". If one waiter goes home sick, the manager calls a new one. The host at the door (Service) sends guests only to waiters who are ready to serve.

- **Pod** — the smallest unit (one or more containers).
- **Deployment** — keeps the wanted number of replicas, does rolling updates and rollback.
- **Service** — a stable virtual IP/DNS name + load-balancing to pods (ClusterIP/NodePort/LoadBalancer).
- **Ingress** — HTTP routing and TLS.
- **ConfigMap/Secret** — config.
- **HPA** — autoscaling on CPU/memory/custom metrics.
- **StatefulSet** — for databases that need a stable identity.
- **Probes:** liveness (restart if dead), readiness (remove from the load balancer if not ready), startup.
- Always set resource **requests/limits**.

**🔍 Internal working:**
1. `kubectl apply` → the **API server** authenticates, authorizes (RBAC), runs admission controllers and validates. Then it stores the object in **etcd** (the cluster's database). The API server is the only component that talks to etcd.
2. **Controllers** (in kube-controller-manager) **watch** the API server. They run reconcile loops: they compare desired state with actual state and fix the difference. The Deployment controller creates a **ReplicaSet**. The ReplicaSet controller creates Pod objects until the count matches.
3. The **scheduler** watches for Pods with no `nodeName`. It filters nodes (enough free **requests**, taints/tolerations, affinity). It scores the nodes. Then it binds the Pod to a node.
4. The **kubelet** (agent on each node) on that node sees the Pod. It asks the container runtime (containerd via CRI) to create the pod sandbox and containers. The CNI plugin gives the pod an IP. Limits become cgroup limits. Memory over the limit → OOMKilled. CPU over the limit → throttled (slowed down).
5. The kubelet runs the **probes** itself (HTTP GET, TCP, exec, gRPC). Liveness failure → the kubelet restarts the container. Readiness failure → the pod is marked NotReady → it is removed from the Service's **EndpointSlice**. The startup probe holds back the other two probes until it passes.
6. A Service gets a virtual ClusterIP. **kube-proxy** on each node watches EndpointSlices. It writes **iptables** (or IPVS) rules that DNAT the ClusterIP to a random ready pod IP. **CoreDNS** resolves `my-svc.my-ns.svc.cluster.local` to that ClusterIP.
7. **HPA** is a control loop (every 15s by default). It reads metrics from **metrics-server** (or the custom metrics API). It computes `desired = ceil(current × currentMetric / target)`. Then it updates the Deployment's `replicas`.

```text
kubectl ─> API server ─> etcd
              ▲  watch
   ┌──────────┼───────────────┐
 controller  scheduler       kubelet (node) ─CRI─> containerd ─> runc
 (Deploy→RS→Pods) (bind node)   └─ runs probes, reports status
 kube-proxy: Service ClusterIP ─iptables/IPVS DNAT─> ready pod IPs
 CoreDNS: svc name ─> ClusterIP
```

**🎤 Say this in the interview:** "Everything goes through the API server into etcd. Independent controllers reconcile the desired state with the actual state. The Deployment creates a ReplicaSet. The scheduler binds pods to nodes based on requests. The kubelet starts containers via CRI and runs the probes. kube-proxy's iptables or IPVS rules load-balance a Service's ClusterIP to only the ready pods."

**🧪 Real scenario:** After a release, your API pods keep restarting. `kubectl get pods` shows `CrashLoopBackOff` and the restart count keeps going up. Some pods show `OOMKilled`. How do you debug it?

**✅ Scenario answer:**
1. Check the reason: `kubectl describe pod <pod>` shows "Last State: Terminated, Reason: OOMKilled, Exit Code: 137", or another error. The Events section also shows failed probes.
2. See the logs of the crashed container: `kubectl logs <pod> --previous`. This shows the error just before the crash (missing env var, DB connection error, etc.).
3. If OOMKilled: the container used more memory than its `limits.memory`. Check usage with `kubectl top pod`. Either raise the limit, or fix the memory leak. For Node, set `--max-old-space-size` below the container limit (e.g. about 75% of it), so V8 manages its heap inside the limit.
4. If it is the liveness probe: the app may be slow to start and gets killed before it is ready. Add a `startupProbe`, or increase `initialDelaySeconds` / `failureThreshold`.
5. Quick recovery: `kubectl rollout undo deployment/<name>` to go back to the last good version while you fix it.

---

### Q10. Explain a CI/CD pipeline you have built.
**🟢 In simple words:** CI/CD is a robot assembly line for code. Every time you push code, it automatically checks it (lint, tests, security scan), builds a Docker image, and ships it to staging and then production. If the new version is unhealthy, it rolls back automatically.
**🏠 Real-life example:** It is like a car factory line. Each car (code change) passes quality checks at each station. Only cars that pass all checks go to the showroom (production). A faulty car is pulled back before customers drive it.

Example answer: *"On a PR: lint → unit tests → build → security scan (npm audit/Trivy). On merge to main: build a Docker image tagged with the commit SHA → push it to the registry (ECR/GHCR) → deploy to staging → run integration/smoke tests → manual approval → production deploy with a rolling or blue-green strategy. DB migrations run as a separate step before the app rollout. Then monitoring + automatic rollback if health checks fail."*
Tools: GitHub Actions / GitLab CI / Jenkins; ArgoCD for GitOps.

**🔍 Internal working:**
1. A push or PR event triggers a webhook. The CI system (e.g. GitHub Actions) schedules jobs on **runners**. Runners are fresh VMs or containers. They check out the commit and run the steps.
2. Docker builds in CI use BuildKit with a **remote cache** (`--cache-from`/`--cache-to`, e.g. registry or GitHub Actions cache). This is needed because the runner starts empty. Tagging with the commit SHA makes each image immutable (never changes) and traceable. The pushed image gets a manifest **digest**. You can pin this digest for deploys.
3. Push to ECR/GHCR = upload the missing layer blobs, then PUT the manifest. The deploy step only changes the image reference (tag or digest) in the Deployment spec.
4. Push-based CD: the pipeline runs `kubectl`/`helm` with cluster credentials. **GitOps (ArgoCD)**: the pipeline commits the new image tag to a Git config repo. The ArgoCD controller inside the cluster keeps comparing Git (desired) with the live state and syncs them. This is another reconcile loop. The cluster needs no inbound CI credentials.
5. Automatic rollback works because a new rollout only moves forward when new pods pass readiness probes. Tools like Argo Rollouts can also check metrics (Prometheus) during the rollout. They abort if the error rate goes up. `kubectl rollout undo` scales the old ReplicaSet back up.
6. Migrations run first. They must be **backward-compatible** (expand/contract), because old and new pods run at the same time during a rolling update.

**🎤 Say this in the interview:** "CI runs on short-lived runners with a remote BuildKit cache. It produces an immutable image tagged with the SHA. CD just changes the image reference. With GitOps, ArgoCD reconciles the cluster to Git. Rollouts are gated by readiness probes and metrics. So a bad version is stopped and rolled back to the previous ReplicaSet."

**🧪 Real scenario:** The pipeline deployed the `latest` tag to production. Something broke, so you ran a rollback. But the "old" pods also have the bug. Also, nobody can say which commit is running in production right now. What went wrong?

**✅ Scenario answer:**
1. Root cause: the `latest` tag is mutable. It always points to the newest image. When pods restart or the rollback runs, they may pull the same new (broken) image again.
2. Confirm it: `kubectl get deploy <name> -o jsonpath='{.spec.template.spec.containers[0].image}'` shows `my-api:latest`. `kubectl describe pod` shows the actual image digest the pod is running.
3. Fix: tag every image with the git commit SHA (e.g. `my-api:3f2a9c1`), and deploy that tag (or the digest). Then a rollback really goes back to the old image.
4. Make the registry tags immutable (ECR has a "tag immutability" setting), so a tag can never be overwritten.
5. Prevent it: in GitOps, the image tag in the config repo shows exactly which commit runs. Add the SHA as a label or in a `/version` endpoint too.

---

### Q11. Deployment strategies.
**🟢 In simple words:** A deployment strategy is how you replace the old version of your app with the new one without hurting users. Rolling replaces copies a few at a time. Blue-green keeps two full copies and switches all traffic at once. Canary sends a small part of users to the new version first to test it safely.
**🏠 Real-life example:** Rolling is like changing the tyres of a bus one by one. Blue-green is having a second bus ready and moving all passengers at once. Canary is like a cook letting a few customers taste a new dish before adding it to the full menu.

- **Rolling** — replace pods step by step.
- **Blue-green** — two environments; switch traffic at once; easy rollback; costs double.
- **Canary** — send 5% of traffic to the new version, watch metrics, then increase.
- **Feature flags** — separate deploy from release.

**🔍 Internal working:**
1. **Rolling in Kubernetes:** changing the pod template creates a **new ReplicaSet** (named by a hash of the template). The Deployment controller scales the new RS up and the old RS down, step by step. Two settings limit this: `maxSurge` (extra pods allowed, default 25%) and `maxUnavailable` (default 25%).
2. It only continues when new pods become **Ready** (the readiness probe passes, plus `minReadySeconds`). If they never get ready, the rollout stops. After `progressDeadlineSeconds`, it is marked failed. Old ReplicaSets are kept (scaled to 0, see `revisionHistoryLimit`). So `rollout undo` just scales one back up.
3. When an old pod is terminated, two things happen at about the same time: it is removed from EndpointSlices, and it gets SIGTERM. So apps should keep serving for a few seconds (or use a `preStop` sleep). This avoids dropped requests.
4. **Blue-green:** two Deployments (blue/green) and one Service. To switch, you change the Service **selector** (or the ALB listener/target group). kube-proxy updates the iptables rules, and all new connections go to green at once.
5. **Canary:** traffic is split by weight. With an ALB, you use weighted target groups. With a service mesh or Ingress (NGINX canary annotations, Istio), you split by percentage or by header. Plain Kubernetes can only do it roughly, by the ratio of replicas. A controller (Argo Rollouts, Flagger) checks metrics at each step. It then promotes or aborts.
6. **Feature flags:** the code for both paths is deployed. An SDK checks the flag at runtime (often cached in memory and updated by streaming or polling). So a release is a config change, not a deploy.

```text
Deployment v2 rollout (replicas=4, maxSurge=1, maxUnavailable=0)
 RS-v1: 4 → 4 → 3 → 3 → 2 ... → 0
 RS-v2: 0 → 1 → 1 → 2 → 2 ... → 4   (each step waits for Ready)
```

**🎤 Say this in the interview:** "A rolling update is the Deployment controller moving replicas from the old ReplicaSet to a new one, within maxSurge and maxUnavailable, gated by readiness. Blue-green flips a Service selector or ALB target group at once. Canary uses weighted routing, with a controller watching metrics to promote or roll back."

**🧪 Real scenario:** You use a rolling update. During every deploy, the error rate goes up for about 30 seconds. Some requests fail with 502/503, and some new pods get traffic before they have connected to the database. How do you make deploys zero-downtime?

**✅ Scenario answer:**
1. Root cause (new pods): there is no readiness probe, or it only checks that the process is alive. So the pod gets traffic before the DB connection and warm-up are done.
2. Root cause (old pods): the pod gets SIGTERM at about the same time it is removed from the endpoints. If the app stops at once, requests still routed to it fail.
3. Confirm it: `kubectl rollout status deploy/<name>` and `kubectl get endpointslices` during a deploy. Check the ALB / Ingress logs for 502s at the time of the rollout.
4. Fix: add a real readiness probe (e.g. `/ready` that checks the DB), use `maxUnavailable: 0` and `maxSurge: 1`, add a `preStop` sleep and graceful shutdown in the app.
```yaml
lifecycle:
  preStop:
    exec: { command: ["sleep", "5"] }
```
5. Prevent it: for risky changes, use a canary (e.g. Argo Rollouts) that watches the error rate and rolls back automatically.

---

### Q12. Observability — logs, metrics, traces.
**🟢 In simple words:** Observability means you can see what is happening inside your running system. Logs are text notes about events. Metrics are numbers over time (requests per second, errors, speed). Traces follow one request as it travels through many services, so you can see where it got slow or failed.
**🏠 Real-life example:** It is like tracking a parcel at the post office. Logs are the notes each clerk writes. Metrics are the daily counts (parcels handled, parcels lost). A trace is the tracking number that shows every post office the parcel passed through and how long it stayed in each.

- **Logs:** structured JSON (pino), correlation/request IDs, stored in one central place (ELK, Loki, CloudWatch).
- **Metrics:** RED (Rate, Errors, Duration) / USE; Prometheus + Grafana; alerts on SLOs.
- **Traces:** OpenTelemetry → Jaeger/Tempo/Datadog, to follow a request across services.

**🔍 Internal working:**
1. **Logs:** the app writes JSON to stdout. The container runtime saves stdout to a file on the node (e.g. `/var/log/pods/...` in Kubernetes). A node agent (Fluent Bit, Promtail, CloudWatch agent) runs as a DaemonSet (one pod on every node). It reads those files, adds pod/namespace labels, and sends them to the backend.
2. **Metrics (pull model):** the app exposes `/metrics` in Prometheus text format (e.g. via `prom-client`). This has counters, gauges, and histograms with buckets. Prometheus discovers targets (Kubernetes service discovery). It **scrapes** them on an interval (e.g. 15s). It stores the time series in its TSDB. `rate()` and `histogram_quantile()` compute RED metrics at query time. Alertmanager handles alerts.
3. **Traces:** the OpenTelemetry SDK auto-instruments http/express/pg etc. Each operation is a **span** with a trace ID, span ID, parent ID and timing. In Node, the context is kept per request with **AsyncLocalStorage**.
4. **Context propagation:** on outgoing calls, OTel adds the W3C `traceparent` header (`00-<32-hex trace-id>-<16-hex parent span-id>-<flags>`). The next service reads it and creates child spans with the same trace ID. For queues, the context goes into message headers/attributes.
5. Spans are batched and exported via **OTLP** to a Collector. The Collector samples (head or tail sampling) and forwards them to Jaeger/Tempo/Datadog. Putting the trace ID into every log line links logs ↔ traces.

```text
client ─> API (span A) ──traceparent: 00-<traceId>-<spanA>-01──> orders (span B, parent A)
              │                                                   │
              └──── OTLP ───> OTel Collector ───> Tempo/Jaeger <──┘
Prometheus ──scrape GET /metrics every 15s──> each pod
```

**🎤 Say this in the interview:** "Logs go to stdout, and a node agent ships them. Prometheus pulls metrics by scraping /metrics on an interval. OpenTelemetry keeps the trace context in AsyncLocalStorage. It sends it on via the W3C traceparent header, so every service's spans share one trace ID. Spans are exported over OTLP through a Collector."

**🧪 Real scenario:** Users complain that "checkout is sometimes very slow". The CPU and memory graphs look normal, and the logs from 5 services are mixed together. How do you find the slow part?

**✅ Scenario answer:**
1. Look at metrics first: check the p95/p99 latency (not only the average) per endpoint in Grafana. Find when and on which route it is slow.
2. Open traces for slow checkout requests (filter by duration in Jaeger/Tempo/Datadog). The trace waterfall shows which span takes the most time, for example a slow DB query or a slow payment API call.
3. Use the trace ID to find the matching logs. This only works if every log line has the trace ID / request ID.
4. If traces break between services, check that the `traceparent` header is passed on (for HTTP and for queue messages).
5. Prevent it: add RED metrics and alerts on p99 latency per route (SLO alerts), and keep structured JSON logs with the trace ID.

---

### Q13. 12-Factor App principles (the most-asked ones).
**🟢 In simple words:** 12-Factor is a list of good rules for building apps that run well in the cloud. The main ideas: keep settings outside the code, don't store user data inside the app's memory, start fast and stop cleanly, and just print logs to the screen. Then you can run, copy and replace the app easily.
**🏠 Real-life example:** It is like a chain of fast-food shops. Every shop uses the same recipe (one image), but each shop gets its own address and supplier list (config). Any cook can be replaced at any time, because no cook keeps important things in their own pocket (stateless).

The main principles:
- Config in the environment.
- Stateless processes.
- Backing services as attached resources.
- Strict separation of build / release / run.
- Port binding.
- Disposability (fast start, graceful shutdown).
- Dev/prod parity (dev looks like prod).
- Logs as event streams.

**🔍 Internal working:**
1. **Config in env:** the same image runs in every environment. Kubernetes injects ConfigMap/Secret values as env vars into the container process when it starts (`process.env`). Changing them needs a pod restart, because env is read once at exec.
2. **Build/release/run:** build = the immutable image (digest). Release = image + config (e.g. a Deployment revision). Run = pods. Rollback = going back to an old release, not rebuilding.
3. **Stateless processes:** any pod can be killed or moved to another node. The Service load-balances to any replica. So sessions and files must live in Redis/DB/S3. Not in memory, and not in the container's writable layer.
4. **Disposability:** on shutdown, the kubelet sends SIGTERM and the pod is removed from endpoints. You have `terminationGracePeriodSeconds` to: stop accepting connections (`server.close()`), finish in-flight requests, close DB pools, then exit. Otherwise you get SIGKILL.
5. **Port binding:** the app itself listens on a port (`app.listen(PORT)`). The platform (Service, ALB) routes traffic to it. No app server is injected at runtime.
6. **Logs as streams:** write to stdout only. The platform's log agent collects and routes them (see Q12).

**🎤 Say this in the interview:** "12-factor maps directly to how containers work. One immutable image, with config injected as env at start. Stateless replicas behind a Service. Graceful handling of the kubelet's SIGTERM within the grace period. And logs to stdout, collected by the platform."

**🧪 Real scenario:** You scaled the API from 1 to 3 pods. Now users get logged out randomly, and files they upload sometimes "disappear". With 1 pod everything worked. What is wrong?

**✅ Scenario answer:**
1. Root cause: the app is not stateless. Sessions are stored in memory (e.g. the default `express-session` MemoryStore), and uploads are saved to the container's local disk.
2. Each request can go to a different pod. Pod B does not know the session from pod A, and it does not have the file that pod A saved. Files are also lost when a pod restarts.
3. Confirm it: check the session config in the code, and check where uploads are written. Send the same request a few times and see in the logs that different pods answer.
4. Fix: move sessions to Redis (ElastiCache) or use JWTs, and save uploads to S3 (for example with pre-signed URLs).
5. Don't use sticky sessions as the main fix. They hide the problem, and data is still lost when a pod dies.

---

### Q14. Common AWS services for a Node app.
**🟢 In simple words:** AWS gives ready-made building blocks so you don't build everything yourself. Some run your code (EC2, ECS, EKS, Lambda), some store data (RDS, S3, ElastiCache), some pass messages (SQS, SNS), and some handle traffic and security (ALB, IAM, Secrets Manager). You pick and connect the blocks you need.
**🏠 Real-life example:** It is like building a shopping mall from rented parts. You rent the shops (compute), the warehouse (storage), the mail room (queues), the security guards (IAM), and the front entrance that sends customers to the right shop (load balancer).

- Compute: EC2 / ECS / EKS / Lambda.
- SQL: RDS / Aurora.
- Redis: ElastiCache.
- Static assets and files: S3 + CloudFront.
- Messaging: SQS / SNS / EventBridge.
- Others: API Gateway, Secrets Manager, CloudWatch, IAM (least privilege), ALB.

**🔍 Internal working:**
1. **ALB:** a Layer-7 (HTTP-level) load balancer. Listeners (e.g. :443 with an ACM TLS certificate) have rules (host/path). The rules forward to **target groups**. Targets are instances or IPs. (In ECS/EKS with `awsvpc`/VPC CNI, the targets are pod/task IPs directly.) The ALB runs health checks per target. It only sends traffic to healthy targets. When a target is removed, the ALB waits the **deregistration delay** to drain connections.
2. **ECS/EKS deploys:** ECS registers new task IPs in the target group. It waits for them to be healthy before it stops the old tasks. On EKS, the AWS Load Balancer Controller watches Ingress/Service objects. It creates and updates ALBs and target groups.
3. **IAM:** a task or pod gets temporary credentials through an IAM role (ECS task role, EKS IRSA or Pod Identity). The AWS SDK gets them from the credential provider chain and refreshes them. So there are no static keys in the image.
4. **Lambda:** each invocation runs in a Firecracker micro-VM execution environment. A **cold start** = create the environment + load the code + run the init code outside the handler. Warm environments are reused. So DB connections created outside the handler are reused too. Use RDS Proxy to avoid connection storms (too many DB connections at once).
5. **SQS:** consumers long-poll (`ReceiveMessage` with `WaitTimeSeconds`). A received message becomes invisible for the **visibility timeout**. It must be deleted after success. Otherwise it appears again. This is at-least-once delivery → handlers must be idempotent (safe to run twice). After `maxReceiveCount` failures, the message goes to a DLQ (dead-letter queue).
6. **CloudFront** caches S3 objects at edge locations (servers close to users). It uses a cache key (path + selected headers/query). Origin Access Control lets only CloudFront read the private bucket.

```text
Route53 ─> ALB :443 (TLS via ACM) ─ rule /api/* ─> TG-api (health checks) ─> ECS tasks / EKS pods (IP targets)
                                  └ default    ─> TG-web
```

**🎤 Say this in the interview:** "Traffic comes through an ALB. Its listener rules route to target groups that health-check each task or pod IP. Compute gets short-lived credentials from an IAM role instead of keys. For async work, SQS gives at-least-once delivery with visibility timeouts and DLQs, so consumers must be idempotent."

**🧪 Real scenario:** Your SQS worker sends order-confirmation emails. Some customers get the same email 2 or 3 times. Processing one message can take up to 2 minutes, because it also creates a PDF invoice. Why are emails duplicated?

**✅ Scenario answer:**
1. Root cause: the visibility timeout (default 30s) is shorter than the processing time. The message becomes visible again before the worker deletes it, so another worker picks it up and sends the email again.
2. Confirm it: in CloudWatch, check the `ApproximateReceiveCount` attribute of messages and the job duration in your logs. You will see the same message ID processed more than once.
3. Fix: set the visibility timeout longer than the max processing time (e.g. 5 minutes), or extend it while working with `ChangeMessageVisibility`. Delete the message only after success.
4. Make the handler idempotent: save the message ID or order ID in a DB table with a unique key, and skip it if it was already processed. SQS is at-least-once, so duplicates can still happen.
5. Add a DLQ with `maxReceiveCount` and an alarm on it, so failing messages do not loop forever.
