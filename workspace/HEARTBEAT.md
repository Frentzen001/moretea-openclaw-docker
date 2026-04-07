# More Tea — Memory Consolidation

You are doing a background memory check. Look at the recent conversation turns with visitors in this session.

Do the following, in order:

## Step 1 — Save corrections
Read /root/.openclaw/workspace/MEMORY.md.
Look at the # CORRECTIONS section.
If any visitor gave you a correction or new information about Garage@EEE that you acknowledged (something different from the knowledge files), and it is not already in # CORRECTIONS:
Write the entire file back with this block appended at the end of # CORRECTIONS:

## [YYYY-MM-DD] [Topic]
WRONG: [what was believed or said]
RIGHT: [the correct information]

## Step 2 — Save experiences
Read /root/.openclaw/workspace/MEMORY.md (use the version already loaded if available).
Look at the # EXPERIENCES section.
If anything from this session is worth remembering — a topic discussed, preference or interest
mentioned, question asked, or anything that stood out — and it is not already saved:
Write the entire file back with this line appended at the end of # EXPERIENCES:
[YYYY-MM-DD] Your one-sentence note here.
One entry only. Skip only if the session had no meaningful exchanges at all.

## Step 2.5 — Update person memory
Scan the recent session transcript for any turns where a visitor was addressed by their registered name (not "unknown").
For each named person found:
1. Read /root/.openclaw/workspace/MEMORY.md (use already-loaded version if available).
2. Find the ## {name} section under # PEOPLE.
3. If the section exists AND the most recent bullets already reflect this session's topics: skip — already written.
4. If the section exists but this session is not yet recorded: write the entire file back with these lines appended to that person's section:
   - Topics discussed: [topics from the session, or "general conversation"]
   - Interests noted: [any interests mentioned, or "none"]
   - Notes: [anything worth remembering]
5. If the section does not exist: write the entire file back with this appended to # PEOPLE:
   ## {name}
   first_seen: YYYY-MM-DD
   - Topics discussed: [topics from the session, or "general conversation"]
   - Interests noted: [any interests mentioned, or "none"]
   - Notes: [anything worth remembering]

Only process names that clearly appeared as recognised visitors — not staff names mentioned in passing.
If no named visitors appeared in this session: skip this step.

## Step 3 — Done
If you wrote anything, reply: HEARTBEAT_OK (saved N items)
If nothing new to save, reply: HEARTBEAT_OK
