import assert from "node:assert/strict";
import test from "node:test";
import { frameAncestors } from "../lib/frame-policy.mjs";

test("allows only fnOS origins for local iframe launch", () => {
  assert.equal(
    frameAncestors({ headers: { host: "nas.local:19090", referer: "https://nas.local:7443/desktop" } }),
    "'self' http://nas.local:5666 https://nas.local:5667 http://nas.local:8000 https://nas.local:8001 https://nas.local:7443",
  );
});

test("does not reflect an unrelated iframe parent", () => {
  assert.equal(
    frameAncestors({ headers: { host: "192.168.1.10:19090", referer: "https://attacker.example/app" } }),
    "'self' http://192.168.1.10:5666 https://192.168.1.10:5667 http://192.168.1.10:8000 https://192.168.1.10:8001",
  );
});

test("allows the exact FN Connect parent for an app subdomain", () => {
  assert.equal(
    frameAncestors({ headers: { host: "com-lidachui-codexweb.user.fnos.net", referer: "https://user.fnos.net/" } }),
    "'self' http://com-lidachui-codexweb.user.fnos.net:5666 https://com-lidachui-codexweb.user.fnos.net:5667 http://com-lidachui-codexweb.user.fnos.net:8000 https://com-lidachui-codexweb.user.fnos.net:8001 https://user.fnos.net",
  );
});

test("uses the public forwarded host behind the fnOS mobile proxy", () => {
  assert.equal(
    frameAncestors({
      headers: {
        host: "127.0.0.1:19090",
        "x-forwarded-host": "nas.local:5667",
        referer: "https://nas.local:7443/desktop",
      },
    }),
    "'self' http://nas.local:5666 https://nas.local:5667 http://nas.local:8000 https://nas.local:8001 https://nas.local:7443",
  );
});
