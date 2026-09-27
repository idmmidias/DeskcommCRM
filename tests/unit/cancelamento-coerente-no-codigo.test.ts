import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * A CONSTRAINT DO BANCO, ESCRITA COMO CERCA — porque ela já foi violada por
 * código nosso e o preço foi uma feature que nunca funcionou.
 *
 * `calendar_appointments` tem, desde a migration que criou o cancelamento:
 *
 *   CHECK ((status <> 'cancelled' AND cancelled_at IS NULL)
 *       OR (status = 'cancelled' AND cancelled_at IS NOT NULL))
 *
 * Os dois campos andam JUNTOS. Um `update` que escreve `status: "cancelled"` e
 * esquece `cancelled_at` não é um bug de estilo: o Postgres recusa a linha, o
 * `update` devolve erro, e o caminho inteiro morre.
 *
 * ─── O QUE FOI MEDIDO, e por que uma cerca e não um teste da rota ───────────
 *
 * Em 27/09/2026, numa instalação recém-atualizada para a 1.52.0,
 * `agenda-expira-pendentes` falhava em TODA passada:
 *
 *   [agenda-expira-pendentes] update falhou
 *   violates check constraint "calendar_appointments_cancelamento_coerente"
 *
 * A rota cancelava sem carimbar a data. Ou seja, a expiração do pedido pendente
 * **nunca funcionou nesta versão** — e o efeito é exatamente o que o cabeçalho
 * daquele arquivo existe para impedir: pendente OCUPA o horário, então pedido
 * abandonado trava o slot para sempre e o próximo cliente ouve "não tenho
 * horário". Falha silenciosa de um lado (o horário some da agenda) e ruidosa do
 * outro (um erro por rodada, de 15 em 15 minutos, que ninguém lê).
 *
 * Um teste da rota pegaria ESTA rota. A cerca pega a PRÓXIMA: qualquer lugar do
 * repo que venha a cancelar um compromisso cai aqui antes de chegar ao banco de
 * alguém. É a diferença entre consertar a instância e fechar a classe, e este
 * repo já pagou a instância duas vezes (o `agenda-google-push` da 1.7.0 e o
 * `since` no futuro do Radar são a mesma família: código que escreve um estado
 * que a própria constraint proíbe).
 *
 * ─── POR QUE PELA AST, E NÃO POR grep ──────────────────────────────────────
 *
 * `grep` de `status: "cancelled"` não sabe dizer se o `cancelled_at` que aparece
 * doze linhas abaixo está no MESMO objeto ou em outro. A AST sabe: a asserção é
 * sobre o objeto literal, que é a unidade que vira uma linha no banco.
 *
 * Roda com:  npx vitest run tests/unit/cancelamento-coerente-no-codigo.test.ts
 */

const RAIZ = join(__dirname, "..", "..");

/** Onde código que escreve no banco pode morar. */
const ALVOS = ["app", "lib", "workers"];

/**
 * A tabela que tem a constraint. A cerca é dela e de mais nenhuma: follow-up e
 * LGPD também cancelam coisas, com schema próprio e sem `cancelled_at`.
 */
const TABELA = "calendar_appointments";

/**
 * Caminhada recursiva à mão, e não um glob de biblioteca: este repo não tem
 * dependência de glob, e acrescentar uma por causa de um teste é custo que a
 * cerca não justifica.
 */
function arquivosDe(dir: string): string[] {
  const saida: string[] = [];
  let entradas;
  try {
    entradas = readdirSync(dir, { withFileTypes: true });
  } catch {
    return saida;
  }
  for (const e of entradas) {
    const caminho = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      saida.push(...arquivosDe(caminho));
      continue;
    }
    if (!/\.tsx?$/.test(e.name)) continue;
    if (/\.test\.tsx?$/.test(e.name)) continue;
    saida.push(caminho);
  }
  return saida;
}

/**
 * Um objeto literal que declara cancelamento sem a data.
 *
 * Só cobra quando o objeto FIXA o status em `'cancelled'` como literal. Um
 * `status: algumaVariavel` não é decidível aqui e fica de fora de propósito:
 * cerca que chuta reprova código correto e é desligada na primeira vez.
 */
interface Achado {
  arquivo: string;
  linha: number;
}

