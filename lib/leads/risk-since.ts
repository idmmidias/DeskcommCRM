import { type RiskBucket, type StageWindow } from "@/lib/leads/risk-radar";

/**
 * DESDE QUANDO o negócio está NESTE estado — que não é "desde quando está em
 * silêncio", e a diferença decide se a coluna responde a alguma pergunta.
 *
 * O acervo entra com `since` no passado e `detected_at` em now (ver 0078). Se
 * `since` fosse `now`, o histórico diria para sempre que cinquenta negócios
 * esfriaram no mesmo minuto — dado falso nascendo junto com o mecanismo que
 * existe para não mentir.
 *
 * ⚠️ REFINO SOBRE O QUE FOI COMBINADO: o contrato dizia `since = last_activity_at`.
 * Isso responde "há quanto tempo está em SILÊNCIO"; a coluna promete "há quanto
 * tempo está NESTE ESTADO". Um negócio com janela de 72h e 100h de silêncio está
 * em risco há 28h, não há 100h — e é a primeira resposta que alguém quer ao
 * triar. Por isso o instante gravado é o do CRUZAMENTO do limiar. Reverter para
 * `last_activity_at` é uma linha, se o refino for recusado.
 *
 * O silêncio não se perde: `last_activity_at` continua no lead, e a diferença
 * entre as duas grandezas fica calculável. O contrário não valeria — de
 * `last_activity_at` sozinho não dá para reconstruir quando a janela mudou.
 */
export function sinceDoBucket(
  bucket: RiskBucket,
  lastActivityAt: Date,
  window: StageWindow,
  /**
   * O AGORA, para o instante do cruzamento nunca cair no futuro.
   *
   * ⚠️ O bucket nem sempre vem do relógio. `classifyRisk` FORÇA `critico`
   * quando a agenda responde `presenca_vencida` (compromisso que passou e
   * ninguém marcou Realizado ou Faltou), e força `em_voo` quando ela manda
   * adiar — nos dois casos sem olhar `hoursSinceActivity`. Aí a conta abaixo
   * devolve `última atividade + janela`, que para um negócio tocado há pouco é
   * um instante que AINDA NÃO ACONTECEU.
   *
   * O preço disso é a passada inteira da organização: `since > detected_at`
   * viola `crm_lead_risk_states_since_no_passado`, o upsert lança, e
   * `observaTravessias` aborta antes de `venceReativacoes`. Medido na F&M: um
   * compromisso de 24/09 sem desfecho congelou o Radar da conta de 25/09 às
   * 15h até o relógio alcançar a janela, de 15 em 15 minutos, sem ninguém ver.
   *
   * Afrouxar a constraint seria o conserto errado: ela está certa, estado não
   * começa no futuro. O certo é o produtor não inventar um.
   */
  now?: Date,
): Date {
  const h = (horas: number): Date =>
    new Date(lastActivityAt.getTime() + horas * 3_600_000);
  /** Nunca devolve instante futuro: bucket forçado não prova limiar cruzado. */
  const naoFuturo = (d: Date): Date =>
    now !== undefined && d.getTime() > now.getTime() ? now : d;
  switch (bucket) {
    case "critico":
      return naoFuturo(h(window.criticalHours));
    case "em_risco":
    // `em_voo` é "esfriou, mas a IA prometeu voltar": ele CRUZOU o limiar de
    // frio como qualquer outro, e o que muda é haver follow-up agendado — não
    // o instante da travessia. Só que ele TAMBÉM é forçado pela agenda
    // (`adiar`), e aí o limiar pode não ter sido cruzado: mesmo grampo.
    case "em_voo":
      return naoFuturo(h(window.coldHours));
    case "em_dia":
      // Ainda não cruzou nada. O estado começou na última interação.
      return lastActivityAt;
  }
}
