"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { format } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import {
  ArrowBendUpLeft,
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
import { ContactCard } from "@/components/inbox/media/ContactCard";
import {
  extractCitations,
  isAiGeneratedMessage,
} from "@/lib/ai/citations/types";

interface Props {
  message: Message;
  debugCitations?: boolean;
  /** Escolher esta mensagem para responder "em cima" dela. */
  onResponder?: (m: Message) => void;
  /** A mensagem citada por ESTA, quando houver — desenha o fio. */
  citada?: Message | null;
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

function AckIndicator({ status, t }: { status: string; t: (texto: string) => string }) {
  if (status === "read") {
    return <Checks size={12} weight="bold" className="text-blue-400" aria-label={t("Lida")} />;
  }
  if (status === "delivered") {
    return <Checks size={12} weight="bold" className="text-current/70" aria-label={t("Entregue")} />;
  }
  if (status === "sent") {
    return <Check size={12} weight="bold" className="text-current/70" aria-label={t("Enviada")} />;
  }
  return null;
}

export function MessageBubble({
  message,
  debugCitations,
  onResponder,
  citada,
  canForward,
  selectionMode,
  selected,
  onToggleSelect,
  onForward,
  onEnterSelection,
}: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const isOutbound = message.direction === "outbound";
  const time = format(new Date(message.sent_at), "HH:mm", { locale: localeDaData });
  const isFailed = message.status === "failed";
  const hasMedia = Boolean(message.media_url || message.media_storage_path);
  const isContact = message.type === "contact";
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
  //
  // VISÍVEL POR PADRÃO, escondida só onde EXISTE hover. A regra chegou com o
  // botão Responder da v1.6.0 e passou a valer para a barra inteira: `opacity-0`
  // + `group-hover` deixa o botão invisível para sempre no celular (não há como
  // passar o mouse, e `focus-visible` só chega por teclado), ou seja, a ação
  // sumia justamente onde esta equipe mais atende. `@media (hover: hover)`
  // pergunta pelo DISPOSITIVO, não pela largura — tablet de toque continua
  // mostrando, desktop estreito continua escondendo.
  const classeAcao = cn(
    "shrink-0 rounded-full p-1.5 text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground",
    "opacity-100 [@media(hover:hover)]:opacity-0",
    "[@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100",
  );

  // Responder (v1.6.0) e encaminhar/selecionar (patch da IDM) nasceram disputando
  // o MESMO canto da bolha, cada um com a sua regra de visibilidade. Viram uma
  // barra só: são todas ações sobre esta mensagem, e dois grupos flutuantes
  // brigariam pelo espaço no hover.
  const temAcaoDeMensagem = Boolean(onResponder) || encaminhavel;

  const acoesDeHover =
    temAcaoDeMensagem && !selectionMode ? (
      <span className="flex shrink-0 items-center">
        {onResponder && (
          <button
            type="button"
            onClick={() => onResponder(message)}
            aria-label={t("Responder a esta mensagem")}
            title={t("Responder")}
            className={classeAcao}
          >
            <ArrowBendUpLeft size={16} aria-hidden />
          </button>
        )}
        {encaminhavel && onForward && (
          <button
            type="button"
            onClick={onForward}
            aria-label={t("Encaminhar mensagem")}
            title={t("Encaminhar")}
            className={classeAcao}
          >
            <ArrowBendUpRight size={16} aria-hidden />
          </button>
        )}
        {encaminhavel && onEnterSelection && (
          // Existe separado do encaminhar porque são duas intenções diferentes:
          // "esta aqui" e "esta e mais algumas". Fundir as duas obrigaria quem
          // quer uma só a passar pelo modo seleção, que é o caminho mais longo
          // para o caso mais comum.
          <button
            type="button"
            onClick={onEnterSelection}
            aria-label={t("Selecionar mensagens")}
            title={t("Selecionar mensagens")}
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
        {/*
          A CITAÇÃO, dentro da bolha e acima do texto — o fio.

          Mostra de quem era e um trecho. `line-clamp-2` porque serve para
          reconhecer, não para reler: a original está logo acima no histórico.
        */}
        {citada && (
          <div
            className={cn(
              "mb-1 rounded-md border-l-2 px-2 py-1 text-xs",
              isOutbound
                ? "border-primary-foreground/50 bg-primary-foreground/10"
                : "border-primary bg-background/60",
            )}
          >
            <div className="font-medium opacity-80">
              {citada.direction === "outbound" ? t("Você") : t("Cliente")}
            </div>
            {/*
              A CITADA PODE TER SIDO APAGADA — e aí o texto dela não volta aqui.

              A bolha principal já trata isto (`apagada`, acima): "mostrá-lo
              seria expor justamente o que o cliente pediu para tirar do ar". A
              citação é o mesmo texto, num segundo lugar da tela — sem esta
              linha, o "apagar para todos" do cliente sumia da bolha original e
              continuava legível dentro de cada resposta que a citou. O fio
              permanece (a citação some, não a resposta); o conteúdo, não.
            */}
            <div className={cn("line-clamp-2 opacity-70", citada.revoked_at && "italic")}>
              {citada.revoked_at
                ? t("Esta mensagem foi apagada")
                : citada.body?.trim() || t("(sem texto)")}
            </div>
          </div>
        )}
        {senderLabel && (
          <div className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold opacity-80">
            {senderLabel === "IA" ? (
              <Robot size={10} weight="duotone" aria-hidden />
            ) : null}
            {senderLabel && t(senderLabel)}
          </div>
        )}

        {foiEncaminhada && !apagada && (
          // Acima do conteúdo e em itálico, como no aplicativo: quem lê precisa
          // saber que aquilo não foi escrito para esta conversa ANTES de ler o
          // texto — depois já leu como se fosse.
          <div className="mb-0.5 flex items-center gap-1 text-[11px] italic opacity-70">
            <ArrowBendUpRight size={11} aria-hidden />
            {t("Encaminhada")}
          </div>
        )}

        {apagada ? (
          // Nem corpo nem mídia: o anexo apagado também sai. Em itálico e
          // esmaecido porque não é texto de ninguém — é o CRM narrando o que
          // aconteceu com aquele lugar da conversa.
          <p className="whitespace-pre-wrap break-words italic leading-snug opacity-60">
            {t("Esta mensagem foi apagada")}
          </p>
        ) : (
          <>
            {hasMedia && (
              <div className={cn(message.body && "mb-1")}>
                <MediaRenderer message={message} />
              </div>
            )}

            {isContact && !hasMedia && (
              <div className={cn(message.body && isContact && "mb-1")}>
                <ContactCard message={message} />
              </div>
            )}

            {message.body && !isContact && (
              <p className="whitespace-pre-wrap break-words leading-snug">{message.body}</p>
            )}
          </>
        )}

        <div
          className={cn(
            "mt-1 flex items-center justify-end gap-1 text-[10px]",
            isOutbound ? "text-primary-foreground" : "text-muted-foreground",
          )}
        >
          {editada && (
            // Ao lado da hora, não no corpo: o texto mostrado JÁ é o novo, e o
            // que falta é avisar que ele mudou. Sem isso, um combinado de preço
            // ou endereço é lido como se sempre tivesse dito aquilo — e a
            // divergência só aparece quando alguém cobra o que não foi.
            <span title={t("O autor editou esta mensagem")}>{t("editada")}</span>
          )}
          <span>{time}</span>
          {showCitationButton && (
            <CitationButton citations={citations} messageId={message.id} />
          )}
          {isOutbound && !isFailed && <AckIndicator status={message.status} t={t} />}
          {isFailed && (
            // Provider local: o painel do inbox não tem TooltipProvider ancestral e
            // este Tooltip só monta em mensagem failed — sem o provider, abrir uma
            // conversa com falha de envio derrubava o painel inteiro (error boundary).
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-0.5 font-semibold text-destructive">
                    <WarningOctagon size={10} weight="fill" aria-hidden /> {t("Falhou")}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {message.error_message ? t(message.error_message) : (message.error_code ?? t("Erro desconhecido"))}
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
