import { Check, Eye, EyeOff, FolderUp, Gauge, PawPrint, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { PetStatus, PetSummary } from "../types";
import { Modal } from "./Modal";

type Props = {
  open: boolean;
  status: PetStatus;
  onClose: () => void;
  onChanged: (status: PetStatus) => void;
};

type LocalPetPackage = {
  fallbackId: string;
  manifest: Record<string, unknown>;
  spritesheet: File;
};

function filePath(file: File) {
  return String(file.webkitRelativePath || file.name).replaceAll("\\", "/").replace(/^\.\//, "");
}

function parentPath(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function leaf(path: string) {
  return path.split("/").filter(Boolean).at(-1) || "pet";
}

function safeChildPath(value: unknown) {
  const normalized = String(value || "spritesheet.webp").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || normalized.split("/").includes("..")) return null;
  return normalized;
}

async function localPackages(fileList: FileList | null) {
  const files = Array.from(fileList || []);
  const byPath = new Map(files.map((file) => [filePath(file), file]));
  const manifests = files.filter((file) => ["pet.json", "avatar.json"].includes(leaf(filePath(file)).toLowerCase()));
  const packages: LocalPetPackage[] = [];
  for (const manifestFile of manifests) {
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(await manifestFile.text()) as Record<string, unknown>; }
    catch { throw new Error(`${filePath(manifestFile)} 不是有效 JSON`); }
    const directory = parentPath(filePath(manifestFile));
    const relativeSprite = safeChildPath(manifest.spritesheetPath);
    if (!relativeSprite) throw new Error(`${filePath(manifestFile)} 的 spritesheetPath 不安全`);
    const expected = [directory, relativeSprite].filter(Boolean).join("/");
    const spritesheet = byPath.get(expected)
      || files.find((file) => leaf(filePath(file)).toLowerCase() === leaf(relativeSprite).toLowerCase() && parentPath(filePath(file)) === directory);
    if (!spritesheet) throw new Error(`${filePath(manifestFile)} 缺少 ${relativeSprite}`);
    if (spritesheet.type && spritesheet.type !== "image/webp") throw new Error(`${filePath(spritesheet)} 不是 WebP 图片`);
    if (spritesheet.size > 8 * 1024 * 1024) throw new Error(`${filePath(spritesheet)} 超过 8 MB`);
    packages.push({ fallbackId: leaf(directory), manifest, spritesheet });
  }
  if (packages.length === 0) throw new Error("没有找到 pet.json 或 avatar.json；请选择 .codex/pets 文件夹或一个完整宠物目录");
  return packages;
}

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error(`读取 ${file.name} 失败`));
    reader.readAsDataURL(file);
  });
}

