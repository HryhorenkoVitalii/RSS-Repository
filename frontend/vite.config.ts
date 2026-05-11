import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

const API_UPSTREAM = 'http://127.0.0.1:8080';

function backendProxy(): ProxyOptions {
  return {
    target: API_UPSTREAM,
    changeOrigin: true,
    configure(proxy) {
      proxy.on('error', (_err, _req, res) => {
        const r = res as {
          headersSent?: boolean;
          writableEnded?: boolean;
          writeHead?: (code: number, headers: Record<string, string>) => void;
          end?: (chunk: string) => void;
        };
        if (!r?.writeHead || r.headersSent || r.writableEnded) return;
        const body = JSON.stringify({
          error:
            'Rust API is not reachable at http://127.0.0.1:8080. From the repository root run `npm run dev` (starts API and Vite). Alternatively run `cargo run` with DATABASE_URL in `.env` in one terminal and `npm run dev --prefix frontend` in another.',
        });
        r.writeHead(502, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(Buffer.byteLength(body)),
        });
        r.end(body);
      });
    },
  };
}

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/framer-motion')) return 'framer-motion';
          if (id.includes('node_modules/dompurify')) return 'dompurify';
          if (id.includes('node_modules/diff/')) return 'diff';
        },
      },
    },
  },
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': backendProxy(),
      '/feed.xml': backendProxy(),
    },
  },
  preview: {
    host: 'localhost',
    port: 4173,
    proxy: {
      '/api': backendProxy(),
      '/feed.xml': backendProxy(),
    },
  },
});
