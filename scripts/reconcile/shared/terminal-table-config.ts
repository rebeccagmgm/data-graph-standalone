import { readFileSync } from "node:fs";

export interface TerminalTableRoleConfig {
  readonly qualifiedNameExact?: readonly string[];
  readonly qualifiedNameTerms: readonly string[];
}

export interface TerminalTableConfig {
  readonly version: string;
  readonly stopRoles: readonly string[];
  readonly roles: Readonly<Record<string, TerminalTableRoleConfig>>;
}

export const DEFAULT_TERMINAL_TABLE_CONFIG_PATH =
  "config/multi-hop-terminal-table-rules.json";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${field.toUpperCase()}_INVALID`);
  return value.trim();
}

export function loadTerminalTableConfig(path: string): TerminalTableConfig {
  const root = asRecord(JSON.parse(readFileSync(path, "utf8")));
  if (!root) throw new Error("TERMINAL_TABLE_CONFIG_INVALID");
  const version = requireNonEmptyString(root.version, "version");
  if (!Array.isArray(root.stopRoles) || root.stopRoles.length === 0)
    throw new Error("TERMINAL_TABLE_CONFIG_STOP_ROLES_INVALID");
  const stopRoles = root.stopRoles.map((role, index) =>
    requireNonEmptyString(role, `stopRoles[${index}]`),
  );
  const roles = asRecord(root.roles);
  if (!roles) throw new Error("TERMINAL_TABLE_CONFIG_ROLES_INVALID");
  const normalizedRoles: Record<string, TerminalTableRoleConfig> = {};
  for (const role of stopRoles) {
    const roleConfig = asRecord(roles[role]);
    const terms = roleConfig?.qualifiedNameTerms;
    if (!Array.isArray(terms) || terms.length === 0)
      throw new Error(`TERMINAL_TABLE_CONFIG_ROLE_${role}_INVALID`);
    normalizedRoles[role] = {
      ...(Array.isArray(roleConfig?.qualifiedNameExact)
        ? {
            qualifiedNameExact: roleConfig.qualifiedNameExact.map((name, index) =>
              requireNonEmptyString(name, `roles.${role}.qualifiedNameExact[${index}]`),
            ),
          }
        : {}),
      qualifiedNameTerms: terms.map((term, index) =>
        requireNonEmptyString(term, `roles.${role}.qualifiedNameTerms[${index}]`),
      ),
    };
  }
  return { version, stopRoles, roles: normalizedRoles };
}

export function matchingTerminalRole(
  config: TerminalTableConfig,
  qualifiedName: string,
): string | null {
  const folded = qualifiedName.toLocaleLowerCase("en-US");
  for (const role of config.stopRoles) {
    const roleConfig = config.roles[role];
    if (
      roleConfig?.qualifiedNameExact?.some(
        (name) => name.toLocaleLowerCase("en-US") === folded,
      )
    )
      return role;
    if (
      roleConfig?.qualifiedNameTerms.some((term) =>
        folded.includes(term.toLocaleLowerCase("en-US")),
      )
    )
      return role;
  }
  return null;
}
