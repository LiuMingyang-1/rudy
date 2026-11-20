const secretName = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PROXY/i;
const previewLength = 2048;

export function previewer(env: NodeJS.ProcessEnv, limit = previewLength): (text: string) => string {
  const secrets = Object.entries(env).flatMap(([key, value]) =>
    secretName.test(key) && value && value.length >= 4 ? [value] : [],
  );
  return (text) => {
    let redacted = text;
    for (const secret of secrets) redacted = redacted.replaceAll(secret, "[redacted]");
    redacted = redacted.replace(/\b(?:Bearer\s+[^\s,;]+|sk-[\w-]{8,})/gi, "[redacted]");
    // Keep control characters from executable output out of terminal previews.
    redacted = redacted.replaceAll(String.fromCharCode(27), "").replaceAll("\r", "");
    return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
  };
}

export function harnessEnvironment(
  source: NodeJS.ProcessEnv,
  credentials: string[],
): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "USERPROFILE", "SystemRoot", "LANG", "LC_ALL", ...credentials];
  return Object.fromEntries(allowed.map((key) => [key, source[key]]));
}
