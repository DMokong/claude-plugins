# L5 owner checklist — preserve half-typed parent input

This is the keyboard-only AC-19 check. It is not automated because automation would itself
modify the parent's input line.

- Start an A2A Codex member manually using the live script's launch form and scratch/state
  conventions; the automated script itself closes its members during cleanup.
- In the Claude parent's input line, type a distinctive string such as
  `L5-half-typed-DO-NOT-SEND`, but do not press Enter.
- Cause the member to call `crew_send` to the parent with a harmless body such as
  `L5 inbound check`.
- Confirm the inbound peer message wakes the idle parent and is visibly labelled as a peer
  message.
- Confirm the complete half-typed string is still present, byte-for-byte, in the input line
  and has not been submitted.
- Capture a screenshot or owner note recording the member name, time, and pass/fail result.
- Delete the half-typed string without submitting it, then close only the test member pane.

Pass only when both the labelled inbound message and the unchanged input text are observed.
