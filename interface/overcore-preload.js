'use strict';
// Preload do painel do Overcore na ilha do Omni (F4, bloco E). Tudo passa pelo canal genérico agente:api do
// main, que confere a rota contra interface.rotas do executor/agente.json e põe o token. O token nunca chega
// aqui. A volta é { status, corpo }; status 0 = o main recusou antes de chamar a API.
// O painel é de leitura: só GET, nas quatro rotas do manifesto.
const { contextBridge, ipcRenderer } = require('electron');

const ID_DE_TAREFA = /^[A-Za-z0-9._:-]{1,200}$/;

const chamar = (rota) => ipcRenderer.invoke('agente:api', { agente: 'overcore', metodo: 'GET', rota, corpo: null });

const motivo = (r, rota) => {
  const c = r && r.corpo;
  if (c && typeof c.erro === 'string' && c.erro.trim()) return c.erro;
  if (c && typeof c.error === 'string' && c.error.trim()) return c.error;
  return `falha ao ler ${rota} (status ${r ? r.status : '?'})`;
};

// 200 → o corpo; com nulo404, 404 → null; o resto rejeita com o motivo que veio
async function ler(rota, nulo404 = false) {
  const r = await chamar(rota);
  if (r && r.status === 200) return r.corpo;
  if (nulo404 && r && r.status === 404) return null;
  throw new Error(motivo(r, rota));
}

async function tarefa(id) {
  const texto = String(id ?? '').trim();
  if (!ID_DE_TAREFA.test(texto)) throw new Error('id de tarefa: letras, números e . _ : - (até 200)');
  return ler(`/v1/tasks/${texto}`, true);
}

contextBridge.exposeInMainWorld('overcore', {
  saude: () => ler('/v1/saude'),
  capacidades: () => ler('/v1/capabilities'),
  evidencias: () => ler('/v1/validation-evidence'),
  tarefa,
});
