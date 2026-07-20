import { defineConfig } from "vite";

export default defineConfig({
  base: "/crypto-lab-encrochat/",
  server: {
    port: 5173,
    host: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
