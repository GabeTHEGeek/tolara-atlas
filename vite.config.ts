import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { intelligenceApi } from "./server/api/intelligencePlugin";
import { agentApi } from "./server/agent/agentPlugin";
import { realtimeApi } from "./server/agent/realtimePlugin";

// The agent's API key is read from .env by the server-side plugin below
// (process.env, never import.meta.env) so it stays out of the bundle.
import { config as loadDotenv } from "dotenv";
loadDotenv();

export default defineConfig({
  plugins: [react(), intelligenceApi(), agentApi(), realtimeApi()],
});
