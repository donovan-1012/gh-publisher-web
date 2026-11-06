/** 网页版发布器：把「本地网页」推到 GitHub Pages，纯前端。 */
import { GitHub, GHError, siteUrl, verifyUrl } from "./gh.js";
import { prepare, scanSecrets } from "./prep.js";

const STEPS = [
  "校验 GitHub 账号",
  "分析站点内容",
  "预处理（改写引用 / 补兜底文件）",
  "创建或复用仓库",
  "上传文件",
  "开启 GitHub Pages",
  "等待构建完成",
  "上线验收",
];

const $ = (sel) => document.querySelector(sel);
const state = {
  files: [],
  running: false,
  cancelled: false,
  result: null,
};

/* ---------------- 令牌 ---------------- */

function loadToken() {
  try {
    return localStorage.getItem("ghp_token") || "";
  } catch {
    return "";
  }
}

function saveToken(token, remember) {
  try {
    if (remember && token) localStorage.setItem("ghp_token", token);
    else localStorage.removeItem("ghp_token");
  } catch {
    /* 隐私模式下不可用，忽略 */
  }
}

/* ---------------- 日志 ---------------- */

function log(msg = "") {
  const el = $("#log");
  el.textContent += msg + "\n";
  el.scrollTop = el.scrollHeight;
}

function clearLog() {
  $("#log").textContent = "";
}

function setStep(index, status) {
  document.querySelectorAll(".step").forEach((el, i) => {
    if (i !== index) return;
    el.dataset.state = status;
    el.querySelector(".mark").textContent = { running: "◐", done: "✓", error: "✗" }[status] || "○";
  });
}

function resetSteps() {
  document.querySelectorAll(".step").forEach((el) => {
    el.dataset.state = "";
    el.querySelector(".mark").textContent = "○";
  });
}

function setStatus(text, kind = "") {
  const el = $("#status");
  el.textContent = text;
  el.dataset.kind = kind;
}

/* ---------------- 文件收集 ---------------- */

async function readEntry(entry, prefix = "", out = []) {
  if (!entry) return out;
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ path: prefix + entry.name, file, size: file.size });
    return out;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const child of batch) await readEntry(child, prefix + entry.name + "/", out);
    } while (batch.length);
  }
  return out;
}

function humanSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

function renderPicked() {
  const total = state.files.reduce((n, f) => n + f.size, 0);
  const box = $("#picked");
  if (!state.files.length) {
    box.textContent = "";
    $("#publish").disabled = true;
    return;
  }
  const root = state.files[0].path.split("/")[0];
  box.textContent = `已选择：${state.files.length} 个文件 · ${humanSize(total)}` + (root && state.files[0].path.includes("/") ? ` · 目录 ${root}/` : "");
  $("#publish").disabled = state.running;
  if (!$("#repo").value.trim()) {
    const base = state.files[0].path.includes("/") ? root : state.files[0].path.replace(/\.[^.]+$/, "");
    $("#repo").value = slug(base);
  }
}

function takeFiles(list) {
  state.files = list;
  renderPicked();
  if (state.files.length) setStatus("点「开始发布」即可", "ready");
}

/* ---------------- 小工具 ---------------- */

