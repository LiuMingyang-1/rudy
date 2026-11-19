import type { Readable } from "node:stream";

const maxLine = 256 * 1024;

export function readLines(stream: Readable, receive: (line: string) => void): void {
  let pending = "";
  let overflow = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    const lines = chunk.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!overflow && pending.length + line.length <= maxLine) pending += line;
      else overflow = true;
      if (index < lines.length - 1) {
        if (!overflow) receive(pending);
        pending = "";
        overflow = false;
      }
    }
  });
  stream.on("end", () => {
    if (pending && !overflow) receive(pending);
  });
}
