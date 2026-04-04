/**
 * index.ts — RosClaw OpenClaw plugin
 *
 * Registers ROS2 tools into OpenClaw so the LLM agent can call them.
 * Compatible with ROS2 Humble + rosbridge_suite.
 *
 * How OpenClaw plugins work:
 *   1. The Gateway loads this module via jiti at runtime.
 *   2. register(api) is called once — you use api.tools.register() to
 *      declare each tool with a JSON schema the LLM uses to call it.
 *   3. When the LLM decides to use a tool, OpenClaw calls the handler
 *      and feeds the result back into the conversation.
 */
import { RosbridgeClient } from "./rosbridge.js";
import * as T from "./tools.js";
export async function register(api) {
    const config = api.config;
    const rosbridgeUrl = config.rosbridgeUrl ?? "ws://localhost:9090";
    const cmdVelTopic = config.cmdVelTopic ?? "/cmd_vel";
    const odomTopic = config.odomTopic ?? "/odom";
    const angularSign = config.angularSign ?? 1;
    const timeoutMs = config.connectionTimeoutMs ?? 5000;
    const faceDirectionYTopic = config.faceDirectionYTopic ?? "/face_direction_y";
    const faceDirectionYDownValue = config.faceDirectionYDownValue ?? "-";
    const faceDirectionYUpValue = config.faceDirectionYUpValue ?? "+";
    const faceDirectionYCenterValue = config.faceDirectionYCenterValue ?? "0";
    const faceDirectionYRepeatHz = config.faceDirectionYRepeatHz ?? 2;
    const faceDirectionYDurationMs = config.faceDirectionYDurationMs ?? 1500;
    // Lazy singleton connection — only connect when a tool is first used,
    // and reconnect automatically if dropped. This keeps startup fast.
    let ros = null;
    async function getRos() {
        if (ros?.connected)
            return ros;
        ros = new RosbridgeClient({ url: rosbridgeUrl, timeoutMs });
        await ros.connect();
        api.logger.info(`[rosclaw] Connected to rosbridge at ${rosbridgeUrl}`);
        return ros;
    }
    // ── /estop command — bypasses AI, fires immediately ────────────────────────
    api.commands.register({
        name: "estop",
        description: "Emergency stop — halts all robot motion immediately",
        ownerOnly: false,
        handler: async () => {
            try {
                const r = await getRos();
                const result = await T.eStop(r, cmdVelTopic);
                return result.success
                    ? "Emergency stop sent. All motion halted."
                    : `E-Stop failed: ${result.error}`;
            }
            catch (e) {
                return `E-Stop error: ${e}`;
            }
        },
    });
    // ── /cancel — cancel current Nav2 goal without full stop ──────────────────
    api.commands.register({
        name: "cancel",
        description: "Cancel current navigation goal. Robot stays where it is.",
        ownerOnly: false,
        handler: async () => {
            try {
                const r = await getRos();
                await r.callService("/navigate_to_pose/_action/cancel_goal", "action_msgs/srv/CancelGoal", { goal_info: { goal_id: { uuid: new Array(16).fill(0) }, stamp: { sec: 0, nanosec: 0 } } });
                return "Navigation cancelled.";
            }
            catch (e) {
                return `Cancel failed: ${e}`;
            }
        },
    });
    // ── /home — navigate to a safe home position defined in config ────────────
    api.commands.register({
        name: "home",
        description: "Navigate robot to its safe home/charging position",
        ownerOnly: true,
        handler: async () => {
            try {
                const r = await getRos();
                // Home position should be defined in config or memory.md
                // Default: origin (0, 0) — update this to your actual charging station coords
                const result = await T.navigateToPose(r, 0, 0, 0, "map");
                return result.success ? "Returning to home position." : `Home failed: ${result.error}`;
            }
            catch (e) {
                return `Home error: ${e}`;
            }
        },
    });
    // ── Tool: move (cmd_vel) ───────────────────────────────────────────────────
    api.tools.register({
        name: "ros2_move",
        description: "Send velocity commands to the robot. Use for direct movement: forward, backward, turn, stop. " +
            "For autonomous navigation to a specific coordinate, use ros2_navigate instead.",
        parameters: {
            type: "object",
            properties: {
                linear_x: {
                    type: "number",
                    description: "Forward (+) / backward (-) speed in m/s. Max ±0.5",
                },
                linear_y: {
                    type: "number",
                    description: "Sideways speed in m/s (0 for non-holonomic robots)",
                    default: 0,
                },
                angular_z: {
                    type: "number",
                    description: "Rotation speed in rad/s. Positive = counter-clockwise.",
                },
                duration_ms: {
                    type: "number",
                    description: "How long to apply the velocity in ms. 0 = publish once and leave running.",
                    default: 0,
                },
            },
            required: ["linear_x", "angular_z"],
        },
        handler: async ({ linear_x, linear_y = 0, angular_z, duration_ms = 0 }) => {
            try {
                const r = await getRos();
                return T.cmdVel(r, cmdVelTopic, linear_x, linear_y, angular_z, angularSign, duration_ms);
            }
            catch (e) {
                return { success: false, error: String(e) };
            }
        },
    });
    api.tools.register({
        name: "ros2_move_distance",
        description: "Move the robot a measured linear distance using odometry feedback. " +
            "Use this for commands like 'move forward 1 meter' or 'back up 0.5 meters'. " +
            "This is more accurate than time-based ros2_move.",
        parameters: {
            type: "object",
            properties: {
                distance_m: {
                    type: "number",
                    description: "Linear distance in meters. Positive = forward, negative = backward.",
                },
                speed_mps: {
                    type: "number",
                    description: "Requested speed in m/s. Keep small for accuracy. Default 0.15.",
                    default: 0.15,
                },
                odom_topic: {
                    type: "string",
                    description: `Odometry topic to measure distance from. Default: ${odomTopic}`,
                    default: odomTopic,
                },
            },
            required: ["distance_m"],
        },
        handler: async ({ distance_m, speed_mps = 0.15, odom_topic = odomTopic }) => {
            try {
                const r = await getRos();
                return T.moveLinearDistance(r, cmdVelTopic, odom_topic, distance_m, speed_mps);
            }
            catch (e) {
                return { success: false, error: String(e) };
            }
        },
    });
    api.tools.register({
        name: "ros2_motion_sequence",
        description: "Execute a sequence of motion steps serially on the robot. " +
            "Use this for multi-step instructions like 'move forward 1 meter, turn left 90 degrees, then move forward 1 meter'. " +
            "Do not split such requests into multiple motion tool calls.",
        parameters: {
            type: "object",
            properties: {
                steps: {
                    type: "array",
                    description: "Ordered motion steps to execute one by one.",
                    items: {
                        type: "object",
                        properties: {
                            action: {
                                type: "string",
                                enum: ["move", "turn", "pause"],
                                description: "Step type.",
                            },
                            distance_m: {
                                type: "number",
                                description: "For move steps: positive forward, negative backward.",
                            },
                            speed_mps: {
                                type: "number",
                                description: "For move steps: linear speed in m/s.",
                            },
                            angle_deg: {
                                type: "number",
                                description: "For turn steps: positive left, negative right.",
                            },
                            angular_speed_rad_s: {
                                type: "number",
                                description: "For turn steps: angular speed in rad/s.",
                            },
                            duration_ms: {
                                type: "number",
                                description: "For pause steps: pause duration in milliseconds.",
                            },
                        },
                        required: ["action"],
                    },
                },
            },
            required: ["steps"],
        },
        handler: async ({ steps }) => {
            try {
                const r = await getRos();
                return T.executeMotionSequence(r, cmdVelTopic, odomTopic, angularSign, steps);
            }
            catch (e) {
                return { success: false, error: String(e) };
            }
        },
    });
    api.tools.register({
        name: "ros2_face_direction_y",
        description: "Publish a face/neck vertical direction command to /face_direction_y. " +
            "Use this for up/down/center neck or face tilt control when the operator requests it.",
        parameters: {
            type: "object",
            properties: {
                direction: {
                    type: "string",
                    enum: ["up", "down", "center"],
                    description: "High-level face direction. Uses the robot's configured symbol mapping for /face_direction_y.",
                },
                value: {
                    type: "string",
                    description: "String to publish to /face_direction_y. Common robot-specific values are '-', '+', or '0'.",
                },
            },
        },
        handler: async ({ direction, value }) => {
            try {
                const r = await getRos();
                const resolvedValue = typeof direction === "string"
                    ? direction === "down"
                        ? faceDirectionYDownValue
                        : direction === "up"
                            ? faceDirectionYUpValue
                            : faceDirectionYCenterValue
                    : value;
                if (typeof resolvedValue !== "string" || !resolvedValue.trim()) {
                    return { success: false, error: "Provide either direction or value" };
                }
                return T.setFaceDirectionY(r, resolvedValue, faceDirectionYTopic, faceDirectionYRepeatHz, faceDirectionYDurationMs);
            }
            catch (e) {
                return { success: false, error: String(e) };
            }
        },
    });
    api.tools.register({
        name: "ros2_eye_expression",
        description: "Set the robot eye expression on /eye_expression. " +
            "Supports either an emotion name or an integer code 0-7. " +
            "Mapped emotions: neutral=0, happy=1, sad=2, angry=3, confused=4, shocked=5, love=6, shy=7.",
        parameters: {
            type: "object",
            properties: {
                emotion: {
                    type: "string",
                    description: "Emotion name. Supported: neutral, happy, sad, angry, confused, shocked, love, shy.",
                },
                code: {
                    type: "number",
                    description: "Optional raw /eye_expression code from 0 to 7.",
                },
            },
        },
        handler: async ({ emotion, code }) => {
            try {
                const r = await getRos();
                if (typeof code === "number") {
                    return T.setEyeExpression(r, code);
                }
                if (typeof emotion === "string") {
                    return T.setEyeExpression(r, emotion);
                }
                return { success: false, error: "Provide either emotion or code" };
            }
            catch (e) {
                return { success: false, error: String(e) };
            }
        },
    });
    // ── Tool: Nav2 navigate to pose (non-blocking) ────────────────────────────
    api.tools.register({
        name: "ros2_navigate",
        description: "Send an autonomous navigation goal to Nav2. Returns immediately once the goal is accepted — " +
            "do not wait for the robot to arrive before replying. " +
            "Say where you're going ('On my way to reception.') then stop talking. " +
            "Use ros2_cancel_navigation if the user asks to stop mid-journey. " +
            "Only use this for known map-frame destinations. Never infer x/y coordinates from a camera image or a guessed object position.",
        parameters: {
            type: "object",
            properties: {
                x: { type: "number", description: "Target X in map frame (meters)" },
                y: { type: "number", description: "Target Y in map frame (meters)" },
                yaw_degrees: { type: "number", description: "Target heading in degrees", default: 0 },
                frame_id: { type: "string", default: "map" },
                location_name: {
                    type: "string",
                    description: "Human-readable name of the destination (used in failure notifications)",
                },
            },
            required: ["x", "y"],
        },
        handler: async ({ x, y, yaw_degrees = 0, frame_id = "map", location_name = "destination" }) => {
            try {
                const r = await getRos();
                return T.navigateToPoseAsync(r, x, y, yaw_degrees, frame_id, (result) => {
                    // Background completion callback — fires when Nav2 finishes or fails
                    // If navigation failed, we need to interrupt the user.
                    // OpenClaw's session.say() is the correct API; use api.session if available,
                    // otherwise log for operator awareness.
                    if (!result.success) {
                        api.logger.warn(`[rosclaw] Navigation to ${location_name} failed: ${result.error}. ` +
                            `Consider implementing api.session.say() here to notify the user.`);
                        // TODO: when OpenClaw exposes a session interrupt API,
                        // call it here: api.session.interrupt(`I couldn't reach ${location_name}.`)
                    }
                });
            }
            catch (e) {
                return { success: false, error: String(e) };
            }
        },
    });
    // ── Tool: cancel current navigation ───────────────────────────────────────
    api.tools.register({
        name: "ros2_cancel_navigation",
        description: "Cancel the current Nav2 navigation goal. Call this if the user says 'stop', " +
            "'never mind', 'cancel', or changes destination mid-journey.",
        parameters: { type: "object", properties: {} },
        handler: async () => {
            // Cancel all tracked goals
            T.activeNavGoals.forEach(({ cancel }) => cancel());
            // Also send the Nav2 service cancel as a hard stop
            try {
                const r = await getRos();
                await r.callService("/navigate_to_pose/_action/cancel_goal", "action_msgs/srv/CancelGoal", { goal_info: { goal_id: { uuid: new Array(16).fill(0) }, stamp: { sec: 0, nanosec: 0 } } });
                return { success: true, data: "Navigation cancelled." };
            }
            catch (e) {
                return { success: false, error: String(e) };
            }
        },
    });
    // ── Tool: subscribe/read a topic ───────────────────────────────────────────
    api.tools.register({
        name: "ros2_read_topic",
        description: "Read the latest message from any ROS2 topic. Use for sensor data, battery state, robot pose, etc.",
        parameters: {
            type: "object",
            properties: {
                topic: {
                    type: "string",
                    description: "Full topic path, e.g. /battery or /odom",
                },
                msg_type: {
                    type: "string",
                    description: "ROS2 message type, e.g. sensor_msgs/msg/BatteryState. " +
                        "Use ros2_list_topics to discover available topics and types.",
                },
            },
            required: ["topic", "msg_type"],
        },
        handler: async ({ topic, msg_type }) => {
            try {
                const r = await getRos();
                return T.subscribeTopic(r, topic, msg_type);
            }
            catch (e) {
                return { success: false, error: String(e) };
            }
        },
    });
    // ── Tool: service call ─────────────────────────────────────────────────────
    api.tools.register({
        name: "ros2_service_call",
        description: "Call any ROS2 service. Use for discrete actions that return a result: " +
            "clearing costmaps, triggering behaviours, querying robot state.",
        parameters: {
            type: "object",
            properties: {
                service: {
                    type: "string",
                    description: "Full service path, e.g. /clear_costmap_around_robot",
                },
                service_type: {
                    type: "string",
                    description: "ROS2 service type, e.g. nav2_msgs/srv/ClearEntireCostmap",
                },
                args: {
                    type: "object",
                    description: "Service request fields. Use {} if the service takes no arguments.",
                    default: {},
                },
            },
            required: ["service", "service_type"],
        },
        handler: async ({ service, service_type, args = {} }) => {
            try {
                const r = await getRos();
                return T.callService(r, service, service_type, args);
            }
            catch (e) {
                return { success: false, error: String(e) };
            }
        },
    });
    // ── Tool: list topics ──────────────────────────────────────────────────────
    api.tools.register({
        name: "ros2_list_topics",
        description: "List all active ROS2 topics and their message types. " +
            "Call this first if you are unsure which topic or type to use.",
        parameters: { type: "object", properties: {} },
        handler: async () => {
            try {
                const r = await getRos();
                return T.listTopics(r);
            }
            catch (e) {
                return { success: false, error: String(e) };
            }
        },
    });
    // ── Tool: camera snapshot ──────────────────────────────────────────────────
    const imageTopic = config.imageTopic ?? "/camera/color/image_raw/compressed";
    api.tools.register({
        name: "ros2_camera_snapshot",
        description: "Capture a single image frame from the robot's camera. " +
            "Returns an image attachment the model can inspect, plus lightweight metadata. " +
            "Use this when the person asks 'what do you see?' or needs visual confirmation of the environment.",
        parameters: {
            type: "object",
            properties: {
                topic: {
                    type: "string",
                    description: `Camera topic to read from. Default: ${imageTopic}`,
                    default: imageTopic,
                },
            },
        },
        handler: async ({ topic = imageTopic }) => {
            try {
                const r = await getRos();
                return T.cameraSnapshot(r, topic);
            }
            catch (e) {
                return { success: false, error: String(e) };
            }
        },
    });
    // ── Tool: get param ────────────────────────────────────────────────────────
    api.tools.register({
        name: "ros2_get_param",
        description: "Read a parameter from a running ROS2 node.",
        parameters: {
            type: "object",
            properties: {
                node: { type: "string", description: "Node name without leading slash, e.g. controller_server" },
                param: { type: "string", description: "Parameter name, e.g. max_vel_x" },
            },
            required: ["node", "param"],
        },
        handler: async ({ node, param }) => {
            try {
                const r = await getRos();
                return T.getParam(r, node, param);
            }
            catch (e) {
                return { success: false, error: String(e) };
            }
        },
    });
    api.logger.info("[rosclaw] Plugin registered. rosbridge target:", rosbridgeUrl);
}
