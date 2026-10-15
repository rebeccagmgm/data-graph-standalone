/** SQL LIKE semantics, with backslash escaping, never a user-supplied regex. */
export function compileScopePatterns(input: unknown) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 25) {
    throw new Error("INVALID_SCOPE_PATTERNS");
  }
  return [...new Set(input)].map(value => {
    if (typeof value !== "string" || value.length > 200 || !/[a-z0-9]/i.test(value)) {
      throw new Error("INVALID_SCOPE_PATTERNS");
    }
    const pattern = value.trim().toLowerCase();
    let regex = "^", wildcards = 0;
    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i];
      if (char === "\\") {
        if (++i === pattern.length) throw new Error("INVALID_SCOPE_PATTERNS");
        regex += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      } else if (char === "%" || char === "_") {
        if (++wildcards > 16) throw new Error("INVALID_SCOPE_PATTERNS");
        regex += char === "%" ? ".*" : ".";
      } else regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return { pattern, regex: `${regex}$`, qualified: pattern.includes(".") };
  });
}
