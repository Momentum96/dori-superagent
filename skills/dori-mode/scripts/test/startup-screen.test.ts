import { expect, test } from "bun:test";
import { startupFailure } from "../src/startup-screen.ts";

// Which text on a new lane's screen is a failed start (#202). The hc join itself is tested through launch.
const warning = `Warning: Failed to load extension "/x/ext/index.js": Cannot find module '/x/ext/node_modules/gone/index.mjs'`;

test("omo's extension warning and its Bun tail are not a failure, whatever the path looks like", () => {
  for (const path of [
    "/Users/John Doe/.omo/agent/extensions/quota-meter/index.js",
    "/Users/anna.tsai/.omo/agent/extensions/quota-meter/index.js",
    "/opt/node.js/.omo/agent/extensions/quota-meter/index.js",
    "C:\\Users\\anna.tsai\\.omo\\agent\\extensions\\quota-meter\\index.js",
  ])
    expect(startupFailure(`${warning} imported from ${path}\n❯ `)).toBeNull();
});

test("code, names and ordinary words that only look like a failure are no failure", () => {
  for (const text of [
    "const rateLimit = ratelimiter(noApiKey, usageLimit); // SessionCrashed",
    "load is moderate\nlimits apply",
    "load is moderate limits apply",
    "const quotaUsed = 3;",
    "my_quota_check",
    "const e = isQuotaExceeded(r);",
    "handler: onRateLimitExceeded",
  ])
    expect(startupFailure(text)).toBeNull();
});

test("real failures count, as words, as bare error codes, and glued onto a line by a wrap join", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["Error: rate limited by provider", "rate limited"],
    ["Error: all quotas exhausted", "quotas"],
    ["error: QUOTA_EXCEEDED", "QUOTA_EXCEEDED"],
    ["error: insufficient_quota", "insufficient_quota"],
    ["code=quotaExceeded", "quotaExceeded"],
    ["429 from the rate limiter", "rate limiter"],
    [`${warning} imported from /x/extensions/quota-meter/index.jsNo API key found`, "No API key"],
    ["Loading providers okRate limit exceeded", "Rate limit"],
    ["Loading providers okQuota exceeded for model", "Quota exceeded"],
    ["Loading providers okUsage limit reached", "Usage limit"],
  ];
  for (const [text, found] of cases) expect(startupFailure(text)).toBe(found);
});
