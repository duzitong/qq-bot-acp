export type ControlCommand =
  | { kind: "id" }
  | { kind: "config"; key?: string; value?: string; operation: "show" | "get" | "set" | "status" }
  | { kind: "session-config"; key?: string; value?: string; operation: "show" | "set" | "reset" }
  | { kind: "test-streaming" }
  | { kind: "cancel" }
  | { kind: "new" };

export function parseControlCommand(text: string): ControlCommand | null {
  const trimmed = text.trim();
  if (trimmed === "/id") return { kind: "id" };
  if (trimmed === "/test-streaming") return { kind: "test-streaming" };
  if (trimmed === "/acp-cancel") return { kind: "cancel" };
  if (trimmed === "/acp-new") return { kind: "new" };

  const config = matchCommand(trimmed, ["/config", "/c"]);
  if (config !== null) {
    if (!config) return { kind: "config", operation: "show" };
    if (config === "status") return { kind: "config", operation: "status" };
    const [first, ...rest] = splitArguments(config);
    if (first === "get") {
      return { kind: "config", operation: "get", key: rest.join(" ") };
    }
    return {
      kind: "config",
      operation: "set",
      key: first,
      value: rest.join(" "),
    };
  }

  const session = matchCommand(trimmed, ["/session-config", "/sc"]);
  if (session !== null) {
    if (!session) return { kind: "session-config", operation: "show" };
    if (session === "reset") return { kind: "session-config", operation: "reset" };
    const [key, ...rest] = splitArguments(session);
    return {
      kind: "session-config",
      operation: "set",
      key,
      value: rest.join(" "),
    };
  }
  return null;
}

function matchCommand(text: string, names: string[]): string | null {
  for (const name of names) {
    if (text === name) return "";
    if (text.startsWith(`${name} `)) return text.slice(name.length).trim();
  }
  return null;
}

function splitArguments(value: string): string[] {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}
