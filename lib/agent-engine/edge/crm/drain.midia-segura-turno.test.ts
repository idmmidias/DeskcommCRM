/**
 * [IDM] Foto ou áudio em leitura SEGURAM o turno que já está na fila.
 *
 * O drain do upstream adia o evento da mídia até a leitura terminar, mas o turno
 * do texto que chegou antes dela já tem job e roda no fim da janela dele, sem a
 * foto. No modo deslizante (`debounceTetoMs > 0`), cada adiamento empurra também
 * esse job. Com o teto em 0, o drain não faz nada além do que já fazia.
 *
 * Mesmo banco falso de `drain.test.ts`: responde por leitura do SQL.
 */
import { expect, it, vi } from 'vitest';
import type pg from 'pg';

import { TIPOS_DERIVAVEIS } from '@/lib/messaging/media/derivable';

import { drainTick } from './drain';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const base = { batchSize: 10, intervalMs: 0, idleIntervalMs: 0, reapTimeoutMs: 60000 };
const evento = {
  id: 'e1',
  organization_id: 'org1',
  attempts: 1,
  created_at: new Date().toISOString(),
  payload: {
    conversation_id: '11111111-1111-4111-8111-111111111111',
    contact_id: '22222222-2222-4222-8222-222222222222',
    channel_session_id: '33333333-3333-4333-8333-333333333333',
    inbound_message_id: '44444444-4444-4444-8444-444444444444',
  },
};

interface Chamada {
  sql: string;
  params: unknown[];
}

function poolFalso(midia: { type: string; media_derived_status: string | null }, chamadas: Chamada[]): pg.Pool {
  const query = vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (sql.includes('returning e.id')) return { rows: [evento] };
    if (sql.includes('ai_dispatch_mode')) return { rows: [{ mode: null }] };
    if (sql.includes('is_group')) return { rows: [{ is_group: false }] };
    if (sql.includes('tem_agente')) return { rows: [{ tem_agente: true, tem_roteador: false }] };
    if (sql.includes('media_derived_status')) {
      if (!TIPOS_DERIVAVEIS.has(midia.type)) return { rows: [] };
      return { rows: [{ ...midia, quando: new Date(Date.now() - 1_000).toISOString() }] };
    }
    if (sql.includes('update job_queue')) return { rows: [{ id: 'job-do-texto' }] };
    return { rows: [] };
  });
  return { query } as unknown as pg.Pool;
}

const extensoes = (chamadas: Chamada[]) => chamadas.filter((c) => c.sql.includes('update job_queue'));
/** O adiamento do evento: volta a pending sem gastar tentativa (drain.ts). */
const adiou = (chamadas: Chamada[]) =>
  chamadas.some((c) => c.sql.includes('update event_log') && c.sql.includes('attempts = greatest(attempts - 1, 0)'));

it('foto em leitura com o teto ligado: o evento é adiado E o turno da fila é empurrado', async () => {
  const chamadas: Chamada[] = [];
  await drainTick(
    poolFalso({ type: 'image', media_derived_status: null }, chamadas),
    { ...base, debounceMs: 20_000, debounceTetoMs: 90_000 },
    log,
  );

  // O evento da foto continua adiado, como no upstream...
  expect(adiou(chamadas)).toBe(true);
  expect(chamadas.some((c) => c.sql.includes('insert into job_queue'))).toBe(false);
  // ...e o job do texto que chegou antes é empurrado, no contato certo.
  const ext = extensoes(chamadas);
  expect(ext).toHaveLength(1);
  expect(ext[0]!.params).toEqual(['org1', evento.payload.contact_id, 20_000, 90_000]);
});

it('CONTROLE: com o teto em 0, o adiamento não toca em job nenhum (comportamento do upstream)', async () => {
  const chamadas: Chamada[] = [];
  await drainTick(
    poolFalso({ type: 'image', media_derived_status: null }, chamadas),
    { ...base, debounceMs: 20_000 },
    log,
  );

  expect(adiou(chamadas)).toBe(true);
  expect(extensoes(chamadas)).toHaveLength(0);
});

it('foto já lida: nada a segurar no adiamento; a carona da rajada é que empurra o turno', async () => {
  const chamadas: Chamada[] = [];
  await drainTick(
    poolFalso({ type: 'image', media_derived_status: 'ready' }, chamadas),
    { ...base, debounceMs: 20_000, debounceTetoMs: 90_000 },
    log,
  );

  // Uma extensão só, a da carona (decidirRajada), e nenhum adiamento.
  expect(extensoes(chamadas)).toHaveLength(1);
  expect(adiou(chamadas)).toBe(false);
});
