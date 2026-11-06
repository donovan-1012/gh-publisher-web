/**
 * GitHub API 客户端（浏览器版）。
 * 只用 fetch + Git Data API，不依赖 git 二进制，所以能纯静态跑在 GitHub Pages 上。
 */

const API = "https://api.github.com";

export class GHError extends Error {
  constructor(message, status = 0, detail = "") {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function friendly(status, payload) {
  const low = (payload || "").toLowerCase();
  if (status === 401) return "令牌无效或已过期，请重新填入。";
  if (status === 403 && low.includes("rate limit")) return "触发了 GitHub 接口限流，等几分钟再试。";
  if (status === 403) return "没有权限：令牌缺少 Contents / Administration / Pages 的读写权限。";
  if (status === 404) return "找不到目标仓库，或令牌没有该仓库的访问权限。";
  if (status === 409) return "仓库还是空的（Git Repository is empty）。";
  if (status === 422 && low.includes("already_exists")) return "同名仓库已存在。";
  if (status === 422) return "GitHub 拒绝了这次请求（422）：" + (payload || "").slice(0, 120);
  if (status >= 500) return "GitHub 服务端临时故障，稍后重试。";
  return `GitHub 返回 ${status}。`;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export class GitHub {
  constructor(token) {
    this.token = (token || "").trim();
  }

  async req(method, path, body) {
    const res = await fetch(path.startsWith("http") ? path : API + path, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${this.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status >= 400) {
      let payload = "";
      try {
        const data = await res.json();
        payload = (data.message || "") + " " + (data.errors ? JSON.stringify(data.errors) : "");
      } catch {
        payload = await res.text().catch(() => "");
      }
      throw new GHError(friendly(res.status, payload), res.status, payload.trim());
    }
    if (res.status === 204) return {};
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  async user() {
    return this.req("GET", "/user");
  }

  /** 返回 [login, plan] 或抛错 */
  async checkToken() {
    const data = await this.user();
    if (!data.login) throw new GHError("令牌缺少读取用户信息的权限（Metadata: read）。");
    return [data.login, ((data.plan || {}).name || "free").toLowerCase()];
  }

  async repo(owner, name) {
    try {
      return await this.req("GET", `/repos/${owner}/${name}`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  /** 判空以「有没有分支」为准：被拒绝的推送也会改写 pushed_at */
  async isRepoEmpty(owner, name) {
    try {
      const branches = await this.req("GET", `/repos/${owner}/${name}/branches?per_page=1`);
      return !branches.length;
    } catch (e) {
      if (e.status === 409 || e.status === 404) return true;
      throw e;
    }
  }

  async createRepo(name, { privateRepo = false, description = "" } = {}) {
    return this.req("POST", "/user/repos", {
      name,
      private: !!privateRepo,
      description: description.slice(0, 350),
      // 必须 auto_init：空仓库上 Git Data API（git/blobs、git/trees…）全部返回 409
      auto_init: true,
      has_issues: true,
      has_wiki: false,
    });
  }

  async blob(owner, name, bytes) {
    return this.req("POST", `/repos/${owner}/${name}/git/blobs`, {
      content: bytesToBase64(bytes),
      encoding: "base64",
    });
  }

  /**
   * 空仓库上用 Contents API 写第一个提交（Git Data API 在空仓库上不可用）。
   * 有了这一个提交之后，后面的整树提交就能正常工作。
   */
  async seedFirstCommit(owner, name, path, bytes) {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return this.req("PUT", `/repos/${owner}/${name}/contents/${encoded}`, {
      message: "Initial commit",
      content: bytesToBase64(bytes),
    });
  }

  /**
   * 一次性提交整棵文件树（等价于桌面版的 force push）。
   * 不传 base_tree 表示「用这份内容完整替换」，所以不存在残留旧文件。
   */
  async commitTree(owner, name, files, message, { onProgress, shouldStop } = {}) {
    if (!files.length) throw new GHError("没有要上传的文件。");

    // 1) 空仓库先用 Contents API 落地第一个文件，否则 git/* 全是 409
    let parentSha = null;
    try {
      const ref = await this.req("GET", `/repos/${owner}/${name}/git/ref/heads/main`);
      parentSha = ref.object && ref.object.sha;
    } catch (e) {
      if (e.status !== 404 && e.status !== 409) throw e;
    }
    if (!parentSha) {
      const seed = files.find((f) => f.path === "index.html") || files[0];
      await this.seedFirstCommit(owner, name, seed.path, seed.bytes);
      const ref = await this.req("GET", `/repos/${owner}/${name}/git/ref/heads/main`);
      parentSha = ref.object && ref.object.sha;
    }

    // 2) 逐个上传 blob（并发 5）
    const entries = [];
    let done = 0;
    const queue = files.slice();
    const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
      while (queue.length) {
        if (shouldStop && shouldStop()) throw new GHError("已取消发布");
        const item = queue.shift();
        const { sha } = await this.blob(owner, name, item.bytes);
        entries.push({ path: item.path, mode: "100644", type: "blob", sha });
        done += 1;
        if (onProgress) onProgress(done, files.length, item.path);
      }
    });
    await Promise.all(workers);

    // 3) 建树 → 提交 → 移动分支
    const tree = await this.req("POST", `/repos/${owner}/${name}/git/trees`, { tree: entries });
    const commit = await this.req("POST", `/repos/${owner}/${name}/git/commits`, {
      message,
      tree: tree.sha,
      parents: parentSha ? [parentSha] : [],
    });

    if (parentSha) {
      await this.req("PATCH", `/repos/${owner}/${name}/git/refs/heads/main`, {
        sha: commit.sha,
        force: true,
      });
    } else {
      await this.req("POST", `/repos/${owner}/${name}/git/refs`, {
        ref: "refs/heads/main",
        sha: commit.sha,
      });
    }
    return commit;
  }

  async enablePages(owner, name) {
    const body = { source: { branch: "main", path: "/" } };
    try {
      return await this.req("POST", `/repos/${owner}/${name}/pages`, body);
    } catch (e) {
      if (e.status === 409 || (e.status === 422 && /already/i.test(e.detail || e.message))) {
        return this.req("PUT", `/repos/${owner}/${name}/pages`, body);
      }
      throw e;
    }
  }

  async latestBuild(owner, name) {
    try {
      return await this.req("GET", `/repos/${owner}/${name}/pages/builds/latest`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async waitBuild(owner, name, { timeoutMs = 240000, onTick, shouldStop } = {}) {
    const started = Date.now();
    let last = "";
    while (Date.now() - started < timeoutMs) {
      if (shouldStop && shouldStop()) throw new GHError("已取消发布");
      const build = await this.latestBuild(owner, name);
      const status = (build && build.status) || "";
      if (status && status !== last) {
        if (onTick) onTick(status);
        last = status;
      }
      if (status === "built") return build;
      if (status === "errored") {
        const msg = (build.error && build.error.message) || "未知原因";
        throw new GHError("GitHub Pages 构建失败：" + msg);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (onTick) onTick("还在排队（通常马上就好）");
    return this.latestBuild(owner, name);
  }
}

export function siteUrl(owner, repo) {
  const o = owner.toLowerCase();
  if (repo.toLowerCase() === `${o}.github.io`) return `https://${o}.github.io/`;
  return `https://${o}.github.io/${repo}/`;
}

export async function verifyUrl(url, { tries = 4 } = {}) {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.status === 200) return [true, "已上线并验证可访问：" + url];
      last = "HTTP " + res.status;
    } catch (e) {
      last = String(e).slice(0, 80);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return [false, `地址已生成，但首次访问还没生效（${last}）。等 1 分钟刷新看看。`];
}
