/**
 * Type shim for openclaw/plugin-sdk
 * Declares the PluginAPI interface used in RosClaw index.ts.
 * The real SDK exposes OpenClawPluginApi with registerTool/registerCommand,
 * but this shim provides the older tools.register / commands.register shape
 * so the TypeScript compiler is satisfied.
 */

declare module "openclaw/plugin-sdk" {
  export interface PluginAPI {
    config: Record<string, unknown>;
    logger: {
      info(...args: unknown[]): void;
      warn(...args: unknown[]): void;
      error(...args: unknown[]): void;
    };
    tools: {
      register(def: {
        name: string;
        description: string;
        parameters: object;
        handler: (args: any) => Promise<unknown>;
      }): void;
    };
    commands: {
      register(def: {
        name: string;
        description: string;
        ownerOnly: boolean;
        handler: () => Promise<string>;
      }): void;
    };
    session?: {
      say(text: string): void;
      interrupt(text: string): void;
    };
  }
}
