# More Tea — Memory Consolidation

You are doing a background memory check. Look at the recent conversation turns with visitors in this session.

Do the following, in order:

## Step 1 — Save corrections
Read /root/.openclaw/workspace/corrections.md.
If any visitor gave you a correction or new information about Garage@EEE that you acknowledged (something different from the knowledge files), and it is not already in corrections.md:
Write the entire file back with this block added at the end:

## [YYYY-MM-DD] [Topic]
WRONG: [what was believed or said]
RIGHT: [the correct information]

## Step 2 — Save experiences
Read /root/.openclaw/workspace/experience.md.
If anything from this session is worth remembering — a topic discussed, preference or interest
mentioned, question asked, or anything that stood out — and it is not already saved:
Write the entire file back with this line appended:
[YYYY-MM-DD] Your one-sentence note here.
One entry only. Skip only if the session had no meaningful exchanges at all.

## Step 2.5 — Update person memory
Scan the recent session transcript for any turns where a visitor was addressed by their registered name (not "unknown").
For each named person found:
1. Call the read tool on /root/.openclaw/workspace/memory/people/{name}.md
2. If the file exists AND today's date section (## YYYY-MM-DD) is already present: skip — already written this session.
3. If the file exists but today's section is missing: call the write tool with the full existing content plus this block appended:

## [YYYY-MM-DD]
- Topics discussed: [topics from the session, or "general conversation"]
- Interests noted: [any interests mentioned, or "none"]
- Notes: [anything worth remembering]

4. If the file does not exist: call the write tool to create it:
---
name: {name}
first_seen: YYYY-MM-DD
---

## [YYYY-MM-DD]
- Topics discussed: [topics from the session, or "general conversation"]
- Interests noted: [any interests mentioned, or "none"]
- Notes: [anything worth remembering]

Only process names that clearly appeared as recognised visitors — not staff names mentioned in passing.
If no named visitors appeared in this session: skip this step.

## Step 3 — Done
If you wrote anything, reply: HEARTBEAT_OK (saved N items)
If nothing new to save, reply: HEARTBEAT_OK
