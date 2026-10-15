import { readFileSync } from "node:fs";
import { normalizeName } from "../../machine-facts/machine-facts-contract.ts";
import { isToHiveSyncCategory } from "./producer-table-identity.ts";

export interface SourceEndpointBoundaryRoleConfig {
  readonly qualifiedNamePrefixes?: readonly string[];
  readonly consumerTaskCategorySuffixes?: readonly string[];
}

export interface SourceEndpointBoundaryConfig {
  readonly version: string;
  readonly roles: Readonly<Record<string, SourceEndpointBoundaryRoleConfig>>;
}

export const DEFAULT_SOURCE_ENDPOINT_BOUNDARY_CONFIG_PATH =
  "config/source-endpoint-boundary-rules.json";

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

function requireStringArray(
  value: unknown,
  field: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${field.toUpperCase()}_INVALID`);
  return value.map((item, index) =>
    requireNonEmptyString(item, `${field}[${index}]`),
  );
}

export function loadSourceEndpointBoundaryConfig(
  path: string,
): SourceEndpointBoundaryConfig {
  const root = asRecord(JSON.parse(readFileSync(path, "utf8")));
  if (!root) throw new Error("SOURCE_ENDPOINT_BOUNDARY_CONFIG_INVALID");
  const version = requireNonEmptyString(root.version, "version");
  const roles = asRecord(root.roles);
  if (!roles) throw new Error("SOURCE_ENDPOINT_BOUNDARY_CONFIG_ROLES_INVALID");
  const normalizedRoles: Record<string, SourceEndpointBoundaryRoleConfig> = {};
  for (const [role, rawRole] of Object.entries(roles)) {
    const roleConfig = asRecord(rawRole);
    if (!roleConfig)
      throw new Error(`SOURCE_ENDPOINT_BOUNDARY_CONFIG_ROLE_${role}_INVALID`);
    const prefixes = roleConfig.qualifiedNamePrefixes;
    const suffixes = roleConfig.consumerTaskCategorySuffixes;
    const hasPrefixes = Array.isArray(prefixes) && prefixes.length > 0;
    const hasSuffixes = Array.isArray(suffixes) && suffixes.length > 0;
    if (!hasPrefixes && !hasSuffixes)
      throw new Error(`SOURCE_ENDPOINT_BOUNDARY_CONFIG_ROLE_${role}_INVALID`);
    normalizedRoles[role] = {
      ...(hasPrefixes
        ? {
            qualifiedNamePrefixes: requireStringArray(
              prefixes,
              `roles.${role}.qualifiedNamePrefixes`,
            ),
          }
        : {}),
      ...(hasSuffixes
        ? {
            consumerTaskCategorySuffixes: requireStringArray(
              suffixes,
              `roles.${role}.consumerTaskCategorySuffixes`,
            ),
          }
        : {}),
    };
  }
  return { version, roles: normalizedRoles };
}

export function matchingSourceEndpointBoundaryRole(
  config: SourceEndpointBoundaryConfig,
  qualifiedName: string,
  consumerTaskCategory: string | null | undefined,
): { role: string; ruleRef: string } | null {
  const folded = normalizeName(qualifiedName).toLowerCase();
  const category = consumerTaskCategory?.trim().toLowerCase() ?? "";
  for (const [role, roleConfig] of Object.entries(config.roles)) {
    const prefix = roleConfig.qualifiedNamePrefixes?.find((term) =>
      folded.startsWith(term.toLowerCase()),
    );
    if (prefix) {
      return {
        role,
        ruleRef: `${DEFAULT_SOURCE_ENDPOINT_BOUNDARY_CONFIG_PATH}#roles.${role}.qualifiedNamePrefixes=${prefix}`,
      };
    }
    const suffix = roleConfig.consumerTaskCategorySuffixes?.find((term) =>
      category.endsWith(term.toLowerCase()),
    );
    if (suffix && isToHiveSyncCategory(category)) {
      return {
        role,
        ruleRef: `${DEFAULT_SOURCE_ENDPOINT_BOUNDARY_CONFIG_PATH}#roles.${role}.consumerTaskCategorySuffixes=${suffix}`,
      };
    }
  }
  return null;
}
