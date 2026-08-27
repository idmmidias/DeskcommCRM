import { describe, expect, it } from "vitest";

import {
  bareWaMessageId,
  chatIdFromWaMessageId,
  parseWahaMessageId,
  wahaForwardableId,
} from "@/lib/waha/message-id";

describe("parseWahaMessageId", () => {
  it("string plana não é uma shape reconhecida (guard exige objeto) → null", () => {
    // NOTA: o JSDoc do parser cita 'string plana' como shape, mas o guard
    // `typeof raw !== 'object'` a rejeita. No WAHA 2026.x/NOWEB a resposta é
    // objeto ({ id: { id } }), então não nos afeta — asserção documenta o real.
    expect(parseWahaMessageId("3EB0ABC")).toBeNull();
  });
  it("WEBJS { id: { _serialized } }", () => {
    expect(parseWahaMessageId({ id: { _serialized: "true_x@c.us_3EB0" } })).toBe("true_x@c.us_3EB0");
  });
  it("NOWEB { id: { id } }", () => {
    expect(parseWahaMessageId({ id: { id: "3EB0DEF" } })).toBe("3EB0DEF");
  });
  it("NOWEB { key: { id } }", () => {
    expect(parseWahaMessageId({ key: { id: "3EB0GHI" } })).toBe("3EB0GHI");
  });
  it("shape desconhecido → null", () => {
    expect(parseWahaMessageId(42)).toBeNull();
    expect(parseWahaMessageId(null)).toBeNull();
  });
});

describe("bareWaMessageId", () => {
  it("reduz o id completo do ack (fromMe_chat@lid_bare) à cauda", () => {
    expect(bareWaMessageId("true_59782320914646@lid_3EB01851263993A0465D2D")).toBe(
      "3EB01851263993A0465D2D",
    );
  });
  it("funciona com chat @c.us", () => {
    expect(bareWaMessageId("true_5511999999999@c.us_3EB0ABC")).toBe("3EB0ABC");
  });
  it("id já-bare (sem _) passa intacto — envio grava assim", () => {
    expect(bareWaMessageId("3EB02714A82A56A80702CE")).toBe("3EB02714A82A56A80702CE");
  });
  it("cauda do ack casa com o external_id NOWEB (invariante do fix)", () => {
    // NOWEB grava parseWahaMessageId({ id: { id } }) = bare; handleAck casa a cauda.
    const stored = parseWahaMessageId({ id: { id: "3EB01851263993A0465D2D" } });
    const fromAck = bareWaMessageId("true_59782320914646@lid_3EB01851263993A0465D2D");
    expect(fromAck).toBe(stored);
  });

  it("o ack full está entre os candidatos que cobrem o WEBJS (_serialized)", () => {
    // WEBJS grava external_id = _serialized (full). handleAck casa por [full, bare],
    // então ambos os engines destravam. Aqui: a forma full do ack é o próprio p.id.
    const ackFull = "true_5511999999999@c.us_3EB0ABC";
    const webjsStored = parseWahaMessageId({ id: { _serialized: ackFull } });
    const candidates = [ackFull, bareWaMessageId(ackFull)];
    expect(candidates).toContain(webjsStored); // WEBJS: casa pela forma full
    expect(candidates).toContain("3EB0ABC"); // NOWEB: casa pela cauda
  });
});

describe("chatIdFromWaMessageId", () => {
  it("recupera o chat de uma mensagem fromMe do NOWEB (payload real)", () => {
    // Capturado numa instalação Hostinger: o dono digitou no celular e o CRM
    // não mostrou. O payload NÃO tem `to` — sem este helper o chatId ficava
    // vazio e a mensagem era descartada em silêncio (webhook devolvia 200).
    expect(chatIdFromWaMessageId("true_250302204792918@lid_2A1B890FB8AA87730CBC")).toBe(
      "250302204792918@lid",
    );
  });

  it("funciona com @c.us (numero classico) e com inbound (false_)", () => {
    expect(chatIdFromWaMessageId("true_5511999999999@c.us_3EB0ABC")).toBe("5511999999999@c.us");
    expect(chatIdFromWaMessageId("false_5511999999999@c.us_3EB0ABC")).toBe("5511999999999@c.us");
  });

  it("id já-bare (do envio) não tem chat embutido → null, não lixo", () => {
    expect(chatIdFromWaMessageId("3EB02714A82A56A80702CE")).toBeNull();
  });

  it("miolo sem @ não é chatId → null (não inventa contato)", () => {
    expect(chatIdFromWaMessageId("true_naoehchat_3EB0ABC")).toBeNull();
  });

  it("convive com bareWaMessageId: um pega o chat, o outro o id", () => {
    const id = "true_250302204792918@lid_2A1B890FB8AA87730CBC";
    expect(chatIdFromWaMessageId(id)).toBe("250302204792918@lid");
    expect(bareWaMessageId(id)).toBe("2A1B890FB8AA87730CBC");
  });
});

describe("wahaForwardableId", () => {
  // O encaminhamento referencia a mensagem de ORIGEM, e só a acha pelo id que
  // carrega o chat. Metade das linhas do banco não está gravada assim.
  const CHAT_ORIGEM = "5511999999999@c.us";

  it("id já composto passa intacto — não há o que remontar", () => {
    const inbound = "false_5511999999999@c.us_3EB0ABC";
    expect(wahaForwardableId(inbound, CHAT_ORIGEM)).toBe(inbound);
  });

  it("WEBJS grava _serialized (composto) → também passa intacto", () => {
    const webjs = parseWahaMessageId({ id: { _serialized: "true_5511999999999@c.us_3EB0ABC" } });
    expect(wahaForwardableId(webjs as string, CHAT_ORIGEM)).toBe(
      "true_5511999999999@c.us_3EB0ABC",
    );
  });

  it("NOWEB grava o id CRU do envio → remonta com o chat de origem e fromMe=true", () => {
    // Este é o caso que fazia a feature nascer quebrada: no NOWEB, TODA mensagem
    // que o próprio atendente mandou está gravada bare — e são justamente as que
    // mais se quer repassar (o catálogo, o orçamento, as fotos que ele enviou).
    const noweb = parseWahaMessageId({ id: { id: "3EB0DEF" } });
    expect(wahaForwardableId(noweb as string, CHAT_ORIGEM)).toBe(
      "true_5511999999999@c.us_3EB0DEF",
    );
  });

  it("remonta com chat @lid (identidade opaca) do mesmo jeito", () => {
    expect(wahaForwardableId("2A1B890FB8AA87730CBC", "250302204792918@lid")).toBe(
      "true_250302204792918@lid_2A1B890FB8AA87730CBC",
    );
  });

  it("sem chat de origem, devolve o que tem em vez de inventar referência", () => {
    // Deixar o canal recusar com o erro dele é melhor que fabricar um id que
    // aponta para a conversa errada — o pior desfecho seria encaminhar OUTRA
    // mensagem sem ninguém perceber.
    expect(wahaForwardableId("3EB0DEF", null)).toBe("3EB0DEF");
    expect(wahaForwardableId("3EB0DEF", undefined)).toBe("3EB0DEF");
  });

  it("o id remontado é reversível pelos helpers que já existiam", () => {
    // Invariante que amarra a função ao resto do módulo: se um dia o formato
    // composto mudar, este teste cai junto com os outros.
    const montado = wahaForwardableId("3EB0DEF", CHAT_ORIGEM);
    expect(chatIdFromWaMessageId(montado)).toBe(CHAT_ORIGEM);
    expect(bareWaMessageId(montado)).toBe("3EB0DEF");
  });
});
