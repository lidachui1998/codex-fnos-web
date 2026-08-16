import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const tag = `v${version}`;
const artifact = join(root, "dist", `com.lidachui.codexweb-${version}-x86_64.fpk`);
const portableGhCandidates = process.platform === "win32"
  ? [join(root, ".tools", "gh", "bin", "gh.exe"), join(root, ".tools", "gh", "gh.exe")]
  : [join(root, ".tools", "gh", "bin", "gh"), join(root, ".tools", "gh", "gh")];
const portableGh = portableGhCandidates.find(existsSync);
const gh = process.env.GH_BIN || portableGh || "gh";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    if (options.capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result;
}

function output(command, args) {
  return run(command, args, { capture: true }).stdout.trim();
}

function assertCleanWorktree() {
  const status = output("git", ["status", "--porcelain"]);
  if (status) {
    throw new Error("Git 工作区不是干净状态。请先提交本次修改，再运行 npm run release:github。\n" + status);
  }
}

function assertVersionMatchesManifest() {
  const manifest = readFileSync(join(root, "fnos", "native", "com.lidachui.codexweb", "manifest"), "utf8");
  const manifestVersion = manifest.match(/^version=(.+)$/m)?.[1]?.trim();
  if (manifestVersion !== version) {
    throw new Error(`package.json (${version}) 与 fnOS manifest (${manifestVersion || "missing"}) 版本不一致`);
  }
}

function assertGhReady() {
  const versionResult = run(gh, ["--version"], { capture: true, allowFailure: true });
  if (versionResult.status !== 0) {
    throw new Error("未找到 GitHub CLI。请安装 gh，或把便携版放到 .tools/gh/bin/gh.exe，或设置 GH_BIN。官方地址：https://cli.github.com/");
  }
  run(gh, ["auth", "status"]);
}

function remoteTagExists() {
  return Boolean(output("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]));
}

assertVersionMatchesManifest();
assertGhReady();
assertCleanWorktree();

run(npm, ["run", "package:fnos"]);
run(npm, ["run", "verify:fnos", "--", artifact]);
if (!existsSync(artifact)) throw new Error(`FPK 不存在：${artifact}`);
assertCleanWorktree();

const branch = output("git", ["branch", "--show-current"]);
run("git", ["push", "origin", branch]);

if (!remoteTagExists()) {
  const localTag = run("git", ["rev-parse", "--verify", `refs/tags/${tag}`], { capture: true, allowFailure: true });
  if (localTag.status !== 0) run("git", ["tag", "-a", tag, "-m", `Codex 飞牛工作台 ${version}`]);
  run("git", ["push", "origin", tag]);
}

const release = run(gh, ["release", "view", tag], { capture: true, allowFailure: true });
if (release.status === 0) {
  run(gh, ["release", "upload", tag, artifact, "--clobber"]);
} else {
  run(gh, [
    "release", "create", tag, artifact,
    "--verify-tag",
    "--title", `Codex 飞牛工作台 ${version}`,
    "--generate-notes",
  ]);
}

const url = output(gh, ["release", "view", tag, "--json", "url", "--jq", ".url"]);
console.log(JSON.stringify({ ok: true, version, tag, branch, artifact, url }, null, 2));
