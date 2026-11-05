'use strict';
// Painel do Overcore na ilha do Omni (F4, bloco E). Lê pela window.overcore que o preload expõe; tudo que
// vem da API entra na tela como texto (textContent), nunca como HTML. Fora da ilha (no teste), só exporta
// as funções puras.
(function () {
  const ESTADOS = {
    accepted: 'aceita', planning: 'planejando', ready: 'pronta', running: 'rodando', verifying: 'verificando',
    blocked: 'bloqueada', cancelling: 'cancelando', cancelled: 'cancelada', succeeded: 'concluída', failed: 'falhou',
  };
  const TOM = {
    succeeded: 'verde', running: 'azul', verifying: 'azul', planning: 'azul', accepted: 'azul', ready: 'azul',
    blocked: 'laranja', cancelling: 'laranja', cancelled: 'cinza', failed: 'vermelho',
  };

  const texto = (v) => (typeof v === 'string' && v ? v : null);

  // o pedaço da tarefa que a tela mostra; o resto (ledger, binding, uso) fica na API
  function resumoDaTarefa(t) {
    if (!t || typeof t !== 'object') return null;
    const ciclo = t.lifecycle && typeof t.lifecycle === 'object' ? t.lifecycle : {};
    return {
      id: String(t.taskId ?? ''),
      estado: texto(ciclo.state) ?? '?',
      revisao: Number.isFinite(t.stateRevision) ? t.stateRevision : null,
      aceitaEm: texto(t.acceptedAt),
      atualizadaEm: texto(t.updatedAt),
      noEstadoDesde: texto(ciclo.enteredAt),
      criterios: Array.isArray(t.criterionProgress) ? t.criterionProgress.length : 0,
    };
  }

  if (typeof module === 'object' && module && module.exports) {
    module.exports = { resumoDaTarefa };
    return;
  }

  const $ = (id) => document.getElementById(id);
  const quando = (iso) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }) : '—';
  };
  const limpar = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
  const no = (tag, classe, conteudo) => {
    const el = document.createElement(tag);
    if (classe) el.className = classe;
    if (conteudo !== undefined) el.textContent = String(conteudo);
    return el;
  };
  const linha = (dl, rotulo, valor, classe) => { dl.append(no('dt', '', rotulo), no('dd', classe || '', valor)); };
  const motivo = (e) => (e && e.message) || String(e);

  const api = window.overcore;

  async function saude() {
    const sinal = $('sinal');
    const dl = $('saude');
    limpar(dl);
    try {
      const s = await api.saude();
      sinal.textContent = 'de pé';
      sinal.dataset.tom = 'verde';
      linha(dl, 'versão', s.versao ?? '—');
      linha(dl, 'motor', s.motor ?? '—');
      linha(dl, 'no ar desde', quando(s.iniciado_em));
    } catch (e) {
      sinal.textContent = 'fora do ar';
      sinal.dataset.tom = 'vermelho';
      linha(dl, 'motivo', motivo(e), 'erro');
    }
  }

  async function capacidades() {
    const lista = $('capacidades');
    limpar(lista);
    try {
      const c = await api.capacidades();
      const itens = Array.isArray(c.capabilities) ? c.capabilities : [];
      if (itens.length === 0) lista.append(no('li', 'vazio', 'nenhuma capacidade declarada'));
      for (const nome of itens) lista.append(no('li', 'chip', nome));
    } catch (e) {
      lista.append(no('li', 'erro', motivo(e)));
    }
  }

  async function evidencias() {
    const dl = $('evidencias');
    limpar(dl);
    try {
      const v = await api.evidencias();
      linha(dl, 'situação', v.status ?? '—');
      linha(dl, 'registros', Array.isArray(v.evidence) ? v.evidence.length : 0);
    } catch (e) {
      linha(dl, 'motivo', motivo(e), 'erro');
    }
  }

  async function consultar(evento) {
    evento.preventDefault();
    const saida = $('tarefa');
    const botao = $('consultar');
    limpar(saida);
    botao.disabled = true;
    try {
      const r = resumoDaTarefa(await api.tarefa($('id').value));
      if (!r) {
        saida.append(no('p', 'vazio', 'nenhuma tarefa com esse id'));
        return;
      }
      const dl = no('dl', 'grade');
      linha(dl, 'tarefa', r.id, 'mono');
      const estado = no('span', 'pilula', ESTADOS[r.estado] || r.estado);
      estado.dataset.tom = TOM[r.estado] || 'cinza';
      dl.append(no('dt', '', 'estado'), no('dd'));
      dl.lastChild.append(estado);
      linha(dl, 'no estado desde', quando(r.noEstadoDesde));
      linha(dl, 'revisão', r.revisao ?? '—');
      linha(dl, 'critérios', r.criterios);
      linha(dl, 'aceita em', quando(r.aceitaEm));
      linha(dl, 'atualizada em', quando(r.atualizadaEm));
      saida.append(dl);
    } catch (e) {
      saida.append(no('p', 'erro', motivo(e)));
    } finally {
      botao.disabled = false;
    }
  }

  function atualizar() {
    return Promise.all([saude(), capacidades(), evidencias()]);
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!api) {
      $('sinal').textContent = 'sem canal';
      $('sinal').dataset.tom = 'vermelho';
      return;
    }
    $('atualizar').addEventListener('click', () => { void atualizar(); });
    $('busca').addEventListener('submit', (e) => { void consultar(e); });
    void atualizar();
  });
})();
