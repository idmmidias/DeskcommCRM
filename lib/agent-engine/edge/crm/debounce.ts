/**
 * Coalescência de rajada inbound — a janela que junta as mensagens de UM contato
 * em UM turno.
 *
 * Morava inline no `drain.ts`; saiu para cá com teste próprio (issue #1390)
 * porque o comportamento carrega duas leis que se cruzam — a janela de debounce
 * e a exclusão do job em HOLD — e as duas precisam de régua própria.
 *
 * Contrato:
 *   - mensagem que chega enquanto há job PENDING **do mesmo contato** com a
 *     janela ainda aberta (`run_after > now()`) viaja de carona nele: o turno lê
 *     o histórico completo e responde a todas as mensagens do lote;
 *   - mensagem que chega fora da janela abre janela nova;
 *   - `debounceMs = 0` desliga a coalescência: job imediato, zero consulta.
 *
 * A janela é ANCORADA no primeiro job, não deslizante: mensagens que chegam
 * dentro dela não empurram o `run_after` para frente (nada aqui faz update de
 * `run_after`). Quem mede o pior caso com contato falante é
 * `debounce.medicao.test.ts`.
 *
 * [IDM] MODO DESLIZANTE, ligado só com `tetoMs > 0` (`INBOUND_DEBOUNCE_TETO_MS`).
 * A carona passa a EMPURRAR o turno para `agora + debounceMs`, sem passar de
 * `criação do job + tetoMs` e sem nunca adiantar o que já estava marcado. Com o
 * teto em 0 nada muda: é a janela ancorada acima, byte a byte.
 *
 * Por que existe: a ancorada conta a partir da PRIMEIRA mensagem, e quem escreve
 * em partes perde a corrida. Medido na F&M em 05/10/2026: "Bom dia" 09:12:03,
 * "Gostaria de agendar uma visita a esse imóvel" 09:12:14, o print do anúncio
 * 09:12:20. A janela de 8s fechou às 09:12:18, o turno leu a conversa sem a foto
 * e pediu "o link ou um print do imóvel"; a foto ganhou turno próprio e a
 * resposta certa saiu dois minutos depois, com um segundo "Bom dia". O teto é o
 * que impede o contrário: contato que não para de escrever ficar sem resposta.
 * Medição em `debounce.deslizante.test.ts`.
 */
import type pg from 'pg';

import { adiadoPelaJanelaDeResposta } from '../../pacing/adiados-da-janela';

/**
 * Job pendente do contato cuja janela ainda não venceu — a carona desta
 * mensagem.
 *
 * ⚠️ `run_after > now()` sozinho casa com um job em HOLD (`enforceHolds`,
 * session-watchdog.ts), que usa `run_after = 'infinity'` como marcador, e
 * 'infinity' É maior que `now()`. Um job em hold por sessão MORTA (WhatsApp
 * reconectado, sessão antiga arquivada) nunca libera — a condição de liberação
 * exige a MESMA sessão antiga voltar a 'WORKING', o que não acontece nunca.
 * Sem esta exclusão, TODA mensagem nova do mesmo contato — inclusive na sessão
 * NOVA — coalescia nesse job morto para sempre: o cliente escrevia, o evento
 * saía "done" sem erro nenhum, e nenhum turno rodava. Medido em produção
 * (2026-09-14): 6 mensagens ao longo de 7h, zero resposta, zero job novo — só o
 * coalescing silencioso repetido no mesmo job com `held_run_after` no payload.
 */
const SQL_JOB_PARA_COALESCER = `select id, payload from job_queue
 where organization_id = $1 and contact_id = $2
   and kind = 'inbound_turn' and status = 'pending' and run_after > now()
   and not (payload ? 'held_run_after')
 limit 1`;

/**
 * [IDM] A carona do modo DESLIZANTE, num statement só.
 *
 * A seleção é a MESMA de `SQL_JOB_PARA_COALESCER` (com a exclusão do HOLD), e o
 * filtro de fora é reavaliado pelo Postgres na linha travada: se o job foi
 * claimado entre a escolha e o update, nada é tocado e a mensagem abre janela
 * nova, exatamente como no modo ancorado.
 *
 * `greatest(run_after, …)` porque o `run_after` de um job pendente pode estar
 * mais longe do que a janela por outro motivo (backoff de retry). Estender
 * nunca pode ADIANTAR um turno.
 */
const SQL_ESTENDER_JANELA = `update job_queue
    set run_after = greatest(
          run_after,
          least(now() + $3::float8 * interval '1 millisecond',
                created_at + $4::float8 * interval '1 millisecond'))
  where id = (${SQL_JOB_PARA_COALESCER})
    and status = 'pending' and run_after > now()
    and not (payload ? 'held_run_after')
  returning id`;

/**
 * [IDM] Empurra a janela do job pendente do contato (modo deslizante). Devolve o
 * job estendido, ou `undefined` quando não há janela aberta para estender.
 *
 * Também é o que a espera de mídia chama (`drain.ts`): foto ou áudio ainda em
 * leitura seguram o turno que já está na fila, para ele não rodar sem ela.
 */
export async function estenderJanelaDaRajada(
  pool: pg.Pool,
  alvo: { organizationId: string; contactId: string },
  debounceMs: number,
  tetoMs: number,
): Promise<string | undefined> {
  const { rows } = await pool.query<{ id: string }>(SQL_ESTENDER_JANELA, [
    alvo.organizationId,
    alvo.contactId,
    debounceMs,
    tetoMs,
  ]);
  return rows[0]?.id;
}

