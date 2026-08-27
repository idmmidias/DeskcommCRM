"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format, isToday, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageBubble } from "./MessageBubble";
import { NoteCard } from "./NoteCard";
import { ForwardDialog } from "./ForwardDialog";
import { useMessagesRealtime } from "@/hooks/inbox/useMessagesRealtime";
import { useConversationNotes } from "@/hooks/inbox/useConversationNotes";
import { useDeleteNote } from "@/hooks/inbox/useDeleteNote";
import { useChannelCapabilities } from "@/hooks/inbox/useChannelCapabilities";
import { useDebugToggle } from "@/hooks/ai/useDebugToggle";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import { FORWARD_MAX_BATCH } from "@/lib/schemas";
import { ArrowBendUpRight, X } from "@/lib/ui/icons";
import type { Message, Note } from "@/lib/types/messaging";

interface Props {
  conversationId: string | null;
  /** Escolher uma mensagem para responder. Sobe até o composer. */
  onResponder?: (m: Message) => void;
}

/** Onda 5.2: union de item do thread — mensagem real ou nota interna (nunca vai ao cliente). */
export type ThreadItem =
  | { kind: "message"; ts: string; data: Message }
  | { kind: "note"; ts: string; data: Note };

/** Intercala mensagens e notas por timestamp asc (puro, sem I/O — testado em thread-merge.test.ts). */
export function mergeThreadItems(messages: Message[], notes: Note[]): ThreadItem[] {
  const items: ThreadItem[] = [
    ...messages.map((data): ThreadItem => ({ kind: "message", ts: data.sent_at, data })),
    ...notes.map((data): ThreadItem => ({ kind: "note", ts: data.created_at, data })),
  ];
  // Sort estável (Array#sort é estável no V8/Node): empate mantém a ordem de
  // inserção acima — mensagens antes de notas no mesmo instante.
  items.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return items;
}

function dayLabel(d: Date): string {
  if (isToday(d)) return "Hoje";
  if (isYesterday(d)) return "Ontem";
  return format(d, "dd/MM/yyyy", { locale: ptBR });
}

