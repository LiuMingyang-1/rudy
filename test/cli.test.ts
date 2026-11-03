import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("CLI help works without credentials", () => {
  const result = spawnSync(process.execPath, ["src/client/cli.ts", "--help"], {
    encoding: "utf8",
    env: { ...process.env, RUDY_API_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: npm start/);
  assert.match(result.stdout, /\/resume <number>/);
});

test("CLI fails clearly before making requests when credentials are missing", () => {
  const result = spawnSync(process.execPath, ["src/client/cli.ts", "hello"], {
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

test("CLI resets, lists and resumes sessions, then restores them across processes", {
  timeout: 15000,
}, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "rudy-cli-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  // Exercise readline through pipes while taking the interactive CLI branch.
  const terminal = join(temporary, "terminal.mjs");
  await writeFile(terminal, 'Object.defineProperty(process.stdin, "isTTY", { value: true });\n');
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(body);
    const chunk = {
      id: "local-response",
      object: "chat.completion.chunk",
      created: 0,
      model: "local-model",
      choices: [
        { index: 0, delta: { role: "assistant", content: "Local answer" }, finish_reason: null },
      ],
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = {
    ...process.env,
    HOME: temporary,
    RUDY_WORKSPACE: temporary,
    RUDY_PROVIDER: "local",
    RUDY_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    RUDY_MODEL: "local-model",
    RUDY_API_KEY: "local-test-key",
  };

  function start() {
    const child = spawn(process.execPath, ["--import", terminal, "src/client/cli.ts"], { env });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    let output = "";
    let errors = "";
    let prompts = 0;
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      output += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      errors += text;
    });
    function ready(): Promise<void> {
      prompts++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error(`CLI timeout: ${output}\n${errors}`)),
          4000,
        );
        function finish(error?: Error) {
          clearTimeout(timer);
          child.stdout.off("data", check);
          child.off("close", closed);
          if (error) reject(error);
          else resolve();
        }
        function check() {
          if ((output.match(/you> /g)?.length ?? 0) >= prompts) finish();
        }
        function closed() {
          finish(new Error(`CLI exited: ${errors}`));
        }
        child.stdout.on("data", check);
        child.once("close", closed);
        check();
      });
    }
    return {
      ready,
      get errors() {
        return errors;
      },
      async send(text: string) {
        const offset = output.length;
        child.stdin.write(`${text}\n`);
        await ready();
        return output.slice(offset);
      },
      async close() {
        const closed = once(child, "close");
        child.stdin.end("/exit\n");
        const [code] = await closed;
        assert.equal(code, 0, errors);
      },
    };
  }

  const first = start();
  await first.ready();
  assert.match(await first.send("/compact"), /No history to compact/);
  await first.send("First question\n/reset\n/compact\n/resume");
  assert.equal(requests.length, 1);
  assert.equal(first.errors.match(/Session is busy/g)?.length, 3);
  assert.match(await first.send("/reset"), /Started a new conversation/);
  await first.send("/resume 1");
  await first.send("Second question");
  const list = await first.send("/resume");
  assert.equal(list.match(/^\d+ {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/gm)?.length, 2);
  assert.ok(!list.includes("question"));
  assert.match(await first.send("/resume 2"), /Conversation resumed/);
  await first.send("Followup");
  assert.match(requests[2], /First question/);
  assert.doesNotMatch(requests[2], /Second question/);
  await first.close();

  const restarted = start();
  await restarted.ready();
  await restarted.send("After restart");
  assert.match(requests[3], /First question/);
  assert.match(requests[3], /Followup/);
  assert.doesNotMatch(requests[3], /Second question/);
  await restarted.close();
});
