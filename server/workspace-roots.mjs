import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

export function discoverWorkspaceCandidates(systemRoot = "/") {
  if (process.platform !== "linux" && systemRoot === "/") return [];
  const result = [];
  let volumes = [];
  try {
    volumes = readdirSync(systemRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^vol\d+$/.test(entry.name));
  } catch {
    return result;
  }
  for (const volume of volumes) {
    const volumePath = join(systemRoot, volume.name);
    try {
      for (const entry of readdirSync(volumePath, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith("@")) continue;
        try {
          result.push(realpathSync(join(volumePath, entry.name)));
        } catch {
          // Ignore inaccessible shares.
        }
      }
    } catch {
      // The fnOS app account may not have access to every volume.
    }
  }
  return [...new Set(result)].sort((left, right) => left.localeCompare(right, "zh-CN"));
}
