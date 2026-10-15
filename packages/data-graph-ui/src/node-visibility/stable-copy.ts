const copies = new WeakMap<object, Map<string, object>>();

/** Preserve explicit boolean flags and reuse copies for unchanged immutable inputs. */
export function withVisibility<T extends object, F extends {hidden: boolean; selected?: boolean}>(value: T, flags: F): T & F {
  if (Object.entries(flags).every(([key, flag]) => (value as Record<string, unknown>)[key] === flag)) return value as T & F;
  const key = `${flags.hidden}:${flags.selected ?? "unset"}`;
  let variants = copies.get(value);
  if (!variants) { variants = new Map(); copies.set(value, variants); }
  let result = variants.get(key);
  if (!result) { result = {...value, ...flags}; variants.set(key, result); }
  return result as T & F;
}
