# MoreTea Bridge Runtime Handoff

**Date:** 2026-03-30  
**Status:** Bridge-first runtime aligned with the live host setup

## Summary

This repo now treats the OpenClaw MCP bridge as the primary robot-control path.

The canonical runtime flow is:

1. Start the robot-side MCP server on the robot PC.
2. Start the SSH tunnel on the OpenClaw host so `127.0.0.1:8765` points to the robot MCP server.
3. Start OpenClaw in this container. The `openclaw-mcp-bridge` plugin connects directly to `http://127.0.0.1:8765/mcp`.
4. The bridge registers prefixed tools as `moretea_robot_*`.

The local `plugin/` directory is retained only as legacy/reference code. It is not part of the default runtime or build path.

## Runtime Shape

### Primary OpenClaw path

- Runtime plugin: `@aiwerk/openclaw-mcp-bridge`
- Mode: `direct`
- Server name: `moretea-robot`
- Transport: `streamable-http`
- Endpoint: `http://127.0.0.1:8765/mcp`
- Tool prefixing: enabled
- Exposed tool names: `moretea_robot_*`

### Why host networking matters

The container runs with `network_mode: host`, so `127.0.0.1:8765` inside the container is the OpenClaw host's loopback interface, where the SSH tunnel listens.

### mcporter

`mcporter.json` is retained only for manual diagnostics and ad-hoc debugging. It is not the primary runtime path for the OpenClaw agent in this repo.

## Expected Tool Surface

The bridge should expose the full robot MCP toolset with the `moretea_robot_` prefix:

- `moretea_robot_health`
- `moretea_robot_express_emotion`
- `moretea_robot_capture_image`
- `moretea_robot_get_recognized_faces`
- `moretea_robot_register_face`
- `moretea_robot_get_navigation_status`
- `moretea_robot_list_tour_stops`
- `moretea_robot_start_navigation_to_stop`
- `moretea_robot_wait_for_navigation_action`
- `moretea_robot_get_navigation_action_status`
- `moretea_robot_cancel_navigation`
- `moretea_robot_move`
- `moretea_robot_move_distance`
- `moretea_robot_stop_motion`
- `moretea_robot_get_odometry`
- `moretea_robot_get_battery`
- `moretea_robot_get_laser_scan`

## Verification Flow

### Host-side tunnel and endpoint

On the OpenClaw host:

```bash
cd /home/morerobot/FYP/moretea-robot-mcp
ROBOT_USER=<robot-user> ROBOT_HOST=<robot-ip> ./scripts/openclaw_tunnel.sh
```

Then verify the tunneled endpoint:

```bash
curl -i --max-time 5 -H 'Accept: text/event-stream' http://127.0.0.1:8765/mcp
```

Healthy behavior:

- HTTP `200 OK`
- `content-type: text/event-stream`
- request may stay open until curl times out

### Container-side bridge registration

Start the container:

```bash
docker compose up --build
```

Then verify bridge startup from inside the container:

```bash
docker exec moretea-openclaw openclaw sandbox explain --json
```

Healthy behavior:

- bridge logs show `Connected to server: moretea-robot`
- startup reports success
- OpenClaw reports the server initialized and registered the prefixed tools

### Agent smoke test

Use a direct agent prompt after the tunnel is up:

```bash
docker exec moretea-openclaw openclaw agent --local --session-id main --message "Check if the robot is ready" --json
```

Expected behavior:

- the agent calls `moretea_robot_health`
- the tool returns a readiness payload

## Troubleshooting

### Bridge config/name mismatch

Symptoms:

- skill says `moretea_robot_*` but the bridge exposes different names
- agent cannot find expected robot tools

Check:

- `openclaw.json` uses server name `moretea-robot`
- `toolPrefix` is `true`
- no stale docs or skills still reference `robot_core_*`

### Tunnel not running

Symptoms:

- bridge startup logs show connection failure
- `curl http://127.0.0.1:8765/mcp` gets connection refused

Check:

- the SSH tunnel process is alive on the OpenClaw host
- port `8765` is listening on host loopback

### Robot-side MCP server not running

Symptoms:

- tunnel exists, but the endpoint does not behave like an MCP SSE server
- the bridge connects inconsistently or hangs without useful tool responses

Check:

- robot PC has `moretea_robot_mcp.server` running
- the server was started after ROS and Nav2 were available

### Stale repo/runtime assumptions

Symptoms:

- docs mention the native `rosclaw` plugin as primary
- users reach for `mcporter` when debugging normal runtime access

Fix:

- treat `plugin/` as legacy/reference only
- treat `mcporter` as optional diagnostics only
- use the bridge-first flow above for all normal runtime checks
