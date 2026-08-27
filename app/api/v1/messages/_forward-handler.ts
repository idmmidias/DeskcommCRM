/**
 * Encaminhamento de mensagens entre conversas — o "Encaminhar" do aplicativo.
 *
 * Reusado por:
 *  - POST /api/v1/messages/forward
 *
 * ─── Por que isto não é "enviar de novo" ────────────────────────────────────
 *
 * Reenviar baixa o anexo e sobe outra vez: vira uma mensagem NOVA, sem a marca
 * de encaminhada, pagando um upload inteiro. Encaminhar referencia a mensagem
 * original dentro da sessão do canal — o anexo não trafega de novo e quem recebe
 * vê que aquilo veio de outra conversa. Nem todo canal tem a primitiva, e por
 * isso ela é uma capability (`canForward`) e um método opcional do adapter.
 *
 * ─── Por que em lote, sempre ────────────────────────────────────────────────
 *
 * Encaminhar é a primeira operação MANUAL que dispara várias mensagens de um
 * clique só. No envio comum existe um humano digitando entre uma e outra, e é
 * esse ritmo que segura o padrão de rajada; aqui ele não existe. O espaçamento
 * precisa morar no servidor: se ficasse na tela, o próximo chamador (um script,
 * o MCP, um retry automático) não o teria — e trava que só um chamador respeita
 * não é trava.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import {
  capabilitiesOf,
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelSessionRef,
} from "@/lib/channels";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import type { ForwardMessagesInput } from "@/lib/schemas";
import type { Message } from "@/lib/types/messaging";

import { MSG_COLS, previewFrom, removerEcoDoProprioEnvio } from "./_handler";

type SB = SupabaseClient;

/**
 * Espaçamento entre um encaminhamento e o próximo, sorteado dentro da faixa.
 *
 * Faixa e não valor fixo de propósito: cadência regular é assinatura de robô
 * mais legível do que o volume em si. O piso mantém a operação tolerável para
 * quem está olhando a tela; o teto, somado ao limite de itens do lote, mantém a
 * requisição inteira dentro de poucos segundos.
 */
const JITTER_MIN_MS = 600;
const JITTER_MAX_MS = 1600;

