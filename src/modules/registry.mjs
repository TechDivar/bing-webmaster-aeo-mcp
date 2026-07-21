import { aeoModule } from "./aeo.mjs";
import { bingModule } from "./bing.mjs";
import { indexNowModule } from "./indexnow.mjs";
import { seoModule } from "./seo.mjs";

export const MODULE_DEFINITIONS = Object.freeze([
  bingModule,
  seoModule,
  aeoModule,
  indexNowModule
]);

export const MODULE_NAMES = Object.freeze(
  MODULE_DEFINITIONS.map(module => module.name)
);

export class ModuleConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModuleConfigurationError";
  }
}

export function resolveEnabledModules(value = process.env.MCP_MODULES) {
  const requested = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);

  if (!requested.length || requested.includes("all")) {
    return new Set(MODULE_NAMES);
  }

  const normalized = [...new Set(requested.map(item => item.toLowerCase()))];
  const unknown = normalized.filter(name => !MODULE_NAMES.includes(name));
  if (unknown.length) {
    throw new ModuleConfigurationError(
      `Unknown MCP module(s): ${unknown.join(", ")}. Choose from ${MODULE_NAMES.join(", ")}, or use all.`
    );
  }
  return new Set(normalized);
}

export function moduleForTool(toolName) {
  return MODULE_DEFINITIONS.find(module => module.matchesTool(toolName)) || null;
}

export function createModuleRegistrar(server, enabledModules) {
  return {
    registerTool(toolName, definition, handler) {
      const module = moduleForTool(toolName);
      if (!module) {
        throw new ModuleConfigurationError(
          `Tool ${toolName} is not assigned to an MCP module.`
        );
      }
      if (!enabledModules.has(module.name)) return null;
      return server.registerTool(toolName, definition, handler);
    }
  };
}
