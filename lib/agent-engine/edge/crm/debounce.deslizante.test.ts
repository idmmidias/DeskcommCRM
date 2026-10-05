/**
 * [IDM] A janela DESLIZANTE da rajada: decisão e medição.
 *
 * O modo ancorado (`debounce.test.ts`, `debounce.medicao.test.ts`) segue sendo o
 * padrão e não é tocado aqui. Este arquivo prova o modo ligado por
 * `INBOUND_DEBOUNCE_TETO_MS > 0`:
 *
 *   - a carona EMPURRA o turno (um UPDATE só, que nunca adianta o `run_after`);
 *   - sem janela aberta, a mensagem abre janela nova como no modo ancorado;
 *   - o caso real da F&M (05/10/2026), que no ancorado vira dois turnos, vira um;
 *   - o contato que não para de escrever é respondido dentro do teto.
 *
 * Determinístico: relógio fixo, fila falsa fazendo o papel do banco.
 */
import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { decidirRajada } from './debounce';

const alvo = { organizationId: 'org1', contactId: 'contato1' };
const AGORA = 1_700_000_000_000;

function poolFalso(resposta: (sql: string) => { id: string }[], chamadas: { sql: string; params: unknown[] }[] = []): pg.Pool {
  const query = vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    return { rows: resposta(sql) };
  });
  return { query } as unknown as pg.Pool;
}

describe('[IDM] janela deslizante: a decisão', () => {
  it('com teto, a carona é um UPDATE que empurra o turno, num statement só', async () => {
    const chamadas: { sql: string; params: unknown[] }[] = [];
    const pool = poolFalso(() => [{ id: 'job-pendente' }], chamadas);

    const decisao = await decidirRajada(pool, alvo, 20_000, AGORA, 90_000);

    expect(decisao).toEqual({ tipo: 'coalescido', jobId: 'job-pendente' });
    expect(chamadas).toHaveLength(1);
    const { sql, params } = chamadas[0]!;
    expect(sql).toContain('update job_queue');
    expect(params).toEqual(['org1', 'contato1', 20_000, 90_000]);
  });

  it('o UPDATE nunca adianta o turno, respeita o teto e não toca job em HOLD', async () => {
    const chamadas: { sql: string; params: unknown[] }[] = [];
    await decidirRajada(poolFalso(() => [], chamadas), alvo, 20_000, AGORA, 90_000);
    const sql = chamadas[0]!.sql.replace(/\s+/g, ' ');

    // greatest(run_after, …): backoff de retry mais longo que a janela fica onde está.
    expect(sql).toContain('greatest( run_after,');
    // least(agora + debounce, criação + teto): o teto é contado da criação do job.
    expect(sql).toContain("least(now() + $3::float8 * interval '1 millisecond', created_at + $4::float8 * interval '1 millisecond')");
    // A lição do #830 vale aqui também: hold nunca recebe carona nem é empurrado.
    expect(sql.match(/not \(payload \? 'held_run_after'\)/g)).toHaveLength(2);
    // Job claimado entre a escolha e o update não é tocado: a guarda de FORA da
    // subconsulta, que o Postgres reavalia na linha travada.
    expect(sql).toContain("limit 1) and status = 'pending' and run_after > now()");
  });

  it('com teto e sem janela aberta (ou job claimado no meio), abre janela nova em agora + debounce', async () => {
    const decisao = await decidirRajada(poolFalso(() => []), alvo, 20_000, AGORA, 90_000);

    expect(decisao).toEqual({ tipo: 'enfileirar', runAfter: new Date(AGORA + 20_000) });
  });

  it('sem teto, o caminho é o ancorado do upstream: só a consulta, nenhum UPDATE', async () => {
    const chamadas: { sql: string; params: unknown[] }[] = [];
    await decidirRajada(poolFalso(() => [{ id: 'j' }], chamadas), alvo, 8_000, AGORA);

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.sql).toContain('select id from job_queue');
    expect(chamadas[0]!.sql).not.toContain('update');
  });

  it('debounce 0 segue desligando tudo, com ou sem teto', async () => {
    const chamadas: { sql: string; params: unknown[] }[] = [];
    const decisao = await decidirRajada(poolFalso(() => [{ id: 'x' }], chamadas), alvo, 0, AGORA, 90_000);

    expect(decisao).toStrictEqual({ tipo: 'enfileirar', runAfter: undefined });
    expect(chamadas).toHaveLength(0);
  });
});

// ─── Medição: fila falsa com as duas semânticas, relógio no tick do drain ────

interface Job {
  id: string;
  status: 'pending' | 'running' | 'done';
  criadoEm: number;
  runAfter: number;
  terminaEm: number;
  mensagens: number[];
}

interface Resultado {
  turnos: number;
  /** Mensagens que cada turno respondeu, na ordem. */
  lotes: number[][];
  /** Quanto a PRIMEIRA mensagem esperou até um turno começar. */
  esperaDaPrimeiraMs: number;
}

