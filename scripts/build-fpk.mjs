import { spawnSync } from "node:child_process";
import { crc32 } from "node:zlib";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const viteRequire = createRequire(import.meta.resolve("vite"));
const { build } = viteRequire("esbuild");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const appId = "com.lidachui.codexweb";
const template = join(root, "fnos", "native", appId);
const stageRoot = join(root, ".fnos-build");
const stage = join(stageRoot, appId);
const extractRoot = join(stageRoot, "codex-linux");
const output = join(root, "dist", `${appId}-${pkg.version}-x86_64.fpk`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

function findPython() {
  return process.env.CODEX_PYTHON || "python";
}

function findLinuxPackage() {
  if (process.env.CODEX_LINUX_TGZ) return resolve(process.env.CODEX_LINUX_TGZ);
  const cache = join(root, "vendor-cache");
  if (!existsSync(cache)) throw new Error("vendor-cache does not exist");
  const files = readdirSync(cache)
    .filter((name) => /^openai-codex-.*-linux-x64\.tgz$/.test(name))
    .map((name) => join(cache, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  if (!files[0]) throw new Error("Missing official Linux Codex package. Run: npm pack @openai/codex@linux-x64 --pack-destination vendor-cache");
  return files[0];
}

function pngChunk(type, data) {
  const label = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([label, data])));
  return Buffer.concat([length, label, data, checksum]);
}

function makeIcon(size) {
  const rows = [];
  const radius = size * 0.2;
  const cx = size * 0.5;
  const cy = size * 0.49;
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x += 1) {
      const dx = Math.max(radius - x, 0, x - (size - radius));
      const dy = Math.max(radius - y, 0, y - (size - radius));
      const inside = dx * dx + dy * dy <= radius * radius;
      const offset = 1 + x * 4;
      if (!inside) continue;
      const gradient = (x + y) / (size * 2);
      row[offset] = Math.round(19 + gradient * 20);
      row[offset + 1] = Math.round(22 + gradient * 24);
      row[offset + 2] = Math.round(25 + gradient * 28);
      row[offset + 3] = 255;
      const rx = x - cx;
      const ry = y - cy;
      const distance = Math.sqrt(rx * rx + ry * ry) / size;
      const angle = Math.atan2(ry, rx);
      const openRight = Math.abs(angle) < 0.7 && rx > 0;
      if (distance > 0.205 && distance < 0.31 && !openRight) {
        row[offset] = 244;
        row[offset + 1] = 243;
        row[offset + 2] = 238;
      }
      const dotX = x - size * 0.72;
      const dotY = y - size * 0.27;
      if (dotX * dotX + dotY * dotY < (size * 0.055) ** 2) {
        row[offset] = 109;
        row[offset + 1] = 226;
        row[offset + 2] = 177;
      }
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

if (!existsSync(join(root, "dist", "index.html"))) throw new Error("Frontend dist is missing; run npm run build first");
const linuxPackage = findLinuxPackage();
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });
cpSync(template, stage, { recursive: true });

const manifestPath = join(stage, "manifest");
writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace(/^version=.*$/m, `version=${pkg.version}`), "utf8");

const serverDir = join(stage, "app", "server");
mkdirSync(join(serverDir, "server"), { recursive: true });
cpSync(join(root, "dist"), join(serverDir, "dist"), {
  recursive: true,
  filter: (source) => !source.includes(`${join("dist", "fnos-stage")}`) && !source.endsWith(".fpk"),
});
writeFileSync(join(serverDir, "package.json"), `${JSON.stringify({ name: "codex-fnos-runtime", version: pkg.version, private: true, type: "module" }, null, 2)}\n`);
await build({
  entryPoints: [join(root, "server", "index.mjs")],
  outfile: join(serverDir, "server", "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  minify: false,
  banner: { js: "import { createRequire as __codexCreateRequire } from 'node:module'; const require = __codexCreateRequire(import.meta.url);" },
});

mkdirSync(extractRoot, { recursive: true });
run("tar", ["-xzf", linuxPackage, "-C", extractRoot]);
const upstreamPackagePath = join(extractRoot, "package", "package.json");
const upstream = JSON.parse(readFileSync(upstreamPackagePath, "utf8"));
if (upstream.name !== "@openai/codex" || !upstream.version.endsWith("-linux-x64") || upstream.license !== "Apache-2.0") {
  throw new Error(`Unexpected Codex platform package metadata: ${JSON.stringify(upstream)}`);
}
const targets = readdirSync(join(extractRoot, "package", "vendor"), { withFileTypes: true }).filter((item) => item.isDirectory());
if (targets.length !== 1 || targets[0].name !== "x86_64-unknown-linux-musl") {
  throw new Error(`Unexpected Codex Linux target: ${targets.map((item) => item.name).join(", ")}`);
}
const vendorDir = join(stage, "app", "vendor");
mkdirSync(join(vendorDir, "openai-codex"), { recursive: true });
cpSync(join(extractRoot, "package", "vendor", targets[0].name), join(vendorDir, targets[0].name), { recursive: true });
cpSync(upstreamPackagePath, join(vendorDir, "openai-codex", "package.json"));
cpSync(join(extractRoot, "package", "README.md"), join(vendorDir, "openai-codex", "README.md"));
writeFileSync(join(vendorDir, "CODEX_VERSION"), `${upstream.version.replace(/-linux-x64$/, "")}\n`);
const codexMagic = readFileSync(join(vendorDir, targets[0].name, "bin", "codex"), { encoding: null, flag: "r" }).subarray(0, 4);
if (!codexMagic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error("Official Codex binary is not ELF");

const appIcon = join(root, "assets", "app-icon.png");
if (!existsSync(appIcon)) throw new Error("Missing assets/app-icon.png");
for (const name of ["ICON.PNG", "ICON_256.PNG"]) {
  copyFileSync(appIcon, join(stage, name));
}
for (const size of [64, 256]) {
  copyFileSync(appIcon, join(stage, "app", "ui", "images", `icon_${size}.png`));
}
for (const file of readdirSync(join(stage, "cmd"))) {
  const path = join(stage, "cmd", file);
  writeFileSync(path, readFileSync(path, "utf8").replace(/\r\n/g, "\n"), "utf8");
}

rmSync(output, { force: true });
run(findPython(), [join(root, "scripts", "build_fnos_fpk.py"), stage, output]);
console.log(JSON.stringify({ ok: true, output, codexVersion: upstream.version, linuxPackage }, null, 2));
