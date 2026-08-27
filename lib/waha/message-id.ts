/**
 * Extração do id externo da resposta de envio do WAHA (Fase 4A-3 da fusão).
 *
 * O shape do `id` varia por engine/versão do WAHA:
 *   - string plana ("ABCD...")
 *   - WAMessageKey do WEBJS: { id: { _serialized: "..." } }
 *   - NOWEB: { id: { id: "..." } } ou { key: { id: "..." } }
 * Sem casar o shape, `messages.external_id` fica null e o ack do webhook nunca
 * encontra a linha — insere duplicata em vez de atualizar (bug real da Fase 1).
 */
export function parseWahaMessageId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { id?: unknown; key?: { id?: unknown } };
  if (typeof r.id === 'string') return r.id;
  if (typeof r.id === 'object' && r.id !== null) {
    const serialized = (r.id as { _serialized?: unknown })._serialized;
    if (typeof serialized === 'string') return serialized;
    const innerId = (r.id as { id?: unknown }).id;
    if (typeof innerId === 'string') return innerId;
  }
  if (typeof r.key === 'object' && r.key !== null && typeof r.key.id === 'string') return r.key.id;
  return null;
}

/**
 * Normaliza um id de mensagem WAHA para a "cauda" serializada (bare id).
 *
 * O WAHA 2026.x/NOWEB é assimétrico: a resposta de ENVIO devolve o id interno
 * cru (`3EB0…`), mas o webhook `message.ack` chega no formato completo
 * `{fromMe}_{chatId}_{3EB0…}` (ex.: `true_5511…@lid_3EB0…`). Como o envio grava
 * `external_id` = bare, casar o ack pelo id completo nunca acha a linha e o
 * status trava em `sent` (ack=0). Aqui reduzimos ambos ao trecho após o último
 * `_` — chatId (`@c.us`/`@lid`) e o serializado WA não contêm `_`, então a
 * cauda é sempre o bare id; um id já-bare passa intacto (sem `_`).
 */
export function bareWaMessageId(id: string): string {
  const cut = id.lastIndexOf('_');
  return cut === -1 ? id : id.slice(cut + 1);
}

/**
 * Extrai o chatId do id composto do WAHA (`{fromMe}_{chatId}_{bareId}`).
 *
 * Existe porque o NOWEB **não manda `to`** no payload de mensagem `fromMe=true`
 * (a que o dono digitou no celular): o chat vai em `from`, e `to` simplesmente
 * não vem. Payload real capturado numa instalação:
 *
 *   { "id": "true_250302204792918@lid_2A1B890FB8AA87730CBC",
 *     "from": "250302204792918@lid", "fromMe": true, "source": "app" }
 *
 * Como o id JÁ carrega o chatId, dá para recuperá-lo sem depender do engine.
 * Mesmo raciocínio de `bareWaMessageId`: chatId (`@c.us`/`@lid`) e o serializado
 * WA não contêm `_`, então as fatias entre o primeiro e o último `_` são o chat.
 *
 * Devolve null quando o id não é composto (id "bare" do envio) ou quando o
 * miolo não parece um chatId — assim quem chama cai no próximo fallback em vez
 * de inventar um contato a partir de lixo.
 */
export function chatIdFromWaMessageId(id: string): string | null {
  const first = id.indexOf('_');
  const last = id.lastIndexOf('_');
  if (first === -1 || last === first) return null;
  const chat = id.slice(first + 1, last);
  return chat.includes('@') ? chat : null;
}

/**
 * O id na forma que o ENCAMINHAMENTO aceita — composta, `{fromMe}_{chatId}_{bare}`.
 *
 * ─── Por que não basta passar o `external_id` como está ─────────────────────
 *
 * Encaminhar pede a mensagem de ORIGEM, e o canal só a localiza pelo id que
 * carrega o chat onde ela vive. O bare sozinho não diz em qual conversa
 * procurar, e a assimetria descrita em `bareWaMessageId` faz com que metade das
 * mensagens do banco esteja gravada exatamente assim:
 *
 *   inbound (veio do webhook)          → composto  → encaminha
 *   outbound no WEBJS (`_serialized`)  → composto  → encaminha
 *   outbound no NOWEB (id cru)         → BARE      → não encaminha
 *
 * A terceira linha não é caso de borda: num engine NOWEB ela é toda mensagem que
 * o próprio atendente mandou — justamente as que mais se quer repassar (o
 * catálogo que ele enviou, o orçamento que ele montou). Sem remontar, a função
 * nasceria funcionando só para o que o cliente escreveu.
 *
 * `fromMe` é `true` porque o bare só aparece na RESPOSTA DE ENVIO: se o id veio
 * sem chat, ele é de mensagem nossa. Inbound chega pelo webhook e já vem composto,
 * caindo no primeiro ramo.
 *
 * Devolve o id intacto quando já está composto (nada a remontar) e também quando
 * não há chat de origem conhecido — aí não há o que inventar, e é melhor deixar o
 * canal recusar com o erro dele do que fabricar uma referência inválida.
 */
export function wahaForwardableId(externalId: string, chatIdOfOrigin?: string | null): string {
  if (chatIdFromWaMessageId(externalId)) return externalId;
  if (!chatIdOfOrigin) return externalId;
  return `true_${chatIdOfOrigin}_${bareWaMessageId(externalId)}`;
}
