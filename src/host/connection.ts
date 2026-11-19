import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultPort } from "../protocol/task.ts";

export interface Connection {
  port: number;
  token: string;
}

export function defaultDataDir(): string {
  return process.env.RUDY_DATA_DIR ?? join(homedir(), ".rudy", "orchestration");
}

export function parsePort(value = String(defaultPort)): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65535) throw new Error("Port must be between 0 and 65535.");
  return port;
}

export function publishConnection(dataDir: string, port: number, token: string): void {
  const temporary = join(dataDir, `connection-${randomBytes(12).toString("hex")}.tmp`);
  writeFileSync(temporary, JSON.stringify({ port, token }), { mode: 0o600, flag: "wx" });
  try {
    renameSync(temporary, join(dataDir, "connection.json"));
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readConnection(dataDir: string): Connection {
  const value: unknown = JSON.parse(readFileSync(join(dataDir, "connection.json"), "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    !("port" in value) ||
    !("token" in value) ||
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    typeof value.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.token)
  ) {
    throw new Error("Invalid Rudy Host connection file.");
  }
  return { port: value.port, token: value.token };
}

export function authorized(expected: string, received: string | undefined): boolean {
  return (
    !!received &&
    /^[a-f0-9]{64}$/.test(received) &&
    timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"))
  );
}
