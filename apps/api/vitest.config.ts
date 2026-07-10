import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

// NestJS usa injeção de dependência baseada em decorators (reflect-metadata).
// Vitest transpila TS com esbuild por padrão, que não emite metadata de
// decorators — por isso o plugin SWC é necessário para os testes de
// integração instanciarem os providers corretamente.
//
// Nota: Vite carrega .env automaticamente em process.env. Isso faz o
// .env de desenvolvimento local (ex.: COOKIE_SECURE=false, útil para
// testar no navegador sem HTTPS) vazar para os testes. Por isso,
// cada arquivo de teste que depende de um valor específico
// (COOKIE_SECURE, DATABASE_URL) define esse valor explicitamente,
// sem confiar em `??=` sozinho.
export default defineConfig({
  plugins: [swc.vite()],
  test: {
    include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec,e2e-spec}.ts"],
    exclude: ["node_modules", "dist"],
    testTimeout: 20000,
  },
});
