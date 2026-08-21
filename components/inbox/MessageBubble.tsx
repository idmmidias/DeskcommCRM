"use client";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  ArrowBendUpRight,
  Check,
  Checks,
  CheckCircle,
  Circle,
  Robot,
  WarningOctagon,
} from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Message } from "@/lib/types/messaging";
import { CitationButton } from "@/components/ai/CitationButton";
import { MediaRenderer } from "@/components/inbox/media/MediaRenderer";
import {
  extractCitations,
  isAiGeneratedMessage,
} from "@/lib/ai/citations/types";

interface Props {
  message: Message;
  debugCitations?: boolean;
  /** O canal desta conversa encaminha? Falso esconde a ação — não a mostra quebrada. */
  canForward?: boolean;
  /** Modo seleção ligado: a bolha inteira vira alvo de clique. */
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  /** Encaminhar só esta mensagem (atalho de hover, sem entrar no modo seleção). */
  onForward?: () => void;
  /** Liga o modo seleção já marcando esta mensagem. */
  onEnterSelection?: () => void;
}

function AckIndicator({ status }: { status: string }) {
  if (status === "read") {
    return <Checks size={12} weight="bold" className="text-blue-400" aria-label="Lida" />;
  }
  if (status === "delivered") {
    return <Checks size={12} weight="bold" className="text-current/70" aria-label="Entregue" />;
  }
  if (status === "sent") {
    return <Check size={12} weight="bold" className="text-current/70" aria-label="Enviada" />;
  }
  return null;
}

