import { createHash, randomUUID } from "node:crypto";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";

const hiddenDirectories = new Set([".git", ".codex-system", ".fnos-build", ".pnpm-store", ".venv", "coverage", "dist", "node_modules", "target", "vendor-cache"]);
const indexableExtensions = new Set([
  "", ".c", ".cc", ".conf", ".cpp", ".cs", ".css", ".csv", ".go", ".h", ".hpp", ".htm", ".html",
  ".ini", ".java", ".js", ".json", ".jsonl", ".jsx", ".kt", ".kts", ".log", ".lua", ".md", ".markdown",
  ".mjs", ".php", ".properties", ".ps1", ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".svelte", ".swift",
  ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml",
]);
const versionedExtensions = new Set([
  ".css", ".csv", ".htm", ".html", ".js", ".json", ".jsonl", ".jsx", ".md", ".markdown", ".mjs",
  ".ps1", ".py", ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml",
]);
const maxIndexedFileBytes = 1024 * 1024;
const maxVersionBytes = 1_500_000;
const maxVisitedEntries = 30_000;
const maxIndexedFiles = 12_000;
const maxIndexedBytes = 256 * 1024 * 1024;

function now() {
  return Math.floor(Date.now() / 1000);
}

function relativePath(root, target) {
  return relative(root, target).split(sep).join("/");
}

function isInside(root, target) {
  const rest = relative(root, target);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

function projectRoot(project) {
  return realpathSync(project.path);
}

function normalizedDirectory(project, value = "") {
  const root = projectRoot(project);
  const requested = String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const target = realpathSync(resolve(root, requested || "."));
  if (!isInside(root, target)) throw Object.assign(new Error("知识库目录超出项目范围"), { status: 403 });
  if (!statSync(target).isDirectory()) throw Object.assign(new Error("知识库目标不是目录"), { status: 400 });
  return { root, target, directory: relativePath(root, target) };
}

function contentHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sensitiveFile(path) {
  const name = basename(path).toLowerCase();
  return name === ".env"
    || name.startsWith(".env.")
    || /(?:^|[-_.])(credential|credentials|secret|secrets)(?:[-_.]|$)/i.test(name)
    || /\.(?:key|pem|p12|pfx|jks|keystore)$/i.test(name)
    || /^(?:id_rsa|id_ed25519|known_hosts|authorized_keys)$/i.test(name);
}

function supportedFile(path, size) {
  if (size <= 0 || size > maxIndexedFileBytes || sensitiveFile(path)) return false;
  const extension = extname(path).toLowerCase();
  if (extension) return indexableExtensions.has(extension);
  return /^(?:dockerfile|makefile|readme|license|changelog)$/i.test(basename(path));
}

function textBuffer(buffer) {
  if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) return null;
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function chunkText(content) {
  const lines = content.split("\n");
  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let characters = 0;
    while (end < lines.length && end - start < 100) {
      characters += lines[end].length + 1;
      end += 1;
      if (characters >= 3_600) break;
    }
    const value = lines.slice(start, end).join("\n").trim();
    if (value) chunks.push({ content: value, startLine: start + 1, endLine: end });
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - 4);
  }
  return chunks;
}

function searchTerms(value) {
  const text = String(value || "").normalize("NFKC").toLowerCase();
  const terms = new Set();
  for (const match of text.matchAll(/[a-z0-9_][a-z0-9_.-]{1,48}/g)) {
    terms.add(match[0]);
    for (const part of match[0].split(/[._-]+/)) if (part.length > 1) terms.add(part);
  }
  for (const match of text.matchAll(/[\p{Script=Han}]{1,80}/gu)) {
    const word = match[0];
    if (word.length === 1) terms.add(word);
    for (let index = 0; index < word.length - 1; index += 1) terms.add(word.slice(index, index + 2));
    for (let index = 0; index < word.length - 2; index += 1) terms.add(word.slice(index, index + 3));
  }
  return [...terms].slice(0, 320);
}

