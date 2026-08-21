import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

const clientPort = Number(process.env.WALLET_BOARD_CLIENT_PORT || 5173)
const apiPort = Number(process.env.WALLET_BOARD_PORT || 8791)
const host = process.env.WALLET_BOARD_HOST || "127.0.0.1"
const apiTargetHost = process.env.WALLET_BOARD_API_TARGET_HOST || process.env.WALLET_BOARD_API_HOST || "127.0.0.1"

export default defineConfig({
  plugins: [react()],
  base: "/opensea/",
  resolve: {
    // Workspace source lives under apps/nfttool, whose shell has its own React 18.
    // Keep the iframe runtime on the root React pair so elements never cross runtimes.
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "dist-opensea",
  },
  server: {
    host,
    port: clientPort,
    strictPort: true,
    proxy: {
      "/api": `http://${apiTargetHost}:${apiPort}`,
    },
  },
  preview: {
    host,
    port: clientPort,
    strictPort: true,
  },
})
