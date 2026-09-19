import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { intelligenceApi } from "./server/api/intelligencePlugin";

export default defineConfig({
  plugins: [react(), intelligenceApi()],
});
