import type { CanvasContents, Item } from "./model.ts";
import { OpValidationError } from "./errors.ts";

/** A derived item is an immutable reading. Refresh replaces a reading, never
 * edits its words. Ordinary operations still place, discuss, delete/restore it.
 * This is enforced after reduction, including nested group content writes; a
 * disabled editor alone would leave the CLI and raw operations as bypasses. */
export function isDerivedItem(item: Pick<Item, "properties">): boolean {
  return item.properties.derived === "roadmap";
}

/** Refuse content/provenance changes through any operation, including nested writes. */
export function validateDerivedReadings(before: CanvasContents, after: CanvasContents): void {
  const previous = [...Object.values(before.items), ...before.trash.map(entry => entry.item)].filter(isDerivedItem);
  if (!previous.length) return;
  const next = new Map([...Object.values(after.items), ...after.trash.map(entry => entry.item)].map(item => [item.id, item]));
  for (const old of previous) {
    const item = next.get(old.id);
    if (!item) continue; // deletion/garbage collection is not an edit
    if (item.title !== old.title || item.description !== old.description || item.currentVersionId !== old.currentVersionId ||
        JSON.stringify(item.versions) !== JSON.stringify(old.versions) ||
        Object.keys({ ...item.properties, ...old.properties }).some(key => item.properties[key] !== old.properties[key])) {
      throw new OpValidationError("bad-op", `This is a derived reading — change its source instead: ${old.properties.source}`);
    }
  }
}