/** O que fazer com a mensagem que acabou de chegar. */
export type DecisaoDeRajada =
  | { tipo: 'coalescido'; jobId: string }
  | {
      tipo: 'enfileirar';
      runAfter: Date | undefined;
      /**
       * Job que ERA o candidato natural à carona mas está adiado pela JANELA DE
       * RESPOSTA que já ABRIU (#3383): não recebe a mensagem, e quem acorda o
       * adiado é quem chama (`drain.ts` — ver `soltarAdiadoPelaJanela`).
       */
      caronaRecusadaEm?: string;
    };

/** Job pendente do contato que pode receber a mensagem de carona. */
export interface CandidatoDeCarona {
  id: string;
  /** `true` quando o job espera a ABERTURA da janela de resposta (rastro do #3383). */
  adiadoPelaJanelaDeResposta: boolean;
}

export async function buscarJobParaCoalescer(
  pool: pg.Pool,
  alvo: { organizationId: string; contactId: string },
): Promise<CandidatoDeCarona | undefined> {
  const { rows } = await pool.query<{ id: string; payload: unknown }>(SQL_JOB_PARA_COALESCER, [
    alvo.organizationId,
    alvo.contactId,
  ]);
  const row = rows[0];
  if (row === undefined) return undefined;
  return { id: row.id, adiadoPelaJanelaDeResposta: adiadoPelaJanelaDeResposta(row.payload) };
}

/**
 * Janela da rajada aberta por esta mensagem: `undefined` quando não há debounce
 * (o job nasce claimável agora).
 *
 * `agora` é injetável porque a janela é aritmética — o teste prende o número
 * sem depender do relógio.
 */
export function janelaDeRajada(debounceMs: number, agora: number = Date.now()): Date | undefined {
  return debounceMs > 0 ? new Date(agora + debounceMs) : undefined;
}

/**
 * Teto da janela de rajada configurável por agente (#1856): não deixar ninguém
 * travar o atendimento sem querer. Vale também como default de tela/UX.
 */
export const TETO_DEBOUNCE_MS = 60_000;

/**
 * Janela de rajada EFETIVA de um agente.
 *
 * `null`/`undefined` (campo vazio na versão) = o `INBOUND_DEBOUNCE_MS` da
 * instalação — regressão zero para quem nunca mexeu no campo. O valor
 * configurado é CLAMPADO em [0, TETO_DEBOUNCE_MS]: 0 desliga a coalescência e
 * valores acima do teto (dado sujo que entrou por fora da validação) caem para
 * 60s em vez de travar o atendimento.
 */
export function debounceEfetivo(
  configurado: number | null | undefined,
  padraoInstalacao: number,
): number {
  if (configurado === null || configurado === undefined) return padraoInstalacao;
  return Math.min(Math.max(0, configurado), TETO_DEBOUNCE_MS);
}

/**
 * Decide entre carona em job existente e janela nova.
 *
 * `janelaDeRespostaAberta` (#3383) é opcional e SÓ é consultada quando o
 * candidato carrega o rastro `adiado_por_janela` — job de debounce (8 s), cap,
 * saldo ou sessão não pagam a leitura e continuam exatamente como antes.
 *
 * Com a janela ABERTA, o job adiado pela janela não recebe carona: a mensagem
 * nova enfileira o próprio turno (e o chamador acorda o adiado, que senão
 * dormiria até o horário antigo). Com a janela FECHADA o comportamento é o de
 * sempre — a mensagem viaja de carona e os dois respondem juntos às 7h.
 * Sem o quinto argumento (todos os chamadores antigos), nada muda.
 *
 * [IDM] `tetoMs > 0` liga o modo deslizante: a carona empurra o turno em vez de
 * só embarcar nele. A regra do turno adiado pela janela (#3383) vem ANTES e vale
 * igual nos dois modos; o empurrão só toca job que espera o debounce, nunca o que
 * espera a janela abrir (e mesmo nesse caso o `greatest` do SQL não adiantaria
 * nada). A janela NOVA nasce igual nos dois modos.
 */
export async function decidirRajada(
  pool: pg.Pool,
  alvo: { organizationId: string; contactId: string },
  debounceMs: number,
  agora: number = Date.now(),
  janelaDeRespostaAberta?: () => Promise<boolean>,
  tetoMs: number = 0,
): Promise<DecisaoDeRajada> {
  if (debounceMs > 0) {
    const candidato = await buscarJobParaCoalescer(pool, alvo);
    if (candidato !== undefined) {
      if (
        candidato.adiadoPelaJanelaDeResposta &&
        janelaDeRespostaAberta !== undefined &&
        (await janelaDeRespostaAberta())
      ) {
        return {
          tipo: 'enfileirar',
          runAfter: janelaDeRajada(debounceMs, agora),
          caronaRecusadaEm: candidato.id,
        };
      }
      if (tetoMs > 0 && !candidato.adiadoPelaJanelaDeResposta) {
        // [IDM] Empurra num statement só, que reavalia o filtro na linha
        // travada: se o job foi claimado entre a escolha e o update, nada é
        // tocado e a mensagem abre janela nova, como no modo ancorado.
        const estendido = await estenderJanelaDaRajada(pool, alvo, debounceMs, tetoMs);
        if (estendido !== undefined) return { tipo: 'coalescido', jobId: estendido };
        return { tipo: 'enfileirar', runAfter: janelaDeRajada(debounceMs, agora) };
      }
      return { tipo: 'coalescido', jobId: candidato.id };
    }
  }
  return { tipo: 'enfileirar', runAfter: janelaDeRajada(debounceMs, agora) };
}
