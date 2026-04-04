/**
 * tools.ts
 * Defines every ROS2 tool the OpenClaw LLM agent can call.
 * Each tool is a plain async function that talks to rosbridge.
 *
 * Humble-specific notes:
 * - Nav2 action server: /navigate_to_pose  (nav2_msgs/action/NavigateToPose)
 * - Velocity: geometry_msgs/msg/Twist on /cmd_vel
 * - Battery: sensor_msgs/msg/BatteryState (if your robot publishes it)
 */
const EYE_EXPRESSION_MAP = {
    neutral: 0,
    happy: 1,
    sad: 2,
    angry: 3,
    confused: 4,
    shocked: 5,
    love: 6,
    shy: 7,
};
// ── Helper ─────────────────────────────────────────────────────────────────
function ok(data) {
    return { success: true, data };
}
function fail(error) {
    return { success: false, error };
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
function moveTowards(current, target, maxDelta) {
    if (current < target)
        return Math.min(current + maxDelta, target);
    return Math.max(current - maxDelta, target);
}
function zeroTwist() {
    return {
        linear: { x: 0, y: 0, z: 0 },
        angular: { x: 0, y: 0, z: 0 },
    };
}
function buildTwist(linear_x, linear_y, angular_z) {
    return {
        linear: { x: linear_x, y: linear_y, z: 0 },
        angular: { x: 0, y: 0, z: angular_z },
    };
}
function normalizeEyeExpressionName(value) {
    const normalized = value.trim().toLowerCase();
    const aliases = {
        neutral: "neutral",
        normal: "neutral",
        calm: "neutral",
        happy: "happy",
        smile: "happy",
        smiling: "happy",
        sad: "sad",
        unhappy: "sad",
        angry: "angry",
        mad: "angry",
        confused: "confused",
        puzzled: "confused",
        shocked: "shocked",
        surprised: "shocked",
        surprise: "shocked",
        love: "love",
        heart: "love",
        shy: "shy",
        embarrassed: "shy",
    };
    return aliases[normalized] ?? null;
}
function extractOdomPosition(msg) {
    const pose = msg?.["pose"];
    const nestedPose = pose?.["pose"];
    const position = nestedPose?.["position"];
    const x = position?.["x"];
    const y = position?.["y"];
    if (typeof x !== "number" || typeof y !== "number") {
        return null;
    }
    return { x, y };
}
function extractOdomYaw(msg) {
    const pose = msg?.["pose"];
    const nestedPose = pose?.["pose"];
    const orientation = nestedPose?.["orientation"];
    const x = orientation?.["x"];
    const y = orientation?.["y"];
    const z = orientation?.["z"];
    const w = orientation?.["w"];
    if (typeof x !== "number" ||
        typeof y !== "number" ||
        typeof z !== "number" ||
        typeof w !== "number") {
        return null;
    }
    const sinyCosp = 2 * (w * z + x * y);
    const cosyCosp = 1 - 2 * (y * y + z * z);
    return Math.atan2(sinyCosp, cosyCosp);
}
function normalizeAngleRadians(angle) {
    let normalized = angle;
    while (normalized > Math.PI)
        normalized -= 2 * Math.PI;
    while (normalized < -Math.PI)
        normalized += 2 * Math.PI;
    return normalized;
}
// ── Velocity / movement ────────────────────────────────────────────────────
/**
 * Publish a single Twist message to cmd_vel.
 * For timed movement, pair with a stop call after `durationMs`.
 */
export async function cmdVel(ros, topic, linear_x, linear_y, angular_z, angularSign = 1, durationMs = 0) {
    if (!ros.connected)
        return fail("Not connected to rosbridge");
    const effectiveAngularZ = angular_z * angularSign;
    const twist = buildTwist(linear_x, linear_y, effectiveAngularZ);
    try {
        if (durationMs <= 0) {
            ros.publish(topic, "geometry_msgs/msg/Twist", twist);
            return ok({ sent: twist, requested_angular_z: angular_z, duration_ms: durationMs });
        }
        const tickMs = 100;
        const rampMs = Math.min(400, Math.max(150, Math.floor(durationMs * 0.25)));
        const endTime = Date.now() + durationMs;
        while (Date.now() < endTime) {
            const now = Date.now();
            const elapsedMs = durationMs - Math.max(0, endTime - now);
            const remainingMs = Math.max(0, endTime - now);
            const rampIn = clamp(elapsedMs / rampMs, 0, 1);
            const rampOut = clamp(remainingMs / rampMs, 0, 1);
            const scale = Math.min(rampIn, rampOut, 1);
            ros.publish(topic, "geometry_msgs/msg/Twist", buildTwist(linear_x * scale, linear_y * scale, effectiveAngularZ * scale));
            await sleep(Math.min(tickMs, Math.max(10, endTime - Date.now())));
        }
        ros.publish(topic, "geometry_msgs/msg/Twist", zeroTwist());
        return ok({ sent: twist, requested_angular_z: angular_z, duration_ms: durationMs });
    }
    catch (e) {
        return fail(String(e));
    }
}
export async function moveLinearDistance(ros, cmdVelTopic, odomTopic, distanceMeters, speedMetersPerSecond = 0.15, timeoutMs) {
    if (!ros.connected)
        return fail("Not connected to rosbridge");
    if (!Number.isFinite(distanceMeters) || distanceMeters === 0) {
        return fail("distance_m must be a non-zero number");
    }
    if (Math.abs(distanceMeters) > 2) {
        return fail("Refusing to move more than 2 meters in one command");
    }
    if (!Number.isFinite(speedMetersPerSecond) || speedMetersPerSecond <= 0 || speedMetersPerSecond > 0.3) {
        return fail("speed_mps must be between 0 and 0.3");
    }
    const direction = distanceMeters >= 0 ? 1 : -1;
    const targetDistance = Math.abs(distanceMeters);
    const accelPerTick = 0.035;
    const tickMs = 100;
    try {
        const startMsg = await ros.subscribeOnce(odomTopic, "nav_msgs/msg/Odometry", 3000);
        const start = extractOdomPosition(startMsg);
        if (!start) {
            return fail(`Could not extract position from ${odomTopic}`);
        }
        const deadline = Date.now() +
            (timeoutMs ?? Math.max(5000, Math.ceil((targetDistance / speedMetersPerSecond) * 3000)));
        let lastDistance = 0;
        let commandedSpeed = 0;
        while (Date.now() < deadline) {
            const remainingDistance = Math.max(0, targetDistance - lastDistance);
            if (remainingDistance <= 0.01) {
                ros.publish(cmdVelTopic, "geometry_msgs/msg/Twist", zeroTwist());
                return ok({
                    target_m: distanceMeters,
                    traveled_m: Number(lastDistance.toFixed(3)),
                    speed_mps: speedMetersPerSecond,
                    odom_topic: odomTopic,
                });
            }
            const desiredSpeed = Math.min(speedMetersPerSecond, Math.max(0.03, remainingDistance * 1.2));
            commandedSpeed = moveTowards(commandedSpeed, desiredSpeed, accelPerTick);
            ros.publish(cmdVelTopic, "geometry_msgs/msg/Twist", buildTwist(commandedSpeed * direction, 0, 0));
            await sleep(tickMs);
            const currentMsg = await ros.subscribeOnce(odomTopic, "nav_msgs/msg/Odometry", 1000);
            const current = extractOdomPosition(currentMsg);
            if (!current) {
                continue;
            }
            lastDistance = Math.hypot(current.x - start.x, current.y - start.y);
            if (lastDistance >= targetDistance) {
                ros.publish(cmdVelTopic, "geometry_msgs/msg/Twist", zeroTwist());
                return ok({
                    target_m: distanceMeters,
                    traveled_m: Number(lastDistance.toFixed(3)),
                    speed_mps: speedMetersPerSecond,
                    odom_topic: odomTopic,
                });
            }
        }
        ros.publish(cmdVelTopic, "geometry_msgs/msg/Twist", zeroTwist());
        return fail(`Timed out before reaching target distance. Target=${targetDistance}m, traveled=${lastDistance.toFixed(3)}m`);
    }
    catch (e) {
        ros.publish(cmdVelTopic, "geometry_msgs/msg/Twist", zeroTwist());
        return fail(String(e));
    }
}
export async function turnAngle(ros, cmdVelTopic, odomTopic, angleDegrees, angularSpeedRadPerSec = 0.35, angularSign = 1, timeoutMs) {
    if (!ros.connected)
        return fail("Not connected to rosbridge");
    if (!Number.isFinite(angleDegrees) || angleDegrees === 0) {
        return fail("angle_deg must be a non-zero number");
    }
    if (Math.abs(angleDegrees) > 180) {
        return fail("Refusing to turn more than 180 degrees in one command");
    }
    if (!Number.isFinite(angularSpeedRadPerSec) ||
        angularSpeedRadPerSec <= 0 ||
        angularSpeedRadPerSec > 0.8) {
        return fail("angular_speed_rad_s must be between 0 and 0.8");
    }
    const targetRadians = Math.abs(angleDegrees) * (Math.PI / 180);
    const direction = angleDegrees >= 0 ? 1 : -1;
    const angularAccelPerTick = 0.12;
    const tickMs = 100;
    try {
        const startMsg = await ros.subscribeOnce(odomTopic, "nav_msgs/msg/Odometry", 3000);
        const startYaw = extractOdomYaw(startMsg);
        if (startYaw === null) {
            return fail(`Could not extract yaw from ${odomTopic}`);
        }
        const deadline = Date.now() +
            (timeoutMs ?? Math.max(5000, Math.ceil((targetRadians / angularSpeedRadPerSec) * 4000)));
        let turnedRadians = 0;
        let lastYaw = startYaw;
        let commandedAngularSpeed = 0;
        while (Date.now() < deadline) {
            const remainingRadians = Math.max(0, targetRadians - turnedRadians);
            if (remainingRadians <= (2 * Math.PI / 180)) {
                ros.publish(cmdVelTopic, "geometry_msgs/msg/Twist", zeroTwist());
                return ok({
                    target_deg: angleDegrees,
                    turned_deg: Number((turnedRadians * 180 / Math.PI).toFixed(1)),
                    odom_topic: odomTopic,
                });
            }
            const desiredAngularSpeed = Math.min(angularSpeedRadPerSec, Math.max(0.08, remainingRadians * 1.8));
            commandedAngularSpeed = moveTowards(commandedAngularSpeed, desiredAngularSpeed, angularAccelPerTick);
            ros.publish(cmdVelTopic, "geometry_msgs/msg/Twist", buildTwist(0, 0, direction * commandedAngularSpeed * angularSign));
            await sleep(tickMs);
            const currentMsg = await ros.subscribeOnce(odomTopic, "nav_msgs/msg/Odometry", 1000);
            const currentYaw = extractOdomYaw(currentMsg);
            if (currentYaw === null) {
                continue;
            }
            // Accumulate incremental yaw deltas so large turns remain measurable
            // even when odometry crosses the -pi / +pi wrap boundary.
            const deltaYaw = normalizeAngleRadians(currentYaw - lastYaw);
            lastYaw = currentYaw;
            // Ignore small reverse/noise blips while still allowing the commanded
            // turn direction to accumulate naturally.
            turnedRadians += Math.max(0, deltaYaw * direction);
            if (turnedRadians >= targetRadians) {
                ros.publish(cmdVelTopic, "geometry_msgs/msg/Twist", zeroTwist());
                return ok({
                    target_deg: angleDegrees,
                    turned_deg: Number((turnedRadians * 180 / Math.PI).toFixed(1)),
                    odom_topic: odomTopic,
                });
            }
        }
        ros.publish(cmdVelTopic, "geometry_msgs/msg/Twist", zeroTwist());
        return fail(`Timed out before reaching target angle. Target=${Math.abs(angleDegrees)}deg, turned=${(turnedRadians * 180 / Math.PI).toFixed(1)}deg`);
    }
    catch (e) {
        ros.publish(cmdVelTopic, "geometry_msgs/msg/Twist", zeroTwist());
        return fail(String(e));
    }
}
export async function executeMotionSequence(ros, cmdVelTopic, odomTopic, angularSign, steps) {
    if (!ros.connected)
        return fail("Not connected to rosbridge");
    if (!Array.isArray(steps) || steps.length === 0) {
        return fail("steps must contain at least one motion step");
    }
    if (steps.length > 8) {
        return fail("Refusing motion sequences longer than 8 steps");
    }
    const results = [];
    for (const [index, step] of steps.entries()) {
        let stepResult;
        if (step.action === "move") {
            if (!Number.isFinite(step.distance_m)) {
                return fail(`Step ${index + 1}: move requires distance_m`);
            }
            stepResult = await moveLinearDistance(ros, cmdVelTopic, odomTopic, step.distance_m, step.speed_mps ?? 0.15);
        }
        else if (step.action === "turn") {
            if (!Number.isFinite(step.angle_deg)) {
                return fail(`Step ${index + 1}: turn requires angle_deg`);
            }
            stepResult = await turnAngle(ros, cmdVelTopic, odomTopic, step.angle_deg, step.angular_speed_rad_s ?? 0.35, angularSign);
        }
        else if (step.action === "pause") {
            const durationMs = step.duration_ms ?? 500;
            if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 10000) {
                return fail(`Step ${index + 1}: pause duration_ms must be between 0 and 10000`);
            }
            ros.publish(cmdVelTopic, "geometry_msgs/msg/Twist", zeroTwist());
            await sleep(durationMs);
            stepResult = ok({ paused_ms: durationMs });
        }
        else {
            return fail(`Step ${index + 1}: unsupported action`);
        }
        if (!stepResult.success) {
            return fail(`Sequence stopped at step ${index + 1}: ${stepResult.error}`);
        }
        results.push({
            step: index + 1,
            action: step.action,
            result: stepResult.data,
        });
    }
    ros.publish(cmdVelTopic, "geometry_msgs/msg/Twist", zeroTwist());
    return ok({ completed_steps: results.length, steps: results });
}
export async function publishStringTopic(ros, topic, value, repeatHz = 0, durationMs = 0) {
    if (!ros.connected)
        return fail("Not connected to rosbridge");
    if (!value.trim())
        return fail("value must be a non-empty string");
    try {
        if (repeatHz > 0 && durationMs > 0) {
            const intervalMs = Math.max(50, Math.floor(1000 / repeatHz));
            const endTime = Date.now() + durationMs;
            let publishCount = 0;
            while (Date.now() < endTime) {
                ros.publish(topic, "std_msgs/msg/String", { data: value });
                publishCount += 1;
                await sleep(Math.min(intervalMs, Math.max(10, endTime - Date.now())));
            }
            return ok({ topic, value, repeat_hz: repeatHz, duration_ms: durationMs, publish_count: publishCount });
        }
        ros.publish(topic, "std_msgs/msg/String", { data: value });
        return ok({ topic, value });
    }
    catch (e) {
        return fail(String(e));
    }
}
export async function setFaceDirectionY(ros, value, topic = "/face_direction_y", repeatHz = 0, durationMs = 0) {
    return publishStringTopic(ros, topic, value, repeatHz, durationMs);
}
export async function setEyeExpression(ros, input, topic = "/eye_expression") {
    if (!ros.connected)
        return fail("Not connected to rosbridge");
    let code = null;
    let emotion = null;
    if (typeof input === "number") {
        code = input;
        emotion =
            Object.entries(EYE_EXPRESSION_MAP).find(([, mappedCode]) => mappedCode === input)?.[0] ?? null;
    }
    else {
        emotion = normalizeEyeExpressionName(input);
        if (emotion !== null) {
            code = EYE_EXPRESSION_MAP[emotion];
        }
        else if (/^\d+$/.test(input.trim())) {
            code = Number(input.trim());
        }
    }
    if (!Number.isInteger(code) || code < 0 || code > 7) {
        return fail("eye_expression must be an emotion name or integer code between 0 and 7");
    }
    try {
        ros.publish(topic, "std_msgs/msg/Int32", { data: code });
        return ok({ topic, code, emotion: emotion ?? "custom" });
    }
    catch (e) {
        return fail(String(e));
    }
}
// Active navigation goals — keyed by goalId.
// The plugin checks this map to cancel on interrupt.
export const activeNavGoals = new Map();
/**
 * Send a NavigateToPose goal to Nav2.
 *
 * Returns IMMEDIATELY after the action server accepts the goal.
 * The robot starts moving; the LLM does not block waiting for arrival.
 *
 * completionPromise resolves when the robot arrives or fails.
 * Wire this to a background callback that notifies the user if navigation fails.
 *
 * Humble Nav2 action server: /navigate_to_pose
 */
