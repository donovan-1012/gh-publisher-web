/**
 * 预处理：把「本地网页」变成「能直接推上 GitHub Pages 的内容」。
 * 规则与桌面版一致，纯浏览器实现（无 git、无后端）。
 */

export const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", ".venv", "venv", "env", "__pycache__",
  ".idea", ".vscode", ".next", ".nuxt", ".cache", ".pytest_cache", ".mypy_cache",
  "dist-info", ".sass-cache", "bower_components",
]);
export const SKIP_FILES = new Set(["thumbs.db", "desktop.ini", ".ds_store", "ehthumbs.db"]);
export const KEEP_DOT = new Set([".nojekyll", ".gitignore", ".gitattributes", ".htaccess", ".well-known", ".htpasswd"]);
export const ENTRY_NAMES = ["index.html", "index.htm", "default.html"];
export const OUTPUT_DIRS = ["dist", "build", "out", "public", "site", "docs", "www", "_site", "html"];
export const MAX_FILE_BYTES = 95 * 1024 * 1024;
const TEXT_EXT = new Set([".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".json", ".svg", ".xml", ".txt", ".md"]);

const ATTR_RE = /\b(?:src|href|action|poster)\s*=\s*(["'])([^"']*)\1/gi;
const SRCSET_RE = /\bsrcset\s*=\s*(["'])([^"']*)\1/gi;
const CSS_URL_RE = /url\(\s*(["']?)([^'")]+)\1\s*\)/gi;
const JS_PATH_RE = /(["'])(\/(?:[\w\-.@%]+\/)*[\w\-.@%]+\.(?:js|mjs|css|json|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|mp4|webm|glb|wasm))\1/gi;

const SKIP_PREFIX = ["#", "data:", "mailto:", "tel:", "javascript:", "http://", "https://", "//", "blob:", "about:", "file:"];

const ext = (p) => {
  const m = /\.[^./]+$/.exec(p);
  return m ? m[0].toLowerCase() : "";
};
const dirOf = (p) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};
const joinPath = (dir, name) => {
  const parts = (dir ? dir + "/" + name : name).split("/");
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
};
const relFrom = (fromDir, target) => {
  if (!fromDir) return target;
  const a = fromDir.split("/").filter(Boolean);
  const b = target.split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = a.length - i;
  return [...Array(up).fill(".."), ...b.slice(i)].join("/") || ".";
};
const depthOf = (dir) => (dir ? dir.split("/").filter(Boolean).length : 0);

function shouldSkipPath(path) {
  const parts = path.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    const low = parts[i].toLowerCase();
    if (SKIP_DIRS.has(low)) return true;
    if (parts[i].startsWith(".") && !KEEP_DOT.has(low)) return true;
  }
  const name = parts[parts.length - 1].toLowerCase();
  if (SKIP_FILES.has(name)) return true;
  if (name.startsWith(".") && !KEEP_DOT.has(name)) return true;
  return false;
}

/** 输入 [{path, file}]，输出去掉公共顶层目录后的列表 */
export function normalize(inputs) {
  const clean = inputs
    .map((it) => ({ ...it, path: it.path.replace(/\\/g, "/").replace(/^\/+/, "") }))
    .filter((it) => it.path);
  if (!clean.length) return { list: [], root: "" };

  const firsts = new Set(clean.map((it) => it.path.split("/")[0]));
  let root = "";
  const allNested = clean.every((it) => it.path.includes("/"));
  if (allNested && firsts.size === 1) root = [...firsts][0];

  const list = clean.map((it) => ({
    ...it,
    path: root ? it.path.slice(root.length + 1) : it.path,
  }));
  return { list, root };
}

/** 判断站点根 / 入口 / 是否单页 */
export function pickSite(list, { singleFile = false } = {}) {
  const notes = [];
  if (singleFile) {
    const entry = list[0];
    return { entry: entry.path, singleFile: true, notes, candidates: [] };
  }

  const at = (p) => list.find((it) => it.path === p);
  for (const name of ENTRY_NAMES) {
    if (at(name)) return { entry: name, singleFile: false, notes, candidates: [] };
  }
  for (const dir of OUTPUT_DIRS) {
    for (const name of ENTRY_NAMES) {
      if (at(`${dir}/${name}`)) {
        notes.push(`站点根在 ${dir}/ 下（构建产物目录）`);
        return { entry: `${dir}/${name}`, singleFile: false, rootPrefix: dir, notes, candidates: [] };
      }
    }
  }
  const hits = list
    .filter((it) => ENTRY_NAMES.includes(it.path.split("/").pop().toLowerCase()))
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  if (hits.length) {
    const entry = hits[0].path;
    if (hits.length > 1) notes.push(`发现多个 index.html，先用 ${entry}`);
    return { entry, singleFile: false, rootPrefix: dirOf(entry), notes, candidates: hits.slice(0, 8).map((h) => h.path) };
  }
  return { entry: null, singleFile: false, notes, candidates: [] };
}

function decodeText(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

class Index {
  constructor(paths) {
    this.files = new Set(paths);
    this.dirs = new Set([""]);
    this.lower = new Map();
    for (const p of paths) {
      this.lower.set(p.toLowerCase(), p);
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
    }
    for (const d of this.dirs) this.lower.set(d.toLowerCase(), d);
  }
  resolve(fromDir, ref) {
    const norm = joinPath(fromDir, ref);
    if (norm === "" || norm === ".") return { target: "", isDir: true };
    if (this.files.has(norm)) return { target: norm, isDir: false };
    if (this.dirs.has(norm)) return { target: norm, isDir: true };
    const real = this.lower.get(norm.toLowerCase());
    if (!real) return null;
    return { target: real, isDir: this.dirs.has(real) };
  }
}

function splitRef(val) {
  const i = val.search(/[?#]/);
  return i < 0 ? [val, ""] : [val.slice(0, i), val.slice(i)];
}

function rewriteOne(val, fromDir, index) {
  if (!val || SKIP_PREFIX.some((p) => val.startsWith(p)) || val.includes("{{") || val.includes("${")) return null;
  let stripped = val.startsWith("./") ? val.slice(2) : val;
  const [base0, suffix] = splitRef(stripped);
  if (!base0) return null;

  const encoded = base0.includes("%");
  let probe = base0;
  if (encoded) {
    try {
      probe = decodeURIComponent(base0);
    } catch {
      probe = base0;
    }
  }
  if (probe === "/") {
    const depth = depthOf(fromDir);
    return [depth === 0 ? "./" : "../".repeat(depth), "根相对路径"];
  }

  const isRootRef = probe.startsWith("/");
  const wantedRaw = isRootRef ? probe.slice(1) : probe;
  const hadSlash = wantedRaw.endsWith("/");
  const wanted = wantedRaw.replace(/\/+$/, "");
  if (!wanted || wanted === ".") return null;

  const found = index.resolve(isRootRef ? "" : fromDir, wanted);
  if (!found) return null;

  const caseMismatch = found.target !== wanted && found.target.toLowerCase() === wanted.toLowerCase();
  if (!isRootRef && !caseMismatch) return null;

  let next = relFrom(fromDir, found.target);
  if (found.isDir && (hadSlash || caseMismatch) && !next.endsWith("/")) next += "/";
  if (encoded) next = next.split("/").map(encodeURIComponent).join("/");
  const out = next + suffix;
  if (out === val) return null;
  return [out, isRootRef ? "根相对路径" : "大小写不一致"];
}

function rewriteText(text, relPath, index, refs) {
  const fromDir = dirOf(relPath);
  const e = ext(relPath);
  let out = text;

  const apply = (re, group = 2, pre = 1) => {
    out = out.replace(re, (m, ...args) => {
      const val = args[group - 1];
      const hit = rewriteOne(val, fromDir, index);
      if (!hit) return m;
      refs.count += 1;
      if (refs.samples.length < 8) refs.samples.push(`${relPath}: ${val} → ${hit[0]}（${hit[1]}）`);
      const q = args[0];
      const before = args[pre - 1] || "";
      return `${before}${q}${hit[0]}${q}`;
    });
  };

  if (e === ".html" || e === ".htm") {
    apply(ATTR_RE, 2, 1);
    out = out.replace(SRCSET_RE, (m, q, val) => {
      let touched = false;
      const next = val.split(",").map((part) => {
        const bits = part.trim().split(/\s+/);
        if (!bits[0]) return part;
        const hit = rewriteOne(bits[0], fromDir, index);
        if (hit) {
          bits[0] = hit[0];
          touched = true;
          refs.count += 1;
        }
        return bits.join(" ");
      });
      return touched ? `srcset=${q}${next.join(", ")}${q}` : m;
    });
  }
  if (e === ".css" || e === ".html" || e === ".htm") {
    out = out.replace(CSS_URL_RE, (m, q, val) => {
      const hit = rewriteOne(val, fromDir, index);
      if (!hit) return m;
      refs.count += 1;
      return `url(${q}${hit[0]}${q})`;
    });
  }
  if ([".js", ".mjs", ".cjs", ".json", ".html", ".htm"].includes(e)) {
    out = out.replace(JS_PATH_RE, (m, q, val) => {
      const hit = rewriteOne(val, fromDir, index);
      if (!hit) return m;
      refs.count += 1;
      return `${q}${hit[0]}${q}`;
    });
  }
  return out;
}

/** 顺引用收集资源（单页模式用） */
async function collectReferenced(entryItem, allByName, picked) {
  const queue = [entryItem];
  const seen = new Set([entryItem.path]);
  while (queue.length) {
    const item = queue.shift();
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    const text = decodeText(bytes);
    if (!text) continue;
    const e = ext(item.path);
    const fromDir = dirOf(item.path);
    const refs = [];
    const push = (v) => v && refs.push(v);
    if (e === ".html" || e === ".htm") {
      text.replace(ATTR_RE, (m, q, v) => (push(v), m));
      text.replace(SRCSET_RE, (m, q, v) => (v.split(",").forEach((p) => push(p.trim().split(/\s+/)[0])), m));
    }
    if ([".css", ".html", ".htm"].includes(e)) text.replace(CSS_URL_RE, (m, q, v) => (push(v), m));
    if ([".js", ".mjs", ".cjs", ".json", ".html", ".htm"].includes(e)) text.replace(JS_PATH_RE, (m, q, v) => (push(v), m));

    for (const ref of refs) {
      if (!ref || SKIP_PREFIX.some((p) => ref.startsWith(p))) continue;
      const [base0] = splitRef(ref);
      let probe = base0;
      try {
        probe = decodeURIComponent(base0);
      } catch {}
      const target = joinPath(probe.startsWith("/") ? "" : fromDir, probe.replace(/^\/+/, ""));
      const hit = allByName.get(target) || allByName.get(target.toLowerCase());
      if (!hit || seen.has(hit.path)) continue;
      seen.add(hit.path);
      picked.push(hit);
      if ([".css", ".html", ".htm"].includes(ext(hit.path))) queue.push(hit);
    }
  }
}

export const SECRET_PATTERNS = [
  ["OpenAI / DeepSeek 密钥", /\bsk-[A-Za-z0-9]{20,}\b/, "high"],
  ["GitHub 令牌", /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/, "high"],
  ["AWS Access Key", /\bAKIA[0-9A-Z]{16}\b/, "high"],
  ["Google API Key", /\bAIza[0-9A-Za-z_-]{35}\b/, "high"],
  ["Stripe 密钥", /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}\b/, "high"],
  ["Slack 令牌", /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, "high"],
  ["私钥文件", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, "high"],
  ["阿里云 AccessKey", /\bLTAI[0-9A-Za-z]{12,}\b/, "high"],
  ["JWT 令牌", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, "high"],
  ["疑似密钥赋值", /\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']([A-Za-z0-9_\-.]{20,})["']/i, "medium"],
];

const mask = (v) => (v.length <= 8 ? v.slice(0, 2) + "***" : `${v.slice(0, 4)}…${v.slice(-2)}(长度 ${v.length})`);

export function scanSecrets(textFiles) {
  const hits = [];
  for (const { path, text } of textFiles) {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line || line.length > 4000) return;
      for (const [kind, re, level] of SECRET_PATTERNS) {
        const m = line.match(re);
        if (m) {
          hits.push({ path, line: i + 1, kind, level, preview: mask(m[1] || m[0]) });
          return;
        }
      }
    });
  }
  return hits;
}

/**
 * 主入口：把选中的文件变成「待上传内容」。
 * inputs: [{path, file}]
 */
export async function prepare(inputs, { singleFile = false, onLog = () => {} } = {}) {
  const { list, root } = normalize(inputs);
  const changes = [];
  const warnings = [];

  const plan = pickSite(list, { singleFile });
  plan.notes.forEach((n) => onLog("  " + n));
  if (!plan.entry) throw new Error("没找到 index.html，无法确定首页（拖单个 html 文件也可以）。");

  const baseDir = plan.rootPrefix || "";
  const inScope = (p) => !baseDir || p === baseDir || p.startsWith(baseDir + "/");
  const rel = (p) => (baseDir ? p.slice(baseDir.length + 1) : p);

  const pool = list.filter((it) => inScope(it.path) && !shouldSkipPath(rel(it.path)));
  const byName = new Map();
  for (const it of list) byName.set(rel(it.path), it);

  let picked;
  if (plan.singleFile) {
    const entryItem = list[0];
    picked = [entryItem];
    await collectReferenced(entryItem, byName, picked);
    onLog(`  单页模式：只发布 ${entryItem.path} 及其引用的本地文件`);
  } else {
    picked = pool;
    onLog(`  文件夹模式：发布 ${baseDir ? baseDir + "/" : "根目录"} 下的 ${picked.length} 个文件`);
  }

  const keep = picked.filter((it) => {
    const p = rel(it.path);
    return !shouldSkipPath(p);
  });

  const oversized = keep.filter((it) => it.size > MAX_FILE_BYTES);
  if (oversized.length) {
    const detail = oversized.slice(0, 5).map((it) => `  · ${rel(it.path)}（${(it.size / 1048576).toFixed(0)} MB）`).join("\n");
    throw new Error(`有文件超过 GitHub 的 100MB 单文件硬上限，推送必然失败：\n${detail}\n请把它们移出发布目录后再试。`);
  }

  const paths = keep.map((it) => rel(it.path));
  const index = new Index(paths);

  const stage = [];
  const textFiles = [];
  const nonUtf8 = [];

  for (const item of keep) {
    const p = rel(item.path);
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    if (TEXT_EXT.has(ext(p)) && !bytes.subarray(0, 4096).includes(0)) {
      const text = decodeText(bytes);
      if (text === null) {
        nonUtf8.push(p);
        stage.push({ path: p, bytes });
        continue;
      }
      const refs = { count: 0, samples: [] };
      const next = rewriteText(text, p, index, refs);
      textFiles.push({ path: p, text: next });
      if (next !== text) {
        stage.push({ path: p, bytes: new TextEncoder().encode(next) });
      } else {
        stage.push({ path: p, bytes });
      }
    } else {
      stage.push({ path: p, bytes });
    }
  }

  const refTotal = textFiles.reduce((n, t) => n + (textFiles.some((x) => x.path === t.path) ? 0 : 0), 0);
  const touched = stage.filter((s) => {
    const src = keep.find((k) => rel(k.path) === s.path);
    return src && src.size !== s.bytes.length;
  }).length;
  if (touched) changes.push(`修正了 ${touched} 个文件的引用/编码`);
  if (nonUtf8.length) warnings.push(`有 ${nonUtf8.length} 个文件不是 UTF-8，未做引用修正：${nonUtf8.slice(0, 3).join("、")}`);

  if (!stage.some((s) => s.path === "index.html")) {
    const entry = stage.find((s) => s.path === rel(plan.entry)) || stage[0];
    stage.push({ path: "index.html", bytes: entry.bytes });
    changes.push("把入口文件重命名为 index.html");
  }

  if (!stage.some((s) => s.path === ".nojekyll")) {
    stage.push({ path: ".nojekyll", bytes: new Uint8Array(0) });
    changes.push("补 .nojekyll");
  }

  const idx = stage.find((s) => s.path === "index.html");
  if (idx && !stage.some((s) => s.path === "404.html")) {
    const html = new TextDecoder("utf-8", { fatal: false }).decode(idx.bytes);
    const spa = html.length < 24000 && /id=["'](?:root|app)["']|__NEXT_DATA__|\/assets\/index-/.test(html);
    if (spa) {
      stage.push({ path: "404.html", bytes: idx.bytes });
      changes.push("补 404.html（子路由刷新不白屏）");
    }
  }

  return { files: stage, changes, warnings, plan, textFiles, root };
}
