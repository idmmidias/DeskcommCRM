-- 9061 — A RLS de leitura de conversas e de leads é avaliada UMA vez por consulta,
-- não uma vez por linha.
--
-- Medido numa instalação real em 31/10/2026: `conversations` com 204 linhas e 664 kB,
-- e a consulta da Inbox com média de 1,2-1,7 s e máximo de 8 s — o `statement_timeout`
-- do PostgREST para `authenticated`. A causa: `conversations_select` chama
-- `fn_can_view_conversation()` por linha, e ela chama `fn_is_platform_admin()` e
-- `fn_user_role_in_org()` (duas vezes; cada uma passa por `fn_support_context()`),
-- todas SECURITY DEFINER com search_path fixo, que o planner não embute. Com a
-- equipe carregando a Inbox junto, a consulta passa dos 8 s e a tela mostra
-- "Erro ao carregar conversas". EXPLAIN ANALYZE como uma manager: 621 ms com a
-- política (5.168 páginas lidas), 60 ms sem ela; com esta migration, 16 ms.
--
-- O que muda: `fn_escopo_de_visao_do_usuario()` devolve UMA linha por organização em
-- que o usuário da sessão enxerga algo, com o modo de visão ('todas',
-- 'proprias_e_sem_dono' ou 'proprias'), reproduzindo a decisão de
-- `fn_can_view_conversation`/`fn_can_view_lead`: admin de plataforma, suporte ativo,
-- papel viewer/manager/admin, e `settings.visibility_mode` para quem é agent. As
-- políticas `conversations_select` e `crm_leads_select` comparam `organization_id`
-- contra o resultado dela em subconsultas SEM correlação, que o Postgres executa uma
-- vez e consulta por hash; `auth.uid()` e `fn_is_platform_admin()` entram como
-- `(select ...)` pelo mesmo motivo. `messages_select` ganha só o `(select ...)` em
-- `fn_is_platform_admin()`: o escopo dela já é herdado de `conversations` pelo exists.
--
-- O que NÃO muda: `fn_can_view_conversation` e `fn_can_view_lead` continuam com a
-- mesma assinatura e o mesmo corpo — as políticas de conversation_drafts,
-- crm_lead_activities, crm_lead_links, passagens_de_atendimento,
-- agent_case_chat_messages e ai_reply_drafts, e as funções fn_reply_action,
-- fn_meet_action e fn_appointment_stamp seguem chamando as duas, em tabelas que não
-- são as quentes. As políticas de escrita não mudam. O conjunto visível por usuário
-- foi conferido igual antes e depois (admin, manager e dois agents em
-- 'own_and_unassigned').
--
-- No `baseline.sql` entra por EDIÇÃO NO LUGAR do bloco da 0035 (a definição intermediária
-- tem de ser igual à final: `tests/unit/baseline-nao-constroi-o-que-derruba.test.ts`).
-- Idempotente, sem dado tocado.

create or replace function public.fn_escopo_de_visao_do_usuario()
returns table (organization_id uuid, modo text)
language sql stable security definer
set search_path = public
as $$
  with suporte as (
    select public.fn_support_context() as s
  ),
  membro as (
    select uo.organization_id, uo.role
      from public.user_organizations uo
     where uo.user_id = auth.uid()
       and uo.revoked_at is null
  )
  -- Suporte ativo na organização: fn_user_role_in_org devolve 'admin' ou 'viewer',
  -- e os dois enxergam todas as conversas e todos os leads.
  select (s->>'organization_id')::uuid, 'todas'::text
    from suporte
   where s->>'status' = 'active'
  union
  select m.organization_id,
         case
           when m.role in ('viewer', 'manager', 'admin') then 'todas'
           else case coalesce(
                  (select o.settings->>'visibility_mode'
                     from public.organizations o
                    where o.id = m.organization_id),
                  'own_and_unassigned')
                  when 'all' then 'todas'
                  when 'own_and_unassigned' then 'proprias_e_sem_dono'
                  else 'proprias'
                end
         end
    from membro m;
$$;

revoke all on function public.fn_escopo_de_visao_do_usuario() from public;
revoke execute on function public.fn_escopo_de_visao_do_usuario() from anon;
grant execute on function public.fn_escopo_de_visao_do_usuario()
  to authenticated, service_role;

drop policy if exists "conversations_select" on public.conversations;
create policy "conversations_select" on public.conversations
  for select using (
    (select public.fn_is_platform_admin())
    or organization_id in (
         select e.organization_id from public.fn_escopo_de_visao_do_usuario() e
          where e.modo = 'todas')
    or (assigned_to_user_id = (select auth.uid())
        and organization_id in (
          select e.organization_id from public.fn_escopo_de_visao_do_usuario() e
           where e.modo in ('proprias', 'proprias_e_sem_dono')))
    or (assigned_to_user_id is null
        and organization_id in (
          select e.organization_id from public.fn_escopo_de_visao_do_usuario() e
           where e.modo = 'proprias_e_sem_dono'))
  );

drop policy if exists "crm_leads_select" on public.crm_leads;
create policy "crm_leads_select" on public.crm_leads
  for select using (
    (select public.fn_is_platform_admin())
    or organization_id in (
         select e.organization_id from public.fn_escopo_de_visao_do_usuario() e
          where e.modo = 'todas')
    or (owner_user_id = (select auth.uid())
        and organization_id in (
          select e.organization_id from public.fn_escopo_de_visao_do_usuario() e
           where e.modo in ('proprias', 'proprias_e_sem_dono')))
    or (owner_user_id is null
        and organization_id in (
          select e.organization_id from public.fn_escopo_de_visao_do_usuario() e
           where e.modo = 'proprias_e_sem_dono'))
  );

drop policy if exists "messages_select" on public.messages;
create policy "messages_select" on public.messages
  for select using (
    (select public.fn_is_platform_admin())
    or exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
    )
  );
