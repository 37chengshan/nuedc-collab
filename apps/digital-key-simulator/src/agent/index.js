export {
  DigitalKeyAgentError,
  normalizeAgentError,
} from "./errors.js";
export { AgentEventStream } from "./events.js";
export { UwbRecorderReadOnlyProxy } from "./live-proxy.js";
export { DigitalKeyCommandRegistry } from "./registry.js";
export {
  AGENT_PROTOCOL_VERSION,
  AGENT_SCHEMA_VERSION,
  DIGITAL_KEY_COMMAND_DEFINITIONS,
  JSON_SCHEMA_DRAFT,
} from "./schemas.js";
export { DigitalKeyRuntime } from "./runtime.js";

import { DigitalKeyRuntime } from "./runtime.js";

export function createDigitalKeyRuntime(options = {}) {
  return new DigitalKeyRuntime(options);
}

