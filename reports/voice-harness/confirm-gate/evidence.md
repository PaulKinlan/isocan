# The person's gate, clicked in a real browser

- harness: `isocan voice` listening at http://127.0.0.1:8042/ (daemon on 40327, home isocan-voice-confirm-Ank13h)
- page: canvas “Voice evidence” prj_voice · agent Voice usr_6x6_WXE4O6 · no provider (no key — the typed path)
- canvas before: Checkout screen, Settings screen
- ✓ the page asks about the item: "delete “Checkout screen”"
- ✓ asking is not doing: the item is still on the canvas
- ✓ no delete op while the question stands
- asked on the page: “delete “Checkout screen”” — and the canvas is untouched (Checkout screen, Settings screen)
- ✓ the no left the item alone
- ✓ the no minted no operation
- clicked No: the bar closed, the item is still there, and the oplog has no delete
- asked again: “delete “Checkout screen”” — and the live answer button HAS focus (confirm-yes), so a keyboard can answer it
- ✓ the yes deleted it — canvas now: Settings screen
- ✓ the yes minted the operation
- clicked Yes: the item is gone (Settings screen) and the oplog ends item.add → item.add → item.delete
- ✓ the ask is in the harness's log
- ✓ both answers are in the log: confirm_requested, confirm_declined, confirm_requested, confirm_allowed
- harness /log: confirm_requested, confirm_declined, confirm_requested, confirm_allowed

Screenshots: 01-question-standing.png, 02-answered-no.png, 03-answered-yes.png.
Raw: evidence.json. Run: `node scripts/voice-confirm-evidence.mjs`.
