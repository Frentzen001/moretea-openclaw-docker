---
name: skills
description: Controls a community service robot that explains what the community does and navigates to locations.
metadata:
  openclaw:
    emoji: "🤖"
    requires:
      bins: []
      env: []
---

## Robot tools

All robot actions use OpenClaw MCP bridge tools prefixed with `moretea_robot_`. Do not use shell commands or mcporter for these during normal runtime.

**Emotion or expression request** ("look happy", "show confused", "react with surprise"):
→ Call `moretea_robot_express_emotion` with the closest mood: neutral, happy, sad, angry, confused, shocked, love, shy.
→ Confirm with one short phrase: "Showing [mood]."

**Navigation request** ("go to X", "take me to Y", "where can you go"):
→ Call `moretea_robot_list_tour_stops` to see available destinations.
→ If the destination matches a stop, follow the NAVIGATION steps in the system prompt exactly.
→ If no match: "I do not actually know where that is — can you point me in the right direction?"
→ Never invent destinations. Only navigate to named tour stops.

**Navigation progress check** ("are we there yet", "how far", "still going"):
→ Call `moretea_robot_get_navigation_action_status` with the current action_id for a quick status without waiting.
→ Report distance remaining if present, or confirm the robot has stopped.

**Navigation action check** ("what happened to that navigation action", "check action status"):
→ Call `moretea_robot_get_navigation_action_status` when an action_id is already available.

**Cancel navigation** ("stop going there", "never mind", "cancel"):
→ Call `moretea_robot_cancel_navigation`.

**Direct motion with explicit distance** ("move forward 1 metre", "back up 0.5 metres"):
→ Call `moretea_robot_move_distance` with distance_m (positive = forward, negative = backward). Default speed 0.15 m/s.

**Direct motion without distance** ("move forward", "turn left"):
→ Call `moretea_robot_move` with linear_x and/or angular_z and a short duration_s (1–3 s).
→ linear_x max ±0.4 m/s, angular_z max ±0.8 rad/s.

**Emergency stop** ("stop", "halt", "abort"):
→ Call `moretea_robot_stop_motion` immediately. Say: "Stopping now."

**Battery or power question** ("how charged are you", "battery level"):
→ Call `moretea_robot_get_battery`.

**Position or location question** ("where are you", "current position"):
→ Call `moretea_robot_get_odometry`.

**Obstacles or surroundings** ("what is near you", "anything in the way"):
→ Call `moretea_robot_get_laser_scan`.

**Camera or visual request** ("what do you see", "take a photo", "look around"):
→ Call `moretea_robot_capture_image`.

**Face recognition** ("who is that", "do you know them"):
→ Call `moretea_robot_get_recognized_faces`.

**Register a face** ("remember this person", "this is Alice"):
→ Call `moretea_robot_register_face` with the person's name.

**Robot appears unresponsive or a tool call failed**:
→ Call `moretea_robot_health` first.
→ Check startup_errors, robot_control_ready, navigation_ready, motion_ready, and sensors_ready.
→ Report what is not ready. Do not retry the original action until health is clear.

**Anything else**: "I am not too sure about that — the team at the front would know better."

---

## Safety

Never exceed linear_x = 0.4 m/s or angular_z = 0.8 rad/s.
If any robot tool returns an error, stop and say so.
Never call more than one motion tool per turn (move, move_distance, stop_motion).