export function navigateToPoseAsync(ros, x, y, yaw_degrees = 0, frame_id = "map", onComplete) {
    if (!ros.connected)
        return Promise.resolve(fail("Not connected to rosbridge"));
    const yaw_rad = (yaw_degrees * Math.PI) / 180;
    const qz = Math.sin(yaw_rad / 2);
    const qw = Math.cos(yaw_rad / 2);
    const goal = {
        pose: {
            header: { stamp: { sec: 0, nanosec: 0 }, frame_id },
            pose: {
                position: { x, y, z: 0 },
                orientation: { x: 0, y: 0, z: qz, w: qw },
            },
        },
        behavior_tree: "",
    };
    // rosbridge sends action_result when Nav2 completes.
    // We start the action, get a local goal ID, and return accepted immediately.
    // The completion runs in the background via onComplete callback.
    const goalId = `nav_${Date.now()}`;
    let cancelled = false;
    activeNavGoals.set(goalId, {
        cancel: () => {
            cancelled = true;
            ros.callService("/navigate_to_pose/_action/cancel_goal", "action_msgs/srv/CancelGoal", { goal_info: { goal_id: { uuid: new Array(16).fill(0) }, stamp: { sec: 0, nanosec: 0 } } }).catch(() => { });
            activeNavGoals.delete(goalId);
        },
    });
    // Fire the action in the background — do not await here
    ros.sendActionGoal("/navigate_to_pose", "nav2_msgs/action/NavigateToPose", goal, undefined // feedback handler optional — omit to keep context clean
    ).then((result) => {
        activeNavGoals.delete(goalId);
        if (!cancelled)
            onComplete?.(ok(result));
    }).catch((e) => {
        activeNavGoals.delete(goalId);
        if (!cancelled)
            onComplete?.(fail(String(e)));
    });
    // Return immediately — LLM gets "accepted" and can speak confirmation now
    return Promise.resolve(ok({
        status: "accepted",
        goalId,
        target: { x, y, yaw_degrees },
        message: `Navigation started toward (${x}, ${y}). Robot is moving.`,
    }));
}
// Keep the original blocking version for cases where you need to await arrival
export async function navigateToPose(ros, x, y, yaw_degrees = 0, frame_id = "map", onFeedback) {
    if (!ros.connected)
        return fail("Not connected to rosbridge");
    const yaw_rad = (yaw_degrees * Math.PI) / 180;
    const qz = Math.sin(yaw_rad / 2);
    const qw = Math.cos(yaw_rad / 2);
    const goal = {
        pose: {
            header: { stamp: { sec: 0, nanosec: 0 }, frame_id },
            pose: {
                position: { x, y, z: 0 },
                orientation: { x: 0, y: 0, z: qz, w: qw },
            },
        },
        behavior_tree: "",
    };
    try {
        const result = await ros.sendActionGoal("/navigate_to_pose", "nav2_msgs/action/NavigateToPose", goal, onFeedback);
        return ok(result);
    }
    catch (e) {
        return fail(String(e));
    }
}
// ── Emergency stop ─────────────────────────────────────────────────────────
export async function eStop(ros, cmdVelTopic) {
    if (!ros.connected)
        return fail("Not connected to rosbridge");
    try {
        // Publish zero twist AND call Nav2 cancel service
        ros.publish(cmdVelTopic, "geometry_msgs/msg/Twist", {
            linear: { x: 0, y: 0, z: 0 },
            angular: { x: 0, y: 0, z: 0 },
        });
        // Cancel all Nav2 goals
        await ros.callService("/navigate_to_pose/_action/cancel_goal", "action_msgs/srv/CancelGoal", { goal_info: { goal_id: { uuid: new Array(16).fill(0) }, stamp: { sec: 0, nanosec: 0 } } }).catch(() => {
            // Nav2 may not be running; ignore cancel errors during estop
        });
        return ok("Emergency stop sent");
    }
    catch (e) {
        return fail(String(e));
    }
}
// ── Subscribe once (read a topic) ─────────────────────────────────────────
// Returns a compact summary, not the raw ROS message.
// Raw messages can be 20+ fields — sending them to the LLM inflates context
// and increases TTFT. Summarize here before the result enters the model.
export async function subscribeTopic(ros, topic, msgType) {
    if (!ros.connected)
        return fail("Not connected to rosbridge");
    try {
        const raw = await ros.subscribeOnce(topic, msgType);
        // Return the raw message only if caller explicitly wants it.
        // For known types, return a compact summary instead.
        return ok(compactSummary(topic, msgType, raw));
    }
    catch (e) {
        return fail(String(e));
    }
}
/**
 * Reduces a ROS message to a short string or small object.
 * Add cases here as you discover new topics your robot uses.
 * Unknown types fall back to returning the full message (safe but verbose).
 */