function varrer(): Achado[] {
  const achados: Achado[] = [];
  const arquivos = ALVOS.flatMap((d) => arquivosDe(join(RAIZ, d)));

  for (const caminho of arquivos) {
    const texto = readFileSync(caminho, "utf8");
    // Corte barato antes de pagar o parse: a constraint é de UMA tabela, e a
    // grande maioria dos arquivos não a menciona.
    if (!texto.includes(TABELA)) continue;

    const fonte = ts.createSourceFile(caminho, texto, ts.ScriptTarget.Latest, true);

    const visita = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const metodo = node.expression.name.text;
        if (
          (metodo === "update" || metodo === "insert" || metodo === "upsert") &&
          node.arguments.length > 0
        ) {
          // A CADEIA é o que decide a tabela. `.update({...})` sozinho não diz
          // em que tabela escreve, e é justamente por isso que a versão anterior
          // desta cerca sinalizava cancelamento de follow-up e de LGPD, que têm
          // schema próprio e nenhum `cancelled_at`. Cerca que reprova código
          // correto é desligada na primeira semana.
          if (cadeiaTocaATabela(node.expression.expression)) {
            for (const arg of node.arguments) {
              if (ts.isObjectLiteralExpression(arg) && cancelaSemData(arg, fonte)) {
                const { line } = fonte.getLineAndCharacterOfPosition(arg.getStart(fonte));
                achados.push({ arquivo: relative(RAIZ, caminho), linha: line + 1 });
              }
            }
          }
        }
      }
      ts.forEachChild(node, visita);
    };

    visita(fonte);
  }

  return achados;
}

/** A cadeia de chamadas à esquerda passa por `.from("calendar_appointments")`? */
function cadeiaTocaATabela(no: ts.Node): boolean {
  let atual: ts.Node | undefined = no;
  while (atual) {
    if (ts.isCallExpression(atual) && ts.isPropertyAccessExpression(atual.expression)) {
      if (atual.expression.name.text === "from") {
        const primeiro = atual.arguments[0];
        if (primeiro && ts.isStringLiteral(primeiro) && primeiro.text === TABELA) return true;
      }
      atual = atual.expression.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(atual)) {
      atual = atual.expression;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * O objeto FIXA `status: 'cancelled'` como literal e não traz `cancelled_at`?
 *
 * Só cobra o literal. `status: algumaVariavel` não é decidível aqui e fica de
 * fora de propósito: cerca que chuta reprova código correto.
 */
function cancelaSemData(obj: ts.ObjectLiteralExpression, fonte: ts.SourceFile): boolean {
  let declaraCancelado = false;
  let temData = false;
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const nome = prop.name.getText(fonte).replace(/['"]/g, "");
    if (
      nome === "status" &&
      ts.isStringLiteral(prop.initializer) &&
      prop.initializer.text === "cancelled"
    ) {
      declaraCancelado = true;
    }
    if (nome === "cancelled_at") temData = true;
  }
  return declaraCancelado && !temData;
}

describe("status 'cancelled' e cancelled_at andam juntos, como o banco exige", () => {
  it("nenhum objeto declara cancelamento sem carimbar a data", () => {
    const achados = varrer();
    const mensagem = achados.map((a) => `${a.arquivo}:${a.linha}`).join("\n");
    expect(
      achados,
      `\nObjeto com status: "cancelled" e sem cancelled_at — a constraint\n` +
        `calendar_appointments_cancelamento_coerente recusa a linha e o update\n` +
        `devolve erro:\n${mensagem}\n`,
    ).toEqual([]);
  });

  it("a cerca REPROVA o defeito que ela existe para pegar", () => {
    // Sem esta metade, uma varredura que devolvesse sempre `[]` ficaria verde —
    // que é o modo de falha clássico de cerca escrita por leitura de fonte.
    const fonte = ts.createSourceFile(
      "exemplo.ts",
      `const x = { status: "cancelled", cancellation_reason: "expirou" };`,
      ts.ScriptTarget.Latest,
      true,
    );
    let pegou = false;
    const visita = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const nomes = node.properties
          .filter(ts.isPropertyAssignment)
          .map((p) => p.name.getText(fonte).replace(/['"]/g, ""));
        const cancelado = node.properties.some(
          (p) =>
            ts.isPropertyAssignment(p) &&
            p.name.getText(fonte).replace(/['"]/g, "") === "status" &&
            ts.isStringLiteral(p.initializer) &&
            p.initializer.text === "cancelled",
        );
        if (cancelado && !nomes.includes("cancelled_at")) pegou = true;
      }
      ts.forEachChild(node, visita);
    };
    visita(fonte);
    expect(pegou, "a mesma lógica da varredura não pega o caso óbvio").toBe(true);
  });
});
