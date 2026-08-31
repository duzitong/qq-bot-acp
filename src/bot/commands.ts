import type * as acp from "@agentclientprotocol/sdk";

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

export function formatSessionConfig(state: {
  active: boolean;
  available: acp.SessionConfigOption[];
}): string {
  const lines = ["## ACP Session Config"];

  if (!state.active) {
    lines.push("", "No active ACP session. Send a normal message first.");
  } else if (state.available.length === 0) {
    lines.push("", "The active agent does not expose configurable session options.");
  } else {
    for (const option of state.available) {
      lines.push("", `**${option.name}** (id: \`${option.id}\`)`);
      lines.push(`- Current: ${describeCurrentValue(option)}`);
      lines.push(`- Options: ${describeChoices(option).join(" | ")}`);
    }
  }

  lines.push(
    "",
    "### Usage",
    "- View: `/session-config` or `/sc`",
    "- Update: `/session-config <configId> <value>` or `/sc <configId> <value>`",
    "- Reset: `/session-config reset` or `/sc reset`",
  );
  return lines.join("\n");
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

function describeCurrentValue(option: acp.SessionConfigOption): string {
  if (option.type === "boolean") return `\`${option.currentValue}\``;
  const current = flattenSelectOptions(option.options).find(
    (choice) => choice.value === option.currentValue,
  );
  return current ? describeChoice(current) : `\`${option.currentValue}\``;
}

function describeChoices(option: acp.SessionConfigOption): string[] {
  if (option.type === "boolean") return ["`true`", "`false`"];
  return flattenSelectOptions(option.options).map(describeChoice);
}

function flattenSelectOptions(
  options: acp.SessionConfigSelect["options"],
): acp.SessionConfigSelectOption[] {
  return options.flatMap((entry) =>
    "value" in entry ? [entry] : entry.options,
  );
}

function describeChoice(choice: acp.SessionConfigSelectOption): string {
  return choice.name === choice.value
    ? `\`${choice.value}\``
    : `${choice.name} (\`${choice.value}\`)`;
}
