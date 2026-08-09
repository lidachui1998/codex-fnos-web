import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const input = resolve(process.argv[2] || join(root, "dist", `com.lidachui.codexweb-${pkg.version}-x86_64.fpk`));
if (!existsSync(input)) throw new Error(`FPK does not exist: ${input}`);
const result = spawnSync(process.env.CODEX_PYTHON || "python", [join(root, "scripts", "verify_fnos_fpk.py"), input], {
  cwd: root,
  encoding: "utf8",
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
