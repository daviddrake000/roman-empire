import { defineConfig } from 'vite';

export default defineConfig({
  // 5173–5176 are Shelf, Crate, Hall of Fame and Live Cards, so all five apps can run at once
  server: { port: 5177 },
});