function searchText(path, content) {
  return searchTerms(`${path}\n${content}`).join(" ");
}

function ftsQuery(value) {
  const terms = searchTerms(value).slice(0, 28);
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function plainSnippet(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 420);
}

export function searchKnowledgeDatabase(db, projectId, query, requestedLimit = 8) {
  const value = String(query || "").trim();
  if (!value) throw Object.assign(new Error("请输入知识库搜索内容"), { status: 400 });
  const match = ftsQuery(value);
  if (!match) return [];
  const limit = Math.min(20, Math.max(1, Number(requestedLimit) || 8));
  const candidates = db.prepare(`
    SELECT chunk.path, chunk.start_line, chunk.end_line, chunk.content, chunk.search_text,
      bm25(knowledge_chunks_fts, 4.0, 1.0, 0.45) AS rank
    FROM knowledge_chunks_fts
    JOIN knowledge_chunks chunk ON chunk.id = knowledge_chunks_fts.rowid
    WHERE knowledge_chunks_fts MATCH ? AND chunk.project_id = ?
    ORDER BY rank
    LIMIT ?
  `).all(match, projectId, Math.max(limit * 6, 36));
  const querySet = new Set(searchTerms(value));
  return candidates.map((row) => {
    const candidateSet = new Set(String(row.search_text || "").split(" ").filter(Boolean));
    let overlap = 0;
    for (const term of querySet) if (candidateSet.has(term)) overlap += 1;
    const coverage = querySet.size ? overlap / querySet.size : 0;
    const phrase = String(row.content).toLowerCase().includes(value.toLowerCase()) ? 0.28 : 0;
    const rankScore = 1 / (1 + Math.abs(Number(row.rank) || 0));
    return {
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      snippet: plainSnippet(row.content),
      score: Number(Math.min(1, coverage * 0.62 + rankScore * 0.28 + phrase).toFixed(4)),
      citation: `${row.path}:${row.start_line}-${row.end_line}`,
    };
  }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path, "zh-CN")).slice(0, limit);
}

function publicStatus(row) {
  return {
    directory: row.directory || "",
    enabled: Boolean(row.enabled),
    state: row.enabled ? row.state : "disabled",
    lastIndexedAt: row.last_indexed_at,
    lastScanAt: row.last_scan_at,
    fileCount: row.file_count,
    chunkCount: row.chunk_count,
    bytesIndexed: row.bytes_indexed,
    error: row.error,
  };
}

export class KnowledgeService {
  constructor({ db, workspace, onChanged = () => {} }) {
    this.db = db;
    this.workspace = workspace;
    this.onChanged = onChanged;
    this.inflight = new Map();
    this.timers = new Map();
    this.projects = new Map();
    this.interval = null;
  }

