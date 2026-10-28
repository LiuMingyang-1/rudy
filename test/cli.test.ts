import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("CLI help works without credentials", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "--help"], {
    encoding: "utf8",
    env: { ...process.env, RUDY_API_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: npm start/);
});

test("CLI fails clearly before making requests when credentials are missing", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "hello"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RUDY_PROVIDER: "openai",
      RUDY_BASE_URL: "",
      RUDY_API_KEY: "",
      OPENAI_API_KEY: "",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENAI_API_KEY/);
});
