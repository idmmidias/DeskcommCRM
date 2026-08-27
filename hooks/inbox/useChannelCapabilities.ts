"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/**
 * O que o canal desta conversa permite — em capacidades, nunca em identidade.
 *
 * A tela usa isto para decidir quais ações oferecer. Perguntar "qual canal é"
 * seria o `if (provider === ...)` que a doutrina de canal proíbe; perguntar
 * "ele encaminha?" é a mesma decisão sem a fragilidade.
 */
export interface ChannelCapabilitiesDTO {
  can_forward: boolean;
  freeform_outside_window: boolean;
  requires_templates: boolean;
  cost_per_message: boolean;
}

export function useChannelCapabilities(conversationId: string | null) {
  return useQuery({
    queryKey: ["conversation", conversationId, "capabilities"],
    queryFn: async () =>
      apiClient.get<{ data: ChannelCapabilitiesDTO }>(
        `/api/v1/conversations/${conversationId}/capabilities`,
      ),
    enabled: Boolean(conversationId),
    // Capability de canal não muda enquanto a conversa está aberta: ela é
    // propriedade da plataforma, não estado da operação. Refazer a pergunta a
    // cada foco seria gastar requisição para receber sempre a mesma resposta.
    staleTime: 10 * 60_000,
    select: (res) => res.data,
  });
}