  ensureProject(project) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO project_knowledge (project_id, directory, enabled, state, updated_at)
      VALUES (?, '', 1, 'idle', ?)
      ON CONFLICT(project_id) DO NOTHING
    `).run(project.id, timestamp);
    return this.status(project);
  }

  status(project) {
    let row = this.db.prepare("SELECT * FROM project_knowledge WHERE project_id = ?").get(project.id);
    if (!row) {
      const timestamp = now();
      this.db.prepare("INSERT INTO project_knowledge (project_id, directory, enabled, state, updated_at) VALUES (?, '', 1, 'idle', ?)").run(project.id, timestamp);
      row = this.db.prepare("SELECT * FROM project_knowledge WHERE project_id = ?").get(project.id);
    }
    return publicStatus(row);
  }

  start(projects) {
    for (const project of projects) {
      this.projects.set(project.id, project);
      this.ensureProject(project);
      this.schedule(project, 500);
    }
    this.interval = setInterval(() => {
      for (const project of this.projects.values()) this.schedule(project, 0);
    }, 90_000);
    this.interval.unref?.();
  }

  syncProjects(projects) {
    for (const project of projects) {
      this.projects.set(project.id, project);
      this.ensureProject(project);
      this.schedule(project, 250);
    }
  }

  close() {
    if (this.interval) clearInterval(this.interval);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  schedule(project, delay = 350) {
    clearTimeout(this.timers.get(project.id));
    const timer = setTimeout(() => {
      this.timers.delete(project.id);
      void this.refresh(project).catch(() => {});
    }, delay);
    timer.unref?.();
    this.timers.set(project.id, timer);
  }

  async configure(project, input) {
    const current = this.status(project);
    const selected = normalizedDirectory(project, Object.hasOwn(input, "directory") ? input.directory : current.directory);
    const enabled = Object.hasOwn(input, "enabled") ? Boolean(input.enabled) : current.enabled;
    const changedDirectory = selected.directory !== current.directory;
    if (changedDirectory) this.#clearProjectIndex(project.id);
    this.db.prepare(`
      UPDATE project_knowledge SET directory = ?, enabled = ?, state = ?, error = NULL, updated_at = ?
      WHERE project_id = ?
    `).run(selected.directory, enabled ? 1 : 0, enabled ? "idle" : "disabled", now(), project.id);
    if (enabled) await this.refresh(project, { force: changedDirectory });
    this.#notify(project);
    return this.status(project);
  }

  refresh(project, options = {}) {
    if (this.inflight.has(project.id)) return this.inflight.get(project.id);
    const running = this.#refresh(project, options).finally(() => this.inflight.delete(project.id));
    this.inflight.set(project.id, running);
    return running;
  }

  async #refresh(project, { force = false } = {}) {
    const status = this.status(project);
    if (!status.enabled) return status;
    const { root, target } = normalizedDirectory(project, status.directory);
    this.db.prepare("UPDATE project_knowledge SET state = 'indexing', error = NULL, last_scan_at = ?, updated_at = ? WHERE project_id = ?")
      .run(now(), now(), project.id);
    this.#notify(project);
    try {
      const known = new Map(this.db.prepare("SELECT * FROM knowledge_files WHERE project_id = ?").all(project.id).map((row) => [row.path, row]));
      const seen = new Set();
      const pending = [target];
      const visitedDirectories = new Set();
      let visitedEntries = 0;
      let indexedFiles = 0;
      let indexedBytes = 0;
      while (pending.length && visitedEntries < maxVisitedEntries && indexedFiles < maxIndexedFiles && indexedBytes < maxIndexedBytes) {
        const directory = pending.shift();
        let resolvedDirectory;
        let entries;
        try {
          resolvedDirectory = realpathSync(directory);
          if (!isInside(target, resolvedDirectory) || !isInside(root, resolvedDirectory) || visitedDirectories.has(resolvedDirectory)) continue;
          visitedDirectories.add(resolvedDirectory);
          entries = readdirSync(resolvedDirectory, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (visitedEntries >= maxVisitedEntries || indexedFiles >= maxIndexedFiles || indexedBytes >= maxIndexedBytes) break;
          visitedEntries += 1;
          if (entry.isDirectory() && hiddenDirectories.has(entry.name)) continue;
          try {
            const resolvedTarget = realpathSync(resolve(resolvedDirectory, entry.name));
            if (!isInside(target, resolvedTarget) || !isInside(root, resolvedTarget)) continue;
            const stats = statSync(resolvedTarget);
            if (stats.isDirectory()) {
              pending.push(resolvedTarget);
              continue;
            }
            if (!stats.isFile()) continue;
            const path = relativePath(root, resolvedTarget);
            if (!supportedFile(path, stats.size) || indexedBytes + stats.size > maxIndexedBytes) continue;
            seen.add(path);
            indexedFiles += 1;
            indexedBytes += stats.size;
            const existing = known.get(path);
            const mtimeMs = Math.floor(stats.mtimeMs);
            if (!force && existing && Number(existing.size) === stats.size && Number(existing.mtime_ms) === mtimeMs) continue;
            const buffer = readFileSync(resolvedTarget);
            const content = textBuffer(buffer);
            if (content === null) {
              seen.delete(path);
              continue;
            }
            const hash = contentHash(content);
            if (!force && existing?.content_hash === hash) {
              this.db.prepare("UPDATE knowledge_files SET size = ?, mtime_ms = ?, indexed_at = ? WHERE project_id = ? AND path = ?")
                .run(stats.size, mtimeMs, now(), project.id, path);
              continue;
            }
            this.#replaceFile(project.id, path, stats.size, mtimeMs, hash, content);
            this.captureVersion(project, path, content, "index");
          } catch {
            // Files can move or become unavailable while a NAS share is scanned.
          }
          if (visitedEntries % 80 === 0) await new Promise((resolveYield) => setImmediate(resolveYield));
        }
      }
      for (const path of known.keys()) if (!seen.has(path)) this.#deleteIndexedFile(project.id, path);
      const totals = this.db.prepare(`
        SELECT COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS bytes_indexed,
          (SELECT COUNT(*) FROM knowledge_chunks WHERE project_id = ?) AS chunk_count
        FROM knowledge_files WHERE project_id = ?
      `).get(project.id, project.id);
      const timestamp = now();
      this.db.prepare(`
        UPDATE project_knowledge SET state = 'ready', last_indexed_at = ?, last_scan_at = ?,
          file_count = ?, chunk_count = ?, bytes_indexed = ?, error = NULL, updated_at = ?
        WHERE project_id = ?
      `).run(timestamp, timestamp, totals.file_count, totals.chunk_count, totals.bytes_indexed, timestamp, project.id);
      this.#notify(project);
      return this.status(project);
    } catch (error) {
      this.db.prepare("UPDATE project_knowledge SET state = 'error', error = ?, updated_at = ? WHERE project_id = ?")
        .run(String(error?.message || error).slice(0, 1000), now(), project.id);
      this.#notify(project);
      throw error;
    }
  }

  async search(project, query, limit = 8) {
    const status = this.status(project);
    if (status.enabled && !status.lastIndexedAt) await this.refresh(project);
    return { status: this.status(project), data: searchKnowledgeDatabase(this.db, project.id, query, limit) };
  }

  observeFile(project, path, content) {
    return this.captureVersion(project, path, content, "observed");
  }

  captureVersion(project, path, content, source = "observed") {
    const value = String(content ?? "");
    if (!versionedExtensions.has(extname(path).toLowerCase()) || Buffer.byteLength(value) > maxVersionBytes) return null;
    const hash = contentHash(value);
    const latest = this.db.prepare("SELECT content_hash FROM file_versions WHERE project_id = ? AND path = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(project.id, path);
    if (latest?.content_hash === hash) return null;
    const id = randomUUID();
    this.db.prepare("INSERT INTO file_versions (id, project_id, path, content_hash, content, source, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, project.id, path, hash, value, source, Buffer.byteLength(value), now());
    this.db.prepare(`
      DELETE FROM file_versions WHERE id IN (
        SELECT id FROM file_versions WHERE project_id = ? AND path = ?
        ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 40
      )
    `).run(project.id, path);
    return id;
  }

  versions(project, path) {
    const file = this.workspace.read(project, path);
    if (file.kind !== "text") throw Object.assign(new Error("只有文本文件支持版本历史"), { status: 415 });
    this.observeFile(project, file.path, file.content);
    return this.db.prepare(`
      SELECT id, path, source, bytes, created_at AS createdAt
      FROM file_versions WHERE project_id = ? AND path = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 40
    `).all(project.id, file.path);
  }

  version(project, path, versionId) {
    const file = this.workspace.read(project, path);
    if (file.kind !== "text") throw Object.assign(new Error("只有文本文件支持版本历史"), { status: 415 });
    const row = this.db.prepare(`
      SELECT id, path, source, bytes, created_at AS createdAt, content
      FROM file_versions WHERE id = ? AND project_id = ? AND path = ?
    `).get(String(versionId || ""), project.id, file.path);
    if (!row) throw Object.assign(new Error("文件版本不存在"), { status: 404 });
    return row;
  }

  saveFile(project, path, content) {
    const before = this.workspace.read(project, path);
    if (before.kind !== "text") throw Object.assign(new Error("只有文本文件支持画布编辑"), { status: 415 });
    this.observeFile(project, before.path, before.content);
    const saved = this.workspace.write(project, before.path, content);
    this.captureVersion(project, saved.path, saved.content, "canvas");
    this.schedule(project, 100);
    return saved;
  }

  rollback(project, path, versionId) {
    const selected = this.version(project, path, versionId);
    const before = this.workspace.read(project, path);
    this.observeFile(project, before.path, before.content);
    const saved = this.workspace.write(project, before.path, selected.content);
    this.captureVersion(project, saved.path, saved.content, "rollback");
    this.schedule(project, 100);
    return { file: saved, restoredVersionId: selected.id };
  }

  removeProject(projectId) {
    this.projects.delete(projectId);
    clearTimeout(this.timers.get(projectId));
    this.timers.delete(projectId);
    this.#clearProjectIndex(projectId);
    this.db.prepare("DELETE FROM file_versions WHERE project_id = ?").run(projectId);
    this.db.prepare("DELETE FROM project_knowledge WHERE project_id = ?").run(projectId);
  }

  #replaceFile(projectId, path, size, mtimeMs, hash, content) {
    const chunks = chunkText(content);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.#deleteChunkRows(projectId, path);
      const insertChunk = this.db.prepare(`
        INSERT INTO knowledge_chunks (project_id, path, chunk_index, start_line, end_line, content, search_text, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFts = this.db.prepare("INSERT INTO knowledge_chunks_fts (rowid, path, content, search_text) VALUES (?, ?, ?, ?)");
      chunks.forEach((chunk, index) => {
        const terms = searchText(path, chunk.content);
        const result = insertChunk.run(projectId, path, index, chunk.startLine, chunk.endLine, chunk.content, terms, contentHash(chunk.content));
        insertFts.run(result.lastInsertRowid, path, chunk.content, terms);
      });
      this.db.prepare(`
        INSERT INTO knowledge_files (project_id, path, size, mtime_ms, content_hash, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, path) DO UPDATE SET
          size = excluded.size, mtime_ms = excluded.mtime_ms,
          content_hash = excluded.content_hash, indexed_at = excluded.indexed_at
      `).run(projectId, path, size, mtimeMs, hash, now());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #deleteChunkRows(projectId, path) {
    const rows = this.db.prepare("SELECT id FROM knowledge_chunks WHERE project_id = ? AND path = ?").all(projectId, path);
    const removeFts = this.db.prepare("DELETE FROM knowledge_chunks_fts WHERE rowid = ?");
    for (const row of rows) removeFts.run(row.id);
    this.db.prepare("DELETE FROM knowledge_chunks WHERE project_id = ? AND path = ?").run(projectId, path);
  }

  #deleteIndexedFile(projectId, path) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.#deleteChunkRows(projectId, path);
      this.db.prepare("DELETE FROM knowledge_files WHERE project_id = ? AND path = ?").run(projectId, path);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #clearProjectIndex(projectId) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare("SELECT id FROM knowledge_chunks WHERE project_id = ?").all(projectId);
      const removeFts = this.db.prepare("DELETE FROM knowledge_chunks_fts WHERE rowid = ?");
      for (const row of rows) removeFts.run(row.id);
      this.db.prepare("DELETE FROM knowledge_chunks WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM knowledge_files WHERE project_id = ?").run(projectId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #notify(project) {
    this.onChanged({ projectId: project.id, status: this.status(project) });
  }
}

export { chunkText, searchTerms };