function compactSummary(topic, msgType, msg) {
    if (msgType.includes("BatteryState")) {
        const pct = Math.round(msg["percentage"] * 100);
        const v = msg["voltage"]?.toFixed(1);
        return `Battery: ${pct}% (${v}V)`;
    }
    if (msgType.includes("Odometry") || topic.includes("odom")) {
        const pose = msg["pose"]?.["pose"];
        const pos = pose?.["position"];
        if (pos) {
            return `Position: x=${pos["x"]?.toFixed(2)}, y=${pos["y"]?.toFixed(2)}`;
        }
    }
    if (msgType.includes("PoseWithCovarianceStamped") || topic === "/pose") {
        const poseWithCov = msg["pose"];
        const pose = poseWithCov?.["pose"];
        const pos = pose?.["position"];
        if (pos) {
            return `Pose: x=${pos["x"]?.toFixed(2)}, y=${pos["y"]?.toFixed(2)}`;
        }
    }
    if (msgType.includes("LaserScan") || topic.includes("scan")) {
        const ranges = msg["ranges"];
        if (ranges) {
            const min = Math.min(...ranges.filter(isFinite)).toFixed(2);
            return `Nearest obstacle: ${min}m`;
        }
    }
    if (msgType.includes("NavSatFix")) {
        return `GPS: ${msg["latitude"]}, ${msg["longitude"]} (status ${msg["status"]?.["status"]})`;
    }
    // Unknown type — return as-is but warn that it may inflate context
    return msg;
}
// ── Service call (generic) ─────────────────────────────────────────────────
export async function callService(ros, service, serviceType, args) {
    if (!ros.connected)
        return fail("Not connected to rosbridge");
    try {
        const result = await ros.callService(service, serviceType, args);
        return ok(result);
    }
    catch (e) {
        return fail(String(e));
    }
}
// ── Topic list (discovery) ─────────────────────────────────────────────────
export async function listTopics(ros) {
    if (!ros.connected)
        return fail("Not connected to rosbridge");
    try {
        const result = await ros.listTopics();
        return ok(result);
    }
    catch (e) {
        return fail(String(e));
    }
}
// ── Battery state ──────────────────────────────────────────────────────────
export async function getBatteryState(ros, batteryTopic = "/battery") {
    return subscribeTopic(ros, batteryTopic, "sensor_msgs/msg/BatteryState");
}
export async function cameraSnapshot(ros, imageTopic) {
    if (!ros.connected)
        return fail("Not connected to rosbridge");
    const compressedTopic = imageTopic.includes("/compressed")
        ? imageTopic
        : `${imageTopic}/compressed`;
    try {
        const compressedMsg = await ros.subscribeOnce(compressedTopic, "sensor_msgs/msg/CompressedImage", 5000);
        const format = compressedMsg.format ?? "jpeg";
        const normalized = format.toLowerCase();
        const mimeType = normalized.includes("png")
            ? "image/png"
            : normalized.includes("webp")
                ? "image/webp"
                : "image/jpeg";
        return ok({
            topic: compressedTopic,
            format,
            mimeType,
            base64Image: compressedMsg.data,
        });
    }
    catch (compressedError) {
        try {
            const rawMsg = await ros.subscribeOnce(imageTopic, "sensor_msgs/msg/Image", 5000);
            return ok({
                topic: imageTopic,
                width: rawMsg.width,
                height: rawMsg.height,
                encoding: rawMsg.encoding,
                error: `Read raw image metadata from ${imageTopic}, but a compressed image stream was not available. ` +
                    `Compressed attempt failed: ${compressedError}`,
            });
        }
        catch (rawError) {
            return fail(`Could not read image from ${imageTopic} or ${compressedTopic}: ${rawError}`);
        }
    }
}
// ── ROS2 param get/set ─────────────────────────────────────────────────────
export async function getParam(ros, node, param) {
    if (!ros.connected)
        return fail("Not connected to rosbridge");
    try {
        const result = await ros.getParam(node, param);
        return ok(result);
    }
    catch (e) {
        return fail(String(e));
    }
}
export async function setParam(ros, node, param, value) {
    if (!ros.connected)
        return fail("Not connected to rosbridge");
    try {
        await ros.setParam(node, param, value);
        return ok(`Set ${node}/${param} = ${value}`);
    }
    catch (e) {
        return fail(String(e));
    }
}
