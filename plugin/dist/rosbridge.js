/**
 * rosbridge.ts
 * Typed WebSocket client for the rosbridge v2.0 protocol.
 * Compatible with rosbridge_suite on ROS2 Humble.
 *
 * rosbridge protocol spec:
 * https://github.com/RobotWebTools/rosbridge_suite/blob/ros2/ROSBRIDGE_PROTOCOL.md
 */
import { WebSocket } from "ws";
export class RosbridgeClient {
    ws = null;
    subscribers = new Map();
    pendingServiceCalls = new Map();
    pendingActionFeedback = new Map();
    config;
    opId = 0;
    constructor(config) {
        this.config = config;
    }
    // ── Connection ─────────────────────────────────────────────────────────────
    connect() {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`rosbridge connection timed out (${this.config.url})`)), this.config.timeoutMs);
            this.ws = new WebSocket(this.config.url);
            this.ws.on("open", () => {
                clearTimeout(timer);
                resolve();
            });
            this.ws.on("message", (raw) => this.handleMessage(raw.toString()));
            this.ws.on("error", (err) => {
                clearTimeout(timer);
                reject(err);
            });
            this.ws.on("close", () => {
                // Reject any pending calls
                const err = new Error("rosbridge connection closed");
                this.pendingServiceCalls.forEach(({ reject }) => reject(err));
                this.pendingServiceCalls.clear();
                this.pendingActionFeedback.forEach(({ reject }) => reject(err));
                this.pendingActionFeedback.clear();
            });
        });
    }
    disconnect() {
        this.ws?.close();
        this.ws = null;
    }
    get connected() {
        return this.ws?.readyState === WebSocket.OPEN;
    }
    // ── Core send ──────────────────────────────────────────────────────────────
    send(payload) {
        if (!this.connected)
            throw new Error("Not connected to rosbridge");
        this.ws.send(JSON.stringify(payload));
    }
    nextId(prefix) {
        return `${prefix}_${++this.opId}`;
    }
    // ── Inbound message dispatcher ─────────────────────────────────────────────
    handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            return;
        }
        const op = msg["op"];
        if (op === "publish") {
            const topic = msg["topic"];
            const handlers = this.subscribers.get(topic) ?? [];
            handlers.forEach((h) => h(msg["msg"]));
            return;
        }
        if (op === "service_response") {
            const id = msg["id"];
            const pending = this.pendingServiceCalls.get(id);
            if (!pending)
                return;
            this.pendingServiceCalls.delete(id);
            if (msg["result"] === false) {
                pending.reject(new Error(String(msg["values"])));
            }
            else {
                pending.resolve(msg["values"]);
            }
            return;
        }
        if (op === "action_feedback") {
            const id = msg["id"];
            const pending = this.pendingActionFeedback.get(id);
            pending?.onFeedback?.(msg["feedback"]);
            return;
        }
        if (op === "action_result") {
            const id = msg["id"];
            const pending = this.pendingActionFeedback.get(id);
            if (!pending)
                return;
            this.pendingActionFeedback.delete(id);
            if (msg["status"] >= 4) {
                pending.reject(new Error(`Action failed with status ${msg["status"]}`));
            }
            else {
                pending.resolve(msg["result"]);
            }
        }
    }
    // ── Publish ────────────────────────────────────────────────────────────────
    publish(topic, msgType, msg) {
        this.send({ op: "publish", topic, type: msgType, msg });
    }
    // ── Subscribe (one-shot read) ──────────────────────────────────────────────
    subscribeOnce(topic, msgType, timeoutMs = 3000) {
        return new Promise((resolve, reject) => {
            const id = this.nextId("sub");
            const timer = setTimeout(() => {
                this.unsubscribe(topic, id);
                reject(new Error(`Timeout waiting for message on ${topic}`));
            }, timeoutMs);
            const handler = (msg) => {
                clearTimeout(timer);
                this.unsubscribe(topic, id);
                resolve(msg);
            };
            if (!this.subscribers.has(topic))
                this.subscribers.set(topic, []);
            this.subscribers.get(topic).push(handler);
            this.send({ op: "subscribe", id, topic, type: msgType });
        });
    }
    unsubscribe(topic, _id) {
        this.send({ op: "unsubscribe", topic });
        this.subscribers.delete(topic);
    }
    // ── Service call ───────────────────────────────────────────────────────────
    callService(service, serviceType, args = {}) {
        return new Promise((resolve, reject) => {
            const id = this.nextId("svc");
            this.pendingServiceCalls.set(id, { resolve, reject });
            this.send({ op: "call_service", id, service, type: serviceType, args });
            setTimeout(() => {
                if (this.pendingServiceCalls.has(id)) {
                    this.pendingServiceCalls.delete(id);
                    reject(new Error(`Service call ${service} timed out`));
                }
            }, 10_000);
        });
    }
    // ── Action goal (Nav2 / MoveIt2) ───────────────────────────────────────────
    // rosbridge_suite >=0.12 supports action_goal / action_result ops
    sendActionGoal(actionServer, actionType, goal, onFeedback) {
        return new Promise((resolve, reject) => {
            const id = this.nextId("action");
            this.pendingActionFeedback.set(id, { onFeedback, resolve, reject });
            this.send({ op: "action_goal", id, action_server: actionServer, action_type: actionType, goal });
            setTimeout(() => {
                if (this.pendingActionFeedback.has(id)) {
                    this.pendingActionFeedback.delete(id);
                    reject(new Error(`Action ${actionServer} timed out after 60s`));
                }
            }, 60_000);
        });
    }
    // ── Parameter get/set ──────────────────────────────────────────────────────
    async getParam(node, param) {
        return this.callService(`/${node}/get_parameters`, "rcl_interfaces/srv/GetParameters", { names: [param] });
    }
    async setParam(node, param, value) {
        await this.callService(`/${node}/set_parameters`, "rcl_interfaces/srv/SetParameters", { parameters: [{ name: param, value }] });
    }
    // ── Topic list ─────────────────────────────────────────────────────────────
    listTopics() {
        return this.callService("/rosapi/topics", "rosapi_msgs/srv/Topics", {});
    }
}
