import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createFauxCore, type Usage } from "@earendil-works/pi-ai";
import { createRudy } from "../../src/agent.ts";
import type { CompactionOptions } from "../../src/compaction/compact.ts";
import { compactionDefaults } from "../../src/config.ts";
import { openSession } from "../../src/session/session.ts";

export async function fixture(
  t: { after(fn: () => Promise<void>): void },
  options: Partial<CompactionOptions> = {},
) {
  const temporary = await mkdtemp(join(tmpdir(), "rudy-compaction-"));
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
  async function create() {
    const agent = await createRudy({
      provider: "openai",
      model: "gpt-5.4",
      apiKey: "unused",
      workspace,
      contextWindow: 128000,
      maxTokens: 4096,
      ...compactionDefaults,
    });
    const faux = createFauxCore({});
    agent.streamFunction = faux.streamSimple;
    const session = await openSession(agent, {
      workspace,
      storageRoot: storage,
      compaction: {
        ...compactionDefaults,
        compactionKeepRecentTokens: 100,
        maxTokens: 4096,
        ...options,
      },
    });
    return { agent, faux, session, file: join(directory, `${agent.sessionId}.jsonl`) };
  }
  return { workspace, storage, directory, create };
}

export const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 });
export const noUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
