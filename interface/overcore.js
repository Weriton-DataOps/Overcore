'use strict';

// O Overcore visto da ilha do Omni (F4, bloco E): o card pede GET /v1/saude pelo canal agente:api e devolve
// { ok, agente, versao, motor, iniciadoEm }.
//
// `chamar` é o canal que a ilha injeta: recebe { agente, metodo, rota, corpo } e devolve { status, corpo },
// com status 0 quando o main recusa antes de chamar. Sem canal, ou com o canal recusando, o card cai em pé
// com ok: false e o motivo.

const PEDIDO = Object.freeze({ agente: 'overcore', metodo: 'GET', rota: '/v1/saude', corpo: null });

const fora = (erro) => ({ ok: false, erro });

const texto = (v) => (typeof v === 'string' && v.trim() ? v : undefined);

async function resumo(chamar) {
  if (typeof chamar !== 'function') return fora('Overcore sem canal');
  let volta;
  try {
    volta = await chamar({ ...PEDIDO });
  } catch {
    return fora('Overcore fora do ar');
  }
  const corpo = volta && volta.corpo && typeof volta.corpo === 'object' ? volta.corpo : undefined;
  if (volta && volta.status === 200 && corpo) {
    return { ok: true, agente: corpo.agente, versao: corpo.versao, motor: corpo.motor, iniciadoEm: corpo.iniciado_em };
  }
  return fora((corpo && (texto(corpo.erro) || texto(corpo.error))) || 'Overcore fora do ar');
}

module.exports = { resumo };
