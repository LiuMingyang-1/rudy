import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createRudy } from "../../src/agent.ts";
import { compactionDefaults } from "../../src/config.ts";
import { openSession } from "../../src/session/session.ts";

export async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const temporary = await mkdtemp(join(tmpdir(), "rudy-session-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const workspace = join(temporary, "workspace");
  const storage = join(temporary, "storage");
  await mkdir(workspace);
  const directory = join(
    storage,
    createHash("sha256")
      .update(await realpath(workspace))
      .digest("hex"),
  );
  async function agent() {
    return createRudy({
      provider: "openai",
      model: "gpt-5.4",
      apiKey: "not-to-be-stored",
      contextWindow: 128000,
      maxTokens: 4096,
      ...compactionDefaults,
      workspace,
    });
  }
  function open(agent: Agent, target = workspace) {
    return openSession(agent, {
      workspace: target,
      compaction: { ...compactionDefaults, maxTokens: 4096 },
      storageRoot: storage,
    });
  }
  return { temporary, workspace, storage, directory, agent, open };
}
