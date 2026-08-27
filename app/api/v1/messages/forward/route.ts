/**
 * POST /api/v1/messages/forward — encaminha mensagens para outra conversa
 * (handler em ../_forward-handler.ts).
 *
 * Rota COLETIVA, e não `[id]/forward`: o espaçamento entre um encaminhamento e o
 * próximo é trava anti-ban e precisa rodar no servidor. Com uma rota por
 * mensagem, a tela faria N chamadas e a trava moraria no cliente — onde o
 * próximo chamador não a herda.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { forwardMessagesSchema, validateRequest, type ForwardMessagesInput } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

import { forwardMessagesHandler } from "../_forward-handler";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  // Encaminhar É enviar: mesma exigência de papel do envio comum (viewer é
  // read-only). Um teto mais frouxo aqui seria uma porta lateral para mandar
  // mensagem sem poder mandar mensagem.
  const authz = await requireRole("agent", { requestId, resource: "messages" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const activeOrg = authz.org;

  let input;
  try {
    input = await validateRequest(forwardMessagesSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  try {
    const result = await forwardMessagesHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: user.id },
        requestId,
      },
      input as ForwardMessagesInput,
    );
    return ok(result, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
