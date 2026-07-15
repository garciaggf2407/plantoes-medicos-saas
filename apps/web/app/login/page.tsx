import Link from "next/link";
import { API_URL } from "@/lib/api";
import { Card } from "@/components/ui/card";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold text-label">Plantões Médicos</h1>
          <p className="mt-1 text-sm text-label-secondary">Entre para continuar.</p>
        </div>

        <Card className="flex flex-col items-center gap-3 p-6">
          {/*
            Navegação de verdade (não fetch/XHR): /auth/login é um GET
            que redireciona ao provedor OIDC (real ou, em dev/CI, à
            página local do FakeOidcProvider). Precisa ser o browser
            seguindo o redirect, não uma chamada assíncrona.
          */}
          <a
            href={`${API_URL}/auth/login`}
            className="inline-flex items-center justify-center gap-2 rounded-control bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/30"
          >
            Entrar
          </a>
        </Card>

        <p className="mt-6 text-center text-sm text-label-secondary">
          Não tem conta?{" "}
          <Link href="/cadastro" className="font-medium text-accent hover:text-accent-hover">
            Cadastre-se
          </Link>
        </p>
      </div>
    </main>
  );
}