function slug(name) {
  const s = (name || "")
    .replace(/[^0-9A-Za-z._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 60);
  if (!s || !/[0-9A-Za-z]/.test(s)) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `site-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }
  return s;
}

/* ---------------- 发布流程 ---------------- */

async function publish() {
  if (state.running) {
    state.cancelled = true;
    log("⏹ 正在取消…");
    return;
  }
  const token = $("#token").value.trim();
  if (!token) {
    setStatus("先把 GitHub 令牌填进来", "error");
    $("#token").focus();
    return;
  }
  if (!state.files.length) {
    setStatus("先选择网页文件或文件夹", "error");
    return;
  }

  state.running = true;
  state.cancelled = false;
  state.result = null;
  const btn = $("#publish");
  btn.textContent = "取消发布";
  btn.className = "danger";
  btn.disabled = false;
  $("#result").hidden = true;
  clearLog();
  resetSteps();
  setStatus("正在发布…");

  const gh = new GitHub(token);
  const shouldStop = () => state.cancelled;
  const guard = () => {
    if (state.cancelled) throw new GHError("已取消发布");
  };

  try {
    /* 1 账号 */
    setStep(0, "running");
    const [login, plan] = await gh.checkToken();
    log(`账号：${login}（${plan} 套餐）`);
    const isPrivate = $("#private").checked;
    if (isPrivate && plan === "free") {
      throw new Error("GitHub 免费账号只能从公开仓库发布 Pages。取消勾选「私有仓库」再试。");
    }
    setStep(0, "done");
    guard();

    /* 2 分析 */
    setStep(1, "running");
    const singleFile = state.files.length === 1 && /\.html?$/i.test(state.files[0].path);
    log(singleFile ? "  单页模式" : `  文件数：${state.files.length}`);
    setStep(1, "done");
    guard();

    /* 3 预处理 */
    setStep(2, "running");
    const prepared = await prepare(state.files, { singleFile, onLog: log });
    prepared.warnings.forEach((w) => log("  ⚠ " + w));
    log(`  待上传文件：${prepared.files.length} 个`);
    prepared.changes.forEach((c) => log("  · " + c));

    const hits = scanSecrets(prepared.textFiles);
    if (hits.length) {
      log(`  ⚠ 发现 ${hits.length} 处疑似密钥：`);
      hits.slice(0, 8).forEach((h) => log(`  · [${h.level}] ${h.path}:${h.line} ${h.kind} ${h.preview}`));
      if (!$("#allow-secrets").checked) {
        throw new Error(
          "内容里有疑似密钥/令牌，GitHub 会在推送时直接拒绝（GH013 密钥扫描）。\n" +
            "把密钥删掉或改成占位符再发；确认是示例文本可勾选「忽略密钥检查」。"
        );
      }
      log("  已选择忽略密钥检查，继续");
    } else {
      log("  密钥自检通过");
    }
    setStep(2, "done");
    guard();

    /* 4 仓库 */
    setStep(3, "running");
    const repoName = slug($("#repo").value.trim() || "site");
    let existing = await gh.repo(login, repoName);
    if (existing) {
      const empty = await gh.isRepoEmpty(login, repoName);
      if (empty) log(`  ${login}/${repoName} 是空仓库，直接复用`);
      else if ($("#overwrite").checked) log(`  复用已有仓库 ${login}/${repoName}（内容将被覆盖）`);
      else throw new Error(`仓库 ${login}/${repoName} 已存在且有内容。勾选「覆盖同名仓库」，或换个名字。`);
    } else {
      await gh.createRepo(repoName, { privateRepo: isPrivate, description: `${prepared.root || "site"} · 网页发布器` });
      log(`  已创建仓库 ${login}/${repoName}`);
    }
    setStep(3, "done");
    guard();

    /* 5 上传 */
    setStep(4, "running");
    await gh.commitTree(login, repoName, prepared.files, `Publish from web @ ${new Date().toLocaleString()}`, {
      shouldStop,
      onProgress: (done, total, path) => {
        if (done === 1 || done === total || done % 5 === 0) log(`  上传 ${done}/${total}：${path}`);
      },
    });
    log("  上传完成");
    setStep(4, "done");
    guard();

    /* 6 Pages */
    setStep(5, "running");
    await gh.enablePages(login, repoName);
    log("  Pages 已开启：分支 main / 根目录");
    setStep(5, "done");
    guard();

    /* 7 构建 */
    setStep(6, "running");
    await gh.waitBuild(login, repoName, { shouldStop, onTick: (s) => log("  构建状态：" + s) });
    setStep(6, "done");
    guard();

    /* 8 验收 */
    setStep(7, "running");
    const url = siteUrl(login, repoName);
    const [ok, note] = await verifyUrl(url);
    log("  " + note);
    setStep(7, "done");

    state.result = { url, repo: `${login}/${repoName}` };
    $("#url").textContent = url;
    $("#url").href = url;
    $("#result").hidden = false;
    setStatus("发布成功 🎉", "ok");
    log("");
    log("✅ " + url);
    saveToken(token, $("#remember").checked);
  } catch (err) {
    const msg = String(err.message || err);
    const cancelled = state.cancelled || /已取消/.test(msg);
    document.querySelectorAll(".step").forEach((el) => {
      if (el.dataset.state === "running") el.dataset.state = "error", (el.querySelector(".mark").textContent = "✗");
    });
    log("");
    log((cancelled ? "⏹ " : "❌ ") + msg);
    setStatus(cancelled ? "已取消" : "发布失败", cancelled ? "" : "error");
  } finally {
    state.running = false;
    btn.textContent = "开始发布";
    btn.className = "primary";
    btn.disabled = !state.files.length;
  }
}

/* ---------------- 事件绑定 ---------------- */

function init() {
  $("#token").value = loadToken();
  $("#remember").checked = !!loadToken();

  $("#publish").addEventListener("click", publish);

  $("#verify").addEventListener("click", async () => {
    const token = $("#token").value.trim();
    if (!token) return setStatus("先填令牌", "error");
    setStatus("正在验证…");
    try {
      const [login, plan] = await new GitHub(token).checkToken();
      setStatus(`已连接：${login}（${plan}）`, "ok");
      saveToken(token, $("#remember").checked);
    } catch (e) {
      setStatus(String(e.message || e), "error");
    }
  });

  $("#token").addEventListener("change", () => saveToken($("#token").value.trim(), $("#remember").checked));
  $("#remember").addEventListener("change", () => saveToken($("#token").value.trim(), $("#remember").checked));

  $("#pick-folder").addEventListener("click", () => $("#folder-input").click());
  $("#folder-input").addEventListener("change", (e) => {
    takeFiles(
      [...e.target.files].map((f) => ({
        path: f.webkitRelativePath || f.name,
        file: f,
        size: f.size,
      }))
    );
  });

  $("#pick-files").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", (e) => {
    takeFiles([...e.target.files].map((f) => ({ path: f.name, file: f, size: f.size })));
  });

  const drop = $("#drop");
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("over");
    })
  );
  drop.addEventListener("drop", async (e) => {
    const items = [...(e.dataTransfer.items || [])];
    const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    if (entries.length) {
      const collected = [];
      for (const entry of entries) await readEntry(entry, "", collected);
      if (collected.length) return takeFiles(collected);
    }
    const files = [...(e.dataTransfer.files || [])].map((f) => ({ path: f.name, file: f, size: f.size }));
    if (files.length) takeFiles(files);
  });
  drop.addEventListener("click", () => $("#pick-folder").click());

  $("#copy").addEventListener("click", async () => {
    if (!state.result) return;
    try {
      await navigator.clipboard.writeText(state.result.url);
      setStatus("链接已复制", "ok");
    } catch {
      setStatus("复制失败，手动选中上面的链接吧", "error");
    }
  });

  $("#clear").addEventListener("click", () => {
    state.files = [];
    $("#folder-input").value = "";
    $("#file-input").value = "";
    $("#repo").value = "";
    renderPicked();
    setStatus("已清除选择");
    resetSteps();
    $("#result").hidden = true;
  });

  document.title = "网页发布器 · ready";
}

document.addEventListener("DOMContentLoaded", init);
export { publish, init };
