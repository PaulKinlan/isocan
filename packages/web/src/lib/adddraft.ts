import { classifyAddable, type Addable } from "@isocan/core";

/** A field is an unfinished paste. Keep an incomplete address as a draft;
 * submit still validates it through normalizeSiteUrl before any request. */
export function classifyAddableDraft(...args: Parameters<typeof classifyAddable>): Addable {
  try {
    return classifyAddable(...args);
  } catch {
    return { kind: "site", url: args[0].trim() };
  }
}
