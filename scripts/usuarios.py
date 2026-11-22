"""Cadastro de usuários da Bússola (arquivo docs/acesso/usuarios.json).

O arquivo guarda só o resumo PBKDF2-SHA256 de cada senha, nunca a senha.

    python scripts/usuarios.py listar
    python scripts/usuarios.py adicionar maria "Maria Souza" [--perfil admin] [--senha ...]
    python scripts/usuarios.py senha maria [--senha ...]      # redefine (sem --senha, gera uma)
    python scripts/usuarios.py desativar maria | ativar maria | remover maria
"""
from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import string
import sys
from datetime import datetime, timezone
from pathlib import Path

ARQUIVO = Path(__file__).resolve().parent.parent / "docs" / "acesso" / "usuarios.json"
ITERACOES = 310_000
PERFIS = ("admin", "membro")
ALFABETO = "".join(c for c in string.ascii_letters + string.digits if c not in "Il1O0o")


def resumo(senha: str, sal_hex: str, iteracoes: int = ITERACOES) -> str:
    return hashlib.pbkdf2_hmac("sha256", senha.encode("utf-8"), bytes.fromhex(sal_hex), iteracoes).hex()


def gerar_senha() -> str:
    """Senha forte e fácil de ditar: 3 blocos de 4 caracteres sem letras ambíguas."""
    return "-".join("".join(secrets.choice(ALFABETO) for _ in range(4)) for _ in range(3))


def normalizar(login: str) -> str:
    login = login.strip().lower()
    if not login or not all(c.isalnum() or c in "._-" for c in login):
        raise SystemExit("Login inválido: use letras, números, ponto, hífen ou sublinhado.")
    return login


def ler() -> dict:
    if ARQUIVO.exists():
        return json.loads(ARQUIVO.read_text(encoding="utf-8"))
    return {"versao": 1, "algoritmo": "PBKDF2-SHA256", "usuarios": []}


def gravar(dados: dict) -> None:
    dados["atualizado_em"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    dados["usuarios"].sort(key=lambda u: u["login"])
    ARQUIVO.parent.mkdir(parents=True, exist_ok=True)
    ARQUIVO.write_text(json.dumps(dados, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def definir_senha(usuario: dict, senha: str) -> None:
    if len(senha) < 10:
        raise SystemExit("A senha precisa ter pelo menos 10 caracteres.")
    usuario["sal"] = secrets.token_hex(16)
    usuario["iteracoes"] = ITERACOES
    usuario["resumo"] = resumo(senha, usuario["sal"])


def achar(dados: dict, login: str) -> dict:
    for u in dados["usuarios"]:
        if u["login"] == login:
            return u
    raise SystemExit(f"Usuário {login!r} não existe.")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="acao", required=True)
    sub.add_parser("listar")
    a = sub.add_parser("adicionar")
    a.add_argument("login"); a.add_argument("nome")
    a.add_argument("--perfil", choices=PERFIS, default="membro"); a.add_argument("--senha")
    s = sub.add_parser("senha"); s.add_argument("login"); s.add_argument("--senha")
    for nome in ("desativar", "ativar", "remover"):
        sub.add_parser(nome).add_argument("login")
    args = ap.parse_args(argv)
    dados = ler()

    if args.acao == "listar":
        for u in dados["usuarios"]:
            print(f"{u['login']:<20} {u['nome']:<30} {u.get('perfil', 'membro'):<7} {'ativo' if u.get('ativo', True) else 'desativado'}")
        return 0
    login = normalizar(args.login)
    if args.acao == "adicionar":
        if any(u["login"] == login for u in dados["usuarios"]):
            raise SystemExit(f"Usuário {login!r} já existe.")
        senha = args.senha or gerar_senha()
        u = {"login": login, "nome": args.nome.strip(), "perfil": args.perfil, "ativo": True}
        definir_senha(u, senha)
        dados["usuarios"].append(u)
        gravar(dados)
        print(f"Usuário {login} criado. Senha: {senha}")
    elif args.acao == "senha":
        senha = args.senha or gerar_senha()
        definir_senha(achar(dados, login), senha)
        gravar(dados)
        print(f"Senha de {login} redefinida: {senha}")
    elif args.acao in ("desativar", "ativar"):
        achar(dados, login)["ativo"] = args.acao == "ativar"
        gravar(dados)
        print(f"Usuário {login} {'ativado' if args.acao == 'ativar' else 'desativado'}.")
    elif args.acao == "remover":
        achar(dados, login)
        dados["usuarios"] = [u for u in dados["usuarios"] if u["login"] != login]
        gravar(dados)
        print(f"Usuário {login} removido.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
