"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

interface ListResponse {
  data: ConversationWithContact[];
}

/**
 * Conversas candidatas a receber um encaminhamento.
 *
 * Reusa a listagem do inbox com `search` em vez de criar rota nova: os destinos
 * possíveis SÃO as conversas que a pessoa já pode ver, e a RLS que decide isso é
 * a mesma. Uma rota paralela precisaria repetir essa regra — e regra repetida é
 * regra que diverge.
 *
 * `exclude_finished` fica de fora de propósito: encaminhar para uma conversa
 * fechada é caso legítimo (o cliente perguntou por um item que já foi tratado em
 * outro atendimento), e esconder o destino obrigaria a reabrir a conversa só
 * para poder mandar.
 */
export function useForwardTargets(search: string, enabled: boolean) {
  const termo = search.trim();

  return useQuery({
    queryKey: ["forward-targets", termo],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (termo) qs.set("search", termo);
      // Curto porque isto alimenta uma lista de escolha, não uma navegação: quem
      // não achou nos primeiros refina a busca, e trazer mais só deixaria a
      // rolagem mais longa.
      qs.set("limit", "20");
      return apiClient.get<ListResponse>(`/api/v1/conversations?${qs.toString()}`);
    },
    enabled,
    staleTime: 30_000,
    select: (res) => res.data,
  });
}
