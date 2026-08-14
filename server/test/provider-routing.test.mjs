import assert from "node:assert/strict";
import test from "node:test";
import { decodeProviderRoute, encodeProviderRoute } from "../provider-routing.mjs";

test("provider retry routes are bounded and round-trip without exposing another provider", () => {
  const encoded = encodeProviderRoute("selected-api", "coder/model-v2");
  assert.deepEqual(decodeProviderRoute(encoded), { providerId: "selected-api", model: "coder/model-v2" });
  assert.equal(decodeProviderRoute("ordinary-model"), null);
  assert.equal(decodeProviderRoute("fnos-provider-route-v1:broken"), null);
  assert.throws(() => encodeProviderRoute("../outside", "model"), /供应商 ID 无效/);
  assert.throws(() => encodeProviderRoute("selected-api", ""), /模型 ID 无效/);
});
