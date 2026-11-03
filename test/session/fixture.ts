import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRudy } from "../../src/agent.ts";

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
      workspace,
    });
  }
  return { temporary, workspace, storage, directory, agent };
}