export function MessageBubble({
  message,
  debugCitations,
  canForward,
  selectionMode,
  selected,
  onToggleSelect,
  onForward,
  onEnterSelection,
}: Props) {
  const isOutbound = message.direction === "outbound";
  const time = format(new Date(message.sent_at), "HH:mm", { locale: ptBR });
  const isFailed = message.status === "failed";
  const hasMedia = Boolean(message.media_url || message.media_storage_path);
  // Figurinha sem caption: sem moldura de bolha (padrão WhatsApp).
  const isBareSticker = hasMedia && message.type === "sticker" && !message.body;
  // Apagada pelo autor ("apagar para todos"). A linha continua no histórico —
  // sumir com ela deixaria a resposta seguinte respondendo ao nada —, mas o
  // texto não aparece: mostrá-lo seria expor justamente o que o cliente pediu
  // para tirar do ar.
  const apagada = Boolean(message.revoked_at);
  const editada = Boolean(message.edited_at) && !apagada;
  const aiGenerated = isAiGeneratedMessage(message.metadata);
  const citations = extractCitations(message.metadata);
  const showCitationButton =
    isOutbound && aiGenerated && (debugCitations ?? false);
  const senderLabel = (() => {
    if (!isOutbound) return null;
    if (message.sent_via === "ai") return "IA";
    return null;
  })();

  // Esta mensagem CHEGOU a existir no canal? Sem `external_id` não há o que
  // referenciar, e o servidor recusaria. Descobrir isso aqui evita oferecer uma
  // ação que só falharia depois de escolhido o destino — e apagada não se
  // encaminha porque o conteúdo já não existe mais nem para quem a recebeu.
  const encaminhavel = Boolean(canForward) && Boolean(message.external_id) && !apagada;

  // A marca vem do metadado gravado no encaminhamento; a bolha não sabe (nem
  // precisa saber) de onde veio, só que veio de outra conversa.
  const foiEncaminhada = Boolean(
    (message.metadata as Record<string, unknown> | null | undefined)?.forwarded_from,
  );

  // Aparece no hover no ponteiro, mas o foco por teclado também revela — senão a
  // ação existiria só para quem usa mouse.
  const classeAcao = cn(
    "shrink-0 rounded-full p-1.5 text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground",
    "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
  );

  const acoesDeHover =
    encaminhavel && !selectionMode ? (
      <span className="flex shrink-0 items-center">
        {onForward && (
          <button
            type="button"
            onClick={onForward}
            aria-label="Encaminhar mensagem"
            title="Encaminhar"
            className={classeAcao}
          >
            <ArrowBendUpRight size={16} aria-hidden />
          </button>
        )}
        {onEnterSelection && (
          // Existe separado do encaminhar porque são duas intenções diferentes:
          // "esta aqui" e "esta e mais algumas". Fundir as duas obrigaria quem
          // quer uma só a passar pelo modo seleção, que é o caminho mais longo
          // para o caso mais comum.
          <button
            type="button"
            onClick={onEnterSelection}
            aria-label="Selecionar mensagens"
            title="Selecionar mensagens"
            className={classeAcao}
          >
            <CheckCircle size={16} aria-hidden />
          </button>
        )}
      </span>
    ) : null;

  return (
    <div
      className={cn(
        "group flex w-full items-center gap-1 px-4 py-1",
        isOutbound ? "justify-end" : "justify-start",
        selectionMode && "cursor-pointer",
        selected && "bg-accent/40",
      )}
      onClick={selectionMode ? onToggleSelect : undefined}
      // No modo seleção a linha inteira é o controle. Fora dele não é clicável,
      // e anunciar um `role` que não faz nada confundiria o leitor de tela.
      role={selectionMode ? "checkbox" : undefined}
      aria-checked={selectionMode ? Boolean(selected) : undefined}
      tabIndex={selectionMode ? 0 : undefined}
      onKeyDown={
        selectionMode
          ? (e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                onToggleSelect?.();
              }
            }
          : undefined
      }
    >
      {selectionMode && (
        <span className="shrink-0 pr-1 text-muted-foreground" aria-hidden>
          {selected ? (
            <CheckCircle size={20} weight="fill" className="text-primary" />
          ) : (
            <Circle size={20} />
          )}
        </span>
      )}

      {isOutbound && acoesDeHover}

      <div
        className={cn(
          "max-w-[75%] text-sm",
          isBareSticker
            ? "px-0 py-0"
            : cn(
                "rounded-2xl px-3 py-2 shadow-sm",
                isOutbound
                  ? "rounded-br-sm bg-primary text-primary-foreground"
                  : "rounded-bl-sm bg-muted text-foreground",
              ),
          isFailed && "border border-destructive",
        )}
      >
        {senderLabel && (
          <div className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide opacity-80">
            {senderLabel === "IA" ? (
              <Robot size={10} weight="duotone" aria-hidden />
            ) : null}
            {senderLabel}
          </div>
        )}

        {foiEncaminhada && !apagada && (
          // Acima do conteúdo e em itálico, como no aplicativo: quem lê precisa
          // saber que aquilo não foi escrito para esta conversa ANTES de ler o
          // texto — depois já leu como se fosse.
          <div className="mb-0.5 flex items-center gap-1 text-[11px] italic opacity-70">
            <ArrowBendUpRight size={11} aria-hidden />
            Encaminhada
          </div>
        )}

        {apagada ? (
          // Nem corpo nem mídia: o anexo apagado também sai. Em itálico e
          // esmaecido porque não é texto de ninguém — é o CRM narrando o que
          // aconteceu com aquele lugar da conversa.
          <p className="whitespace-pre-wrap break-words italic leading-snug opacity-60">
            Esta mensagem foi apagada
          </p>
        ) : (
          <>
            {hasMedia && (
              <div className={cn(message.body && "mb-1")}>
                <MediaRenderer message={message} />
              </div>
            )}

            {message.body && (
              <p className="whitespace-pre-wrap break-words leading-snug">{message.body}</p>
            )}
          </>
        )}

        <div
          className={cn(
            "mt-1 flex items-center justify-end gap-1 text-[10px]",
            isOutbound ? "text-primary-foreground/70" : "text-muted-foreground",
          )}
        >
          {editada && (
            // Ao lado da hora, não no corpo: o texto mostrado JÁ é o novo, e o
            // que falta é avisar que ele mudou. Sem isso, um combinado de preço
            // ou endereço é lido como se sempre tivesse dito aquilo — e a
            // divergência só aparece quando alguém cobra o que não foi.
            <span title="O autor editou esta mensagem">editada</span>
          )}
          <span>{time}</span>
          {showCitationButton && (
            <CitationButton citations={citations} messageId={message.id} />
          )}
          {isOutbound && !isFailed && <AckIndicator status={message.status} />}
          {isFailed && (
            // Provider local: o painel do inbox não tem TooltipProvider ancestral e
            // este Tooltip só monta em mensagem failed — sem o provider, abrir uma
            // conversa com falha de envio derrubava o painel inteiro (error boundary).
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-0.5 font-semibold text-destructive">
                    <WarningOctagon size={10} weight="fill" aria-hidden /> Falhou
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {message.error_message ?? message.error_code ?? "Erro desconhecido"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>

      {!isOutbound && acoesDeHover}
    </div>
  );
}
