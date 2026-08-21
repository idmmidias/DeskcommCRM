/**
 * Schemas Zod do EPIC-03 Inbox + Messaging.
 *
 * Cobre boundary de validação das rotas /api/v1/conversations e
 * /api/v1/messages. Validações compartilhadas entre rota REST e webhooks
 * (quando o payload entra na pipeline pós-verificação HMAC).
 */
import { z } from "zod";

export const conversationStatusSchema = z.enum([
  "open",
  "claimed",
  "ai_handling",
  "closed",
  "archived",
]);

export const messageDirectionSchema = z.enum(["inbound", "outbound"]);

export const messageTypeSchema = z.enum([
  "text",
  "image",
  "audio",
  "document",
  "sticker",
  "video",
  "location",
  "contact",
  // Envio de template aprovado (canal oficial, fora da janela de 24h). Não é
  // "texto com outro nome": o tipo é o que carrega custo, conformidade de janela e
  // o que o contato de fato viu (cabeçalho, rodapé, botões).
  "template",
]);

export const messageStatusSchema = z.enum([
  "queued",
  "sending",
  "sent",
  "delivered",
  "read",
  "failed",
]);

export const sendMessageSchema = z
  .object({
    conversation_id: z.string().uuid(),
    type: messageTypeSchema.default("text"),
    body: z.string().min(1).max(4096).optional(),
    media_url: z.string().url().optional(),
    media_storage_path: z.string().min(1).max(500).optional(),
    media_mime: z.string().optional(),
    media_size_bytes: z.number().int().positive().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    /** Só em `type: "template"`. Nome exato aprovado na Meta. */
    template_name: z.string().min(1).max(512).optional(),
    /** Só em `type: "template"`. `pt_BR` e `pt` são templates DISTINTOS. */
    template_language: z.string().min(2).max(16).optional(),
    /**
     * Só em `type: "template"`. Valor por slot, chaveado por `slotKey`
     * (`lib/channels/meta/build-components.ts`) — a MESMA função que o formulário
     * da tela usa. Chave montada de outro jeito é o mismatch voltando.
     */
    template_values: z.record(z.string(), z.string()).optional(),
  })
  .refine((d) => !!d.body || !!d.media_url || !!d.media_storage_path, {
    message: "body, media_url or media_storage_path required",
    path: ["body"],
  });

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/**
 * Teto de mensagens por encaminhamento.
 *
 * Dois motivos independentes, e o menor dos dois é que manda:
 *
 *  1. **Anti-ban.** Encaminhar em lote é o primeiro caminho MANUAL que dispara
 *     várias mensagens de um clique só — sem alguém digitando entre uma e outra,
 *     o ritmo natural que protege o envio comum desaparece. O handler espaça com
 *     jitter, e o teto limita o tamanho da rajada possível.
 *  2. **A requisição precisa caber.** O espaçamento roda dentro do request; teto
 *     alto demais bate no timeout do proxy e o operador vê erro numa operação que
 *     na verdade estava indo bem.
 *
 * 10 cobre o caso real que motivou a função (repassar o álbum de fotos de um
 * item para outro interessado) e mantém o pior caso em poucos segundos.
 */
export const FORWARD_MAX_BATCH = 10;

/**
 * Encaminhamento — sempre em lote, mesmo quando é uma mensagem só.
 *
 * Uma rota coletiva em vez de uma por mensagem porque o espaçamento anti-ban
 * precisa acontecer no SERVIDOR: se a tela disparasse N requisições, a trava
 * moraria no cliente, e trava que mora no cliente é trava que o próximo
 * chamador (um script, o MCP, um retry) não tem.
 */
export const forwardMessagesSchema = z.object({
  /** Na ordem em que o chamador quiser; o handler reordena cronologicamente. */
  message_ids: z.array(z.string().uuid()).min(1).max(FORWARD_MAX_BATCH),
  target_conversation_id: z.string().uuid(),
});

export type ForwardMessagesInput = z.infer<typeof forwardMessagesSchema>;

export const claimConversationSchema = z.object({
  expected_assignee: z.string().uuid().nullable().optional(),
});

export type ClaimConversationInput = z.infer<typeof claimConversationSchema>;

/** G3-01: transferência imediata (decisão G1-06d) — reatribui com motivo opcional. */
export const transferConversationSchema = z.object({
  to_user_id: z.string().uuid(),
  reason: z.string().trim().min(1).max(500).optional(),
});

export type TransferConversationInput = z.infer<typeof transferConversationSchema>;

export const updateConversationStatusSchema = z.object({
  status: conversationStatusSchema,
});

export type UpdateConversationStatusInput = z.infer<typeof updateConversationStatusSchema>;

/**
 * G3-05: normalização reutilizável de tag (mesmo shape de contacts.tags /
 * crm_leads.tags — text[]). trim + lowercase; 1..40 chars por tag.
 */
export const conversationTagSchema = z.string().trim().toLowerCase().min(1).max(40);

/** ≤20 tags, deduplicadas após normalização. */
export const conversationTagsSchema = z
  .array(conversationTagSchema)
  .max(20)
  .transform((tags) => Array.from(new Set(tags)));

export type ConversationTags = z.infer<typeof conversationTagsSchema>;

/** G3-05: PATCH /conversations/[id] aceita status e/ou tags (ao menos um). */
export const patchConversationSchema = z
  .object({
    status: conversationStatusSchema.optional(),
    tags: conversationTagsSchema.optional(),
  })
  .refine((d) => d.status !== undefined || d.tags !== undefined, {
    message: "Informe status ou tags.",
  });

export type PatchConversationInput = z.infer<typeof patchConversationSchema>;

/**
 * Estados TERMINAIS: a conversa acabou e não volta sozinha.
 *
 * Vive aqui, e não espalhado em cada `.not(...)`, porque "acabou" é uma decisão
 * de produto — se um dia `resolved` deixar de ser legado e passar a valer, o
 * lugar de dizer isso é um só.
 */
export const CONVERSATION_TERMINAL_STATUSES = ["closed", "archived"] as const;

export const listConversationsQuerySchema = z.object({
  status: conversationStatusSchema.optional(),
  /**
   * Esconde as conversas terminais (fechada/arquivada).
   *
   * Existe porque "Minhas" filtrava SÓ por dono e `Fechar` não solta o dono
   * (de propósito: quem atendeu é histórico que vale). Sem isto, tudo que o
   * atendente já fechou ficava na aba dele para sempre, e ela deixava de
   * significar "meu trabalho" para virar "tudo que já toquei".
   */
  exclude_finished: z.boolean().optional(),
  assigned_to: z.union([z.string().uuid(), z.literal("me"), z.literal("unassigned")]).optional(),
  channel_session_id: z.string().uuid().optional(),
  tag: conversationTagSchema.optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

export const listMessagesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
