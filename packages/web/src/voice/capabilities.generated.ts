/**
 * GENERATED — do not edit. `node scripts/voice-capability-sweep.mjs` writes
 * this from the same rows as docs/projects/voice-harness/capability-sweep.md,
 * and `--check` fails when it is stale. The help dialog renders it, and
 * packages/web/test/voicehelp.test.ts fails when the dialog and the sweep
 * disagree — which is the only reason a help section stays true.
 */
export const HELP_COUNTS = {
  "total": 187,
  "tooled": 124,
  "missing": 34,
  "excluded": 29
} as const;
export const HELP_GROUPS = [
  {
    "title": "Remember things for later",
    "acts": [
      {
        "label": "Read one stored memory",
        "tool": "read_memory"
      },
      {
        "label": "Remember a fact for a later session",
        "tool": "remember"
      },
      {
        "label": "Search its memories",
        "tool": "search_memory"
      }
    ]
  },
  {
    "title": "Files in the folder you granted",
    "acts": [
      {
        "label": "List the folder you granted",
        "tool": "list_dir"
      },
      {
        "label": "Read one file from the folder you granted",
        "tool": "read_file"
      }
    ]
  },
  {
    "title": "Find and read what is there",
    "acts": [
      {
        "label": "Find items by what they say",
        "tool": "find_items"
      },
      {
        "label": "Read the canvas",
        "tool": "read_canvas"
      },
      {
        "label": "Read one item, and its versions",
        "tool": "read_item"
      },
      {
        "label": "See who is live on the canvas",
        "tool": "read_presence"
      },
      {
        "label": "Read threads and comments",
        "tool": "read_threads"
      }
    ]
  },
  {
    "title": "Put things on the canvas",
    "acts": [
      {
        "label": "Add a note, a card, a link or an image",
        "tool": "add_item"
      },
      {
        "label": "Draw ink on the canvas",
        "tool": "drawing_add"
      }
    ]
  },
  {
    "title": "Change what is already there",
    "acts": [
      {
        "label": "Keep an item's text as a new version",
        "tool": "item_add_version"
      },
      {
        "label": "React to an item with an emoji",
        "tool": "item_react"
      },
      {
        "label": "Switch an item to another version",
        "tool": "item_set_current_version"
      },
      {
        "label": "Rename an item",
        "tool": "rename_item"
      },
      {
        "label": "Change an item's text, title or description",
        "tool": "update_item"
      }
    ]
  },
  {
    "title": "Move, resize and point the view",
    "acts": [
      {
        "label": "Move several items at once",
        "tool": "items_move"
      },
      {
        "label": "Move an item",
        "tool": "move_item"
      },
      {
        "label": "Resize an item",
        "tool": "resize_item"
      },
      {
        "label": "Clear the selection",
        "tool": "selection_clear"
      },
      {
        "label": "Select items",
        "tool": "selection_set"
      },
      {
        "label": "Bring an item into somebody's view",
        "tool": "viewport_focus"
      },
      {
        "label": "Pan the view",
        "tool": "viewport_pan"
      }
    ]
  },
  {
    "title": "Remove, and bring back",
    "acts": [
      {
        "label": "Move an item to the trash",
        "tool": "delete_item"
      },
      {
        "label": "Move several items to the trash",
        "tool": "items_delete"
      },
      {
        "label": "Bring several items back",
        "tool": "items_restore"
      },
      {
        "label": "Bring an item back from the trash",
        "tool": "restore_item"
      }
    ]
  },
  {
    "title": "Talk on the canvas",
    "acts": [
      {
        "label": "Ask a question in the Chat and wait for an answer",
        "tool": "ask"
      },
      {
        "label": "Leave a comment on an item",
        "tool": "comment_on_item"
      },
      {
        "label": "Edit a comment",
        "tool": "comment_update"
      },
      {
        "label": "Post in the Chat without waiting for an answer",
        "tool": "notify"
      },
      {
        "label": "Say something in the Chat",
        "tool": "say"
      },
      {
        "label": "Start a thread on an item",
        "tool": "thread_create"
      },
      {
        "label": "Delete a thread and its comments",
        "tool": "thread_delete"
      },
      {
        "label": "Pin a thread to a point on the canvas",
        "tool": "thread_set_anchor"
      },
      {
        "label": "Make a thread the canvas's main Chat",
        "tool": "thread_set_main"
      }
    ]
  },
  {
    "title": "Identity and other agents",
    "acts": [
      {
        "label": "Fold another of this machine's identities into itself",
        "tool": "actor_join"
      },
      {
        "label": "Change the colour of its own presence",
        "tool": "actor_set_color"
      },
      {
        "label": "Change the emoji on its own presence",
        "tool": "actor_set_mark"
      },
      {
        "label": "Enrol another agent so it can be summoned by name",
        "tool": "agent_enroll"
      },
      {
        "label": "Withdraw an enrolled agent",
        "tool": "agent_withdraw"
      }
    ]
  }
] as const;
export const HELP_REFUSED = [
  {
    "label": "project.delete",
    "why": "confirmation-gated; a canvas is not deleted unattended"
  },
  {
    "label": "item.removeVersion",
    "why": "internal: the engine refuses it from clients (INTERNAL_OP_TYPES); it is addVersion's undo inverse"
  },
  {
    "label": "item.restoreVersion",
    "why": "internal: same set — removeVersion's inverse"
  },
  {
    "label": "trash.empty",
    "why": "confirmation-gated; purge is not an unattended act"
  },
  {
    "label": "comment.remove",
    "why": "internal: the engine refuses it from clients; removing a comment is deleting its thread"
  },
  {
    "label": "comment.restore",
    "why": "internal: comment.remove's undo inverse"
  },
  {
    "label": "thread.restore",
    "why": "internal: thread.delete's undo inverse"
  },
  {
    "label": "wait",
    "why": "a voice turn ends when the person stops talking; parking belongs to a summoned agent"
  },
  {
    "label": "trash empty",
    "why": "confirmation-gated"
  },
  {
    "label": "undo / redo",
    "why": "history belongs to the operator; the agent issues a new operation instead"
  },
  {
    "label": "open / pass / embed",
    "why": "credentials and entry are the operator's"
  },
  {
    "label": "share / space / group / badges",
    "why": "access control is operator-only"
  },
  {
    "label": "canvas background / archive / delete",
    "why": "archival and deletion are operator acts"
  },
  {
    "label": "map / tree",
    "why": "no voice act; `read_canvas` answers the question"
  },
  {
    "label": "inline / copy / blobs",
    "why": "machine helpers, not canvas acts"
  },
  {
    "label": "identity",
    "why": "the harness's enrolled actor is its identity; identity is set before the microphone opens"
  },
  {
    "label": "serve / status / restart / stop / upgrade / setup / clone / use / home / direct / mcp / gc / harness / voice / rc / agent add-remove",
    "why": "operator infrastructure, not a canvas capability"
  },
  {
    "label": "prefer / choose / persona",
    "why": "operator configuration"
  },
  {
    "label": "inbox / doc / context",
    "why": "inbox and configuration belong to the person; AGENTS.md is already loaded into the model's instruction"
  },
  {
    "label": "sprint / design / evals / whatsnew / recap / timeline / lens / history / tail / activity / at / shortcuts / tool / command / module",
    "why": "none of them is a canvas mutation; the ones a voice agent needs (`read_activity`) are listed in the agent-guide table"
  },
  {
    "label": "help",
    "why": "the model already has the system instruction and the tool declarations"
  },
  {
    "label": "Wait for another agent",
    "why": "parking belongs to the summoned agent, not the microphone"
  },
  {
    "label": "Summon an agent (`rc turn`)",
    "why": "a machine-side act, on another host"
  },
  {
    "label": "Identity (`--as`, `--session`)",
    "why": "the harness's enrolled actor is its identity"
  },
  {
    "label": "Remove / restore a version",
    "why": "internal ops; the engine refuses them from clients"
  },
  {
    "label": "Permanent trash purge",
    "why": "confirmation-gated"
  },
  {
    "label": "Share links and permissions",
    "why": "operator-only"
  },
  {
    "label": "Background / ground / theme",
    "why": "taste, and the person is looking at it"
  },
  {
    "label": "Undo / redo",
    "why": "history belongs to the operator"
  }
] as const;
