// Builds index.html (a browser viewer) from README.md, progress.md and qa/*.md
// Usage: node build.js   → then open index.html in your browser
const fs = require('fs');
const path = require('path');

const root = __dirname;
const qaDir = path.join(root, 'qa');
const pages = [
  { id: 'readme', title: 'Overview', file: 'README.md' },
  { id: 'progress', title: 'Progress Tracker', file: 'progress.md' },
  ...fs.readdirSync(qaDir).filter(f => f.endsWith('.md')).sort().map(f => ({
    id: f.replace('.md', ''),
    title: f.replace('.md', '').replace(/^\d+-/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      .replace('Javascript', 'JavaScript').replace('Nodejs', 'Node.js').replace('Sql', 'SQL').replace('Dsa', 'DSA').replace('Devops', 'DevOps'),
    num: f.slice(0, 2),
    file: path.join('qa', f),
  })),
].map(p => ({ ...p, md: fs.readFileSync(path.join(root, p.file), 'utf8') }));

const data = JSON.stringify(pages).replace(/</g, '\\u003c');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Interview Prep Kit</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link id="hl-light" rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
<link id="hl-dark" rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css" disabled>
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<style>
:root{
  --bg:#f7f8fa; --panel:#ffffff; --text:#1f2430; --muted:#667085; --border:#e4e7ec;
  --accent:#4f46e5; --accent-soft:#eef2ff; --code-bg:#f3f4f6; --q-bg:#ffffff; --shadow:0 1px 3px rgba(16,24,40,.06),0 1px 2px rgba(16,24,40,.04);
}
:root[data-theme="dark"]{
  --bg:#0f1117; --panel:#161a23; --text:#e6e8ee; --muted:#98a2b3; --border:#2a3040;
  --accent:#8b8cf8; --accent-soft:#1e2140; --code-bg:#0d1117; --q-bg:#161a23; --shadow:none;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,sans-serif;font-size:16px;line-height:1.65}
.layout{display:flex;min-height:100vh}
aside{width:270px;flex-shrink:0;background:var(--panel);border-right:1px solid var(--border);position:sticky;top:0;height:100vh;overflow-y:auto;padding:22px 14px}
.brand{font-weight:700;font-size:17px;padding:0 10px 4px}
.sub{font-size:12.5px;color:var(--muted);padding:0 10px 16px;border-bottom:1px solid var(--border);margin-bottom:12px}
.countdown{display:inline-block;margin-top:6px;background:var(--accent-soft);color:var(--accent);font-weight:600;padding:2px 8px;border-radius:999px}
nav a{display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;color:var(--text);text-decoration:none;font-size:14.5px;margin-bottom:2px}
nav a:hover{background:var(--bg)}
nav a.active{background:var(--accent-soft);color:var(--accent);font-weight:600}
nav .num{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--muted);width:20px}
nav a.active .num{color:var(--accent)}
nav .group{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);padding:14px 10px 6px}
.controls{border-top:1px solid var(--border);margin-top:14px;padding:14px 10px 0;display:flex;flex-direction:column;gap:8px}
button.btn{font:inherit;font-size:13.5px;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--panel);color:var(--text);cursor:pointer;text-align:left}
button.btn:hover{border-color:var(--accent)}
button.btn.on{background:var(--accent);border-color:var(--accent);color:#fff}
main{flex:1;min-width:0;padding:36px 48px 80px}
.content{max-width:860px;margin:0 auto}
.search{width:100%;max-width:860px;margin:0 auto 22px;display:block;padding:10px 14px;border:1px solid var(--border);border-radius:10px;background:var(--panel);color:var(--text);font:inherit}
h1{font-size:30px;line-height:1.25;margin:0 0 18px}
h2{font-size:22px;margin:40px 0 14px;padding-bottom:6px;border-bottom:1px solid var(--border)}
h3{font-size:17.5px;margin:0}
a{color:var(--accent)}
code{font-family:'JetBrains Mono',monospace;font-size:.88em;background:var(--code-bg);padding:2px 6px;border-radius:5px}
pre{background:var(--code-bg);border:1px solid var(--border);border-radius:10px;padding:0;overflow-x:auto}
pre code{display:block;padding:16px 18px;background:transparent;font-size:13.5px;line-height:1.6}
pre code.hljs{background:transparent}
table{border-collapse:collapse;width:100%;margin:16px 0;font-size:14.5px;display:block;overflow-x:auto}
th,td{border:1px solid var(--border);padding:8px 12px;text-align:left;vertical-align:top}
th{background:var(--bg);font-weight:600}
blockquote{margin:16px 0;padding:10px 16px;border-left:4px solid var(--accent);background:var(--accent-soft);border-radius:0 8px 8px 0}
blockquote p{margin:4px 0}
hr{display:none}
details.qa{background:var(--q-bg);border:1px solid var(--border);border-radius:12px;margin:14px 0;box-shadow:var(--shadow)}
details.qa>summary{cursor:pointer;padding:14px 18px;list-style:none;display:flex;gap:10px;align-items:flex-start}
details.qa>summary::-webkit-details-marker{display:none}
details.qa>summary::before{content:'▸';color:var(--accent);transition:transform .15s;margin-top:1px}
details.qa[open]>summary::before{transform:rotate(90deg)}
details.qa>summary:hover h3{color:var(--accent)}
details.qa .body{padding:0 20px 14px 38px;border-top:1px dashed var(--border)}
.internal{margin:18px 0 6px;padding:4px 18px 10px;border-radius:10px;background:var(--int-bg);border-left:4px solid var(--int)}
.internal>p:first-child strong{color:var(--int)}
.internal pre{background:var(--panel)}
.internal p.say{margin-top:12px;padding:10px 14px;border-radius:8px;background:var(--panel);border:1px dashed var(--int)}
.simple{margin:16px 0;padding:10px 18px;border-radius:10px;background:var(--sim-bg);border-left:4px solid var(--sim)}
.simple p{margin:6px 0}
.simple strong{color:var(--sim)}
.scenario{margin:16px 0 6px;padding:6px 18px 10px;border-radius:10px;background:var(--sc-bg);border-left:4px solid var(--sc)}
.scenario>p:first-child{font-weight:500}
.scenario strong{color:var(--sc)}
.scenario pre{background:var(--panel)}
:root{--sc:#7c3aed;--sc-bg:#f5f3ff}
:root[data-theme="dark"]{--sc:#c4b5fd;--sc-bg:#1e1636}
:root{--sim:#15803d;--sim-bg:#f0fdf4}
:root[data-theme="dark"]{--sim:#4ade80;--sim-bg:#0c2618}
:root{--int:#0e7490;--int-bg:#ecfeff}
:root[data-theme="dark"]{--int:#22d3ee;--int-bg:#0b2530}
.hidden{display:none!important}
.menu-btn{display:none}
@media (max-width:860px){
  .layout{display:block}
  aside{position:fixed;z-index:10;left:0;transform:translateX(-100%);transition:transform .2s;box-shadow:0 0 30px rgba(0,0,0,.25)}
  aside.open{transform:none}
  main{padding:64px 16px 60px}
  .menu-btn{display:block;position:fixed;top:12px;left:12px;z-index:11}
  details.qa .body{padding:0 14px 12px 14px}
}
</style>
</head>
<body>
<button class="btn menu-btn" onclick="document.querySelector('aside').classList.toggle('open')">☰ Menu</button>
<div class="layout">
  <aside>
    <div class="brand">🎯 Interview Prep Kit</div>
    <div class="sub">Senior Full-Stack · Node + React<br><span class="countdown" id="countdown"></span></div>
    <nav id="nav"></nav>
    <div class="controls">
      <button class="btn" id="quizBtn" title="Hide all answers so you can test yourself">🧠 Quiz mode: OFF</button>
      <button class="btn" id="expandBtn">↕ Expand all</button>
      <button class="btn" id="themeBtn">🌙 Dark mode</button>
    </div>
  </aside>
  <main>
    <input class="search" id="search" placeholder="Search questions on this page…  (press / to focus)">
    <article class="content" id="content"></article>
  </main>
</div>
<script>
const PAGES = ${data};
const $ = s => document.querySelector(s);
const store = { get(k){ try{return localStorage.getItem(k)}catch(e){return null} }, set(k,v){ try{localStorage.setItem(k,v)}catch(e){} } };

// countdown to 15 Dec
(() => {
  const days = Math.ceil((new Date('2026-12-15T23:59:59') - new Date()) / 864e5);
  $('#countdown').textContent = days > 0 ? days + ' days to 15 Dec' : 'Target date reached';
})();

// nav
const nav = $('#nav');
nav.innerHTML = PAGES.map((p, i) =>
  (i === 2 ? '<div class="group">Q&amp;A Bank</div>' : '') +
  \`<a href="#\${p.id}" data-id="\${p.id}"><span class="num">\${p.num || (p.id==='readme'?'🏠':'📈')}</span>\${p.title}</a>\`
).join('');

let quiz = store.get('quiz') === '1';
let allOpen = false;

function render() {
  const id = location.hash.slice(1) || 'readme';
  const page = PAGES.find(p => p.id === id) || PAGES[0];
  document.title = page.title + ' · Interview Prep';
  nav.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.id === page.id));

  const el = $('#content');
  el.innerHTML = marked.parse(page.md);

  // links between md files → hash routes
  el.querySelectorAll('a[href]').forEach(a => {
    const m = a.getAttribute('href').match(/([\\w-]+)\\.md$/i);
    if (m) { const t = PAGES.find(p => p.file.replace(/\\\\/g,'/').endsWith(m[1] + '.md') || p.id === m[1].toLowerCase()); if (t) a.href = '#' + t.id; }
  });

  // wrap each ### question + its answer into a collapsible card
  [...el.querySelectorAll('h3')].forEach(h3 => {
    const d = document.createElement('details'); d.className = 'qa';
    const s = document.createElement('summary'); const body = document.createElement('div'); body.className = 'body';
    h3.before(d); s.appendChild(h3); d.append(s, body);
    while (d.nextSibling && !/^(H1|H2|H3)$/.test(d.nextSibling.nodeName) && !(d.nextSibling.nodeName === 'DETAILS')) {
      const n = d.nextSibling;
      if (n.nodeName === 'HR') { n.remove(); break; }
      body.appendChild(n);
    }
    d.open = !quiz;
  });
  // green "🟢 In simple words" box (+ following "🏠 Real-life example" paragraph)
  [...el.querySelectorAll('p')].filter(p => p.textContent.trim().startsWith('🟢')).forEach(p => {
    const box = document.createElement('div'); box.className = 'simple';
    p.before(box); box.appendChild(p);
    const n = box.nextSibling && box.nextSibling.nodeType === 3 ? box.nextSibling.nextSibling : box.nextSibling;
    if (n && n.nodeName === 'P' && n.textContent.trim().startsWith('🏠')) box.appendChild(n);
  });
  // highlight "🔍 Internal working" ... "🎤 Say this" blocks
  [...el.querySelectorAll('p')].filter(p => p.textContent.trim().startsWith('🔍 Internal working')).forEach(p => {
    const box = document.createElement('div'); box.className = 'internal';
    p.before(box); box.appendChild(p);
    while (box.nextSibling && !/^(H1|H2|H3|DETAILS|HR)$/.test(box.nextSibling.nodeName)) {
      const n = box.nextSibling; box.appendChild(n);
      if (n.nodeName === 'P' && n.textContent.trim().startsWith('🎤')) { n.classList.add('say'); break; }
    }
  });
  // purple "🧪 Real scenario" box (scenario + "✅ Scenario answer" and its list/code)
  [...el.querySelectorAll('p')].filter(p => p.textContent.trim().startsWith('🧪')).forEach(p => {
    const box = document.createElement('div'); box.className = 'scenario';
    p.before(box); box.appendChild(p);
    while (box.nextSibling && !/^(H1|H2|H3|DETAILS|HR)$/.test(box.nextSibling.nodeName) &&
           !(box.nextSibling.nodeName === 'P' && /^(🧪|🔍|🟢)/.test(box.nextSibling.textContent.trim()))) {
      box.appendChild(box.nextSibling);
    }
  });
  allOpen = !quiz;
  syncButtons();
  el.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
  $('#search').value = '';
  window.scrollTo(0, 0);
  document.querySelector('aside').classList.remove('open');
}

function syncButtons() {
  $('#quizBtn').textContent = '🧠 Quiz mode: ' + (quiz ? 'ON' : 'OFF');
  $('#quizBtn').classList.toggle('on', quiz);
  $('#expandBtn').textContent = allOpen ? '↕ Collapse all' : '↕ Expand all';
}

$('#quizBtn').onclick = () => { quiz = !quiz; store.set('quiz', quiz ? '1' : '0'); render(); };
$('#expandBtn').onclick = () => { allOpen = !allOpen; document.querySelectorAll('details.qa').forEach(d => d.open = allOpen); syncButtons(); };

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#hl-dark').disabled = t !== 'dark'; $('#hl-light').disabled = t === 'dark';
  $('#themeBtn').textContent = t === 'dark' ? '☀️ Light mode' : '🌙 Dark mode';
}
applyTheme(store.get('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('#themeBtn').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; store.set('theme', t); applyTheme(t); };

$('#search').oninput = e => {
  const q = e.target.value.toLowerCase().trim();
  document.querySelectorAll('details.qa').forEach(d => {
    const hit = !q || d.textContent.toLowerCase().includes(q);
    d.classList.toggle('hidden', !hit);
    if (q && hit) d.open = true;
  });
};
document.addEventListener('keydown', e => { if (e.key === '/' && document.activeElement !== $('#search')) { e.preventDefault(); $('#search').focus(); } });

window.addEventListener('hashchange', render);
render();
</script>
</body>
</html>`;

fs.writeFileSync(path.join(root, 'index.html'), html);
console.log('✔ Built index.html with ' + PAGES_COUNT() + ' pages');
function PAGES_COUNT() { return pages.length; }
