/// <reference types="vite/client" />

import type { DigitalKeyAgentClient } from "./ui/agent-client";

declare global {
  interface Window {
    digitalKeyAgent?: {
      v1: DigitalKeyAgentClient;
    };
  }
}

export {};
