# Bússola — o que ainda falta (versão 1.23.0, 25/11/2026)

## Roteiro de desempenho (PASSO-A-PASSO-DESEMPENHO-BUSSOLA.md)

| Passo | Situação |
|---|---|
| 1 Medidas e linha de base | Feito |
| 2 Teste de equivalência | Feito (200 consultas, com e sem workers) |
| 3 Núcleo separado | Feito |
| 4 Workers | Feito (cancelamento no meio da tarefa completado no passo 7) |
| 5 Chamadas diretas | Feito |
| 6 Índice espacial e vetores para o desenho | Parcial: temas feitos; falta quadras/ruas/lotes no formato rápido e o cache de 200 blocos preparados; meta de "filtrar" < 2 ms não atingida (a medida inclui baixar e descompactar) |
| 7 Cancelamento e prioridade | Feito |
| 8 Cache em memória por bytes | A fazer |
| 9 Cache no aparelho | A fazer (já existe um service worker desde a 1.8; ajustar às regras do roteiro) |
| 10 Pré-carga da vizinhança | A fazer (a fila já tem a prioridade "vizinhança") |
| 11 Levantamento em partes | A fazer |
| 12 Conferência da fase 1 | A fazer |
| 13 a 20 Formato 2 do banco | Depende da extração bruta completa (3 partes) e da senha do cofre, informada só na hora |
| 21 a 24 Desenho em segundo plano e conferência final | Depende dos passos 13 a 20 |

## Funções do sistema

- Regiões do Conselho Tutelar: aproximadas pelos locais de votação; trocar pelo mapa oficial do CMDCA quando houver.
- Logs de acesso: falta o endereço /exec do Apps Script (registro-acessos.gs) para ligar.
- Associações: só a A.M.C. Jardim América cadastrada; cada nova precisa de nome, bairros, logins e levantamento. A separação entre associações é só de tela (site estático).
- Busca de pessoas no cofre: não testada com a senha real.
- Números de lote do painel Associação sobre o satélite ainda não desviam do marcador de quadra.
- Cadastro imobiliário do bairro tributário 101: 3.773 no servidor, 3.769 no banco.
- Anexos dos lotes: só a lista (os arquivos não estão no site).
- Conferência visual dos postes e dos números de teto num computador com placa de vídeo.
- Ambiente de testes com 1 processador: medidas de desempenho só comparáveis entre si; conferir no computador real com `bussola.desempenho()`.
