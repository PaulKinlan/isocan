import type { CanvasHandle } from "@isocan/api";
import { isRecord, type VoiceToolCall, type VoiceToolDeclaration } from "./types.ts";

const reads: VoiceToolDeclaration[] = [
  { name: "canvas_items", description: "List this canvas's item IDs, titles and geometry.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "canvas_who", description: "List names known on this canvas and whether they are present.", parameters: { type: "object", properties: {}, additionalProperties: false } },
];
const move: VoiceToolDeclaration = {
  name: "item_move",
  description: "Move an explicitly authorised item, with its attached annotations, to an absolute canvas position. Use its exact ID.",
  parameters: {
    type: "object", additionalProperties: false,
    properties: { itemId: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
    required: ["itemId", "x", "y"],
  },
};
const names = new Set([...reads, move].map((tool) => tool.name));

/** A closed allowlist, not a blacklist whose spelling can be bypassed. */
export function assertVoiceToolSafety(tools: readonly VoiceToolDeclaration[]): void {
  for (const tool of tools) if (!names.has(tool.name)) throw new Error("Unsupported voice tool");
}

/** One canvas, read-only by default. No raw op, eval, deletion or thread-dispatch escape hatch. */
export function canvasVoiceTools(canvas: CanvasHandle, moveItems: readonly string[] = []) {
  const allowed = new Set(moveItems);
  const tools = [...reads, ...(allowed.size ? [move] : [])];
  let revoked = false;
  return {
    tools,
    revoke() { revoked = true; },
    async invoke(call: VoiceToolCall, signal: AbortSignal): Promise<Record<string, unknown>> {
      if (revoked || signal.aborted) throw new Error("Voice authority revoked");
      if (!tools.some((tool) => tool.name === call.name)) throw new Error("Voice tool not granted");
      if (!isRecord(call.args)) throw new Error("Tool arguments must be an object");
      if (call.name !== "item_move") {
        if (Object.keys(call.args).length) throw new Error("This read tool takes no arguments");
        if (call.name === "canvas_who") return { people: await canvas.who() };
        return { items: (await canvas.items()).map(({ id, title, x, y, width, height }) => ({ id, title, x, y, width, height })) };
      }
      const { itemId, x, y } = call.args;
      if (Object.keys(call.args).length !== 3 || !Object.keys(call.args).every((key) => ["itemId", "x", "y"].includes(key)) ||
          typeof itemId !== "string" || typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
        throw new Error("item_move requires exactly itemId, finite x and finite y");
      }
      if (!allowed.has(itemId)) throw new Error("Item is outside the voice move grant");
      // Reuse the real gesture: CanvasHandle.move also carries attached annotations.
      await canvas.move(itemId, x, y);
      const after = await canvas.item(itemId);
      return { itemId: after.id, x: after.x, y: after.y };
    },
  };
}