export function ChatThread({ conversationId, onResponder }: Props) {
  const q = useMessagesRealtime(conversationId);
  const notes = useConversationNotes(conversationId);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const paginasVistas = useRef(0);
  const activeOrg = useActiveOrg();
  const currentUser = useUser();
  const deleteNote = useDeleteNote(conversationId ?? "");
  const canManage = activeOrg != null && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  const { enabled: debugCitations } = useDebugToggle(activeOrg?.role ?? null);

  // ── Encaminhamento ─────────────────────────────────────────────────────────
  // A tela pergunta o que o canal PERMITE, nunca qual canal é (doutrina de
  // restrição de canal, invariante 1). Enquanto a resposta não chega, a ação não
  // aparece — melhor um botão que surge um instante depois do que um que some
  // na cara de quem já ia clicar.
  const caps = useChannelCapabilities(conversationId);
  const canForward = caps.data?.can_forward ?? false;

  const [selectionMode, setSelectionMode] = useState(false);
  const [selecionadas, setSelecionadas] = useState<string[]>([]);
  const [forwardAberto, setForwardAberto] = useState(false);
  // Encaminhar UMA mensagem pelo atalho de hover não passa pela seleção: o alvo
  // vai direto para o diálogo e a thread continua como estava.
  const [alvoAvulso, setAlvoAvulso] = useState<string | null>(null);

  const sairDaSelecao = useCallback(() => {
    setSelectionMode(false);
    setSelecionadas([]);
  }, []);

  // Conversa nova zera a seleção: manter ids de outra thread faria o diálogo
  // encaminhar mensagem que não está mais na tela.
  //
  // Ajustado DURANTE o render, não por efeito. É o padrão que o próprio React
  // recomenda para "resetar estado quando uma prop muda": por efeito, a thread
  // chega a pintar uma vez com a seleção da conversa ANTERIOR sobre as mensagens
  // da nova — e é essa passada intermediária que faria a barra anunciar
  // "3 selecionadas" numa conversa onde nada está selecionado.
  const [convAnterior, setConvAnterior] = useState(conversationId);
  if (conversationId !== convAnterior) {
    setConvAnterior(conversationId);
    setSelectionMode(false);
    setSelecionadas([]);
    setAlvoAvulso(null);
    setForwardAberto(false);
  }

  // Esc sai do modo seleção — mas não enquanto o diálogo está aberto, senão a
  // mesma tecla fecharia os dois de uma vez e a escolha do destino se perderia.
  useEffect(() => {
    if (!selectionMode || forwardAberto) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") sairDaSelecao();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionMode, forwardAberto, sairDaSelecao]);

  const alternarSelecao = useCallback((id: string) => {
    setSelecionadas((atual) => {
      if (atual.includes(id)) return atual.filter((x) => x !== id);
      if (atual.length >= FORWARD_MAX_BATCH) {
        // Barrar aqui, e não no envio: o teto existe para limitar a rajada, e
        // descobri-lo só depois de escolher o destino desperdiçaria o trabalho
        // de quem selecionou.
        toast.warning(`Dá para encaminhar até ${FORWARD_MAX_BATCH} mensagens por vez.`);
        return atual;
      }
      return [...atual, id];
    });
  }, []);

  // O que o diálogo recebe: o avulso quando veio do hover, a seleção quando veio
  // da barra. Uma fonte só evita os dois caminhos se contradizerem.
  const idsParaEncaminhar = alvoAvulso ? [alvoAvulso] : selecionadas;

  const messages: Message[] = useMemo(
    () => q.data?.pages.flatMap((p) => p.data) ?? [],
    [q.data],
  );

  /**
   * As mensagens por id, para resolver a CITADA sem ir ao servidor.
   *
   * Uma consulta por bolha citada seria uma cascata de requisições numa
   * conversa longa. Aqui o fio sai da lista que já está na tela — e quando a
   * citada ficou fora da página carregada, ele simplesmente não aparece, que é
   * melhor que segurar a conversa esperando por um texto de enfeite.
   */
  const porId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  const items: ThreadItem[] = useMemo(
    () => mergeThreadItems(messages, notes),
    [messages, notes],
  );

  const paginas = q.data?.pages.length ?? 0;

  // Conversa nova: a contagem de páginas recomeça, senão a primeira carga da
  // próxima conversa seria confundida com um "carregar mais antigas".
  useEffect(() => {
    paginasVistas.current = 0;
  }, [conversationId]);

  // Rola ao fim na primeira carga e quando chega mensagem/nota nova — mas NÃO
  // quando o crescimento veio do "Carregar mais antigas".
  //
  // A thread pagina para o PASSADO: cada `fetchNextPage` traz mensagens mais
  // antigas, que entram ACIMA das que já estão na tela. Rolar ao fim aqui
  // devolveria o usuário ao rodapé no instante em que ele pediu para subir —
  // o clique parece não ter efeito, embora tenha carregado (medido: thread vai
  // de msg#15..#64 para msg#1..#64 e a viewport volta a 7px do fim).
  //
  // A segunda guarda cobre o outro caso: se o usuário rolou para ler o
  // histórico, mensagem nova não deve arrancá-lo de onde estava.
  useEffect(() => {
    const primeiraCarga = paginasVistas.current === 0;
    const carregouAntigas = !primeiraCarga && paginas > paginasVistas.current;
    paginasVistas.current = paginas;
    if (carregouAntigas) return;

    // A guarda de distância NÃO vale na primeira carga: ali o scroller ainda
    // está no topo por definição, e tratá-lo como "usuário lendo o histórico"
    // abriria a conversa na mensagem mais antiga da página em vez da mais nova
    // (medido: a thread abria em msg#15 em vez de msg#64).
    if (!primeiraCarga) {
      const sc = scrollerRef.current;
      if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight > 120) return;
    }

    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, conversationId, paginas]);

  /**
   * O ESTADO DO CANAL DESTE THREAD, PUBLICADO SEMPRE — inclusive quando não há
   * mensagem nenhuma.
   *
   * ⚠️ A primeira versão punha estes atributos só no caso de SUCESSO, junto com
   * o `data-testid`. Isso os tornava invisíveis exatamente no estado em que
   * mais importam: conversa sem mensagens, esperando a primeira chegar. O canal
   * existe desde que a conversa abre; o sinal dele não pode depender de já
   * haver o que mostrar.
   *
   * Custou uma rodada de CI para aparecer, e por um motivo que vale registrar:
   * na máquina de quem desenvolve a conversa tem histórico acumulado, então o
   * caminho de sucesso é o único que se exercita. No CI o banco é fresco e a
   * conversa nasce vazia — o estado que nunca se vê localmente é o normal lá.
   *
   * Os dois atributos dizem coisas diferentes e nenhum sozinho basta:
   * `-status-mensagens` distingue "assinou" de "nem chegou a assinar";
   * `-divergencias-mensagens` é o que denuncia canal ASSINADO E MUDO, porque só
   * incrementa quando o refetch traz o que o canal não trouxe.
   */
  const sinalDoCanal = {
    "data-testid": "chat-thread",
    "data-realtime-status-mensagens": q.realtimeStatus,
    "data-refetch-divergencias-mensagens": q.seguranca?.divergencias ?? 0,
  } as const;

  if (!conversationId) {
    return (
      <div
        {...sinalDoCanal}
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        Selecione uma conversa
      </div>
    );
  }

  if (q.isLoading) {
    return (
      <div {...sinalDoCanal} className="space-y-3 p-4">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-12 w-2/3" />
        ))}
      </div>
    );
  }

  if (q.isError) {
    return (
      <div
        {...sinalDoCanal}
        className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <p>Erro ao carregar mensagens.</p>
        <Button size="sm" variant="outline" onClick={() => q.refetch()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div
        {...sinalDoCanal}
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        Nenhuma mensagem nesta conversa.
      </div>
    );
  }

  // Group by day for separators (usa o timestamp do item — sent_at pra mensagem, created_at pra nota).
  const groups: { key: string; date: Date; items: ThreadItem[] }[] = [];
  for (const item of items) {
    const d = new Date(item.ts);
    const key = format(d, "yyyy-MM-dd");
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, date: d, items: [item] });
  }

  return (
    <div {...sinalDoCanal} className="flex h-full flex-col">
      {selectionMode && (
        // Barra ACIMA da thread, não flutuando sobre ela: o que está selecionado
        // fica visível junto com o que se pode fazer, e nada do histórico é
        // encoberto no momento em que a pessoa está escolhendo.
        <div className="flex items-center justify-between gap-2 border-b bg-muted/50 px-4 py-2">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={sairDaSelecao}
              aria-label="Sair do modo seleção"
            >
              <X size={16} aria-hidden />
            </Button>
            <span className="text-sm font-medium">
              {selecionadas.length === 0
                ? "Selecione as mensagens"
                : `${selecionadas.length} selecionada${selecionadas.length > 1 ? "s" : ""}`}
            </span>
          </div>
          <Button
            size="sm"
            disabled={selecionadas.length === 0}
            onClick={() => {
              setAlvoAvulso(null);
              setForwardAberto(true);
            }}
          >
            <ArrowBendUpRight size={16} className="mr-1.5" aria-hidden />
            Encaminhar
          </Button>
        </div>
      )}

      <ForwardDialog
        open={forwardAberto}
        onOpenChange={(v) => {
          setForwardAberto(v);
          if (!v) setAlvoAvulso(null);
        }}
        messageIds={idsParaEncaminhar}
        currentConversationId={conversationId}
        onDone={sairDaSelecao}
      />

      <div ref={scrollerRef} className="flex-1 overflow-y-auto py-2">
        {q.hasNextPage && (
          <div className="flex justify-center py-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
            >
              {q.isFetchingNextPage ? "Carregando…" : "Carregar mais antigas"}
            </Button>
          </div>
        )}

        {groups.map((g) => (
          <div key={g.key} className="space-y-1">
            <div className="sticky top-0 z-10 flex justify-center py-1">
              <span className="rounded-full bg-background/80 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
                {dayLabel(g.date)}
              </span>
            </div>
            {g.items.map((item) =>
              item.kind === "note" ? (
                <NoteCard
                  key={`note-${item.data.id}`}
                  note={item.data}
                  // Só o autor ou manager+ vê o excluir — o backend barra o resto (403),
                  // então não mostramos um botão que daria erro.
                  onDelete={
                    item.data.created_by_user_id === currentUser.id || canManage
                      ? () => deleteNote.mutate(item.data.id)
                      : undefined
                  }
                />
              ) : (
                <MessageBubble
                  key={`msg-${item.data.id}`}
                  message={item.data}
                  debugCitations={debugCitations}
                  onResponder={onResponder}
                  // A citada sai da MESMA lista já carregada: buscar no servidor
                  // por cada citação faria uma consulta por bolha. Quando a
                  // citada é antiga demais e ficou fora da página, o fio some —
                  // que é melhor que segurar a conversa esperando.
                  citada={porId.get(item.data.reply_to_message_id ?? "") ?? null}
                  canForward={canForward}
                  selectionMode={selectionMode}
                  selected={selecionadas.includes(item.data.id)}
                  onToggleSelect={() => alternarSelecao(item.data.id)}
                  onForward={() => {
                    setAlvoAvulso(item.data.id);
                    setForwardAberto(true);
                  }}
                  onEnterSelection={() => {
                    setSelectionMode(true);
                    setSelecionadas([item.data.id]);
                  }}
                />
              ),
            )}
          </div>
        ))}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