function sizeLabel(bytes: number) {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function PetPreview({ pet }: { pet: PetSummary }) {
  const width = 72;
  const height = 78;
  return <div
    className="pet-preview-sprite"
    role="img"
    aria-label={`${pet.displayName} 空闲动作预览`}
    style={{
      width,
      height,
      backgroundImage: `url(/api/pets/${encodeURIComponent(pet.id)}/spritesheet)` ,
      backgroundSize: `${width * 8}px ${height * (pet.spriteVersionNumber === 2 ? 11 : 9)}px`,
      backgroundPosition: "0 0",
    }}
  />;
}

export function PetCenterDialog({ open, status: initialStatus, onClose, onChanged }: Props) {
  const [status, setStatus] = useState(initialStatus);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const directoryInput = useRef<HTMLInputElement>(null);

  useEffect(() => { setStatus(initialStatus); }, [initialStatus]);
  useEffect(() => { directoryInput.current?.setAttribute("webkitdirectory", ""); }, [open]);

  function commit(next: PetStatus) {
    setStatus(next);
    onChanged(next);
  }

  async function changeSettings(input: Partial<PetStatus["settings"]>) {
    setBusy("settings"); setError(""); setNotice("");
    try {
      const next = await api<PetStatus>("/api/pets/settings", { method: "PATCH", body: JSON.stringify(input) });
      commit(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "宠物设置保存失败"); }
    finally { setBusy(""); }
  }

  async function importDirectory(files: FileList | null) {
    setBusy("import"); setError(""); setNotice("");
    try {
      const packages = await localPackages(files);
      const imported: string[] = [];
      const skipped: string[] = [];
      let next = status;
      for (const item of packages) {
        try {
          const result = await api<{ status: PetStatus }>("/api/pets/import", {
            method: "POST",
            body: JSON.stringify({ manifest: item.manifest, fallbackId: item.fallbackId, spritesheetDataUrl: await readDataUrl(item.spritesheet) }),
          });
          next = result.status;
          imported.push(String(item.manifest.displayName || item.manifest.id || item.fallbackId));
        } catch (reason) {
          if (reason instanceof ApiError && reason.status === 409) skipped.push(String(item.manifest.displayName || item.manifest.id || item.fallbackId));
          else throw reason;
        }
      }
      commit(next);
      const parts = [imported.length ? `已导入 ${imported.join("、")}` : "", skipped.length ? `已存在并跳过 ${skipped.join("、")}` : ""].filter(Boolean);
      setNotice(parts.join("；") || "没有需要导入的新宠物");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "宠物导入失败"); }
    finally {
      setBusy("");
      if (directoryInput.current) directoryInput.current.value = "";
    }
  }

  async function remove(pet: PetSummary) {
    if (!window.confirm(`移除宠物“${pet.displayName}”？文件会进入 NAS 可恢复隔离区。`)) return;
    setBusy(`delete:${pet.id}`); setError(""); setNotice("");
    try {
      const result = await api<{ status: PetStatus }>(`/api/pets/${encodeURIComponent(pet.id)}`, { method: "DELETE" });
      commit(result.status);
      setNotice(`${pet.displayName} 已移入可恢复隔离区`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "宠物移除失败"); }
    finally { setBusy(""); }
  }

  const active = status.pets.find((pet) => pet.id === status.settings.activePetId) ?? null;
  return <Modal open={open} title="宠物中心" subtitle="迁移现有 Codex 宠物，让任务状态在工作台里活起来" onClose={onClose} wide>
    <div className="pet-center">
      <section className="pet-center-toolbar">
        <div><strong>{active ? `当前：${active.displayName}` : "尚未启用宠物"}</strong><span>支持 v1 基础动作和 v2 方向观察；宠物按当前 Codex 账户隔离。</span></div>
        <input ref={directoryInput} className="sr-only" type="file" multiple accept="application/json,image/webp,.json,.webp" onChange={(event) => void importDirectory(event.target.files)} />
        <button className="primary-button" disabled={Boolean(busy)} onClick={() => directoryInput.current?.click()}><FolderUp size={16} />从本机 Codex 导入</button>
      </section>

      <section className="pet-preferences">
        <button className="secondary-button" disabled={!active || Boolean(busy)} onClick={() => void changeSettings({ visible: !status.settings.visible })}>{status.settings.visible ? <EyeOff size={15} /> : <Eye size={15} />}{status.settings.visible ? "隐藏宠物" : "显示宠物"}</button>
        <label><Gauge size={15} /><span>动画</span><select disabled={Boolean(busy)} value={status.settings.motion} onChange={(event) => void changeSettings({ motion: event.target.value as "full" | "reduced" })}><option value="full">完整动画</option><option value="reduced">减少动态</option></select></label>
        <label><span>大小 {Math.round(status.settings.scale * 100)}%</span><input disabled={Boolean(busy)} type="range" min="0.7" max="1.4" step="0.05" value={status.settings.scale} onChange={(event) => setStatus((current) => ({ ...current, settings: { ...current.settings, scale: Number(event.target.value) } }))} onPointerUp={(event) => void changeSettings({ scale: Number(event.currentTarget.value) })} onKeyUp={(event) => void changeSettings({ scale: Number(event.currentTarget.value) })} /></label>
      </section>

      {notice && <div className="settings-success">{notice}</div>}
      {error && <div className="settings-error">{error}</div>}
      {status.errors.length > 0 && <div className="settings-warning">有 {status.errors.length} 个宠物包未通过校验：{status.errors.map((item) => `${item.id}：${item.message}`).join("；")}</div>}

      <section className="pet-grid">
        {status.pets.map((pet) => {
          const selected = pet.id === status.settings.activePetId;
          return <article className={`pet-card ${selected ? "active" : ""}`} key={pet.id}>
            <div className="pet-card-preview"><PetPreview pet={pet} />{selected && <span><Check size={12} />使用中</span>}</div>
            <div className="pet-card-copy"><strong>{pet.displayName}</strong><p>{pet.description || "Codex 自定义宠物"}</p><small>v{pet.spriteVersionNumber} · {pet.width}×{pet.height} · {sizeLabel(pet.bytes)}</small></div>
            <div className="pet-card-actions"><button className="primary-button" disabled={selected || Boolean(busy)} onClick={() => void changeSettings({ activePetId: pet.id, visible: true })}>{selected ? "已启用" : "启用"}</button><button className="icon-button danger" disabled={Boolean(busy)} title="移入可恢复隔离区" aria-label={`移除 ${pet.displayName}`} onClick={() => void remove(pet)}><Trash2 size={15} /></button></div>
          </article>;
        })}
        {status.pets.length === 0 && <div className="pet-empty"><PawPrint size={32} /><strong>还没有宠物</strong><p>选择 Windows 上的 <code>C:\Users\你的用户名\.codex\pets</code>，工作台会识别其中所有标准宠物并批量导入。</p><button className="primary-button" onClick={() => directoryInput.current?.click()}><FolderUp size={16} />选择宠物文件夹</button></div>}
      </section>
    </div>
  </Modal>;
}
