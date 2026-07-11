import js from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  security.configs.recommended,
  {
    rules: {
      // Falsos positivos comuns em código Nest/Prisma legítimo
      // (objeto vindo de req.body sempre validado por DTO/guard antes
      // de chegar a uma query, não indexação dinâmica não confiável).
      "security/detect-object-injection": "off",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
