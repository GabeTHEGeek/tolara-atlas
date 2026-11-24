import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { intelligenceApi } from "./server/api/intelligencePlugin";
import { agentApi } from "./server/agent/agentPlugin";
import { realtimeApi } from "./server/agent/realtimePlugin";
import { contactsApi } from "./server/contacts/contactsPlugin";
import { scoresApi } from "./server/match/scoresPlugin";
import { seoPages } from "./server/seo/vitePlugin";

// The agent's API key is read from .env by the server-side plugin below
// (process.env, never import.meta.env) so it stays out of the bundle.
import { config as loadDotenv } from "dotenv";
loadDotenv();

// The public address of the built site. Search pages, the sitemap and social
// cards point here, and the app is built to be served from its path
// (GitHub Pages serves this repo under /tolara-atlas/). Override with
// SITE_URL=https://your.domain when hosting elsewhere.
const SITE_URL = (process.env.SITE_URL ?? "https://gabethegeek.github.io/tolara-atlas").replace(/\/$/, "");

export default defineConfig(({ command }) => ({
  base: command === "build" ? `${new URL(SITE_URL + "/").pathname}` : "/",
  plugins: [react(), intelligenceApi(), agentApi(), realtimeApi(), contactsApi(), scoresApi(), seoPages(SITE_URL)],
}));
