/**
 * GET /api/v1/conversations/[id]/capabilities — o que o canal DESTA conversa
 * permite.
 *
 * ─── Por que a tela precisa disto ───────────────────────────────────────────
 *
 * O invariante 1 da doutrina de canal proíbe qualquer feature de perguntar QUAL
 * canal é; a resposta certa é perguntar o que ele PERMITE. No servidor isso se
 * resolve testando a presença do método no adapter, mas a tela não tem adapter
 * em mãos — e até aqui ela também não tinha como perguntar, porque nenhuma rota
 * expunha capability nenhuma. Sem esta porta, a única forma de a tela decidir se
 * mostra "Encaminhar" seria olhar o nome do provider, que é exatamente o que o
 * lint reprova.
 *
 * Rota própria em vez de mais um campo no payload da conversa: capability não é
 * atributo da conversa, é do canal por trás dela: derivada, não persistida.
 * Enfiá-la na linha faria toda consulta de conversa (lista, kanban, contadores)
 * carregar um dado que só a tela de mensagem usa.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { capabilitiesOf, DEFAULT_CHANNEL_PROVIDER, type ChannelProvider } from "@/lib/channels";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: conversationId } = await ctx.params;

  // Leitura: viewer basta. Quem enxerga a conversa pode saber o que ela permite.
  const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data: conv, error } = await supabase
    .from("conversations")
    .select("id, channel_sessions:channel_session_id(provider)")
    .eq("id", conversationId)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();

  if (error) {
    return fail("internal_error", "Erro ao buscar conversa.", 500, { requestId });
  }
  if (!conv) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  const provider =
    ((conv as unknown as { channel_sessions: { provider?: string } | null }).channel_sessions
      ?.provider as ChannelProvider | undefined) ?? DEFAULT_CHANNEL_PROVIDER;

  const caps = capabilitiesOf(provider);

  // O corpo devolve a capability, NÃO o provider: quem consome não pode aprender
  // o nome do canal por aqui, senão a porta que existe para respeitar o
  // invariante 1 vira o caminho para burlá-lo.
  return ok(
    {
      can_forward: caps.canForward,
      freeform_outside_window: caps.freeformOutsideWindow,
      requires_templates: caps.requiresTemplates,
      cost_per_message: caps.costPerMessage,
    },
    { requestId },
  );
}