/**
 * Cada evento é o instante em que o drain PROCESSA a mensagem (a foto entra
 * quando a leitura dela termina, como no drain de verdade).
 */
async function simular(
  eventosMs: number[],
  c: { debounceMs: number; tetoMs: number; turnoMs: number; tickMs: number },
): Promise<Resultado> {
  const fila: Job[] = [];
  let agora = AGORA;
  let proximo = 1;

  const pool = {
    query: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
      const aberto = fila.find((j) => j.status === 'pending' && j.runAfter > agora);
      if (sql.includes('update job_queue')) {
        if (aberto === undefined) return { rows: [] };
        const debounce = Number(params[2]);
        const teto = Number(params[3]);
        aberto.runAfter = Math.max(aberto.runAfter, Math.min(agora + debounce, aberto.criadoEm + teto));
        return { rows: [{ id: aberto.id }] };
      }
      return { rows: aberto === undefined ? [] : [{ id: aberto.id }] };
    }),
  } as unknown as pg.Pool;

  const tick = (): void => {
    for (const j of fila) if (j.status === 'running' && j.terminaEm <= agora) j.status = 'done';
    if (fila.some((j) => j.status === 'running')) return;
    const vencido = fila.find((j) => j.status === 'pending' && j.runAfter <= agora);
    if (vencido !== undefined) {
      vencido.status = 'running';
      vencido.terminaEm = agora + c.turnoMs;
    }
  };

  const ultimo = Math.max(...eventosMs);
  for (let t = 0; t <= ultimo + c.tetoMs + 4 * c.turnoMs; t += c.tickMs) {
    agora = AGORA + t;
    for (const [i, em] of eventosMs.entries()) {
      if (em !== t) continue;
      const d = await decidirRajada(pool, alvo, c.debounceMs, agora, c.tetoMs);
      if (d.tipo === 'coalescido') {
        fila.find((j) => j.id === d.jobId)!.mensagens.push(i);
      } else {
        fila.push({
          id: `job-${proximo++}`,
          status: 'pending',
          criadoEm: agora,
          runAfter: d.runAfter?.getTime() ?? agora,
          terminaEm: Number.POSITIVE_INFINITY,
          mensagens: [i],
        });
      }
    }
    tick();
  }

  const primeiro = fila[0]!;
  return {
    turnos: fila.length,
    lotes: fila.map((j) => j.mensagens),
    esperaDaPrimeiraMs: primeiro.terminaEm - c.turnoMs - (AGORA + eventosMs[0]!),
  };
}

describe('[IDM] janela deslizante: a medição', () => {
  /**
   * F&M, 05/10/2026, horários do drain: "Bom dia" processado em 7s (o job nasceu
   * 09:12:10 para a mensagem das 09:12:03), o texto em 11s, a foto em 25s (chegou
   * 09:12:20 e só entrou depois de lida, 09:12:28). Turno de ~35s.
   */
  const FM = [0, 4_000, 18_000];
  const base = { turnoMs: 35_000, tickMs: 1_000 };

  it('CONTROLE: no ancorado de 8s, o caso da F&M vira DOIS turnos e a foto fica para o segundo', async () => {
    const r = await simular(FM, { ...base, debounceMs: 8_000, tetoMs: 0 });

    expect(r.turnos).toBe(2);
    expect(r.lotes).toEqual([[0, 1], [2]]);
  });

  it('CONTROLE: ancorado de 20s ainda perde a foto quando ela chega depois da janela da 1ª mensagem', async () => {
    const r = await simular([0, 4_000, 22_000], { ...base, debounceMs: 20_000, tetoMs: 0 });

    expect(r.turnos).toBe(2);
  });

  it('deslizante de 20s com teto de 90s: o mesmo caso vira UM turno, com a foto', async () => {
    const r = await simular(FM, { ...base, debounceMs: 20_000, tetoMs: 90_000 });

    expect(r.turnos).toBe(1);
    expect(r.lotes).toEqual([[0, 1, 2]]);
    // O turno começa 20s depois da ÚLTIMA mensagem processada.
    expect(r.esperaDaPrimeiraMs).toBe(18_000 + 20_000);
  });

  it('frase longa: mensagens a cada 15s viram um turno só enquanto a pessoa escreve', async () => {
    const r = await simular([0, 15_000, 30_000, 45_000], { ...base, debounceMs: 20_000, tetoMs: 90_000 });

    expect(r.turnos).toBe(1);
    expect(r.esperaDaPrimeiraMs).toBe(45_000 + 20_000);
  });

  it('contato que não para de escrever é respondido no TETO, não fica esperando para sempre', async () => {
    const aCada10s = Array.from({ length: 30 }, (_, i) => i * 10_000);
    const r = await simular(aCada10s, { ...base, debounceMs: 20_000, tetoMs: 90_000 });

    expect(r.esperaDaPrimeiraMs).toBe(90_000);
    expect(r.turnos).toBeGreaterThan(1);
  });
});
