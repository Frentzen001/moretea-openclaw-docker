/**
 * adapter.ts
 *
 * Bridges the RosClaw plugin's expected API shape (api.tools.register / api.commands.register)
 * to the current OpenClaw SDK shape (api.registerTool / api.registerCommand).
 *
 * This file is the real entry point declared in openclaw.plugin.json.
 * It wraps the real OpenClawPluginApi and calls the original RosClaw register() function
 * with a compatible shim.
 */
import { register as rosclawRegister } from "./index.js";
export async function register(api) {
    function buildToolResponse(result) {
        const data = result?.data;
        const hasImage = result?.success === true &&
            data &&
            typeof data === "object" &&
            typeof data.base64Image === "string" &&
            typeof data.mimeType === "string";
        if (!hasImage) {
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
                details: result,
            };
        }
        const { base64Image, ...imageSummary } = data;
        const summarized = {
            ...result,
            data: imageSummary,
        };
        return {
            content: [
                { type: "image", data: base64Image, mimeType: data.mimeType },
                { type: "text", text: JSON.stringify(summarized) },
            ],
            details: summarized,
        };
    }
    const adaptedApi = {
        // Spread real api so logger, runtime, etc. pass through
        ...api,
        // RosClaw reads plugin config from api.config — map from api.pluginConfig
        config: api.pluginConfig ?? {},
        // Adapt api.tools.register(def) → api.registerTool(agentTool)
        tools: {
            register: (def) => {
                api.registerTool({
                    name: def.name,
                    label: def.name,
                    description: def.description,
                    parameters: def.parameters,
                    execute: async (_toolCallId, params) => {
                        const result = await def.handler(params);
                        return buildToolResponse(result);
                    },
                });
            },
        },
        // Adapt api.commands.register(def) → api.registerCommand(def)
        commands: {
            register: (def) => {
                api.registerCommand({
                    name: def.name,
                    description: def.description,
                    requireAuth: def.ownerOnly,
                    handler: async (_ctx) => {
                        const text = await def.handler();
                        return { text };
                    },
                });
            },
        },
    };
    await rosclawRegister(adaptedApi);
}