function esperarComJitter(): Promise<void> {
  const ms = JITTER_MIN_MS + Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mensagem que nem chegou a ser tentada, e por quê. */
export interface ForwardRejection {
  message_id: string;
  code: "no_external_id" | "not_found";
  message: string;
}

export interface ForwardResult {
  /** As linhas criadas na conversa de destino, com o status de cada uma. */
  forwarded: Message[];
  /** Recusadas ANTES de tocar o canal — nenhuma linha foi criada para elas. */
  rejected: ForwardRejection[];
}

interface OrigemJoin {
  id: string;
  external_id: string | null;
  type: string;
  body: string | null;
  media_url: string | null;
  media_mime: string | null;
  media_size_bytes: number | null;
  media_storage_path: string | null;
  sent_at: string;
  conversations: {
    is_group: boolean;
    group_chat_id: string | null;
    contacts: {
      phone_number: string | null;
      wa_identity: string | null;
      wa_lid: string | null;
    } | null;
  } | null;
}

export async function forwardMessagesHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: ForwardMessagesInput,
): Promise<ForwardResult> {
  // ── Destino ────────────────────────────────────────────────────────────────
  // Mesmo `select` tolerante do envio comum, pelo mesmo motivo: num clone sem a
  // migration 0106, pedir `archived_at` direto derrubaria a operação com 42703.
  const convSelect = (comArchived: boolean) =>
    `id, organization_id, contact_id, channel_session_id, is_group, group_chat_id, provider_conversation_id, contacts:contact_id(phone_number, wa_identity, wa_lid, is_blocked), channel_sessions:channel_session_id(${CHANNEL_SESSION_REF_COLUMNS}, status${comArchived ? `, ${ARCHIVED_AT}` : ""})`;

  const { data: conv, error: convErr } = await queryTolerantToMissingArchived(
    () =>
      supabase
        .from("conversations")
        .select(convSelect(true))
        .eq("id", input.target_conversation_id)
        .eq("organization_id", ctx.organization_id)
        .maybeSingle(),
    () =>
      supabase
        .from("conversations")
        .select(convSelect(false))
        .eq("id", input.target_conversation_id)
        .eq("organization_id", ctx.organization_id)
        .maybeSingle(),
  );

  if (convErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, convErr.message);
  }
  if (!conv) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Conversa de destino não encontrada.");
  }

  type DestinoJoin = {
    id: string;
    organization_id: string;
    contact_id: string;
    channel_session_id: string;
    is_group: boolean;
    group_chat_id: string | null;
    provider_conversation_id: string | null;
    contacts: {
      phone_number: string | null;
      wa_identity: string | null;
      wa_lid: string | null;
      is_blocked: boolean;
    } | null;
    channel_sessions: (ChannelSessionRef & { status: string; archived_at?: string | null }) | null;
  };
  const destino = conv as unknown as DestinoJoin;

  if (destino.contacts?.is_blocked) {
    throw new ApiError(403, "forbidden", undefined, ctx.requestId, "Contato bloqueou o atendimento.");
  }
  if (destino.channel_sessions?.archived_at) {
    throw new ApiError(
      422,
      "channel_archived",
      undefined,
      ctx.requestId,
      "Este número foi excluído da Central de Conexões.",
    );
  }

  const provider = destino.channel_sessions?.provider ?? DEFAULT_CHANNEL_PROVIDER;
  const adapter = getAdapter(provider);

  // A capability e o método respondem à MESMA pergunta em dois momentos: ela
  // para quem decide sem ter adapter (a tela), ele para quem vai executar. Testar
  // os dois mantém a resposta honesta mesmo se um canal declarar `true` e não
  // implementar — que seria bug nosso, e é melhor recusar do que estourar.
  if (!capabilitiesOf(provider).canForward || !adapter.forwardMessage) {
    throw new ApiError(
      422,
      "forward_unsupported",
      undefined,
      ctx.requestId,
      "O canal desta conversa não permite encaminhar mensagens.",
    );
  }
  if (!adapter.isConfigured()) {
    throw new ApiError(
      422,
      adapter.codes.notConfigured,
      undefined,
      ctx.requestId,
      "O canal desta conversa ainda não está conectado.",
    );
  }
  if (!destino.channel_sessions || destino.channel_sessions.status !== "WORKING") {
    throw new ApiError(
      422,
      "channel_session_not_working",
      undefined,
      ctx.requestId,
      "A conexão deste número não está ativa no momento.",
    );
  }

  const chatIdDestino = adapter.resolveRecipient({
    isGroup: destino.is_group,
    groupChatId: destino.group_chat_id,
    phoneNumber: destino.contacts?.phone_number,
    waIdentity: destino.contacts?.wa_identity,
    waLid: destino.contacts?.wa_lid,
  });
  if (!chatIdDestino) {
    throw new ApiError(
      422,
      "missing_phone_number",
      undefined,
      ctx.requestId,
      "A conversa de destino não tem endereço para envio.",
    );
  }

  // ── Origens ────────────────────────────────────────────────────────────────
  // O contato da conversa de ORIGEM vem junto porque é dele que sai o chat usado
  // para remontar o id em engine assimétrico (ver `wahaForwardableId`). Sem ele,
  // encaminhar mensagem que nós mesmos mandamos falharia em parte dos canais.
  const { data: origensRaw, error: origensErr } = await supabase
    .from("messages")
    .select(
      `id, external_id, type, body, media_url, media_mime, media_size_bytes, media_storage_path, sent_at,
       conversations:conversation_id(is_group, group_chat_id, contacts:contact_id(phone_number, wa_identity, wa_lid))`,
    )
    .in("id", input.message_ids)
    .eq("organization_id", ctx.organization_id);

  if (origensErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, origensErr.message);
  }

  const origens = (origensRaw ?? []) as unknown as OrigemJoin[];
  const porId = new Map(origens.map((m) => [m.id, m]));

  const rejected: ForwardRejection[] = [];
  for (const id of input.message_ids) {
    const m = porId.get(id);
    if (!m) {
      rejected.push({ message_id: id, code: "not_found", message: "Mensagem não encontrada." });
      continue;
    }
    if (!m.external_id) {
      // Não é falha de envio: é pré-condição não atendida. A mensagem nunca
      // chegou ao canal (envio que falhou antes), então não existe nada lá para
      // referenciar. Criar uma linha `failed` no destino registraria uma
      // tentativa que não houve — recusa antes, e a tela mostra o porquê.
      rejected.push({
        message_id: id,
        code: "no_external_id",
        message: "Esta mensagem não chegou a ser enviada pelo canal, então não pode ser encaminhada.",
      });
    }
  }

  // Cronológica, não a ordem em que a tela mandou: quem recebe lê uma sequência,
  // e fora de ordem a conversa encaminhada deixa de fazer sentido.
  const aEncaminhar = origens
    .filter((m) => m.external_id)
    .sort((a, b) => a.sent_at.localeCompare(b.sent_at));

  if (aEncaminhar.length === 0) {
    return { forwarded: [], rejected };
  }

  const sessionRef = resolveSessionRef(destino.channel_sessions);
  const forwarded: Message[] = [];

  for (const [indice, origem] of aEncaminhar.entries()) {
    // Antes de CADA envio menos o primeiro. Depois do último seria segurar a
    // resposta sem motivo nenhum.
    if (indice > 0) await esperarComJitter();

    const now = new Date().toISOString();
    const { data: created, error: insErr } = await supabase
      .from("messages")
      .insert({
        organization_id: destino.organization_id,
        conversation_id: destino.id,
        channel_session_id: destino.channel_session_id,
        contact_id: destino.contact_id,
        type: origem.type,
        direction: "outbound" as const,
        status: "queued",
        body: origem.body,
        // A mídia é espelhada para a linha nova conseguir se RENDERIZAR na tela.
        // O canal não usa nada disto: lá o anexo vai pela referência à mensagem
        // original, sem re-upload — este espelho é só o que o inbox lê.
        media_url: origem.media_url,
        media_mime: origem.media_mime,
        media_size_bytes: origem.media_size_bytes,
        media_storage_path: origem.media_storage_path,
        sent_via: ctx.actor.type !== "user" ? ("ai" as const) : ("user" as const),
        sent_by_user_id: ctx.actor.type === "user" ? ctx.actor.id : null,
        sent_at: now,
        metadata: { forwarded_from: origem.id },
      })
      .select(MSG_COLS)
      .single();

    if (insErr || !created) {
      throw new ApiError(
        500,
        "internal_error",
        undefined,
        ctx.requestId,
        insErr?.message ?? "insert_failed",
      );
    }
    let message = created as unknown as Message;

    try {
      const chatIdOrigem = origem.conversations
        ? adapter.resolveRecipient({
            isGroup: origem.conversations.is_group,
            groupChatId: origem.conversations.group_chat_id,
            phoneNumber: origem.conversations.contacts?.phone_number,
            waIdentity: origem.conversations.contacts?.wa_identity,
            waLid: origem.conversations.contacts?.wa_lid,
          })
        : null;

      const { externalId } = await adapter.forwardMessage({
        sessionRef,
        to: chatIdDestino,
        externalId: origem.external_id as string,
        recipientOfOrigin: chatIdOrigem,
      });

      // Sem isto o encaminhamento DUPLICA no destino: o eco do próprio envio
      // volta pelo webhook como `fromMe` e, não achando linha para casar, vira
      // uma segunda mensagem. Mesmo mecanismo (e mesma armadilha) do envio comum.
      await removerEcoDoProprioEnvio(
        supabase,
        ctx.organization_id,
        destino.id,
        message.id,
        externalId,
        externalId
          ? (adapter.echoExternalIds?.({ externalId, recipient: chatIdDestino }) ?? [externalId])
          : [],
      );

      const { data: updated } = await supabase
        .from("messages")
        .update({ status: "sent", external_id: externalId, ack: 0 })
        .eq("id", message.id)
        .select(MSG_COLS)
        .maybeSingle();
      if (updated) message = updated as unknown as Message;
    } catch (err) {
      // Um item que falha NÃO aborta o lote: as outras mensagens são
      // independentes, e desistir de todas por causa de uma faria o operador
      // reenviar as que já tinham chegado — duplicando para o cliente.
      const msg = err instanceof Error ? err.message : adapter.codes.unknownError;
      const { data: updated } = await supabase
        .from("messages")
        .update({ status: "failed", error_code: adapter.codes.sendFailed, error_message: msg })
        .eq("id", message.id)
        .select(MSG_COLS)
        .maybeSingle();
      if (updated) message = updated as unknown as Message;
    }

    forwarded.push(message);

    await supabase
      .rpc("emit_event", {
        p_event_type: "message.sent",
        p_entity_kind: "message",
        p_entity_id: message.id,
        p_payload: { status: message.status, conversation_id: destino.id, forwarded: true },
        p_metadata: { request_id: ctx.requestId },
        p_organization_id: destino.organization_id,
      })
      .then(({ error }) => {
        if (error) console.error("[messages.forward] emit_event failed", error.message);
      });
  }

  // Uma atualização só, com a última mensagem: o que a lista de conversas mostra
  // é o estado final, e escrever a cada item seria N escritas para o mesmo efeito.
  const ultima = forwarded[forwarded.length - 1];
  if (ultima) {
    await supabase
      .from("conversations")
      .update({
        last_outbound_at: ultima.sent_at,
        last_message_at: ultima.sent_at,
        last_message_preview: previewFrom({
          body: ultima.body ?? undefined,
          media_url: ultima.media_url ?? undefined,
          media_storage_path: ultima.media_storage_path ?? undefined,
          type: ultima.type,
        }),
      })
      .eq("id", destino.id);
  }

  await audit({
    action: "message.forwarded",
    actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
    organizationId: destino.organization_id,
    resourceType: "conversation",
    resourceId: destino.id,
    requestId: ctx.requestId,
    metadata: {
      total: forwarded.length,
      enviadas: forwarded.filter((m) => m.status === "sent").length,
      recusadas: rejected.length,
      origem_ids: aEncaminhar.map((m) => m.id),
    },
  });

  return { forwarded, rejected };
}
