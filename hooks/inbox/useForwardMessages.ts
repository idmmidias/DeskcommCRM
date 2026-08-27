"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Message } from "@/lib/types/messaging";

interface ForwardArgs {
  message_ids: string[];
  target_conversation_id: string;
}

interface ForwardRejection {
  message_id: string;
  code: string;
  message: string;
}

interface ForwardResponse {
  data: {
    forwarded: Message[];
    rejected: ForwardRejection[];
  };
}

/**
 * Encaminha mensagens para outra conversa.
 *
 * Uma requisição para o lote inteiro, e não uma por mensagem: o espaçamento
 * entre um envio e o próximo é trava anti-ban e roda no servidor. Por isso a
 * chamada demora proporcionalmente ao tamanho da seleção — quem chama precisa
 * mostrar estado de progresso, não travar a tela achando que é instantâneo.
 */
export function useForwardMessages() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: ForwardArgs) =>
      apiClient.post<ForwardResponse>("/api/v1/messages/forward", args),
    onError: (err) => {
      showApiError(err);
    },
    onSuccess: (res, args) => {
      // A conversa de DESTINO ganhou mensagens; a de origem não mudou.
      qc.invalidateQueries({ queryKey: ["messages", args.target_conversation_id] });
      qc.invalidateQueries({ queryKey: ["conversations"] });

      const { forwarded, rejected } = res.data;
      const enviadas = forwarded.filter((m) => m.status === "sent").length;
      const falharam = forwarded.length - enviadas;

      // Desfecho parcial é o caso NORMAL de um lote, e achatá-lo num "pronto!"
      // esconderia justamente o que o operador precisa saber para reagir. Cada
      // grandeza é dita separada: o que saiu, o que o canal recusou e o que nem
      // chegou a ser tentado.
      if (enviadas > 0) {
        toast.success(
          enviadas === 1 ? "Mensagem encaminhada." : `${enviadas} mensagens encaminhadas.`,
        );
      }
      if (falharam > 0) {
        toast.error(
          falharam === 1
            ? "1 mensagem não pôde ser encaminhada."
            : `${falharam} mensagens não puderam ser encaminhadas.`,
        );
      }
      for (const r of rejected) {
        toast.warning(r.message);
      }
    },
  });
}
