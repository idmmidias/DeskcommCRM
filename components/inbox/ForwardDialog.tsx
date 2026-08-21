"use client";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Check, MagnifyingGlass } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { useForwardMessages } from "@/hooks/inbox/useForwardMessages";
import { useForwardTargets } from "@/hooks/inbox/useForwardTargets";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Mensagens escolhidas, na ordem em que a tela as tem. O servidor reordena. */
  messageIds: string[];
  /** Some da lista de destinos: encaminhar para a própria conversa é quase sempre engano. */
  currentConversationId: string | null;
  /** Chamado depois de um encaminhamento aceito — a tela sai do modo seleção. */
  onDone?: () => void;
}

/** Espera antes de consultar: o servidor não precisa ver cada tecla. */
const DEBOUNCE_MS = 300;

export function ForwardDialog({
  open,
  onOpenChange,
  messageIds,
  currentConversationId,
  onDone,
}: Props) {
  const [busca, setBusca] = useState("");
  const [buscaAdiada, setBuscaAdiada] = useState("");
  const [destino, setDestino] = useState<string | null>(null);
  const forward = useForwardMessages();

  useEffect(() => {
    const t = setTimeout(() => setBuscaAdiada(busca), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [busca]);

  const alvos = useForwardTargets(buscaAdiada, open);

  const opcoes = useMemo(
    () => (alvos.data ?? []).filter((c) => c.id !== currentConversationId),
    [alvos.data, currentConversationId],
  );

  function fechar(v: boolean) {
    if (!v) {
      setBusca("");
      setBuscaAdiada("");
      setDestino(null);
    }
    onOpenChange(v);
  }

  const total = messageIds.length;

  return (
    <Dialog open={open} onOpenChange={fechar}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {total === 1 ? "Encaminhar mensagem" : `Encaminhar ${total} mensagens`}
          </DialogTitle>
          <DialogDescription>
            {/* O que o operador precisa saber ANTES de confirmar: o destinatário
                verá que a mensagem foi encaminhada, e o envio é espaçado — a
                espera é proposital, não travamento. */}
            A mensagem chega marcada como encaminhada, igual ao aplicativo.
            {total > 1 && " O envio é espaçado, então leva alguns segundos."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <MagnifyingGlass
              size={16}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              autoFocus
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar conversa por nome ou telefone"
              className="pl-8"
              aria-label="Buscar conversa de destino"
            />
          </div>

          <ScrollArea className="h-64 rounded-md border">
            {alvos.isLoading ? (
              <div className="space-y-2 p-2">
                {[1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-11 w-full" />
                ))}
              </div>
            ) : opcoes.length === 0 ? (
              <p className="p-4 text-center text-sm text-muted-foreground">
                {buscaAdiada
                  ? "Nenhuma conversa encontrada."
                  : "Nenhuma outra conversa disponível."}
              </p>
            ) : (
              <ul className="p-1">
                {opcoes.map((c) => {
                  const nome =
                    c.contacts?.display_name ??
                    c.contacts?.name ??
                    c.contacts?.phone_number ??
                    "Contato sem nome";
                  const escolhido = destino === c.id;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setDestino(c.id)}
                        aria-pressed={escolhido}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                          escolhido ? "bg-accent" : "hover:bg-accent/50",
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{nome}</span>
                          {c.contacts?.phone_number && c.contacts.display_name && (
                            <span className="block truncate text-xs text-muted-foreground">
                              {c.contacts.phone_number}
                            </span>
                          )}
                        </span>
                        {escolhido && (
                          <Check size={16} weight="bold" className="shrink-0" aria-hidden />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => fechar(false)} disabled={forward.isPending}>
            Cancelar
          </Button>
          <Button
            disabled={!destino || forward.isPending || total === 0}
            onClick={() => {
              if (!destino) return;
              forward.mutate(
                { message_ids: messageIds, target_conversation_id: destino },
                {
                  onSuccess: () => {
                    fechar(false);
                    onDone?.();
                  },
                },
              );
            }}
          >
            {forward.isPending ? "Encaminhando…" : "Encaminhar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
