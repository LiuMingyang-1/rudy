const secretName = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PROXY/i;
const previewLength = 2048;

export function previewer(env: NodeJS.ProcessEnv): (text: string) => string {
  const secrets = Object.entries(env).flatMap(([key, value]) =>
    secretName.test(key) && value && value.length >= 4 ? [value] : [],
  );
  return (text) => {
    let redacted = text;
    for (const secret of secrets) redacted = redacted.replaceAll(secret, "[redacted]");
    redacted = redacted.replace(/\b(?:Bearer\s+[^\s,;]+|sk-[\w-]{8,})/gi, "[redacted]");
    // Keep control characters from executable output out of terminal previews.
    redacted = redacted.replaceAll(String.fromCharCode(27), "").replaceAll("\r", "");
    return redacted.length > previewLength ? `${redacted.slice(0, previewLength)}…` : redacted;
  };
}

export function codexEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "LANG",
    "LC_ALL",
    "CODEX_HOME",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
  ];
  return Object.fromEntries(allowed.map((key) => [key, source[key]]));
}
