import type { VoiceToolDeclaration } from "./types.ts";

/**
 * Irreversible operations that are STRICTLY FORBIDDEN from voice tool manifests.
 * Voice prompt injection or acoustic misrecognition must never trigger these.
 */
export const FORBIDDEN_VOICE_OPERATIONS = new Set<string>([
  "trash.empty",
  "project.delete",
  "canvas.delete",
]);

/**
 * Fast operations (<50ms engineering target) and thread dispatch declarations.
 */
export const VOICE_TOOL_DECLARATIONS: VoiceToolDeclaration[] = [
  {
    name: "item_move",
    description: "Move a canvas item to an absolute (x, y) coordinate. Fast operation (<50ms).",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The exact or prefix-matched item ID" },
        x: { type: "number", description: "Target x coordinate on canvas" },
        y: { type: "number", description: "Target y coordinate on canvas" },
      },
      required: ["itemId", "x", "y"],
    },
  },
  {
    name: "items_move",
    description: "Move multiple canvas items simultaneously (e.g. alignment or multi-card shift).",
    parameters: {
      type: "object",
      properties: {
        moves: {
          type: "array",
          description: "List of item moves",
          items: {
            type: "object",
            properties: {
              itemId: { type: "string" },
              x: { type: "number" },
              y: { type: "number" },
            },
            required: ["itemId", "x", "y"],
          },
        },
      },
      required: ["moves"],
    },
  },
  {
    name: "item_resize",
    description: "Resize a canvas item to explicit width and height.",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The item ID to resize" },
        width: { type: "number", description: "New width in pixels" },
        height: { type: "number", description: "New height in pixels" },
      },
      required: ["itemId", "width", "height"],
    },
  },
  {
    name: "item_update",
    description: "Update metadata on an item (title, starred state).",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The item ID to update" },
        title: { type: "string", description: "New title for the item" },
        starred: { type: "boolean", description: "Whether the item is starred" },
      },
      required: ["itemId"],
    },
  },
  {
    name: "item_set_current_version",
    description: "Convergence gesture: select which explored version of an item to keep as current ('keep the second one'). Fast operation (<50ms).",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The item ID whose version is being selected" },
        versionId: { type: "string", description: "The version ID to set as active" },
      },
      required: ["itemId", "versionId"],
    },
  },
  {
    name: "item_delete",
    description: "Move an item to the canvas trash (reversible via item_restore).",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The item ID to move to trash" },
      },
      required: ["itemId"],
    },
  },
  {
    name: "item_restore",
    description: "Restore an item from the canvas trash.",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The item ID to restore" },
      },
      required: ["itemId"],
    },
  },
  {
    name: "thread_create",
    description: "Create a discussion thread, optionally anchored to an item or canvas position.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The initial comment text" },
        itemId: { type: "string", description: "Optional item ID to anchor the thread to" },
        anchor: {
          type: "object",
          description: "Optional (x, y) canvas coordinate anchor",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
          },
          required: ["x", "y"],
        },
      },
      required: ["message"],
    },
  },
  {
    name: "thread_reply",
    description: "Reply to an existing comment thread on the canvas.",
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "The thread ID to reply to" },
        message: { type: "string", description: "The reply message text" },
      },
      required: ["threadId", "message"],
    },
  },
  {
    name: "canvas_who",
    description: "Read-only: List active and enrolled actors currently known on this canvas.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "canvas_items",
    description: "Read-only: List items on the canvas with their titles, positions, sizes, and version counts.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "dispatch_task",
    description: "Slow work dispatch: Ask a parked background agent (e.g. @Gina, @Charlie) to build, edit, or test something. Creates a thread comment that wakes the agent asynchronously without blocking the voice turn.",
    parameters: {
      type: "object",
      properties: {
        agentName: { type: "string", description: "The name of the agent to summon (e.g. 'Gina')" },
        task: { type: "string", description: "Detailed task description for the agent" },
        itemId: { type: "string", description: "Optional item ID the task pertains to" },
        threadId: { type: "string", description: "Optional existing thread ID to post on" },
      },
      required: ["agentName", "task"],
    },
  },
];

/**
 * Asserts that no forbidden destructive actions exist in the manifest.
 */
export function assertVoiceToolSafety(tools: VoiceToolDeclaration[]): void {
  for (const tool of tools) {
    if (FORBIDDEN_VOICE_OPERATIONS.has(tool.name) || tool.name.includes("empty_trash") || tool.name.includes("delete_canvas") || tool.name.includes("delete_project")) {
      throw new Error(`Security violation: destructive operation '${tool.name}' must never be exposed as a voice tool.`);
    }
  }
}
